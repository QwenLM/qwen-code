# Linux 输入投递不再由模型选择模式

[English](linux-input-delivery.md) | [简体中文](linux-input-delivery.zh-CN.md)

Linux Computer Use 工作流保留显式进程、窗口定位和当前元素 token。模型选择目标与动作，运行时选择语义操作或经过校验的原生输入。

## 范围

基于 PR #11829 合并后的 main：`ba0ddcd0b7d077a66d803898706210ae8b02d910`。

1. Linux Computer Use 动作默认允许原生焦点准备；保留已有程序调用和 Windows 的显式投递覆盖。
2. 仅在发送输入之前恢复失败的焦点准备。输入回调开始后，错误或不确定结果均不重放动作。
3. 在 benchmark launcher 中传递所选桌面的环境。
4. 解释 Node REPL 既有的 10 秒 yield 默认值，并用当前 skill 验证截图转发。

Linux App handle、音频能力和 shell 策略不在范围内。后续 PR 包含 driver/SDK 0.20.8 与 Node REPL 0.1.5 的发布元数据、安装器、使用方版本和完整包验证。创建 PR 不会执行生产发布。

Linux 完整工作流直接放在固定的 `computer-use/SKILL.md` 入口中。OSWorld 只从 npm 包提取这一成员并注入 user message，因此 Linux 指导不能依赖再读取一个 skill resource。

## 归属与授权

JavaScript facade 根据所连接 driver 的平台选择默认值，而非 Node 宿主系统。它向原生调用传递既有 foreground 权限上限，让授权层看到可能发生的焦点切换。不修改原生层缺省 delivery 字段的解释：bounded manifest 当前将其理解为仅允许 background。

Linux 原生层保留既有语义路径和目标寻址路径。需要全局 X11 输入时，先准备并核验精确窗口。既有进程级桌面动作协调器负责串行物理输入。不增加运行时进程、可执行文件、依赖、权限或协议。

显式调用 getPlatform 会刷新平台选择。原生 session 替换后，用于默认值的平台缓存失效。内部发现不会增加模型工具轮次或桌面观察。

## 恢复边界

焦点准备与输入回调分离。仅准备阶段允许在有限总时限和次数内重试。成功、部分投递、投递后超时或回调错误都结束该操作，不重放输入。需要临时切入目标时，结束后恢复原活动窗口和 core focus。目标原本已聚焦时，保留动作造成的控件或对话框焦点变化；恢复旧子控件会撤销点击和键盘导航。

恢复其他窗口时，先等待它完成激活与焦点切换，再恢复精确子控件，避免窗口管理器覆盖恢复结果。确认阶段使用与准备阶段相同的有界 timeout；窗口管理器拒绝恢复时，仍执行既有 best-effort core-focus 恢复。输入回调不重放。

在削弱或修改 active-window 校验前，历史 active=0 错误需要 X11 复现。不存在 EWMH 窗口管理器，与既有窗口管理器延迟或拒绝激活，是不同情况。

## Launcher 边界

Benchmark launcher 必须使用实际所选 GUI session 的 DISPLAY、XAUTHORITY、DBUS_SESSION_BUS_ADDRESS、XDG_RUNTIME_DIR，以及适用时的 Wayland display。不猜测 :0，也不复制其他 session 的环境。变量应传入 MCP 进程及其 Node kernel。缺少 display 选择时，在改写 MCP 配置前失败。Launcher 不预探测 GUI 可用性；不可访问的 display 或 bus 仍在使用 driver 时失败。

仅改善 driver 的发现错误信息不能修复 launcher 丢失环境的问题。

实际 launcher 修改在 OSWorld-V2 仓库中，基线为 `f4d1d85929c81c1e345a3c8404bde22fec6798f3`。Codex、Claude 两条 setup 路径仅向 node-repl MCP 配置复制所选桌面变量，显式 MCP 环境优先。既有 systemd setup 同时提供服务所属用户的 D-Bus session 地址。

## 验证

使用 typed driver 替身验证按平台选择的默认值、显式覆盖兼容性、取消和不重放修改。使用 Linux X11 fixture 观察真实焦点目标和输入次数，覆盖激活延迟、拒绝及回调错误。在同一原生构建上验证既有 sparse token 和截断修复。

比较 launcher 父进程、MCP 与 kernel 的环境值，不打印秘密。验证立即和延迟返回的 MCP 图片均为 image block，以及超过一秒的 cell 在默认 yield 下的表现。

原生测试与协议测试分别报告。在相同 benchmark case 重跑之前，不宣称总体得分或 token 改善。
