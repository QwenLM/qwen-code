# Qwen Live Host

Qwen Live Host 是 WebShell Live Voice 在 macOS 上的必需组件。它只承载小浮层、
Electron 全局快捷键、麦克风输入、扬声器输出和内置原生 Appshot。Host 不打开
WebShell 或 Session 窗口；具体对话和任务仍在现有 WebShell 中跟进。没有浏览器
麦克风或浏览器快捷键降级方案。

## 用户要求

- macOS 12 或更高版本。
- 本机运行的 Qwen Code WebShell。
- 可调用 `qwen3.5-omni-plus-realtime` 的 DashScope API key。

Live Voice 仅在 macOS WebShell 中提供，默认关闭。普通 CLI/TUI、`--no-web`
daemon 和其他操作系统不会显示入口。

## 首次启用

1. 在 WebShell 打开 **设置 → 实验性功能 → Qwen Live**。
2. 输入专用于 Realtime 模型的 DashScope API key；快捷键默认是
   `Command+E`，可在同一处修改。
3. 打开开关并确认安装。WebShell 优先从阿里云 OSS 镜像下载当前架构的签名 Host；
   镜像不可用时回退到独立的 GitHub `live-host-latest` feed。下载后校验 manifest、
   SHA-256、bundle identity、Developer ID 签名和 Gatekeeper，然后原子安装到
   `/Applications/Qwen Live Host.app` 并启动。
4. 按 Host 引导完成麦克风、辅助功能和屏幕录制授权。授权只能由用户在 macOS
   完成；全部 readiness 通过前 Live 不可使用。

API key 只写入用户级设置。WebShell 只能看到“已配置”状态，不会读取或回显 key。
关闭 Live 会停止当前通话、撤下快捷键和 Host discovery，但不会卸载 Host 或删除
Live 对话。

## 开发构建

开发者需要 Node.js 22 和 Bun。在仓库的 `packages/desktop` 目录执行：

```bash
bun install
bun run live-host:build
bun run live-host:typecheck
bun run live-host:test
bun run live-host:dist:mac
```

构建产物位于 `apps/live-host/dist/`，打包产物位于
`apps/live-host/release/`。正式用户不需要手工下载 DMG；WebShell 的实验性设置
负责安装和启动。

## 发布

Live Host 使用独立的 **Qwen Live Host Release** workflow、版本号和发布节奏，
不参与也不阻塞 Qwen Code Desktop Release。PR 会自动执行一次未签名 dry run，
检查 arm64/x64 的 DMG、ZIP 和 manifest；正式发布只能从 `main` 手工触发，并执行
Developer ID 签名、notarization、Gatekeeper 和 stapler 验证。

版本发布使用 `live-host-vX.Y.Z` tag，包含两个 DMG、两个 ZIP、
`Qwen-Live-Host-manifest.json` 和 `SHA256SUMS.txt`。非 draft、非 prerelease 的
正式版本还会更新固定的 GitHub `live-host-latest` feed，并在发布成功后调用一次
独立的 OSS 镜像 workflow。镜像保存版本化 ZIP 和 manifest，再发布一个 latest
manifest；需要重传时可手工运行同一镜像 workflow。WebShell 自动安装优先读取 OSS，
失败时使用 GitHub feed。

构建会把仓库内的 Objective-C++ Appshot 源码编译成一个 universal N-API 模块，
并随 Host 一起签名。模块在 Host 主进程内调用 macOS 截屏与 AX API；没有额外 Appshot
App、Appshot Helper、MCP、CLI、插件、守护进程或运行时下载。正式产物必须通过
Developer ID 签名、notarization/staple、`codesign`、Gatekeeper 和 stapler 校验。

Host 不会自行创建或强制启用 Login Item。需要开机启动时由用户在“系统设置 → 通用 →
登录项”中显式添加。

Live 启用后，daemon 会在 `~/.qwen/live/daemon.json` 发布权限为 `0600` 的稳定
locator。Host 只连接 loopback 地址并校验协议版本和 daemon nonce。record 可能包含
bearer token，不要打印、复制或共享其内容。

Live 被禁用、discovery 不存在或 daemon 断开时，Host 的全局快捷键、音频和 Appshot
readiness 保持 dormant。只有 v6 daemon 完成 welcome 后这些服务才启动；断开时会立即
清理音频 context 并解注册快捷键。

活跃 Live Session 的屏幕上下文只走 Session-local 的内置
`capture_screen_context` 通道。它不会修改、隐藏或跳过普通 Qwen 工具及用户配置的
MCP；Appshot 本身不依赖这些能力。

## 快捷键

快捷键由 daemon 通过每个 `LiveStatus.shortcut` 下发，默认是 `Command+E`。Host 使用
Electron `globalShortcut` 注册普通 accelerator，不请求 Input Monitoring 权限，也没有
裸修饰键 helper。WebShell 设置通过 daemon 请求 Host 先注册新 accelerator，成功后才
解注册旧值并持久化；冲突或非法值会保留旧快捷键并返回设置错误。退出或断开 daemon
也会解注册当前 accelerator。

浮层和菜单栏中的“新对话”会显式创建新的无项目对话；开始、停止当前通话是独立动作。

## 内置 Appshot 和三项授权

| 权限     | 授权主体       | 用途                            |
| -------- | -------------- | ------------------------------- |
| 麦克风   | Qwen Live Host | 采集 Live 对话音频              |
| 辅助功能 | Qwen Live Host | 读取前台窗口的可访问性树        |
| 屏幕录制 | Qwen Live Host | 为显式 Appshot 请求采集窗口图像 |

Appshot 是 Host 的内部核心能力。内置原生模块选择最前面的非 Host 普通窗口，通过
macOS 原生 API 返回应用信息、窗口标题、AX 文本和 PNG。模型只能调用一次无参数、只读的
`capture_screen_context`；不能通过这条通道指定窗口、坐标或动作。

Host 激活时只读取一次权限状态，用户显式点击授权或 Host 再次激活时才重新检查，不做
后台轮询。每次真实 Appshot 都在 Host 进程内重新验证两项权限。授权丢失会令捕获失败并
使 Live fail closed。整个流程不启动或探测任何外置屏幕工具。

## 音频和 fail-closed

`devicechange`、输入 track ended/mute、播放失败或音频帧无法交给 daemon 时，Host 会先
将 input/output 标记为 unavailable、停止当前通话并清理旧 context，再重新执行自检。
麦克风重新授权后只有实际输入自检通过才会恢复 ready。overlay renderer、preload 加载、
页面加载失败或 renderer 无响应也会执行 fail-closed。

任一权限、自检、快捷键或 provider 配置失败时，Live 都保持不可用。Host readiness
不会连接 Realtime；只有用户开始对话时才建立 provider WebSocket。限流或配额错误不做
自动重试或后台探测，用户稍后可手工重试。

## 卸载

1. 从菜单栏选择“退出 Qwen Live Host”。
2. 如果用户曾手工添加 Login Item，在系统设置中将其移除。
3. 从 `/Applications` 删除 **Qwen Live Host.app**。
4. 在 WebShell 的 **设置 → 实验性功能 → Qwen Live** 中关闭功能。
5. 如不再需要，可在“隐私与安全性”中撤销 Host 的麦克风、辅助功能和屏幕录制权限。
