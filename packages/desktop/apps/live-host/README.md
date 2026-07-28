# Qwen Live Host

Qwen Live Host 是 WebShell Live Voice 在 macOS 上的必需组件。它只承载小浮层、
Electron 全局快捷键、麦克风输入、扬声器输出和本机权限状态。Host 不打开 WebShell
或 session 窗口；具体对话和任务仍在现有 WebShell 中跟进。没有浏览器麦克风或浏览器
快捷键降级方案。

## 要求

- macOS 12 或更高版本；Apple Silicon 和 Intel 分别打包。
- Node.js 22 和 Bun。
- 已安装 Qwen Code 固定版本的 CuaDriver。Host 不内置另一份 driver。
- WebShell daemon 正在本机运行，并使用 Live Host 协议 v3。

## 构建、打包和安装

在仓库的 `packages/desktop` 目录执行：

```bash
bun install
bun run live-host:build
bun run live-host:typecheck
bun run live-host:test
bun run live-host:dist:mac
```

构建产物位于 `apps/live-host/dist/`，打包产物位于
`apps/live-host/release/`。打开与当前 Mac 架构匹配的 DMG，将
**Qwen Live Host.app** 拖入 `/Applications`，再从 Applications 启动。

Host 变更会由独立的 macOS CI 执行类型检查、测试、构建和 unsigned package smoke。
正式产物跟随 `Desktop Release` 工作流统一版本化和发布；非 dry-run 发布必须使用
Developer ID 签名、完成 notarization/staple，并通过 `codesign`、Gatekeeper 和 stapler
校验。Host 没有额外原生 helper；Electron app 及其标准子进程按 electron-builder 的
hardened-runtime 配置签名。

Host 不会自行创建或强制启用 Login Item。需要开机启动时由用户在“系统设置 → 通用 →
登录项”中显式添加。

## Live Voice 配置

建议将 Live Voice 配置放在用户级 `~/.qwen/settings.json`，让无项目对话也能使用。
Realtime credential 继续复用现有 provider 条目；不要把 API key 放入 endpoint、命令行、
截图或问题报告。

Live 启用后，daemon 会在 `~/.qwen/live/daemon.json` 发布权限为 `0600` 的稳定
locator。Host 只连接 loopback 地址并校验协议版本和 daemon nonce。record 可能包含
bearer token，不要打印、复制或共享其内容。

Live 被禁用、discovery 不存在或 daemon 断开时，Host 的全局快捷键、音频服务和
CuaDriver 轮询全部保持 dormant。只有 v3 daemon 完成 welcome 后这些服务才启动；断开
时会立即清理音频 context、停止 CuaDriver 轮询并解注册快捷键。

## 快捷键

快捷键由 daemon 通过每个 `LiveStatus.shortcut` 下发，默认是 `Command+Q`。Host 使用
Electron `globalShortcut` 注册普通 accelerator，不请求 Input Monitoring 权限，也没有
DoubleCommand helper。daemon 更新 accelerator 时，Host 会先解注册旧值再注册新值；
注册失败会令 `globalShortcut` self-check 失败并保持 fail-closed。退出或断开 daemon
也会解注册当前 accelerator。快捷键被其他应用占用时，Host 以五秒间隔保持单次低频
重试；冲突应用释放快捷键后可自动恢复，不需要重启 Host。

浮层和菜单栏中的“新对话”会显式创建新的无项目对话；开始、停止当前通话是独立动作。

## CuaDriver 和三项授权

如果 `~/.qwen/computer-use/` 下还没有 CuaDriver，先通过 Qwen Code 的既有 Computer
Use 安装流程获取固定且已签名的 driver。Host 会明确显示“CuaDriver 未安装”，且不会
提供无效的辅助功能或屏幕录制授权按钮。Host 不复制下载器、不自行下载 driver，也不会
为安装流程加载 WebShell；不要手工替换来源不明的二进制。

| 权限     | 授权主体       | 用途                            |
| -------- | -------------- | ------------------------------- |
| 麦克风   | Qwen Live Host | 采集 Live 对话音频              |
| 辅助功能 | CuaDriver      | 读取前台窗口和可访问性树        |
| 屏幕录制 | CuaDriver      | 为显式 Appshot 请求采集窗口图像 |

Host 只接受 Qwen Code 当前固定的 CuaDriver `0.5.2`，并持续重新校验固定安装路径、
bundle ID `com.trycua.driver`、有效 codesign 和 Team ID `YCK386LBJ7`。运行期间身份、
签名或路径发生变化会在下一次轮询中立即令 Appshot 不可用。

## 音频和 fail-closed

Host 持续检查默认输入和输出。`devicechange`、输入 track ended/mute、播放失败或音频帧
无法交给 daemon 时，会先同时将 input/output 标记为 unavailable、停止当前通话并清理
旧 context，再重新执行两项自检。麦克风重新授权后只有实际输入自检通过才会恢复 ready。
initialize、recheck、capture 和 dispose 共用带 generation 的生命周期队列；dispose 会先
同步停止采集、清空输出并移除旧 listener，再等待旧 context 关闭，因此重连不能让旧
cleanup 删除新资源。
overlay renderer、preload 加载或页面加载失败以及 renderer 无响应也会执行相同的
fail-closed；每个 Host 进程最多重建三次，成功 load 不会让 load-crash 循环重置预算。
新 preload 的真实音频自检通过前不会恢复。
开始、新对话、停止或静音 action 无法写入 daemon 时也不会乐观继续：Host 会立即停止并
清空本地音频、将两项音频 self-check 置为失败，并强制重连以释放 daemon 侧通话 lease。

任一权限、自检、快捷键或 provider 检查失败时，Live 都保持不可用。菜单栏中的
“打开 Qwen Live 状态”和 daemon 的认证 `GET /live/status` 可用于诊断。

## 卸载

1. 从菜单栏选择“退出 Qwen Live Host”。
2. 如果用户曾手工添加 Login Item，在系统设置中将其移除。
3. 从 `/Applications` 删除 **Qwen Live Host.app**。
4. 将 `general.liveVoice.enabled` 设回 `false`。
5. 如不再需要，可在“隐私与安全性”中撤销 Host 麦克风权限。

不要仅为卸载 Host 删除 `~/.qwen/computer-use/`；CuaDriver 同时供普通 Computer Use
功能使用。
