# magpie SSH Tunnel Panel

English | [简体中文](README.zh-CN.md)

A small Windows web panel for managing SSH reverse tunnels from a local [magpie](https://github.com/yetone/magpie) gateway to one or more Linux/Unix servers. It uses the native `ssh`, `codex`, and `claude` commands; it does not install or maintain wrapper packages.

## What it does

The panel creates this forwarding path for each server:

```text
remote 127.0.0.1:<remote-port>  <-- SSH reverse tunnel -->  local 127.0.0.1:<local-magpie-port>
```

This lets a CLI running on the remote server use the magpie instance running on your Windows machine. Servers can be started independently or together, and interrupted tunnels reconnect with backoff.

## Requirements

### Windows machine

- Windows 10 or Windows 11.
- Node.js 18 or newer: <https://nodejs.org/>
- The Windows OpenSSH client (`ssh`, `ssh-keygen`, and `scp` are normally included with Windows).
- magpie, running locally or available for the panel to start: <https://github.com/yetone/magpie>

### Remote server

- Linux or another Unix-like SSH server.
- SSH access and a user with a home directory.
- `curl` for the connection check and inference test.
- `python3` for OpenCode synchronization and native Codex/Claude configuration.
- `bash` is recommended for discovering CLI installations and for the optional Codex daemon restart button.

## Download and start

Download the repository as a ZIP from GitHub, extract it, and double-click `start-hidden.vbs` for a completely windowless start, or `start.bat` if you want a console that shows the log. Or clone it with Git:

```powershell
git clone https://github.com/Gokie369/magpie-ssh.git
cd magpie-ssh
wscript start-hidden.vbs
```

The panel listens only on `http://127.0.0.1:3480` and normally opens that address automatically. There are no npm packages to install.

### Start without a console window

`start-hidden.vbs` launches the same backend with no visible cmd/PowerShell window. Its output is written to `panel.log` in the project folder (UTF-8, kept under 1 MB by dropping the oldest lines), so startup errors are still diagnosable. Use **Quit panel** in the web UI or double-click `stop-hidden.vbs` to stop it; Ctrl+C is not available in hidden mode.

`start.bat` / `stop.bat` remain available for troubleshooting and show a console window. A desktop shortcut should point to `wscript.exe "<folder>\start-hidden.vbs"` (or directly to `start-hidden.vbs`) to stay hidden.

The first launch creates `hosts.json` next to the panel. It contains your servers and local settings and is intentionally ignored by Git. Do not copy it into a public issue or commit it to a repository.

## Quick start

1. Start magpie and confirm that its local API is listening on port `3425`, or set the port in **Settings**.
2. Open the panel and choose **Add server**.
3. Enter an SSH alias. An alias already present in `~/.ssh/config` reuses its existing host, user, port, key, proxy, and other SSH options.
4. For a new alias, enter the host address, SSH user, and SSH port. Choose a remote tunnel port, normally `3425`.
5. Use an existing key login, or enter the server password once so the panel can create a dedicated Ed25519 key and append its public key to `authorized_keys`. The password is not saved and the private key is not uploaded.
6. Turn on the server switch. Use **Check** to verify the remote HTTP path and **Test model** to make a small inference request.
7. Optionally enable automatic start for the tunnel and automatic magpie configuration synchronization in Settings.

Different physical servers may use the same remote port. Different users on the same physical server share the same remote port space, so they need different ports. The tunnel binds both ends to loopback; it is not a public reverse proxy.

The first SSH connection uses OpenSSH `StrictHostKeyChecking=accept-new`: a new fingerprint is recorded, but a changed fingerprint is rejected. Verify the server address and fingerprint in security-sensitive environments.

## Native Codex and Claude Code

Each server card has **Connect Codex** and **Connect Claude** buttons. They edit the normal per-user CLI configuration on the server, so you keep running the original commands:

```bash
codex
claude
codex -m <magpie-model-id>
claude --model <magpie-model-id>
```

No `codex-magpie` or `claude-magpie` wrapper is installed.

### Codex

- The panel keeps the existing `model_provider` ID so existing Codex conversations remain in the same provider/history list.
- It redirects that provider to `http://127.0.0.1:<remote-port>/v1`, uses the Responses API, and uses a local placeholder bearer token. Real upstream credentials stay on the Windows magpie instance.
- It writes `~/.codex/magpie-models.json` and registers it through `model_catalog_json`, allowing `/model` to list the live magpie models and their available reasoning levels.
- After a catalog update, newer Codex versions may need **Restart Codex server** on the server card. This runs `codex app-server daemon restart` and can interrupt running Codex tasks. `codex --no-daemon` is an alternative for a one-off check.

### Claude Code

- It updates `~/.claude/settings.json` with the remote magpie URL, model, and authentication token.
- The **bypassPermissions** option is off by default in a fresh installation. Enable it in Settings only for servers and projects you trust; it skips Claude Code permission prompts and is a significant security tradeoff.
- The panel records per-model compaction windows when the local OpenCode metadata provides them.

Both integrations save the original bytes before changing a file. Use **Restore Codex** or **Restore Claude** to restore the original configuration. The panel keeps one rolling `*.magpie-panel.bak` for the current file and does not create an ever-growing series of timestamped backups. If a file was edited after connection, the UI warns before reconnecting or restoring.

## OpenCode and automatic synchronization

Use **Sync OpenCode config** on a server card to merge the local magpie provider into the remote OpenCode configuration. The panel keeps the other providers and settings, updates the remote `baseURL` to that server's tunnel port, and updates the live model list.

The panel watches these local sources:

- `~/.config/magpie/providers.json`
- `~/.config/magpie/settings.json`
- `~/.config/opencode/opencode.json`
- the live magpie `/v1/models` response

When automatic sync is enabled, a change waits briefly and then syncs all configured servers. The remote old file is saved as one rolling `*.magpie-panel.bak`. Only client configuration is synchronized; magpie credentials, login files, quotas, and other local gateway data are not copied to the server.

The Codex catalog is built from the live model IDs and local OpenCode metadata. A model appearing in `/model` does not by itself prove that every upstream model supports Codex tool calls; verify models before relying on them for unattended work.

## Language and controls

The web UI includes a Chinese/English switch in the top-right controls. The choice is stored in browser local storage and is sent to the local API for translated errors and logs.

- **Start all / Stop all** affects only tunnels managed by this panel.
- **Quit panel** closes the panel and its tunnels but does not stop magpie.
- Closing the browser tab does not stop the backend or tunnels.
- Run `stop-hidden.vbs` (no window) or `stop.bat`, use **Quit panel**, or press Ctrl+C for a normal shutdown.
- Re-running `start-hidden.vbs` or `start.bat` while the panel is already running opens the existing panel instead of creating a second one.
- The panel can identify SSH tunnel processes outside its own process tree. It only ends one after explicit confirmation.

## Security notes

- The panel and all tunnel endpoints bind to `127.0.0.1`; do not expose port `3480` through a proxy or port forward.
- API requests require a random token generated for each panel launch and cross-site browser origins are rejected. This protects against accidental browser requests, not against another local Windows user with access to the same machine.
- Passwords are used only during one-time public-key installation and are never written to `hosts.json`.
- The panel does not provide arbitrary remote shell execution. It sends narrowly scoped scripts for checks and configuration updates.
- `bypassPermissions` can allow destructive commands without confirmation. Keep it disabled unless the server and project are trusted.
- The panel refuses changed SSH host keys and invalid JSON/configuration instead of silently overwriting them.

## Troubleshooting

### Remote port is in use

When this happens, the panel first checks whether the listener belongs to an old SSH session owned by the same remote user. If it can verify that safely, it sends a normal `TERM` signal to that old SSH session and reconnects immediately. It never kills a normal service, another user's SSH session, or uses `kill -9`. If ownership cannot be verified, the panel leaves the listener alone, retries with backoff, and you can stop the old tunnel manually or choose another remote port.

### SSH is established but the check fails

Confirm that magpie is running locally, that the local port in Settings matches magpie, and that `curl http://127.0.0.1:<remote-port>/v1/models` works on the remote server.

### `/model` still shows an old Codex list

Click **Restart Codex server** on the connected server card, or run:

```bash
codex app-server daemon restart
```

This may interrupt active Codex work. For a temporary diagnostic, run `codex --no-daemon`.

### A CLI configuration changed after connection

The panel marks it as changed. **Reconnect** backs up the current file and reapplies the magpie settings; **Restore** backs up the current file and writes back the original pre-connection bytes.

### The panel will not start

Check that Node.js is version 18 or newer, that port `3480` is available, and that `hosts.json` is valid JSON. The panel refuses to replace an invalid `hosts.json`.

## Files and development

- `server.js` — local backend, HTTP API, SSH process management, and synchronization.
- `index.html` — browser UI.
- `i18n.js` — shared Chinese/English message tables.
- `native-cli.py` — remote native CLI configuration and byte-preserving backup/restore helper.
- `start.bat` / `stop.bat` — Windows launch and shutdown scripts with a console.
- `start-hidden.vbs` / `stop-hidden.vbs` — windowless launch and shutdown; output goes to `panel.log`.
- `server.test.js` and `native-cli.test.py` — isolated regression tests.

Run the tests from the project directory:

```powershell
node --test server.test.js
python native-cli.test.py
```

The test suite uses temporary homes and does not contact your servers or modify your local Codex/OpenCode configuration.

## License

This project is released under the [MIT License](LICENSE). magpie, Codex, Claude Code, OpenCode, and Node.js remain the property of their respective authors.
