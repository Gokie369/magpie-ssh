# magpie SSH 隧道面板

[English](README.md) | 简体中文

这是一个运行在 Windows 上的 SSH 反向隧道管理面板，用来把本机运行的 [magpie](https://github.com/yetone/magpie) 网关连接到一台或多台 Linux/Unix 服务器。面板使用系统自带的 `ssh`、原生 `codex` 和原生 `claude` 命令，不安装或维护任何 CLI 包装器。

## 功能原理

每台服务器建立如下转发：

```text
远程 127.0.0.1:<远程端口>  <-- SSH 反向隧道 -->  本机 127.0.0.1:<本机 magpie 端口>
```

这样，服务器上的 CLI 就能使用 Windows 本机的 magpie。每台服务器可以单独开启，也可以全部开启；隧道断开后会自动退避重连。

## 环境要求

### Windows 本机

- Windows 10 或 Windows 11。
- Node.js 18 或更新版本：<https://nodejs.org/>。
- Windows OpenSSH 客户端（Windows 通常自带 `ssh`、`ssh-keygen` 和 `scp`）。
- 本机已经运行 magpie，或者允许面板启动 magpie：<https://github.com/yetone/magpie>。

### 远程服务器

- Linux 或其他 Unix-like SSH 服务器。
- 可用的 SSH 登录和用户主目录。
- `curl`，用于连接检查和推理测试。
- `python3`，用于 OpenCode 同步和原生 Codex/Claude 配置。
- 建议安装 `bash`，用于发现 CLI 路径和执行可选的 Codex 后台重启。

## 下载和启动

在 GitHub 页面通过 **Code → Download ZIP** 下载并解压，然后双击 `start-hidden.vbs`，完全不会出现窗口；如果想看到控制台日志，则双击 `start.bat`。也可以使用 Git：

```powershell
git clone https://github.com/Gokie369/magpie-ssh.git
cd magpie-ssh
wscript start-hidden.vbs
```

面板默认只监听 `http://127.0.0.1:3480`，通常会自动打开浏览器。项目没有需要执行 `npm install` 的依赖。

### 无窗口启动

`start-hidden.vbs` 用完全相同的方式启动后台，但不会出现 cmd/PowerShell 窗口。输出写入项目目录的 `panel.log`（UTF-8，超过 1 MB 时自动丢弃最旧的行，文件始终不超过 1 MB），因此启动错误仍然可以排查。停止时用网页里的“退出面板”，或双击 `stop-hidden.vbs`；无窗口模式下没有 Ctrl+C 可用。

`start.bat` / `stop.bat` 仍保留，用于需要查看控制台时排障。桌面快捷方式应指向 `wscript.exe "<目录>\start-hidden.vbs"`（或直接指向 `start-hidden.vbs`），才能保持无窗口。

第一次启动会在面板目录创建 `hosts.json`。它保存你的服务器和本机设置，已经被 Git 忽略。不要把它提交到公开仓库，也不要在 issue 中粘贴它的内容。

## 快速开始

1. 启动 magpie，确认本机 API 监听 `3425` 端口；也可以在“设置”里改端口。
2. 打开面板，选择“添加服务器”。
3. 输入 SSH 别名。如果该别名已经存在于 `~/.ssh/config`，面板会复用原有的主机、用户、端口、密钥、跳板机及其他 SSH 设置。
4. 新别名需要填写主机地址、SSH 用户和 SSH 端口。远程隧道端口通常填写 `3425`。
5. 如果已经可以免密登录，不需要填写密码；否则可填写一次服务器密码，面板会生成专用 Ed25519 密钥并把公钥追加到远程 `authorized_keys`。密码不会保存，私钥不会上传。
6. 打开服务器卡片上的开关。用“检查”验证远程 HTTP 通路，用“推理测试”验证模型确实能返回文本。
7. 可以开启“面板启动时自动开启隧道”和“自动同步 magpie 配置”。

不同物理服务器可以使用相同远程端口。同一台物理服务器上的不同用户共享端口空间，需要使用不同端口。隧道两端都绑定回环地址，不是公开反向代理。

首次 SSH 连接使用 OpenSSH `StrictHostKeyChecking=accept-new`：新指纹会自动记录，但已记录的指纹发生变化时会拒绝连接。安全要求较高时，请提前人工核对服务器指纹。

## 原生接入 Codex 和 Claude Code

每张服务器卡片都有“原生接入 Codex”和“原生接入 Claude”按钮。它们修改服务器上当前用户的正常 CLI 配置，之后仍然直接运行原命令：

```bash
codex
claude
codex -m <magpie-model-id>
claude --model <magpie-model-id>
```

不会安装 `codex-magpie` 或 `claude-magpie` 包装器。

### Codex

- 保留原来的 `model_provider` ID，因此已有 Codex 会话仍属于原来的 provider/history 列表。
- 把该 provider 指向 `http://127.0.0.1:<远程端口>/v1`，使用 Responses API 和本地占位 bearer token。真实上游凭据仍保留在 Windows 本机的 magpie 中。
- 写入 `~/.codex/magpie-models.json`，通过 `model_catalog_json` 注册实时 magpie 模型和可用的思考程度，之后可以在 `/model` 中选择。
- 模型目录更新后，较新的 Codex 版本可能需要点击服务器卡片上的“重启 Codex 后台”。它会执行 `codex app-server daemon restart`，可能中断正在运行的 Codex 任务。也可以临时使用 `codex --no-daemon` 检查最新配置。

### Claude Code

- 修改 `~/.claude/settings.json`，写入远程 magpie 地址、模型和认证 token。
- 新安装默认关闭 `bypassPermissions`。只有在确认服务器和项目可信时，才在“设置”里开启；它会跳过 Claude Code 的权限确认，安全风险较高。
- 如果本机 OpenCode 元数据提供了模型窗口，面板会写入每个模型对应的压缩窗口设置。

两种接入都会先按字节保存原始文件。点击“恢复 Codex”或“恢复 Claude”即可还原接入前的配置。面板只保留当前文件的一份滚动 `*.magpie-panel.bak`，不会不断生成带时间戳的备份。如果文件在接入后被手动修改，重新接入或恢复前会显示警告。

## OpenCode 和自动同步

在服务器卡片上点击“同步 OpenCode 配置”，会把本机 magpie provider 合并到远程 OpenCode 配置中。其他 provider 和设置会保留，远程 `baseURL` 会按该服务器的隧道端口更新，模型列表也会同步。

面板会监视本机以下内容：

- `~/.config/magpie/providers.json`
- `~/.config/magpie/settings.json`
- `~/.config/opencode/opencode.json`
- magpie 实际返回的 `/v1/models` 列表

开启自动同步后，检测到变化会等待片刻，再同步到所有已配置服务器。远程旧文件会保存为一份滚动 `*.magpie-panel.bak`。同步的只是客户端配置，不会把 magpie 的凭据、登录文件、额度等本机网关数据复制到服务器。

Codex 模型目录由实时模型 ID 和本机 OpenCode 元数据生成。模型出现在 `/model` 中，并不代表它已经验证支持 Codex 工具调用；重要任务前请先单独测试。

## 语言和常用控制

网页右上角提供中英文切换。选择会保存到浏览器 local storage，并通过请求头发送给本地 API，用于翻译错误和日志。

- “全部开启 / 全部关闭”只影响本面板管理的隧道。
- “退出面板”会关闭面板及其隧道，但不会关闭 magpie。
- 关闭浏览器标签页不会停止后台或隧道。
- 可用“退出面板”、`stop-hidden.vbs`（无窗口）或 `stop.bat` 正常关闭；控制台模式下也可以 Ctrl+C。
- 面板已运行时再次双击 `start-hidden.vbs` 或 `start.bat`，会打开现有面板，不会启动第二个面板。
- 面板可以发现不属于自己的 SSH 隧道进程；只有确认后才会结束指定的一条进程。

## 安全说明

- 面板和隧道端点都绑定 `127.0.0.1`；不要把 `3480` 端口通过代理或端口转发暴露到外网。
- 每次启动生成随机 API token，并拒绝跨站浏览器请求。它用于防止误操作，不是本机不同 Windows 用户之间的权限隔离。
- 密码只在一次安装公钥时使用，不会写入 `hosts.json`。
- 面板不提供任意远程终端执行入口，只发送范围明确的检查和配置脚本。
- `bypassPermissions` 可能让危险命令无需确认。除非服务器和项目完全可信，否则请保持关闭。
- SSH 主机指纹变化和无效 JSON/配置会被拒绝，不会静默覆盖。

## 排障

### 远程端口被占用

发生端口冲突时，面板会先检查监听者是否属于当前远程用户的旧 SSH 会话。如果能够安全确认，就向旧 SSH 会话发送普通 `TERM` 信号，然后立即重连。面板不会结束普通服务、其他用户的 SSH 会话，也不会使用 `kill -9`。如果无法确认归属，面板会保留监听者并退避重试；此时可以手动结束旧隧道或换一个远程端口。

### 显示 SSH 已建立，但检查失败

确认本机 magpie 正在运行，设置里的本机端口与 magpie 一致，并在远程服务器运行：

```bash
curl http://127.0.0.1:<远程端口>/v1/models
```

### `/model` 仍然是旧的 Codex 列表

点击服务器卡片上的“重启 Codex 后台”，或在服务器运行：

```bash
codex app-server daemon restart
```

这可能中断正在执行的 Codex 任务。临时排查时可运行 `codex --no-daemon`。

### CLI 配置在接入后被修改

面板会标记配置已变化。“重新接入”会先备份当前文件，再保留其他设置并重新写入 magpie 配置；“恢复”会先备份当前文件，再写回接入前的原始字节。

### 面板无法启动

确认 Node.js 是 18 或更新版本，`3480` 端口没有被其他程序占用，并检查 `hosts.json` 是否为合法 JSON。无效的 `hosts.json` 会导致面板拒绝启动，不会清空服务器列表。

## 文件和开发

- `server.js`：本地后台、HTTP API、SSH 进程管理和同步。
- `index.html`：网页界面。
- `i18n.js`：中英文消息表。
- `native-cli.py`：远程原生 CLI 配置及按字节备份/恢复助手。
- `start.bat` / `stop.bat`：带控制台的 Windows 启动和关闭脚本。
- `start-hidden.vbs` / `stop-hidden.vbs`：无窗口启动和关闭；输出写入 `panel.log`。
- `server.test.js`、`native-cli.test.py`：隔离回归测试。

在项目目录运行测试：

```powershell
node --test server.test.js
python native-cli.test.py
```

测试使用临时 home，不会连接你的服务器，也不会修改本机 Codex/OpenCode 配置。

## 许可证

本项目采用 [MIT License](LICENSE)。magpie、Codex、Claude Code、OpenCode 和 Node.js 归各自作者所有。
