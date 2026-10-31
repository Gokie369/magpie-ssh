'use strict';
// magpie SSH tunnel panel: a local web page plus backend that manages SSH reverse
// tunnels from this Windows machine to Linux servers. Listens on 127.0.0.1 only;
// quitting the panel closes every tunnel it opened.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const I18N = require('./i18n.js');

const HOME = os.homedir();
const APP_DIR = __dirname;
const DATA_FILE = path.join(APP_DIR, 'hosts.json');
const SSH_DIR = path.join(HOME, '.ssh');
const SSH_CONFIG = path.join(SSH_DIR, 'config');
const OPENCODE_CFG = path.join(HOME, '.config', 'opencode', 'opencode.json');
const MAGPIE_DIR = path.join(HOME, '.config', 'magpie');
const PANEL_PORT = Number(process.env.MAGPIE_PANEL_PORT || 3480);
const TOKEN = crypto.randomBytes(18).toString('hex');
const CONSOLE_LANG = /^zh/i.test(process.env.MAGPIE_PANEL_LANG || Intl.DateTimeFormat().resolvedOptions().locale || '') ? 'zh' : 'en';

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9._\/:\[\]-]{1,128}$/;

// ---------- messages ----------
// Errors and log lines carry a message key so the page can show them in either language.
const M = (key, params) => ({ key, params });
const raw = text => M('raw', { text: String(text || '') });
function httpError(status, key, params) {
  const e = new Error(I18N.format('en', key, params));
  e.status = status;
  e.msg = M(key, params);
  return e;
}
function errMsg(e) { return e && e.msg ? e.msg : raw(e && e.message ? e.message : e); }
function say(key, params) { return I18N.format(CONSOLE_LANG, key, params); }

// ---------- data ----------
function defaults() {
  return {
    settings: {
      localPort: 3425,
      magpieExe: '',
      testModel: '',
      codexModel: '',
      claudeModel: '',
      autoSyncMagpie: true,
      claudeBypass: false,
      lastMagpieHash: '',
      lastMagpieSyncAt: 0,
    },
    hosts: [],
  };
}
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return defaults();
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const settings = { ...defaults().settings, ...(d.settings || {}) };
    if (!validPort(settings.localPort)) throw new Error(I18N.format(CONSOLE_LANG, 'hostsBadPort'));
    if (!Array.isArray(d.hosts)) throw new Error(I18N.format(CONSOLE_LANG, 'hostsNotArray'));
    const aliases = new Set();
    for (const h of d.hosts) {
      if (!ALIAS_RE.test(h.alias) || !validPort(h.remotePort) || aliases.has(h.alias)) throw new Error(I18N.format(CONSOLE_LANG, 'hostsBadHost'));
      aliases.add(h.alias);
    }
    return { settings, hosts: d.hosts };
  } catch (e) { throw new Error(say('hostsInvalid', { error: e.message })); }
}
let data = loadData();
function saveData() {
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
function getHost(alias) {
  const h = data.hosts.find(x => x.alias === alias);
  if (!h) throw httpError(404, 'hostNotFound', { alias });
  return h;
}

// ---------- log ----------
const logs = [];
function log(alias, key, params) {
  const msg = typeof key === 'object' ? key : M(key, params);
  logs.push({ t: Date.now(), alias: alias || '', msg });
  if (logs.length > 400) logs.shift();
}

// ---------- processes ----------
function tail(s, n = 300) { s = String(s || '').trim(); return s.length > n ? '…' + s.slice(-n) : s; }

function run(cmd, args, { input, timeout = 60000, env } = {}) {
  return new Promise(resolve => {
    let out = '', err = '', done = false;
    let timer;
    const finish = code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } };
    let child;
    try {
      child = spawn(cmd, args, { env: env ? { ...process.env, ...env } : process.env, windowsHide: true });
    } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    timer = setTimeout(() => { err += '\n[timeout]'; child.kill(); finish(-1); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out = (out + d).slice(-1024 * 1024); });
    child.stderr.on('data', d => { err = (err + d).slice(-65536); });
    child.on('error', e => { err += e.code === 'ENOENT' ? 'ENOENT ' + cmd : e.message; finish(-1); });
    child.on('close', code => finish(code));
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? '' : input);
  });
}

// Remote scripts are fed to `sh -s` on stdin, which avoids login-shell quoting differences.
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];
function remoteScript(alias, script, timeout = 60000) {
  return run('ssh', [...SSH_OPTS, alias, 'sh -s'], { input: script.replace(/\r/g, ''), timeout });
}
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// ---------- SSH config ----------
function readSshConfig() { try { return fs.readFileSync(SSH_CONFIG, 'utf8'); } catch { return ''; } }
function parseSshConfig(text) {
  const entries = [];
  let cur = null;
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)\s*(?:=|\s)\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'host') {
      cur = {};
      for (const a of val.split(/\s+/)) if (!/[*?!]/.test(a)) entries.push({ alias: a, props: cur });
      continue;
    }
    if (key === 'match') { cur = null; continue; }
    if (cur && !(key in cur)) cur[key] = val;
  }
  return entries.map(e => ({
    alias: e.alias,
    hostname: e.props.hostname || e.alias,
    user: e.props.user || '',
    port: e.props.port || '22',
    identityFile: e.props.identityfile || '',
  }));
}
function sshEntry(alias) { return parseSshConfig(readSshConfig()).find(e => e.alias === alias) || null; }
function eolOf(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function backupSshConfig() {
  if (fs.existsSync(SSH_CONFIG)) fs.copyFileSync(SSH_CONFIG, SSH_CONFIG + '.magpie-panel.bak');
}
function appendSshHost({ alias, hostname, user, port, identityFile }) {
  fs.mkdirSync(SSH_DIR, { recursive: true });
  backupSshConfig();
  const text = readSshConfig();
  const eol = eolOf(text);
  const lines = [`Host ${alias}`, `  HostName ${hostname}`, `  User ${user}`];
  if (port && Number(port) !== 22) lines.push(`  Port ${port}`);
  if (identityFile) lines.push(`  IdentityFile ${identityFile}`);
  const sep = text && !text.endsWith('\n') ? eol : '';
  fs.writeFileSync(SSH_CONFIG, text + sep + eol + lines.join(eol) + eol);
}
function addIdentityToHost(alias, identityFile) {
  const text = readSshConfig();
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex(l => {
    const m = l.trim().match(/^host\s+(.+)$/i);
    return m && m[1].split(/\s+/).includes(alias);
  });
  if (idx < 0) return false;
  for (let i = idx + 1; i < lines.length && !/^\s*(host|match)\s/i.test(lines[i]); i++) {
    if (lines[i].trim().toLowerCase() === ('identityfile ' + identityFile).toLowerCase()) return true;
  }
  backupSshConfig();
  lines.splice(idx + 1, 0, `  IdentityFile ${identityFile}`);
  fs.writeFileSync(SSH_CONFIG, lines.join(eol));
  return true;
}

// ---------- key login ----------
async function ensureAskpass() {
  // Windows OpenSSH starts askpass with CreateProcess, so it needs a real executable rather than a .cmd file.
  const exe = path.join(APP_DIR, 'askpass.exe');
  if (!fs.existsSync(exe)) {
    const source = path.join(APP_DIR, 'askpass.cs');
    fs.writeFileSync(source, 'using System; public class Askpass { public static void Main() { Console.WriteLine(Environment.GetEnvironmentVariable("MAGPIE_PANEL_PW") ?? ""); } }\n');
    const quote = s => "'" + s.replace(/'/g, "''") + "'";
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -Path ${quote(source)} -OutputAssembly ${quote(exe)} -OutputType ConsoleApplication`], { timeout: 30000 });
    if (result.code !== 0 || !fs.existsSync(exe)) throw httpError(500, 'askpassFailed', { error: tail(result.err) });
  }
  return exe;
}
async function testLogin(alias) {
  const r = await run('ssh', [...SSH_OPTS, alias, 'echo MAGPIE_LOGIN_OK'], { timeout: 20000 });
  return { ok: r.out.includes('MAGPIE_LOGIN_OK'), err: tail(r.err) };
}
async function setupKeyLogin(alias, password) {
  const keyPath = path.join(SSH_DIR, `magpie_${alias}_ed25519`);
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(SSH_DIR, { recursive: true });
    const g = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `magpie-panel@${alias}`, '-f', keyPath], { timeout: 20000 });
    if (g.code !== 0) throw httpError(500, 'keygenFailed', { error: tail(g.err) });
    log(alias, 'logKeyGenerated', { path: keyPath });
  }
  const pub = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+\/=]+( \S+)?$/.test(pub)) throw httpError(500, 'pubkeyInvalid');
  const script = `set -e
umask 077
mkdir -p "$HOME/.ssh"
f="$HOME/.ssh/authorized_keys"
touch "$f"
k='${pub}'
grep -qxF "$k" "$f" || printf '%s\\n' "$k" >> "$f"
echo KEY_INSTALLED
`;
  const r = await run('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
    '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'NumberOfPasswordPrompts=1', alias, 'sh -s',
  ], {
    input: script, timeout: 40000,
    env: { SSH_ASKPASS: await ensureAskpass(), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || 'magpie-panel:0', MAGPIE_PANEL_PW: password },
  });
  if (!r.out.includes('KEY_INSTALLED')) throw httpError(500, 'keyInstallFailed', { error: tail(r.err) || M('noOutput') });
  const idf = `~/.ssh/${path.basename(keyPath)}`;
  addIdentityToHost(alias, idf);
  log(alias, 'logKeyInstalled');
  return idf;
}

// ---------- tunnels ----------
// state: { proc, wanted, status: 'stopped'|'stopping'|'starting'|'running'|'retrying', since, lastError, restarts, timer }
const tunnels = new Map();
function tstate(alias) {
  if (!tunnels.has(alias)) tunnels.set(alias, { proc: null, wanted: false, status: 'stopped', since: null, lastError: null, restarts: 0, timer: null });
  return tunnels.get(alias);
}
function forwardSpec(h) { return `127.0.0.1:${h.remotePort}:127.0.0.1:${data.settings.localPort}`; }

function startTunnel(alias) {
  const h = getHost(alias);
  const st = tstate(alias);
  st.wanted = true;
  clearTimeout(st.timer);
  if (st.proc) {
    if (st.status === 'stopping') st.restartRequested = true;
    return;
  }
  st.status = 'starting';
  st.lastError = null;
  st.restartRequested = false;
  const args = ['-v', '-N', '-T', '-R', forwardSpec(h), ...SSH_OPTS,
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes', alias];
  const proc = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  st.proc = proc;
  let stderr = '';
  let notFound = false;
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => {
    stderr = (stderr + d).slice(-8192);
    // Only show "running" after the server confirms the forward, not just because ssh is alive.
    if (st.proc === proc && st.status === 'starting' && /remote forward success for:/.test(stderr)) {
      st.status = 'running'; st.since = Date.now();
      log(alias, st.restarts ? 'logTunnelUpRetry' : 'logTunnelUp', { port: h.remotePort, n: st.restarts });
      st.restarts = 0;
    }
  });
  const upTimer = setTimeout(() => {
    if (st.proc === proc && st.status === 'starting') { stderr += '\nMAGPIE_SETUP_TIMEOUT'; proc.kill(); }
  }, 25000);
  proc.on('error', e => { if (e.code === 'ENOENT') notFound = true; stderr += e.message; });
  proc.on('close', code => {
    clearTimeout(upTimer);
    if (st.proc !== proc || tunnels.get(alias) !== st) return;
    st.proc = null;
    st.since = null;
    if (!st.wanted) { st.status = 'stopped'; st.lastError = null; log(alias, 'logTunnelClosed'); return; }
    if (st.restartRequested) {
      st.restartRequested = false;
      st.timer = setTimeout(() => { if (st.wanted) startTunnel(alias); }, 250);
      return;
    }
    const errors = stderr.split(/\r?\n/).filter(l => l && !/^debug\d:/.test(l));
    st.lastError = notFound ? M('sshNotFound')
      : /MAGPIE_SETUP_TIMEOUT/.test(stderr) ? M('sshSetupTimeout')
      : explainSshError(tail(errors.join('\n'), 400)) || M('sshExit', { code });
    st.restarts++;
    const delay = Math.min(60, 3 * 2 ** Math.min(st.restarts - 1, 4));
    st.status = 'retrying';
    log(alias, 'logTunnelDropped', { error: st.lastError, delay });
    st.timer = setTimeout(() => { if (st.wanted) startTunnel(alias); }, delay * 1000);
  });
  log(alias, 'logTunnelConnecting');
}
function stopTunnel(alias) {
  const st = tstate(alias);
  st.wanted = false;
  clearTimeout(st.timer);
  st.restarts = 0;
  st.restartRequested = false;
  st.lastError = null;
  if (st.proc) { st.status = 'stopping'; st.proc.kill(); } else st.status = 'stopped';
}
function restartTunnel(alias) {
  const st = tstate(alias);
  st.wanted = true;
  st.restartRequested = true;
  st.restarts = 0;
  clearTimeout(st.timer);
  if (st.proc) { st.status = 'starting'; st.proc.kill(); } else startTunnel(alias);
}
function explainSshError(s) {
  if (!s) return null;
  if (/remote port forwarding failed/i.test(s)) return M('sshPortInUse');
  if (/Permission denied/i.test(s)) return M('sshDenied');
  if (/Host key verification failed/i.test(s)) return M('sshHostKey');
  if (/Could not resolve hostname/i.test(s)) return M('sshResolve');
  if (/timed out|Connection timed out/i.test(s)) return M('sshTimeout');
  if (/Connection refused/i.test(s)) return M('sshRefused');
  if (/ENOENT ssh/.test(s)) return M('sshNotFound');
  return raw(s);
}

// ssh tunnels to the same magpie port that this panel did not start; shown as a warning only.
let externalCache = null, externalScan = null;
async function findExternalTunnels(fresh = false) {
  if (process.platform !== 'win32') return [];
  if (!fresh && externalCache && Date.now() - externalCache.at < 10000) return externalCache.value;
  if (!fresh && externalScan) return externalScan;
  const scan = scanExternalTunnels();
  externalScan = scan;
  try { return await scan; } finally { if (externalScan === scan) externalScan = null; }
}
async function scanExternalTunnels() {
  const r = await run('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { timeout: 15000 });
  const own = new Set([...tunnels.values()].filter(t => t.proc).map(t => t.proc.pid));
  const port = data.settings.localPort;
  const pattern = new RegExp('(?:^|\\s)-R\\s+"?(?:127\\.0\\.0\\.1:)?\\d+:127\\.0\\.0\\.1:' + port + '(?:"|\\s|$)');
  const value = r.out.split(/\r?\n/).map(l => l.split('\t')).filter(p => p.length === 2 && pattern.test(p[1]) && !own.has(Number(p[0])))
    .map(([pid, cmd]) => ({ pid: Number(pid), cmd: cmd.trim() }));
  externalCache = { at: Date.now(), value };
  return value;
}
async function killExternal(pid) {
  const ext = await findExternalTunnels(true);
  if (!ext.some(e => e.pid === pid)) throw httpError(400, 'notExternal');
  process.kill(pid);
  externalCache = null;
}

// ---------- local magpie ----------
async function magpieStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${data.settings.localPort}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { up: false, error: 'HTTP ' + res.status };
    const j = await res.json();
    return { up: true, models: (j.data || []).map(m => m.id).filter(id => typeof id === 'string') };
  } catch (e) { return { up: false, error: e.name === 'TimeoutError' ? 'timeout' : e.message }; }
}

// Model defaults: an empty setting means "pick from what magpie serves".
const MODEL_HINTS = { codex: [/gpt|codex/i], claude: [/claude/i], test: [/flash|mini|luna|haiku/i] };
function pickModel(kind, models) {
  const configured = data.settings[kind + 'Model'];
  if (configured) return configured;
  for (const re of MODEL_HINTS[kind] || []) {
    const hit = models.find(id => re.test(id));
    if (hit) return hit;
  }
  if (models.length) return models[0];
  throw httpError(400, 'noModelForTool', { tool: kind === 'claude' ? 'Claude Code' : kind === 'codex' ? 'Codex' : 'test' });
}

function findMagpieExe() {
  const names = ['magpie-windows-amd64.exe', 'magpie-windows-arm64.exe', 'magpie.exe'];
  const candidates = [data.settings.magpieExe];
  for (const n of names) candidates.push(path.join(HOME, 'Downloads', n));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'magpie', 'magpie.exe'));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) for (const n of names) candidates.push(path.join(dir, n));
  return candidates.find(f => f && fs.existsSync(f)) || '';
}

function readOpencodeConfig() {
  try { return JSON.parse(fs.readFileSync(OPENCODE_CFG, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function opencodeMagpie(cfg) {
  if (!cfg) return null;
  const section = cfg.providers && cfg.providers.magpie ? 'providers' : 'provider';
  return cfg[section] && cfg[section].magpie ? { section, magpie: cfg[section].magpie } : null;
}
// Per-model metadata (reasoning variants, context limit) from the local OpenCode magpie provider, if any.
function modelMetadata() {
  const found = opencodeMagpie(readOpencodeConfig());
  return (found && found.magpie.models) || {};
}

// Fingerprint of the local magpie setup: provider/settings files, OpenCode config and the live model list.
function hashText(text) { return crypto.createHash('sha256').update(String(text)).digest('hex'); }
function hashFile(file) {
  try {
    const st = fs.statSync(file);
    return st.size + ':' + st.mtimeMs + ':' + hashText(fs.readFileSync(file));
  } catch { return 'missing'; }
}
async function magpieFingerprint(status) {
  const st = status || await magpieStatus();
  const files = ['providers.json', 'settings.json'].map(f => hashFile(path.join(MAGPIE_DIR, f)));
  files.push(hashFile(OPENCODE_CFG));
  const models = st.up ? st.models.slice().sort() : [];
  return {
    up: !!st.up,
    modelCount: models.length,
    models,
    hash: hashText(files.join('|') + '|' + models.join('\n')),
    at: Date.now(),
  };
}

let magpieSyncing = false;
let magpieSyncTimer = null;
let lastSyncAttempt = { hash: '', at: 0 };
async function syncAllMagpie(reason = 'manual') {
  if (magpieSyncing) throw httpError(409, 'syncBusy');
  magpieSyncing = true;
  try {
    const fp = await magpieFingerprint();
    if (!fp.up) throw httpError(503, 'magpieDown');
    lastSyncAttempt = { hash: fp.hash, at: Date.now() };
    const hasOpencode = !!opencodeMagpie(readOpencodeConfig());
    const metadata = modelMetadata();
    const results = [];
    for (const h of data.hosts) {
      const result = { alias: h.alias };
      try {
        if (hasOpencode) {
          await syncOpencode(h.alias);
          result.opencode = true;
        }
        if (h.native?.codex?.active) {
          await nativeCall(h.alias, { action: 'catalog', model: pickModel('codex', fp.models), extra: fp.models, metadata });
          result.codexCatalog = true;
          log(h.alias, 'logCatalogUpdated', { count: fp.modelCount });
        }
        result.ok = true;
      } catch (e) {
        result.error = I18N.render(CONSOLE_LANG, errMsg(e));
        log(h.alias, 'logSyncHostFailed', { error: errMsg(e) });
      }
      results.push(result);
    }
    // Keep retrying later if any server failed.
    if (results.every(r => r.ok)) data.settings.lastMagpieHash = fp.hash;
    data.settings.lastMagpieSyncAt = Date.now();
    saveData();
    const ok = results.filter(r => r.ok).length;
    log('', reason === 'auto' ? 'logSyncDoneAuto' : 'logSyncDoneManual', { ok, total: results.length, count: fp.modelCount });
    return { results, at: Date.now(), modelCount: fp.modelCount };
  } finally { magpieSyncing = false; }
}

async function pollMagpieConfig() {
  try {
    const fp = await magpieFingerprint();
    if (!fp.up) return;
    if (!data.settings.lastMagpieHash) {
      data.settings.lastMagpieHash = fp.hash;
      saveData();
      return;
    }
    if (fp.hash === data.settings.lastMagpieHash) return;
    // After a failed attempt, retry the same configuration at most every 5 minutes.
    if (fp.hash === lastSyncAttempt.hash && Date.now() - lastSyncAttempt.at < 300000) return;
    log('', 'logConfigChanged', { count: fp.modelCount });
    if (data.settings.autoSyncMagpie) {
      clearTimeout(magpieSyncTimer);
      lastSyncAttempt = { hash: fp.hash, at: Date.now() };
      magpieSyncTimer = setTimeout(() => {
        syncAllMagpie('auto').catch(e => log('', 'logAutoSyncFailed', { error: errMsg(e) }));
      }, 3000);
    } else {
      lastSyncAttempt = { hash: fp.hash, at: Date.now() };
      log('', 'logAutoSyncOff');
    }
  } catch (e) { log('', 'logPollFailed', { error: errMsg(e) }); }
}
async function startMagpie() {
  const exe = findMagpieExe();
  if (!exe) throw httpError(400, data.settings.magpieExe ? 'magpieNotFound' : 'magpieExeUnset', { path: data.settings.magpieExe });
  const child = spawn(exe, ['tray'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', e => log('', 'logMagpieStartFailed', { error: e.message }));
  child.unref();
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    if ((await magpieStatus()).up) { log('', 'logMagpieStarted'); return; }
  }
  throw httpError(500, 'magpieStillDown');
}

// ---------- remote checks ----------
async function checkHost(alias) {
  const h = getHost(alias);
  const script = `p=${h.remotePort}
code=$(curl --noproxy '*' -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$p/v1/models 2>/dev/null || true)
echo "gateway=\${code:-none}"
lookup() {
  if command -v bash >/dev/null 2>&1; then bash -lic "command -v $1" 2>/dev/null | tail -n 1; fi
  command -v "$1" 2>/dev/null
  ls "$HOME/.opencode/bin/$1" "$HOME/.local/bin/$1" "$HOME"/.nvm/versions/node/*/bin/"$1" 2>/dev/null
}
for c in opencode codex claude; do
  b=$(lookup $c | grep '^/' | head -n 1)
  echo "$c=\${b:-}"
done
[ -f "$HOME/.config/opencode/opencode.json" ] && grep -q '"magpie"' "$HOME/.config/opencode/opencode.json" && echo "opencodecfg=magpie" || echo "opencodecfg="
echo "user=$(id -un)"
`;
  const r = await remoteScript(alias, script, 30000);
  const kv = {};
  for (const line of r.out.split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim(); }
  if (r.code !== 0 || !('user' in kv)) {
    const result = { ok: false, error: explainSshError(tail(r.err)) || M('connectFailed'), at: Date.now() };
    h.lastCheck = result; saveData();
    return result;
  }
  const result = {
    ok: true, at: Date.now(), user: kv.user,
    gateway: kv.gateway === '200',
    gatewayCode: kv.gateway,
    tools: { opencode: !!kv.opencode, codex: !!kv.codex, claude: !!kv.claude },
    opencodeConfigured: kv.opencodecfg === 'magpie',
  };
  const native = await nativeStatus(alias);
  if (!native.error) { result.native = native; h.native = native; }
  h.lastCheck = result; saveData();
  return result;
}

async function syncOpencode(alias) {
  const h = getHost(alias);
  const found = opencodeMagpie(readOpencodeConfig());
  if (!found) throw httpError(400, 'raw', { text: `${OPENCODE_CFG}: no "magpie" provider` });
  const { section, magpie } = found;
  const remote = JSON.parse(JSON.stringify(magpie));
  const optionsKey = remote.package || remote.settings ? 'settings' : 'options';
  remote[optionsKey] = { ...(remote[optionsKey] || {}), baseURL: `http://127.0.0.1:${h.remotePort}/v1` };
  const live = await magpieStatus();
  let added = 0, removed = 0;
  if (live.up && live.models.length) {
    const served = new Set(live.models);
    remote.models = remote.models || {};
    for (const id of live.models) {
      if (!remote.models[id]) { remote.models[id] = { name: id }; added++; }
    }
    for (const id of Object.keys(remote.models)) {
      if (!served.has(id)) { delete remote.models[id]; removed++; }
    }
  }
  // Replace only provider.magpie in the remote config and keep everything else.
  const script = `set -e
umask 077
d="$HOME/.config/opencode"; f="$d/opencode.json"
mkdir -p "$d"
command -v python3 >/dev/null 2>&1 || { echo "NEED_PYTHON3"; exit 3; }
python3 - "$f" <<'PY'
import base64, json, os, shutil, sys, tempfile
f = sys.argv[1]
cfg = {}
if os.path.exists(f) and os.path.getsize(f) > 0:
    with open(f, encoding="utf-8-sig") as fh: cfg = json.load(fh)
elif os.path.exists(f + "c"):
    raise RuntimeError("opencode.jsonc exists; refusing to shadow it. Merge manually first.")
cfg.setdefault("$schema", "https://opencode.ai/config.json")
cfg.setdefault("${section}", {})["magpie"] = json.loads(base64.b64decode("${b64(JSON.stringify(remote))}"))
if os.path.exists(f):
    shutil.copy2(f, f + ".magpie-panel.bak")
fd, tmp = tempfile.mkstemp(prefix=".magpie-", dir=os.path.dirname(f))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as fh: json.dump(cfg, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, f)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
echo SYNC_OK
`;
  const r = await remoteScript(alias, script, 40000);
  if (r.out.includes('NEED_PYTHON3')) throw httpError(500, 'remoteNoPython');
  if (!r.out.includes('SYNC_OK')) throw httpError(500, 'syncFailed', { error: tail(r.err) || tail(r.out) });
  log(alias, 'logOpencodeSynced', { count: Object.keys(remote.models || {}).length, added, removed });
}

async function testInference(alias, model) {
  const h = getHost(alias);
  if (!model) {
    const st = await magpieStatus();
    model = pickModel('test', st.up ? st.models : []);
  }
  if (!MODEL_RE.test(model)) throw httpError(400, 'invalidModel');
  const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: MAGPIE_OK' }], max_tokens: 256 });
  const script = `set -e
umask 077
f=$(mktemp)
trap 'rm -f "$f"' EXIT HUP INT TERM
echo '${b64(body)}' | base64 -d > "$f"
start=$(date +%s%N 2>/dev/null || date +%s)
curl --noproxy '*' -sS -m 90 http://127.0.0.1:${h.remotePort}/v1/chat/completions -H 'Content-Type: application/json' -H 'Authorization: Bearer magpie' --data-binary @"$f"
echo
end=$(date +%s%N 2>/dev/null || date +%s)
echo "ELAPSED=$(( (end - start) / 1000000 ))"
`;
  const r = await remoteScript(alias, script, 120000);
  const lines = r.out.trim().split(/\r?\n/);
  const elapsed = Number((lines.find(l => l.startsWith('ELAPSED=')) || '').slice(8)) || null;
  const jsonLine = lines.find(l => l.startsWith('{'));
  if (!jsonLine) throw httpError(500, 'noResponse', { error: explainSshError(tail(r.err)) || M('tunnelMaybeOff') });
  let j; try { j = JSON.parse(jsonLine); } catch { throw httpError(500, 'notJson', { text: tail(jsonLine) }); }
  if (j.error) throw httpError(500, 'modelError', { error: j.error.message || JSON.stringify(j.error) });
  const reply = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
  if (typeof reply !== 'string' || !reply.trim()) throw httpError(502, 'noText');
  const result = { model, reply: reply.slice(0, 2000), elapsedMs: elapsed, exactMatch: reply.replace(/\s+/g, '').toUpperCase() === 'MAGPIE_OK', truncated: j.choices?.[0]?.finish_reason === 'length', at: Date.now() };
  h.lastTest = result; saveData();
  log(alias, 'logInferenceOk', { model, reply: tail(reply, 100), ms: elapsed });
  return result;
}

// ---------- native CLI integration ----------
// Only the two CLIs' fixed user config files are edited. The original bytes are saved first.
async function nativeCall(alias, request) {
  getHost(alias);
  const helper = fs.readFileSync(path.join(APP_DIR, 'native-cli.py'));
  const script = `set -e
umask 077
f=$(mktemp)
r=$(mktemp)
trap 'rm -f "$f" "$r"' EXIT HUP INT TERM
echo '${b64(helper)}' | base64 -d > "$f"
echo '${b64(JSON.stringify(request))}' | base64 -d > "$r"
python3 "$f" < "$r"
`;
  const r = await remoteScript(alias, script, 60000);
  const line = r.out.split(/\r?\n/).find(l => l.startsWith('{'));
  if (!line) throw httpError(502, 'helperNoOutput', { error: explainSshError(tail(r.err)) || M('helperNoPython') });
  let result;
  try { result = JSON.parse(line); } catch { throw httpError(502, 'helperBad'); }
  if (!result.ok) {
    const message = result.error || 'native CLI helper failed';
    if (/Configuration changed after activation/i.test(message)) {
      const err = httpError(409, 'nativeConflict');
      err.code = 'config-changed';
      throw err;
    }
    throw httpError(409, 'raw', { text: message });
  }
  return result.data;
}
async function nativeStatus(alias) {
  try { return await nativeCall(alias, { action: 'status' }); }
  catch (e) { return { error: e.message }; }
}
async function nativeCallSafe(alias, request) {
  try {
    return await nativeCall(alias, request);
  } catch (e) {
    if (e.code === 'config-changed' && !request.force) {
      log(alias, 'logNativeRetry');
      return nativeCall(alias, { ...request, force: true });
    }
    throw e;
  }
}
async function nativeApply(alias, tool, force) {
  const h = getHost(alias);
  if (tool !== 'codex' && tool !== 'claude') throw httpError(400, 'unknownCli');
  const fp = await magpieFingerprint();
  const model = pickModel(tool, fp.models);
  const metadata = modelMetadata();
  const contextWindow = Number(metadata[model]?.limit?.context) || 400000;
  const windows = Object.fromEntries(Object.entries(metadata).filter(([id]) => /claude/i.test(id)).map(([id, m]) => [id, m?.limit?.context]).filter(([, v]) => v));
  const result = await nativeCallSafe(alias, {
    action: 'apply', tool, port: h.remotePort, model, force: !!force,
    extra: fp.models, metadata, contextWindow, windows, bypass: !!data.settings.claudeBypass,
  });
  h.native = { ...(h.native || {}), [tool]: { active: true, changed: false, canRestore: true, port: result.port, model: result.model, backup: result.backup } };
  h.nativeStale = false;
  saveData();
  log(alias, 'logNativeApplied', { tool: tool === 'codex' ? 'Codex' : 'Claude Code' });
  return result;
}
async function nativeRestore(alias, tool, force) {
  if (tool !== 'codex' && tool !== 'claude') throw httpError(400, 'unknownCli');
  const result = await nativeCallSafe(alias, { action: 'restore', tool, force: !!force });
  const h = getHost(alias);
  h.native = { ...(h.native || {}), [tool]: { active: false, changed: false, canRestore: false } };
  if (!h.native.codex?.active && !h.native.claude?.active) h.nativeStale = false;
  saveData();
  log(alias, 'logNativeRestored', { tool: tool === 'codex' ? 'Codex' : 'Claude Code' });
  return result;
}
// Newer Codex versions keep a background app server that caches the model catalog.
async function restartCodexDaemon(alias) {
  getHost(alias);
  const script = `command -v bash >/dev/null 2>&1 || { echo DAEMON_UNSUPPORTED; exit 0; }
help=$(bash -lic 'codex app-server daemon --help' 2>/dev/null || true)
case "$help" in *restart*) ;; *) echo DAEMON_UNSUPPORTED; exit 0;; esac
bash -lic 'codex app-server daemon restart' >/dev/null 2>&1 && echo DAEMON_OK || echo DAEMON_FAIL
`;
  const r = await remoteScript(alias, script, 60000);
  if (r.out.includes('DAEMON_UNSUPPORTED')) throw httpError(400, 'daemonUnsupported');
  if (!r.out.includes('DAEMON_OK')) throw httpError(500, 'daemonFailed', { error: explainSshError(tail(r.err)) || M('noOutput') });
  log(alias, 'logDaemonRestarted');
}

// ---------- add / remove servers ----------
function validPort(p) { p = Number(p); return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : null; }

async function addHost(body) {
  const alias = String(body.alias || '').trim();
  if (!ALIAS_RE.test(alias)) throw httpError(400, 'aliasInvalid');
  if (data.hosts.some(h => h.alias.toLowerCase() === alias.toLowerCase())) throw httpError(400, 'aliasExists');
  const remotePort = body.remotePort ? validPort(body.remotePort) : data.settings.localPort;
  if (!remotePort) throw httpError(400, 'remotePortInvalid');

  if (!sshEntry(alias)) {
    const hostname = String(body.hostname || '').trim();
    const user = String(body.user || '').trim();
    const port = body.port ? Number(body.port) : 22;
    if (!HOSTNAME_RE.test(hostname)) throw httpError(400, 'hostnameRequired');
    if (!USER_RE.test(user)) throw httpError(400, 'userInvalid');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'sshPortInvalid');
    appendSshHost({ alias, hostname, user, port });
    log(alias, 'logSshConfigWritten');
  }

  let login = await testLogin(alias);
  if (!login.ok && body.password) {
    await setupKeyLogin(alias, String(body.password));
    login = await testLogin(alias);
  }
  data.hosts.push({ alias, remotePort, autoStart: !!body.autoStart, addedAt: Date.now() });
  saveData();
  const loginError = login.ok ? null : explainSshError(login.err) || M('connectFailed');
  if (login.ok) log(alias, 'logHostAddedOk');
  else log(alias, 'logHostAddedNoLogin', { error: loginError });
  if (login.ok && body.autoStart) startTunnel(alias);
  return { alias, login: login.ok, loginError };
}
function removeHost(alias) {
  getHost(alias);
  stopTunnel(alias);
  tunnels.delete(alias);
  data.hosts = data.hosts.filter(h => h.alias !== alias);
  saveData();
  log(alias, 'logHostRemoved');
}
function updateHost(alias, body) {
  const h = getHost(alias);
  const next = { ...h };
  if ('remotePort' in body) {
    const p = validPort(body.remotePort);
    if (!p) throw httpError(400, 'remotePortInvalid');
    next.remotePort = p;
  }
  if ('autoStart' in body) next.autoStart = !!body.autoStart;
  const changedPort = next.remotePort !== h.remotePort;
  Object.assign(h, next);
  if (changedPort) { h.lastCheck = null; h.lastTest = null; if (h.native && (h.native.codex?.active || h.native.claude?.active)) h.nativeStale = true; }
  saveData();
  if (changedPort && tstate(alias).wanted) restartTunnel(alias);
}
function updateSettings(body) {
  const s = { ...data.settings };
  if ('localPort' in body) { const p = validPort(body.localPort); if (!p) throw httpError(400, 'localPortInvalid'); s.localPort = p; }
  if ('magpieExe' in body) s.magpieExe = String(body.magpieExe).trim();
  if ('autoSyncMagpie' in body) s.autoSyncMagpie = !!body.autoSyncMagpie;
  if ('claudeBypass' in body) s.claudeBypass = !!body.claudeBypass;
  for (const k of ['testModel', 'codexModel', 'claudeModel']) {
    if (k in body) {
      const v = String(body[k]).trim();
      if (v && !MODEL_RE.test(v)) throw httpError(400, 'settingInvalid', { name: k });
      s[k] = v;
    }
  }
  const changedPort = s.localPort !== data.settings.localPort;
  data.settings = s;
  saveData();
  if (changedPort) {
    externalCache = null;
    for (const h of data.hosts) if (tstate(h.alias).wanted) restartTunnel(h.alias);
  }
}

// ---------- state ----------
function hostView(h) {
  const st = tstate(h.alias);
  const e = sshEntry(h.alias);
  return {
    alias: h.alias, remotePort: h.remotePort, autoStart: !!h.autoStart,
    ssh: e ? { hostname: e.hostname, user: e.user, port: e.port } : null,
    native: h.native || null,
    nativeStale: !!h.nativeStale,
    tunnel: { wanted: st.wanted, status: st.status, since: st.since, lastError: st.lastError, restarts: st.restarts, pid: st.proc ? st.proc.pid : null },
    lastCheck: h.lastCheck || null,
    lastTest: h.lastTest || null,
  };
}

// ---------- HTTP ----------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, re: new RegExp('^' + pattern + '$'), handler }); }

route('GET', '/api/state', async () => {
  const magpie = await magpieStatus();
  const fp = await magpieFingerprint(magpie);
  return {
    magpie,
    settings: data.settings,
    magpieExeFound: findMagpieExe(),
    hosts: data.hosts.map(hostView),
    external: await findExternalTunnels(),
    sshConfigHosts: parseSshConfig(readSshConfig()).map(e => e.alias).filter(a => !data.hosts.some(h => h.alias === a)),
    sync: {
      auto: data.settings.autoSyncMagpie !== false,
      changed: !!data.settings.lastMagpieHash && fp.hash !== data.settings.lastMagpieHash,
      syncing: magpieSyncing,
      lastAt: data.settings.lastMagpieSyncAt || 0,
      modelCount: fp.modelCount,
    },
  };
});
route('POST', '/api/sync/all', async () => syncAllMagpie('manual'));
route('GET', '/api/logs', async () => logs.slice(-200));
route('POST', '/api/magpie/start', async () => { await startMagpie(); return {}; });
route('POST', '/api/settings', async (m, b) => { updateSettings(b); return {}; });
route('POST', '/api/hosts', async (m, b) => addHost(b));
route('DELETE', '/api/hosts/([^/]+)', async m => { removeHost(m[1]); return {}; });
route('POST', '/api/hosts/([^/]+)/update', async (m, b) => { updateHost(m[1], b); return {}; });
route('POST', '/api/hosts/([^/]+)/start', async m => { startTunnel(getHost(m[1]).alias); return {}; });
route('POST', '/api/hosts/([^/]+)/stop', async m => { stopTunnel(getHost(m[1]).alias); return {}; });
route('POST', '/api/hosts/([^/]+)/restart', async m => { restartTunnel(getHost(m[1]).alias); return {}; });
route('POST', '/api/hosts/([^/]+)/check', async m => checkHost(m[1]));
route('POST', '/api/hosts/([^/]+)/key', async (m, b) => {
  getHost(m[1]);
  if (!b.password) throw httpError(400, 'passwordRequired');
  await setupKeyLogin(m[1], String(b.password));
  const t = await testLogin(m[1]);
  if (!t.ok) throw httpError(500, 'keyStillFails', { error: explainSshError(t.err) || M('connectFailed') });
  return {};
});
route('POST', '/api/hosts/([^/]+)/sync', async m => { await syncOpencode(m[1]); return {}; });
route('POST', '/api/hosts/([^/]+)/native/(apply|restore)', async (m, b) => {
  const tool = String(b.tool || '');
  return m[2] === 'apply' ? nativeApply(m[1], tool, b.force) : nativeRestore(m[1], tool, b.force);
});
route('POST', '/api/hosts/([^/]+)/codex-daemon', async m => { await restartCodexDaemon(m[1]); return {}; });
route('POST', '/api/hosts/([^/]+)/test', async (m, b) => testInference(m[1], b.model));
route('POST', '/api/all/(start|stop)', async m => {
  for (const h of data.hosts) (m[1] === 'start' ? startTunnel : stopTunnel)(h.alias);
  return {};
});
route('POST', '/api/external/(\\d+)/kill', async m => { await killExternal(Number(m[1])); return {}; });
route('POST', '/api/shutdown', async () => { setTimeout(shutdown, 200); return { ok: true }; });
const operationLocks = new Set();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 1e6) { reject(httpError(413, 'bodyTooLarge')); req.destroy(); } });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const b = s ? JSON.parse(s) : {};
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error();
        resolve(b);
      } catch { reject(httpError(400, 'bodyNotJson')); }
    });
  });
}
function send(res, status, obj, type = 'application/json; charset=utf-8') {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const lang = req.headers['x-panel-lang'] === 'en' ? 'en' : req.headers['x-panel-lang'] === 'zh' ? 'zh' : CONSOLE_LANG;
  const fail = (status, key) => send(res, status, { error: I18N.format(lang, key) });
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') return fail(403, 'forbidden');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return fail(403, 'crossSite');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/i18n.js') return send(res, 200, fs.readFileSync(path.join(APP_DIR, 'i18n.js')), 'text/javascript; charset=utf-8');
    if (!url.pathname.startsWith('/api/')) return fail(404, 'notFound');
    if (req.headers['x-panel-token'] !== TOKEN) return fail(401, 'sessionExpired');

    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
    if (!r) return fail(404, 'notFound');
    const m = url.pathname.match(r.re).map((v, i) => (i ? decodeURIComponent(v) : v));
    const body = req.method === 'POST' ? await readBody(req) : {};
    const lock = req.method === 'POST' && url.pathname === '/api/hosts' ? 'add-host' :
      req.method === 'POST' && /\/(sync|key|test|check|codex-daemon|native\/apply|native\/restore)$/.test(url.pathname) ? m[1] : null;
    if (lock && operationLocks.has(lock)) throw httpError(409, 'opBusy');
    if (lock) operationLocks.add(lock);
    try { send(res, 200, (await r.handler(m, body)) || {}); }
    finally { if (lock) operationLocks.delete(lock); }
  } catch (e) {
    send(res, e.status || 500, { error: I18N.render(lang, errMsg(e)) });
  }
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  for (const [, st] of tunnels) { st.wanted = false; clearTimeout(st.timer); if (st.proc) st.proc.kill(); }
  const children = [...tunnels.values()].map(st => st.proc).filter(Boolean);
  const deadline = setTimeout(() => process.exit(0), 3000);
  Promise.all(children.map(child => new Promise(resolve => child.once('close', resolve))))
    .then(() => { clearTimeout(deadline); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

function openBrowser() {
  const url = `http://127.0.0.1:${PANEL_PORT}`;
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
  child.on('error', e => console.error(say('consoleBrowserFailed', { error: e.message })));
}
async function panelCommand(action) {
  try {
    const base = `http://127.0.0.1:${PANEL_PORT}`;
    const html = await (await fetch(base, { signal: AbortSignal.timeout(3000) })).text();
    const token = (html.match(/const TOKEN = '([a-f0-9]+)'/) || [])[1];
    if (!token) throw new Error('port is used by another application');
    const res = await fetch(base + (action === 'stop' ? '/api/shutdown' : '/api/state'), {
      method: action === 'stop' ? 'POST' : 'GET', headers: { 'X-Panel-Token': token }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (action === 'stop') {
      // The shutdown API replies before cleaning up; wait until the port closes so an immediate restart works.
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { await fetch(base, { signal: AbortSignal.timeout(500) }); } catch { break; }
        if (i === 39) throw new Error('shutdown did not finish');
      }
    }
    console.log(action === 'stop' ? 'Panel stopped. Its tunnels are closed.' : JSON.stringify(await res.json(), null, 2));
  } catch (e) { console.error('Panel not reachable: ' + e.message); process.exitCode = 1; }
}
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${PANEL_PORT}`;
    console.log(say('consolePortInUse', { port: PANEL_PORT, url }));
    if (!process.argv.includes('--no-open')) openBrowser();
    process.exit(0);
  }
  throw e;
});
function startPanel() {
  server.listen(PANEL_PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PANEL_PORT}`;
    console.log(say('consoleStarted', { url }));
    console.log(say('consoleHint'));
    log('', 'logPanelStarted');
    for (const h of data.hosts) if (h.autoStart) startTunnel(h.alias);
    setTimeout(pollMagpieConfig, 3000);
    setInterval(pollMagpieConfig, 15000);
    if (!process.argv.includes('--no-open')) openBrowser();
  });
}
if (require.main === module) {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.error(say('consoleNodeOld', { version: process.version }));
    process.exit(1);
  }
  if (process.argv.includes('--stop')) panelCommand('stop');
  else if (process.argv.includes('--status')) panelCommand('status');
  else startPanel();
}
module.exports = { parseSshConfig, validPort, forwardSpec, updateSettings, updateHost, getHost, startTunnel, stopTunnel, restartTunnel, hostView, tstate, data: () => data, server, startPanel, ALIAS_RE, HOSTNAME_RE, ensureAskpass, nativeCall, nativeStatus, nativeApply, nativeRestore, pickModel, I18N };
