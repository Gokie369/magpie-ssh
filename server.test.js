'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cp = require('node:child_process');

// 完全隔离配置和 SSH 子进程，不接触用户服务器、密钥和配置。
const parent = path.join(process.env.LOCALAPPDATA || os.tmpdir(), process.env.LOCALAPPDATA ? 'Temp/opencode' : 'opencode');
fs.mkdirSync(parent, { recursive: true });
const dir = fs.mkdtempSync(path.join(parent, 'magpie-panel-test-'));
const home = path.join(dir, 'home');
fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(home, '.ssh/config'), 'Host imported-host\n HostName 192.0.2.1\n User tester\n');
fs.writeFileSync(path.join(dir, 'server.js'), fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace('const HOME = os.homedir();', 'const HOME = ' + JSON.stringify(home) + ';'));
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(dir, 'index.html'));
fs.copyFileSync(path.join(__dirname, 'i18n.js'), path.join(dir, 'i18n.js'));
fs.writeFileSync(path.join(dir, 'hosts.json'), JSON.stringify({ settings: { localPort: 3425 }, hosts: [{ alias: 'test-host', remotePort: 3425, autoStart: false }] }));
const originalSpawn = cp.spawn;
const children = [];
cp.spawn = (cmd, args) => {
  assert.equal(cmd, 'ssh');
  const p = new EventEmitter();
  p.pid = 100000 + children.length;
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
  p.args = args;
  p.kill = () => { p.killed = true; process.nextTick(() => p.emit('close', 0)); return true; };
  children.push(p);
  if (args.at(-1) === 'echo MAGPIE_LOGIN_OK') process.nextTick(() => { p.stdout.end('MAGPIE_LOGIN_OK\n'); p.emit('close', 0); });
  return p;
};
const app = require(path.join(dir, 'server.js'));
const tick = () => new Promise(resolve => setImmediate(resolve));

after(() => {
  app.server.close();
  app.stopTunnel('test-host');
  cp.spawn = originalSpawn;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('both languages define the same message keys and the page uses only known keys', () => {
  const { MESSAGES } = app.I18N;
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const used = new Set([...html.matchAll(/data-i18n(?:-ph|-html)?="(\w+)"/g), ...html.matchAll(/\bt\('(\w+)'/g)].map(m => m[1]));
  for (const key of used) assert.ok(key in MESSAGES.en, 'missing message ' + key);
  for (const key of ['stStopped', 'stStopping', 'stStarting', 'stRunning', 'stRetrying', 'stError']) assert.ok(key in MESSAGES.en);
  const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  for (const m of server.matchAll(/(?:httpError\(\d+, |M\(|log\([^,]+, )'(\w+)'/g)) assert.ok(m[1] in MESSAGES.en, 'missing message ' + m[1]);
  assert.equal(app.I18N.format('en', 'logTunnelDropped', { error: { key: 'sshTimeout' }, delay: 3 }), 'Tunnel dropped: Connection timed out: server unreachable; reconnecting in 3s');
});

test('empty model settings pick a fitting live model', () => {
  const models = ['auto/kimi-k3', 'codex/gpt-6.1-sol', 'auto/claude-opus-5-5', 'x/gemini-flash'];
  assert.equal(app.pickModel('codex', models), 'codex/gpt-6.1-sol');
  assert.equal(app.pickModel('claude', models), 'auto/claude-opus-5-5');
  assert.equal(app.pickModel('test', models), 'x/gemini-flash');
  assert.equal(app.pickModel('claude', ['auto/kimi-k3']), 'auto/kimi-k3');
  assert.throws(() => app.pickModel('codex', []));
});

test('hidden log stays under its cap and keeps the newest entries', () => {
  const file = path.join(dir, 'capped.log');
  const max = 4096;
  for (let i = 0; i < 100; i++) app.appendCapped(file, `line ${String(i).padStart(3, '0')} ${'x'.repeat(80)}\n`, max);
  assert.ok(fs.statSync(file).size <= max);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /line 099/);
  assert.doesNotMatch(text, /line 000/);
  assert.ok(text.endsWith('\n'));
  const utf8 = path.join(dir, 'capped-utf8.log');
  app.appendCapped(utf8, '中'.repeat(10), 7);
  assert.ok(fs.statSync(utf8).size <= 7);
});

test('ports reject fractions, invalid ranges and command strings', () => {
  for (const p of [0, 22, 1023, 65536, 3425.2, '3425;echo']) assert.equal(app.validPort(p), null);
  assert.equal(app.validPort('3425'), 3425);
});

test('aliases and addresses cannot inject SSH options or config lines', () => {
  for (const a of ['-oProxyCommand=bad', '../oops', 'a\nHost *', 'a;bad', '']) assert.equal(app.ALIAS_RE.test(a), false);
  for (const h of ['-oBad', 'a\nUser root', 'foo bar']) assert.equal(app.HOSTNAME_RE.test(h), false);
  assert.equal(app.ALIAS_RE.test('server-new_2'), true);
});

test('SSH parser lists literal aliases and preserves shared Host fields', () => {
  const parsed = app.parseSshConfig('Host a b\r\n HostName 10.0.0.1\r\n User ubuntu\r\n Port 2222\r\nHost *\r\n ServerAliveInterval 30\r\nMatch all\r\n User ignored\r\nHost c\r\n HostName example.org');
  assert.deepEqual(parsed.map(e => e.alias), ['a', 'b', 'c']);
  assert.equal(parsed[1].hostname, '10.0.0.1');
  assert.equal(parsed[0].port, '2222');
});

test('settings validation is atomic and leaves file unchanged on failure', () => {
  const before = fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8');
  assert.throws(() => app.updateSettings({ localPort: 5000, codexModel: 'bad;model' }));
  assert.equal(app.data().settings.localPort, 3425);
  assert.equal(fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8'), before);
});

test('host validation is atomic and does not partially change autoStart', () => {
  assert.throws(() => app.updateHost('test-host', { autoStart: true, remotePort: 0 }));
  assert.equal(app.getHost('test-host').autoStart, false);
});

test('reverse forwarding explicitly binds remote loopback', () => {
  assert.equal(app.forwardSpec(app.getHost('test-host')), '127.0.0.1:3425:127.0.0.1:3425');
});

test('running state requires SSH forwarding confirmation and stop cancels retry', async () => {
  app.startTunnel('test-host');
  assert.equal(app.tstate('test-host').status, 'starting');
  const p = children.at(-1);
  p.stderr.write('debug1: remote forward success for: listen 127.0.0.1:3425, connect 127.0.0.1:3425\n');
  assert.equal(app.tstate('test-host').status, 'running');
  app.stopTunnel('test-host');
  await tick();
  assert.equal(app.tstate('test-host').status, 'stopped');
  assert.equal(app.tstate('test-host').wanted, false);
  assert.equal(app.tstate('test-host').lastError, null);
});

test('rapid stop/start does not strand wanted tunnel in stopped state', async () => {
  app.startTunnel('test-host');
  const count = children.length;
  app.stopTunnel('test-host');
  app.startTunnel('test-host');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(children.length, count + 1);
  assert.equal(app.tstate('test-host').wanted, true);
  assert.equal(app.tstate('test-host').status, 'starting');
  app.stopTunnel('test-host'); await tick();
});

test('local port change rebuilds active tunnel to new destination', async () => {
  app.startTunnel('test-host');
  app.updateSettings({ localPort: 3500 });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.ok(children.at(-1).args.includes('127.0.0.1:3425:127.0.0.1:3500'));
  app.stopTunnel('test-host'); await tick();
});

test('remote port change rebuilds active tunnel and clears stale check', async () => {
  app.getHost('test-host').lastCheck = { gateway: true };
  app.startTunnel('test-host');
  app.updateHost('test-host', { remotePort: 3501 });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.ok(children.at(-1).args.includes('127.0.0.1:3501:127.0.0.1:3500'));
  assert.equal(app.getHost('test-host').lastCheck, null);
  app.stopTunnel('test-host'); await tick();
});

test('SSH failure schedules retry, and explicit stop cancels it', async () => {
  app.startTunnel('test-host');
  children.at(-1).stderr.write('Warning: remote port forwarding failed for listen port 3501\n');
  children.at(-1).emit('close', 255);
  assert.equal(app.tstate('test-host').status, 'retrying');
  assert.equal(app.tstate('test-host').lastError.key, 'sshPortInUse');
  assert.match(app.I18N.render('en', app.tstate('test-host').lastError), /Remote port is in use/);
  assert.match(app.I18N.render('zh', app.tstate('test-host').lastError), /端口被占用/);
  app.stopTunnel('test-host'); await tick();
  assert.equal(app.tstate('test-host').wanted, false);
  assert.equal(app.tstate('test-host').status, 'stopped');
});

test('HTTP API rejects missing token, foreign origin, invalid JSON and SSH option injection', async () => {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const page = await fetch(base);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  const token = html.match(/const TOKEN = '([a-f0-9]+)'/)[1];
  assert.equal((await fetch(base + '/i18n.js')).status, 200);
  assert.equal((await fetch(base + '/api/logs')).status, 401);
  const zh = await fetch(base + '/api/hosts/nope/check', { method: 'POST', headers: { 'X-Panel-Token': token, 'X-Panel-Lang': 'zh', 'Content-Type': 'application/json' }, body: '{}' });
  assert.match((await zh.json()).error, /面板里没有/);
  const en = await fetch(base + '/api/hosts/nope/check', { method: 'POST', headers: { 'X-Panel-Token': token, 'X-Panel-Lang': 'en', 'Content-Type': 'application/json' }, body: '{}' });
  assert.match((await en.json()).error, /not in the panel/);
  const headers = { 'X-Panel-Token': token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/logs', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  for (const body of ['null', '[]', '{invalid']) {
    assert.equal((await fetch(base + '/api/hosts', { method: 'POST', headers, body })).status, 400);
  }
  for (const alias of ['-oProxyCommand=bad', 'x\nHost *', 'test-host']) {
    assert.equal((await fetch(base + '/api/hosts', { method: 'POST', headers, body: JSON.stringify({ alias }) })).status, 400);
  }
  assert.equal((await fetch(base + '/api/logs', { headers })).status, 200);
  const sshBefore = fs.readFileSync(path.join(home, '.ssh/config'), 'utf8');
  const added = await fetch(base + '/api/hosts', { method: 'POST', headers, body: JSON.stringify({ alias: 'imported-host', remotePort: 3426 }) });
  assert.equal(added.status, 200);
  assert.equal((await added.json()).login, true);
  assert.equal(app.getHost('imported-host').remotePort, 3426);
  assert.equal((await fetch(base + '/api/hosts/imported-host', { method: 'DELETE', headers })).status, 200);
  assert.throws(() => app.getHost('imported-host'));
  assert.equal(fs.readFileSync(path.join(home, '.ssh/config'), 'utf8'), sshBefore);
  const newHost = await fetch(base + '/api/hosts', { method: 'POST', headers, body: JSON.stringify({ alias: 'new-host', hostname: '192.0.2.2', user: 'ubuntu', port: 2222 }) });
  assert.equal(newHost.status, 200);
  const sshAfter = fs.readFileSync(path.join(home, '.ssh/config'), 'utf8');
  assert.ok(sshAfter.startsWith(sshBefore));
  assert.match(sshAfter, /Host new-host\n  HostName 192.0.2.2\n  User ubuntu\n  Port 2222/);
  assert.equal(fs.readFileSync(path.join(home, '.ssh/config.magpie-panel.bak'), 'utf8'), sshBefore);
  await fetch(base + '/api/hosts/new-host', { method: 'DELETE', headers });
  assert.equal(fs.readFileSync(path.join(home, '.ssh/config'), 'utf8'), sshAfter);
});
