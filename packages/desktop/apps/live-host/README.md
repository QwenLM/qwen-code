# Qwen Live Host

Qwen Live Host 是 WebShell Live Voice 在 macOS 上的必需组件。它负责全局
DoubleCommand、麦克风输入、扬声器输出、权限状态以及 Live 浮层。未安装、未运行或
未完成全部授权时，Live Voice 会保持不可用；没有浏览器麦克风或浏览器快捷键降级方案。

## 要求

- macOS 12 或更高版本；Apple Silicon 和 Intel 分别打包。
- Node.js 22、Bun、Xcode Command Line Tools。构建会调用 `xcrun swiftc` 和
  `lipo` 生成通用架构的 DoubleCommand helper。
- 已安装 Qwen Code 的 CuaDriver。Live Host 不内置另一份 driver。
- WebShell daemon 正在本机运行，且与 Host 使用相同版本的 Live 协议。

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
`apps/live-host/release/`。`live-host:dist:mac` 会按架构生成
`Qwen-Live-Host-arm64.dmg`、`Qwen-Live-Host-x64.dmg` 及对应 ZIP。

打开与当前 Mac 架构匹配的 DMG，将 **Qwen Live Host.app** 拖入
`/Applications`，然后从 Applications 启动一次。完成授权后应始终运行这份已安装的
app，不要改用构建目录中的副本，否则 macOS 可能把它识别为不同的授权主体。

正式分发构建应在已配置 Developer ID 签名身份的机器上完成。打包钩子会校验内置
DoubleCommand helper 的签名和 app 使用同一 Team ID；校验失败时打包会终止。

## Live Voice 配置

建议将配置放在用户级 `~/.qwen/settings.json`，以便无项目的 Conversations session
也能使用。以下示例不包含任何凭据：

```json
{
  "general": {
    "liveVoice": {
      "enabled": true,
      "model": "qwen3.5-omni-plus-realtime",
      "providerModel": "openai:qwen3.8-max-preview",
      "endpoint": "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
      "voice": "Tina"
    }
  }
}
```

`providerModel` 必须唯一匹配现有 `modelProviders` 条目。该条目需要配置受支持的
DashScope HTTPS `baseUrl` 和 `envKey`；实际 API key 由启动 daemon 的环境或受保护的
`.env` 文件提供。不要把 key 放入 Realtime endpoint、命令行、截图或问题报告。

Live 启用后，daemon 会在 `~/.qwen/live/daemon.json` 发布权限为 `0600` 的稳定
locator；即使 daemon 使用 `QWEN_RUNTIME_DIR` 或 `advanced.runtimeOutputDir`，从
Finder 或 Login Items 启动的 Host 也无需继承这些环境变量。自定义 runtime 下仍会保留
runtime-local record 供诊断。稳定 locator 同一时间只允许一个存活 daemon 持有：新
daemon 不会覆盖仍存活的 owner，只会接管 PID 已不存在的合法 stale record；退出时也
只删除同时匹配自身 PID 和 nonce 的记录。record 可能包含 bearer token，不要打印、
复制或共享其内容。

## CuaDriver 和四项授权

如果 `~/.qwen/computer-use/` 下还没有 Qwen Code 安装的 CuaDriver，先保持
`tools.computerUse.enabled` 为 `true`，并在 Qwen Code 中实际调用一次
`computer_use__*` 工具，让既有安装流程下载固定且已签名的 driver。不要手工替换为
来源不明的二进制。

启动 Qwen Live Host 后，点击菜单栏图标并选择“打开 Qwen Live 状态”。不可用时，浮层
会显示授权按钮。四项权限必须全部通过：

| 权限     | 授权主体                               | 用途                            |
| -------- | -------------------------------------- | ------------------------------- |
| 麦克风   | Qwen Live Host                         | 采集 Live 对话音频              |
| 输入监控 | Qwen Live Host 的 DoubleCommand helper | 监听全局 Command 键             |
| 辅助功能 | CuaDriver                              | 读取前台窗口和可访问性树        |
| 屏幕录制 | CuaDriver                              | 为显式 Appshot 请求采集窗口图像 |

点击对应“授权”按钮后按 macOS 系统提示操作。若权限曾被拒绝，请在“系统设置 →
隐私与安全性”中为系统提示所列的对应 app 或负责进程重新启用。Accessibility 和
Screen Recording 都会按 CuaDriver 的实时状态判断；仅给 Host 本身授予这两项权限
不能使 Appshot 就绪。

Host 只接受 Qwen Code 当前固定的 CuaDriver `0.5.2`，路径必须是对应安装目录中的
`CuaDriver.app/Contents/MacOS/cua-driver`，并同时校验 bundle ID
`com.trycua.driver`、有效 codesign 和 Team ID `YCK386LBJ7`。其他旧版或未来版本即使
签名有效也不会被当作 ready；版本、路径、签名或身份任一不匹配都会将 Appshot 保持为
不可用。升级 core 的 `CUA_DRIVER_VERSION` 时必须同步 Host pin 后再打包。

## DoubleCommand

在任意界面连续独立按下并松开 Command 两次；从第一次按下到第二次松开不得超过
350 ms，期间不要按普通键或其他修饰键。Live 空闲时该动作开始或继续最近的兼容对话；
Live 活跃时该动作停止当前音频通话。浮层会在所有桌面和全屏空间上显示。
每次唤起时，浮层会移动到当前光标所在显示器的工作区右下角。浮层和菜单栏中的
“新对话”会显式创建新的无项目对话；它与开始、停止当前通话是不同动作。

快捷键只有在 Host 已连接、全部 readiness 检查通过且 Live 可用时才会开始通话。

## 状态诊断和 self-check

菜单栏的“打开 Qwen Live 状态”是首选诊断入口。就绪时标题状态为 `idle`、开始按钮可用，
且没有 blocker。Host 和 daemon 会持续检查：

- Host 连接和 Live 协议版本；
- provider 配置及 Realtime endpoint 可达性；
- 四项权限；
- 默认音频输入、音频输出和 DoubleCommand helper；
- CuaDriver 的可捕获状态；
- Conversations runtime 中 `computer_use__list_windows` 和
  `computer_use__get_window_state` 是否可用。

任一检查失败或权限在通话中被撤销，当前通话都会停止并保持 fail-closed。常见 blocker
可按以下方向排查：

| blocker                                                    | 检查项                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `host_missing` / `host_disconnected`                       | Applications 中的 Host 是否运行，WebShell daemon 是否运行                  |
| `host_version`                                             | Host 与当前 Qwen Code 是否来自兼容构建                                     |
| `provider_config` / `provider_unreachable`                 | `general.liveVoice`、唯一 provider 匹配、daemon 环境中的 credential 和网络 |
| `microphone_permission` / `input_monitoring_permission`    | Host 和内置 helper 的系统授权                                              |
| `accessibility_permission` / `screen_recording_permission` | CuaDriver 的系统授权                                                       |
| `audio_input` / `audio_output`                             | macOS 默认输入、输出设备是否可用                                           |
| `global_shortcut`                                          | 输入监控授权和 DoubleCommand helper 状态                                   |
| `appshot`                                                  | CuaDriver 安装、可捕获状态及 Conversations runtime 的 Computer Use 工具    |

daemon 的 `GET /live/status` 是对应的机器可读状态，但只能通过已经认证的
WebShell/daemon client 访问。不要为了诊断把 discovery token 拼进 URL 或 shell 历史。

## 无浏览器降级

Live Voice 不会退化成普通浏览器录音。Host 缺失、退出、协议不兼容、CuaDriver 缺失或
任一授权/self-check 未通过时，WebShell 只显示 blocker，不能开始 Live。对话中的
session 链接由 Host 在隔离的 Electron 窗口中打开，daemon credential 不进入 URL 或
renderer。

## Login Item 和卸载

已打包的 app 启动时会把自己注册为隐藏启动的 Login Item，目前没有 app 内开关。可在
“系统设置 → 通用 → 登录项”中查看或停用；再次手动启动已打包的 Host 时，它会重新确保
该 Login Item 已启用。

卸载顺序：

1. 从菜单栏选择“退出 Qwen Live Host”。
2. 在 Login Items 中停用或移除 Qwen Live Host。
3. 从 `/Applications` 删除 **Qwen Live Host.app**。
4. 将 `general.liveVoice.enabled` 设回 `false`。
5. 如不再需要，可在“隐私与安全性”中撤销它的麦克风和输入监控权限。

不要仅为卸载 Host 删除 `~/.qwen/computer-use/`；CuaDriver 同时由 Qwen Code 的普通
Computer Use 功能共享。
