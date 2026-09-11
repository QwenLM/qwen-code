# Qwen Live Host

Qwen Live Host 是独立 Qwen Live daemon 和 WebShell Live Voice 在 macOS 上的原生组件。它承载小浮层、
Electron 全局快捷键、麦克风输入、可选摄像头输入、扬声器输出和内置原生 Appshot。Host 不打开
WebShell 或 Session 窗口；对话由连接的 daemon 管理，编码任务由配置的后端执行。没有浏览器
麦克风或浏览器快捷键降级方案。

## 用户要求

- macOS 12 或更高版本。
- 本机运行的独立 `qwen-live` daemon 或 Qwen Code WebShell。
- 可调用 `qwen3.5-omni-plus-realtime` 的 DashScope API key。

WebShell 内置 Live Voice 默认关闭；独立 `qwen-live` 可直接从命令行启动并连接 Host。
原生音视频功能目前要求 macOS。

## 首次启用

1. 在 WebShell 打开 **设置 → 实验性功能 → Qwen Live**。
2. 输入专用于 Realtime 模型的 DashScope API key；快捷键默认是
   `Command+E`，可在同一处修改。
3. 打开开关并确认安装。WebShell 优先从阿里云 OSS 镜像下载当前架构的签名 Host；
   镜像不可用时回退到独立的 GitHub `live-host-latest` feed。下载后校验 manifest、
   SHA-256、bundle identity、Developer ID 签名和 Gatekeeper，然后原子安装到
   `/Applications/Qwen Live Host.app` 并启动。
4. 按 Host 引导完成麦克风以及当前视觉源需要的授权：Screen 需要辅助功能和屏幕
   录制，Camera 需要摄像头。授权只能由用户在 macOS 完成；当前 Source 的 readiness
   通过前 Live 不可使用。

API key 只写入用户级设置。WebShell 只能看到“已配置”状态，不会读取或回显 key。
关闭 Live 会停止当前通话、撤下快捷键和 Host discovery，但不会卸载 Host 或删除
Live 对话。

## 开发构建

开发者需要 Node.js 22。在仓库根目录执行：

```bash
cd packages/live-host
npm ci
npm run build
npm run typecheck
npm test
npm run dist:mac
```

构建产物位于 `packages/live-host/dist/`，打包产物位于
`packages/live-host/release/`。正式用户不需要手工下载 DMG；WebShell 的实验性设置
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
readiness 保持 dormant。只有 v9 daemon 完成 welcome 后这些服务才启动；断开时会立即
清理音频 context 并解注册快捷键。

活跃 Live Session 的视觉上下文只走 Session-local 的内置视觉通道。它不会修改、隐藏
或跳过普通 Qwen 工具及用户配置的 MCP；Screen 捕获使用的 Appshot 本身也不依赖这些
能力。

## 快捷键

快捷键由 daemon 通过每个 `LiveStatus.shortcut` 下发，默认是 `Command+E`。Host 使用
Electron `globalShortcut` 注册普通 accelerator，不请求 Input Monitoring 权限，也没有
裸修饰键 helper。WebShell 设置通过 daemon 请求 Host 先注册新 accelerator，成功后才
解注册旧值并持久化；冲突或非法值会保留旧快捷键并返回设置错误。退出或断开 daemon
也会解注册当前 accelerator。

菜单栏中的“新对话”会显式创建新的无项目对话；开始、停止当前通话是独立动作。

## 悬浮球与设置

初始化框和悬浮球首次分别按当前可见尺寸放在启动屏幕右下角，保留 20px 边距。
拖动初始化框标题栏或小球可移动，
位置保存到 Host 用户数据目录中的 `overlay-position.json`，下次启动恢复；显示器移除后
会调整到可见区域。小球按动画、工具栏和字幕的紧凑区域限位，不再被初始化框的透明空白
挡住。打开 Settings 或预览时会临时调整到完整可见的位置，关闭后恢复记忆位置；临时调整
不会覆盖拖动记录。状态刷新不会重新定位窗口。

鼠标移到小球上显示麦克风、播报、`Start call`／`End call`、`Settings` 和 `Quit Host`
按钮；移出后等待 1 秒淡出，移回或键盘聚焦会保持可用。工具栏位于球上方，为底部贴边
留出空间。`Command+E` 启动／结束通话。
Host 启动后会等待连接、当前来源权限和自检就绪，再自动开始一次交互；已有通话时不会
重复启动。手动启停／新对话／退出、自动启动失败、重连或 renderer 重载均不会再次触发
自动启动。重新启动 Host 才产生下一次自动启动意图。
结束后小球变灰并留在原位，不再自动隐藏。小球动画、摄像头预览和设置控件保持挂载，
状态／字幕变化不会重建它们；小球没有投影。半透明状态条位于小球下方，控制按钮悬浮在
上方；圆形齿轮按钮打开 Settings，面板默认显示滚动条及轨道。
麦克风关闭或扬声器静音时，状态条第二行显示 `Mic off`／`Speaker muted`（支持中文），
同时保留第一行的通话状态或授权入口。麦克风静音会释放输入设备，取消静音后重新收音。

初始化页只处理连接、Source 和对应权限，不要求 Camera 用户先授权 Screen。
日常设置集中在 `Settings`：Audio Source（麦克风）、Video Source（Screen／Camera）、
Capture Mode（On Demand／Live Feed）三个同级设置组，以及独立 daemon 支持的 Memory。
模式说明随已确认的选项更新。设置支持 Esc、外部点击关闭，编辑草稿保留。
顶部的 `Open config.json ↗`／`打开 config.json ↗` 会使用系统为 JSON 文件关联的
默认 IDE／文本编辑器，打开当前独立 daemon 实际使用的配置（默认
`~/.qwen-live/config.json`，也支持 daemon 的 `QWEN_LIVE_DATA_DIR`）。保存后需重启
Qwen Live 才应用手动修改。旧 daemon 或内置 `qwen serve` 不提供此入口能力；文件
缺失、不是常规文件（包括符号链接）或编辑器打开失败时会提示，不自动创建或覆盖配置。
设置标题栏可以拖动，与小球共享位置记忆；打开时先等待原生窗口完成屏内定位再显示，
避免边缘处先露出被裁切的面板。用户说话的小音量视觉响应已增强，保留有界动画和缓慢
回落，不会提高发送给模型的音频音量。

Settings 倒数第二组为 `Language`／`语言`（其后是 Theme），支持 `简体中文` 和 `English`。
独立 daemon 确认后立即切换，并保存到 `~/.qwen-live/config.json` 顶层 `language`
（`zh-CN`／`en`）；旧配置未设置时保持英文。通话中也可修改，不重连媒体、不丢编辑草稿。
旧 WebShell 连接仅保存 Host 本地语言偏好，不写独立 Live 的配置。首次未连接时使用
本地缓存，连接 standalone 后以 daemon 设置为准。语言不影响模型提示词／回答或用户
自定义名称。`qwen-live init` 的第一项也可通过左右方向键选择语言，后续问题随之切换。

全部固定 Live 展示文案统一维护在
[`packages/qwen-live/src/i18n/messages.ts`](../qwen-live/src/i18n/messages.ts)，
每个键并列 `en` 和 `zh-CN`。修改后分别重建 Live 和 Host。Host 的构建别名直接编译
同一份纯文本模块，打包后不需要 qwen-live 运行时依赖；开发构建仍应在完整仓库内进行。
默认是 Screen + On Demand；配置决定每次 daemon 启动的初值，Source／Mode 切换只影响
当前运行实例。

### 子智能体状态

悬停或用键盘聚焦小球时，侧面显示明确标注 `Subagents`／`子智能体` 的摘要：
紧凑图标计数显示进行中和已完成；有运行任务时小点柔和闪烁（遵循系统减少动态效果设置），
需要用户输入时才显示提醒标记。悬停提示与辅助功能标签保留完整计数。
点击展开列表，再点击任务在同一个无边框悬浮面板中显示详情，查看原始委托、
实际运行状态、最新活动、公开中间文本、可用的计划／工具更新及最终结果。
`Back`／`返回` 回到列表；列表与详情的标题区均可拖动，返回时保留位置并限制在屏幕内。
不再打开带 macOS 标题栏的独立详情窗口；关闭面板不会取消任务。

摘要离开后约 1 秒收起，鼠标移到摘要上会保持；点击展开后一直保留，直到点击关闭或 Esc。
拖动小球时只隐藏未展开的摘要，下次悬停按新位置贴靠。展开的列表／详情不会因失焦、
打开 Settings、拖动小球或连接中断而消失。任务面板不会挤压、移动或调整小球大小，
状态更新不翻边、不重排已打开列表的点击目标，也不会把用户正在看的输出滚到底部。
自动展开的位置会避开小球、工具栏、预览和下方状态条的完整可见区域；原侧面不足以容纳
展开面板时选择有空间的另一侧，不把面板夹回状态条上。

进行中包含排队／等待输入任务；已完成包含成功任务及已取消的 Proactive monitor。
monitor 详情仍显示已取消，不伪装成成功；取消的 timer／harness、失败和中断仍独立计数。
需关注只表示正在等待用户输入／授权，不包括失败或中断。持续 monitor 的每轮判断或通知不会增加子智能体数量，
通知排队／送达与任务结束是两个状态。追加到既有后台任务的指令不重复计数。

结束语音后 Proactive 停止采样并保留结束记录，后台 harness 任务继续运行及更新。
无通话时收到权限请求只登记等待，不新增自动批准；可在任务详情中按后端实际提供的
范围允许或拒绝，未确认所属任务的请求单独显示。普通文件系统拒绝不会被虚构成授权请求。
未关联请求也会点亮摘要的待处理标记。描述过长时请到后端完整查看后授权，仍可在这里拒绝。
Live 为支持的 Codex ACP 新会话选择明确提供的 `Ask for approval` 模式；不改全局权限、
不关闭沙箱，模式不支持或设置失败时记录警告。

列表和详情提供 `Stop`／`停止`，只停止对应任务；后端尚未确认时显示正在停止，不会提前
宣称已结束，也不会用旧任务 ID 取消同一会话的新任务。停止请求与最终结果以静默文字
反馈给主 Omni，前台忙时排队，挂断后保留到本次 daemon 的下一次通话。`Close` 仅关闭面板。
Live 不再限制活动 Harness／monitor 数量；独立并行的 Harness 任务使用独立会话，
同一会话保留追加／排队语义，后端自身的队列、配额以及机器和 API 资源限制仍适用。

任务历史只保留本次 daemon 运行；全部活动任务保留有限详情，已结束任务仅保留最近 32 条。
使用上一页／下一页访问任务，每页最多 32 条，单个快照上限 240 KiB；超限时明确提示
省略／截断，总计数仍覆盖省略任务。此功能通过可选能力协商，仅在
支持的独立 Live daemon 连接上显示，不影响旧版 Host 或 WebShell。

Settings 最后一个选项 `Theme`／`主题` 位于 Language 后，支持跟随系统（默认）、浅色和深色。
主题保存在 Host 本地，与 daemon 的模型／Memory 配置无关；小球控件、设置和子智能体面板
同时更新，切换不会重建媒体或中断通话。

`Quit Host` 请求当前独立 Live daemon 完成通话、后端、Memory 和 discovery 清理后退出
Host；不会关闭另外运行的 `qwen serve`。旧 WebShell 连接只结束 Live 并退出 Host。
从未连接到已认证实例时只退出 Host；同一独立实例重连期间仍请求原实例退出。
退出未获确认时保留界面并显示错误、保持媒体停止，再次点击只重试原实例，
不会悄悄切到另一个 daemon。正常结束通话不会执行这条完整退出路径。
只有匹配的退出回执，或系统明确确认原 daemon PID 已不存在，才允许完成退出；
404、连接重置或拒绝连接都不单独视为退出成功。
清理失败时 daemon 保留同实例的退出控制入口和 discovery，但拒绝新通话及普通请求；
重试只处理尚未成功关闭的资源，全部完成后才确认退出。

连接独立 Qwen Live daemon 时，Settings 的 `Memory` 区域提供记忆开关、
独立的 `Visual memory` 开关、选择记忆库、`New`／`Rename`，以及
`Consolidation model` 设置（默认 `qwen3.7-plus`）。通话中可以开关和改名；
选择／新建记忆库和修改模型需要先结束通话。操作由 daemon 确认并写回 Live 配置，
内联编辑草稿不会被音频状态刷新打断。库默认存储在 `~/.qwen-live/memories`。
daemon 断开时 Settings 关闭，未保存的编辑草稿保留到重新连接后再次打开。
`qwen-live init` 也会询问是否启用 Memory 和整理模型名，详细参数见
[Memory 文档](../qwen-live/README.md#memory)。旧的 WebShell 内置 Live 没有声明 Memory
能力时，Host 不显示这一入口。

Camera 被选中后，气泡球上方默认显示镜像的本地预览小窗；没有字幕时更靠近小球。
球旁的小眼睛按钮可以隐藏／显示预览，独立于悬停工具栏。隐藏只影响本地小窗，不会停止
Camera 输入、视频帧上传或后台监控；切回 Screen 或 Quit 才关闭摄像头。再次选择 Camera
默认重新显示预览。空闲时画面只留在本机；
Live Feed 在通话中按配置 FPS（默认 1）持续发送有界 JPEG。On Demand 的前台模型
通过 `appshot` 获取单次截图；若存在视觉 Proactive 任务，后台 Monitor 仍会按自己的
FPS 持续采样。任务等待播报时继续观察，新事件进入 FIFO；结束通话会停止全部监控。

`visualInput.cameraResolution` 控制预览／Live Feed 采集，默认 1280×720。
`visualInput.cameraSnapshotResolution` 独立控制 Camera Appshot，默认 `native`，
也可设置 `{ "width": 1920, "height": 1080 }`；环境变量为
`QWEN_LIVE_CAMERA_SNAPSHOT_RESOLUTION=native` 或 `WIDTHxHEIGHT`。Host 优先从同一
camera track 拍摄静态照片；设备不支持时尝试临时调整视频采集约束，等新尺寸画面就绪后
截图并恢复预览。无法满足原生采集时明确报错，不会把预览的 720p 冒充原生照片。
Camera 高分辨率 JPEG 单独保存为 handoff asset（上限 8 MiB），不通过 Host WebSocket
传输；后台 Monitor 不调用这条高分辨率拍照路径。`snapshotResolution` 继续用于 Screen。

Screen Live Feed 与视觉 Proactive monitor 使用独立的完整显示器采集路径，包含桌面、
菜单栏、Dock 和其他应用，但排除 Live Host 自身窗口。Settings 的 Video Source 下可选
`Display`／`显示器`，选择保存到 `config.json` 的 `visualInput.screenDisplayId`。
默认 `primary` 跟随系统主显示器，也可保存某块显示器的 UUID；明确选择的显示器断开后
报错，不自动换屏。切换显示器会丢弃过期截图并清空 monitor 旧视觉缓冲。无需重新 init。
两条持续画面路径都使用 `liveResolution`，默认等比放进 1280×720；完整范围不代表原生像素。
所有送入 Omni 的 JPEG 和 Host 传输预览受 1080p／190 KiB 上限约束，
Camera 原图 asset 与 Screen 的 PNG asset 不受该小图上限影响。
前台 Appshot 工具与 On Demand 视觉记忆仍使用原来的前台窗口截图，不读取整屏；Camera 不变。

停止通话、切换 Source/Mode、daemon 断开或 Host 退出都会清理不再使用的通话采集。
停止通话后，Camera Source 的可见小窗可以继续显示本地预览，此时不会上传画面；
切回 Screen、断开 daemon 或退出 Host 会关闭摄像头。
Camera Source 需要摄像头权限；Screen On Demand 的 Appshot 需要辅助功能和屏幕录制权限，
Screen Live Feed 仅需屏幕录制权限。未选中的
来源权限不会阻止 Live。通话中切换到尚未授权的来源时，Host 会先保留当前可用来源，
授权成功后再一次性完成切换；授权取消或失败不会让正在工作的来源提前失效。

开发诊断可在终端启动开发版或应用可执行文件并传入 `--live-debug`。不要给 Electron
Host 传 `--debug`，该参数会被 Electron 当成已废弃的 Node 调试参数并在启动前退出。
日志只包含状态、readiness blocker、尺寸、字节数
和错误码，不包含图片、音频、API key 或转写内容：

```bash
cd packages/live-host
npm start -- --live-debug

"release/mac-arm64/Qwen Live Host.app/Contents/MacOS/Qwen Live Host" --live-debug
```

Proactive 判断、通知排队／播报、harness 任务和 Realtime 生命周期日志由 **daemon** 输出，
需在另一个终端运行 `qwen-live --debug`。Host 的 `--live-debug` 不会替代 daemon 的日志开关。

排查 monitor 输入时，用 `frameHash`（JPEG 字节的 SHA256 前 16 位）对应 Host 的
`visual_snapshot_captured`／`visual_frame_sent`、daemon 的截图／帧记录，以及
`proactive.monitor_image_sent`。后者只表示实际写入模型连接的帧，不把排队当作已发送。
`proactive.monitor_commit` 显示本次实际发送的图片数、音频字节数和时长（含协议要求的静音），
`monitor_committed` 表示服务端确认提交，`monitor_action` 区分 wait／reply／function_call／invalid。
这些日志不包含图像、音频或模型输出原文。

daemon 的 debug 模式另外为视觉 Monitor 保存真实请求，目录为系统临时目录下的
`qwen-live-monitor-debug/`。每个 Monitor 一个目录，每次推理保存 `request.json`、
实际送出的 JPEG、含协议静音的 16 kHz `input.wav`，以及结果 `response.json`。
`proactive.monitor_debug_started` 和 `proactive.monitor_request_saved` 日志给出绝对路径。
仅 daemon debug 开启；Host 的 `--live-debug` 单独启用不会录制，纯音频 Monitor 也不录制。
启动及新建 Monitor 时清理，只保留最近创建的 10 个 Monitor（不是最近 10 次请求）。
被清理的 Monitor 继续运行但停止录制。文件仅在 macOS／Linux 上保证仅当前用户可访问
（0700/0600 强制执行，不满足则拒绝）；Windows 无法校验 POSIX 权限位，
隔离性仅取决于系统临时目录自身继承的 ACL。内容包含真实屏幕／摄像头、
任务文本和混合 Monitor 的麦克风输入，虽然不保存连接凭据，画面或音频中的秘密不会被脱敏。
录制失败会单独报错而不影响通话；长时间 debug 可能占用较多磁盘，诊断完请关闭 debug。
完整格式与清理规则见 [Qwen Live README](../qwen-live/README.md)。

`native_display_changed` 记录原生显示器事件与几何信息；`overlay_position` 记录 Host 主动
定位的原因及前后坐标，`overlay_native_moved` 记录原生窗口移动。非几何显示器事件不会再
丢弃正在采集的帧或中断拖拽；真正需要边界修正时才调整小球位置。

## 内置 Appshot 与来源相关授权

| 权限     | 授权主体       | 用途                                   |
| -------- | -------------- | -------------------------------------- |
| 麦克风   | Qwen Live Host | 采集 Live 对话音频                     |
| 摄像头   | Qwen Live Host | Camera Source 的预览、实时帧或单帧截图 |
| 辅助功能 | Qwen Live Host | 读取前台窗口的可访问性树               |
| 屏幕录制 | Qwen Live Host | Screen Source 的实时帧或单帧截图       |

Appshot 是 Host 的内部核心能力。内置原生模块选择最前面的非 Host 普通窗口，通过
macOS 原生 API 返回应用信息、窗口标题、AX 文本和 PNG。模型侧的 `appshot` 是无参数、
只读工具，捕获气泡球当前选中的 Source；不能通过工具参数临时指定另一个来源、窗口、
坐标或动作。Live Feed 模式禁用该工具，On Demand 模式才允许调用。

Host 激活后会在 Screen 为当前或待切换来源时定期刷新 Appshot 权限，以便授权完成后
自动恢复或切换；每次真实 Screen 捕获还会在 Host 进程内重新验证两项权限。当前来源的
授权丢失会令捕获失败并使 Live fail closed。整个流程不启动或探测任何外置屏幕工具。

## 音频和 fail-closed

Omni 响应以单声道 16-bit、24 kHz PCM 接收。播放 AudioContext 不指定采样率，使用当前
系统输出设备的默认时钟（如 44.1／48／96 kHz），不强制更改设备采样率。
当前协商了输出结束标记的连接，对每条响应进行连续、带抗混叠滤波的流式重采样，再放入
设备采样率的 AudioBuffer，按整数采样点连续排程，避免逐块转换的衔接尖峰及无谓间隙。
结束标记到达时输出短暂的滤波尾部。未协商结束标记的旧连接保持原有 Web Audio
逐帧转换和播放排空逻辑，不会等待不存在的标记。
`--live-debug` 日志中的 `output_context_ready` 显示源／输出上下文采样率及是否重采样。

蓝牙耳机的麦克风被打开时，macOS 可能将耳机切换到免提通话模式，影响同时播放的音乐／视频；
这与模型 PCM 采样率是两回事。可在 Audio Source 选择 Mac 内置麦克风，输出仍使用蓝牙耳机。
关闭麦克风时 Host 立即停止输入 track 并释放捕获上下文，而不只是丢弃录音数据；
静音期间设备变化不会重新打开麦克风，取消静音后才重新收音。

`devicechange` 会在收音时检查／替换输入，在空闲时重新自检；静音通话不重新获取输入。
输入 track ended、播放失败或音频帧无法交给 daemon 时，Host 会先
将 input/output 标记为 unavailable、停止当前通话并清理旧 context，再重新执行自检。
麦克风重新授权后只有实际输入自检通过才会恢复 ready。overlay renderer、preload 加载、
页面加载失败或 renderer 无响应也会执行 fail-closed。

任一权限、自检、快捷键或 provider 配置失败时，Live 都保持不可用。Host readiness
不会连接 Realtime；首次就绪自动开始或用户手动开始对话时才建立 provider WebSocket。限流或配额错误不做
自动重试或后台探测，用户稍后可手工重试。

## 卸载

1. 从菜单栏选择“退出 Qwen Live Host”。
2. 如果用户曾手工添加 Login Item，在系统设置中将其移除。
3. 从 `/Applications` 删除 **Qwen Live Host.app**。
4. 在 WebShell 的 **设置 → 实验性功能 → Qwen Live** 中关闭功能。
5. 如不再需要，可在“隐私与安全性”中撤销 Host 的麦克风、摄像头、辅助功能和屏幕录制权限。
