# 桌面客户端的已保存连接与工作区主机状态

[English](2026-10-25-desktop-shell-state.md) | [简体中文](2026-10-25-desktop-shell-state.zh-CN.md)

- 状态：本次改动中已实现
- 相关 issue：[#14947](https://github.com/QwenLM/qwen-code/issues/14947) 第一部分
- 第二部分（记住 daemon 凭据）另作处理，本次未实现

## 目标

让 Web Shell 的已保存 daemon 连接和工作区主机目录在桌面客户端重启后仍然存在，同时不持久化任何凭据。

## 当前行为

桌面外壳会在临时回环端口上启动内置的 `qwen serve`（`serve --port 0 --hostname 127.0.0.1 --require-auth`），并把窗口导航到 `http://127.0.0.1:<port>/#token=<每次启动生成的令牌>`。

WebView2 按 origin 隔离 `localStorage` 与 `sessionStorage`，因此每次启动都是一个全新的存储区。保存在 `localStorage` 中的 `qwen-remote-connections` 与 `qwen-workspace-hosts` 在会话内写入成功，但下一次启动时无法读取。`desktop-state.json` 只持久化了工作区、窗口几何和缩放。

当目录开始持久化后，第二个问题浮现出来：`rememberWorkspaceHost` 会为当前连接的主机调用，其中也包括页面自身的 origin。在桌面客户端中，该 origin 就是临时运行时 origin，因此朴素的持久化实现会在每次启动时追加一个过期主机，并把它们带入 fan-out 集合。

## 决定

通过一层小而带白名单的 Tauri IPC，把两个目录持久化到 `desktop-state.json`。不把桌面页面 origin 变为稳定 origin，也不存储凭据。浏览器 Web Shell 继续使用 `localStorage`，行为不变。

## 设计

### 持久化设置

`DesktopSettings` 增加 `shell_state: BTreeMap<String, String>`（JSON 中为 `shellState`）。每个值就是 Web Shell 原本写入的 JSON 字符串：

- `qwen-remote-connections`：规范化 daemon origin 的数组。
- `qwen-workspace-hosts`：`{ origin, workspaces }` 的数组，每个工作区保留 `id`、`cwd` 和可选的 `displayName`。

`SHELL_STATE_KEYS` 是白名单。`validate_shell_state` 拒绝其他键以及超过 256 KiB 的值。写入复用既有的 `SettingsStore::update` 与 `write_atomic`，因此目录更新会与窗口、缩放写入串行化，不会交错。

### IPC 边界

新增两个命令：`shell_state_read(key)` 和 `shell_state_write(key, value)`。

两者都会调用 `require_runtime_origin`，把调用方 webview 的 URL origin 与本次启动记录的运行时 origin 比较。bootstrap 页面和其他 origin 都会被拒绝。命令在 `build.rs` 中注册，并且只授予 daemon 提供的 `web-shell-external-url` capability；其 `remote.urls` 已经是 `http://127.0.0.1:*`。

`shell_state_read` 对缺失的键返回 `null`。`shell_state_write` 不返回负载。

### Web Shell 适配器

`packages/web-shell/client/config/shell-state.ts` 负责桌面分支：

- `hydrateShellState()` 在首次渲染前运行。它通过 IPC 读取两个键并缓存到内存。与原生值相同的 `localStorage` 副本会被删除；与之不同的副本更新的 —— 在一次启动内 `writeShellState` 每次变更都写镜像，而水合会清空镜像 —— 因此必须回推而不是删除，否则重载会用过期目录复活并销毁唯一一份较新的副本。
- 迁移只取当前 origin 的 `localStorage` 条目。更早的启动写入的是已无法解析的端口，无法恢复。
- `readShellState` 在桌面外壳中优先使用已水合的缓存，在其他环境中退回 `localStorage`。
- `writeShellState` 同时写入 `localStorage`（浏览器路径与会话内回退）和 IPC。IPC 写入是 fire-and-forget：失败时当前会话仍可用，镜像在同源重载下存活，只有在全新 origin 上启动才会丢失该值。
- `remote-connections.ts` 与 `workspace-hosts.ts` 调用该适配器；它们读取侧的校验保持不变。`rememberWorkspaceHost` 新增了仅限桌面外壳的写入路径拒绝，同时会跳过其变更事件派发；详见下方工作区主机目录规则。

### 启动导航

`start_runtime` 在导航前读取两个目录，为每个 daemon 可接受的已保存主机（仅 http/https、不接受方括号 IPv6 字面量、无账号密码、根路径、无 query 与 fragment）追加一个 `fanout=<origin>`，跳过页面 origin，并把列表上限设为三十二个。daemon 只根据请求 URL 生成 `connect-src`，因此缺少这些参数时，已保存主机在整个首次文档期间都会被拦截；而水合必然发生在该文档下发之后。这个上限让 URL 远低于 daemon 的请求头上限——超过上限的文档会被直接拒绝，外壳根本无法加载；超出上限的主机走原先的重载路径。

### 工作区主机目录规则

`rememberWorkspaceHost` **只在桌面外壳中**不持久化页面自身的 origin。那里的 origin 是临时运行时 origin，持久化会在每次启动时追加一个过期主机。浏览器仍会保存它：当页面 daemon 不可达时，该条目是本地分组的离线快照。`useOtherOrigins` 只保证分组本身留在会话内，而每个分组的项目列表来自该已保存条目。

## 安全与信任边界

- 持久化的值是地址和工作区标识，绝不是令牌或其他秘密。
- 白名单与 256 KiB 上限使该接口不会变成通用的文件存储。
- 运行时 origin 检查把 bootstrap 页面和其他 origin 挡在外面；capability 只作用于 daemon 提供的页面。
- Web Shell 内的恶意脚本可以修改目录，例如把已保存连接指向攻击者主机，但无法从该存储读取凭据，因为其中不保存凭据。凭据持久化属于第二部分，需要单独决策。
- `desktop-state.json` 仍是明文；现在其中不含秘密。

## 失败模式

- `QWEN_DESKTOP_DISABLE_SETTINGS_PERSISTENCE=1` 会让 `update()` 变成空操作，因此回推会报告成功但不会落盘。水合随后会消费并删除镜像：第一次同源重载仍能读到目录，若期间没有新的写入，第二次重载就会丢失，重启同样会丢失。
- 水合失败时该键不进入缓存，读取退回当前 origin 的 `localStorage`。
- 原生写入失败时，内存副本和 `localStorage` 镜像仍然存在；下一次同源水合会回推镜像，只有在全新 origin 上启动才会丢失该变更。
- 畸形的目录 JSON 会被既有目录读取器过滤。损坏的设置文件仍像以前一样回退到默认值。

## 验收标准

1. 已保存连接及其工作区主机条目在桌面客户端重启后仍然存在，包括页面 origin 变为新端口。
2. 重启后 Settings → Connections 会列出已保存主机，删除后该条目从 `desktop-state.json` 中消失。
3. 反复重启不会向 `qwen-workspace-hosts` 添加每次启动对应的 `127.0.0.1:<port>` 条目。
4. 浏览器 Web Shell 保持既有的 `localStorage` 行为。
5. 未知键、超过上限的值，以及来自 bootstrap 或其他 origin 的调用都会被拒绝。
6. `desktop-state.json` 中不出现令牌或其他秘密。

## 验证

- `packages/desktop/src-tauri` 中的 `cargo test`：该 crate 的单元测试，其中包括一个设置重载测试：写入目录、丢弃存储、重新加载并读回该值，以及白名单和大小上限测试。实际运行的用例数按平台不同，因为部分用例带有 `windows`/`unix` 门控。
- `cargo clippy --all-targets -- -D warnings`：干净。
- `npm run typecheck --workspace=@qwen-code/web-shell`：干净。
- 对改动文件运行 ESLint 与 Prettier：干净。
- `vitest run client/config client/components/workspaces client/main-boot.test.tsx --no-file-parallelism`：覆盖桌面水合、镜像回推、迁移、写穿、水合先于首渲的启动顺序、仅限桌面外壳的页面 origin 规则、目录已命名主机跳过确认门，以及浏览器的离线快照。
- `node packages/desktop/scripts/test-release.js`：通过，其中包括两项钉住：capability 授予两个 shell-state 命令，以及每个命令体在触达存储前先调用 `require_runtime_origin`。
- 在 Windows 上使用隔离的应用 identifier 进行手动实跑：通过 IPC 写入目录，重启进程，确认页面 origin 已变化，读回目录，打开 Settings → Connections 并看到已保存主机。同一次实跑先复现了每次启动累积工作区主机的问题，随后验证了修复。

## 限制与后续

- 凭据不被持久化。在第二部分落地前，已保存连接在每个新会话中仍需要其 bearer 令牌。
- 目录不在多个桌面实例之间同步；外壳是单实例的。
- 迁移只覆盖当前 origin。本次改动之前启动写入的目录无法恢复。
- 重启检查是手动的；目前还没有自动化的桌面端到端测试。
- 第二部分的「记住令牌」应基于 daemon 签发的设备凭据，而不是 `QWEN_SERVER_TOKEN`。

## 参考

- [#14947](https://github.com/QwenLM/qwen-code/issues/14947)
- [Desktop Web Shell release](./2026-07-31-desktop-web-shell-release.md)
