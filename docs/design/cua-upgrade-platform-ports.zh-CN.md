# Computer Use 平台移植记录（2026-10）

[English](cua-upgrade-platform-ports.md) | [简体中文](cua-upgrade-platform-ports.zh-CN.md)

本文是已批准[升级方案](./cua-upgrade-2026-10.zh-CN.md)的实施台账。移植来源为 trycua/cua 截至 `cua-driver-rs-v0.35.4` 的 MIT 代码，Copyright (c) 2025 Cua AI。仅原生 driver 库作为来源，不纳入上游 bench 包及其许可证。

## 派发合同

App 输入在 driver 内解析精确应用和窗口。macOS 使用辅助功能与进程定向事件，不自动回退全局前台。Windows/Linux 仅在原生层返回派发前 `background_unavailable` 且 `sent:false` 时，允许一次前台路径。可能已经派发后的执行器错误不回放。显式桌面输入是独立前台接口。

前台事务观察物理输入而不消耗它；检测到后停止剩余输入，保留用户选择的前台 C，仅在仍拥有 B 时恢复原 A。Windows 恢复前等待目标输入队列排空，并在 UTF-16 单元间检查目标。Linux 在 XTest 前同时确认 EWMH 激活和核心输入焦点。

成功表示派发确认，不表示应用效果已确认。输入调用不等待截图变化，下一次观察提供效果证据。持续按压和多击仅保留完成手势所需的时序。

## macOS

| 上游来源                   | 适配                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| #4943                      | 定向焦点到 B 时，不给 A 发送合成失焦通知。                                                                                     |
| #4943, #4955, #5091, #5129 | 键盘焦点保护复用进程级 `app_focus` 观察者；有界尾部/层序恢复和主动焦点 epoch 避免观察者竞争。                                  |
| #4976                      | 物理鼠标/修饰键活动优先保留用户切换；现有激活保护检查同一物理输入状态。                                                        |
| #5051                      | 定向鼠标事件显式设置修饰键，包括空集合。                                                                                       |
| #5057                      | 保存已有文件和 Finder 改名使用有界 Apple Events 并读回；参数作为脚本参数传入，不拼接 AppleScript；Automation 走正常 TCC 授权。 |
| 弹出选择                   | AX 打开菜单并选择唯一匹配项；拒绝时关闭本次打开的菜单。Safari 原有 DOM 回退仍仅限实际前台文档。                                |
| 文本插入                   | ASCII 使用定向事件；非 ASCII 要求聚焦可编辑元素和 AX selected-text 支持，并读回预期插入；不确定 AX 写入后不重放键盘。          |
| 文档模型                   | 已验证的 AppKit 文档字段 AX 写入，通过定向且净变化为零的编辑 shim 注册修改；无法验证注册时拒绝。                               |

后台拖动在派发前拒绝；滑块使用 `setValue`；粘贴保留剪贴板恢复事务。删除旧的动作后固定一秒等待。AX 确认或事件投递本身都不算效果确认。

P7 对完整原生工具模块的受控 provider 测试复现：raw 双击/右键的 AXOpen/AXShowMenu 先产生效果再报错，旧实现继续发送鼠标动作。现在一旦尝试该 AX 动作，错误直接返回正常 sent/unconfirmed 响应与警告，不进入鼠标路径。成功语义路径及未提供语义动作时选择的鼠标路径保持原行为。该语义分支未执行前台事务，因此即使请求 foreground，也明确报告实际 background。独立测试执行完整模块及真实 core 公开投影，双击六格、右键四格均通过，三项不确定结果保持 unverifiable/accessibility 并保留警告。默认 App 的提前转发仅作对照，不证明 App 缺陷或真实 AX 服务器生效后报错。

## Windows

| 上游来源     | 适配                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4500        | 连接实际目标输入队列，以 sentinel 读有界等待排空再恢复。                                                                                                                      |
| #4901        | UTF-16 单元之间检查前台所有权和物理输入；单元停滞后停止，不回放。                                                                                                             |
| #3671        | UIA 点动作超时与派发前不存在合适 pattern 分开，不确定动作不能变成第二次坐标点击。                                                                                             |
| #4774        | 原生 combo 使用控件选择/通知消息，并验证选中值。                                                                                                                              |
| Tk           | 输入前拒绝不支持的后台鼠标路径，随后共享 App 派发器可前台执行一次。                                                                                                           |
| 扩展键       | 左右 Windows 键保留 extended-key 标志。                                                                                                                                       |
| Worker IPC   | 有界读取响应；超时说明可能已发送。UIAccess 路由明确 opt-in。                                                                                                                  |
| 普通用户启动 | 高权限 daemon 从自身 token 派生并验证 Medium token，管理员成员为 deny-only；不打开/借用其他进程 token。直接可执行文件和 shell helper 均使用它，失败则拒绝，不高权限启动应用。 |

保留正常安装/UAC 流程。交叉编译仅证明构建，不证明交互桌面、UAC、运行时 token 或共享桌面打扰。

## Linux

删除原生 Wayland、helper、依赖和安装载荷。X11 和 XWayland 中的 X11 应用共用 X11 实现；不支持 compositor 原生 Wayland 表面。

| 上游来源     | 适配或现有等效实现                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #3882        | MPX 鼠标/键盘、toolkit 拒绝规则、遮挡和焦点保护，不使用输入屏障；保留 fork 精确窗口检查。                                                              |
| #3761        | hold 计时前 flush/check 按下；短连接关闭前无条件 server round-trip。P7 后续复现表明临时映射仅靠 server 送达不够，下面的客户端队列修复仍需验收。        |
| #3762        | 检查按下/释放，保留时序，出错后释放已排队按钮和修饰键。                                                                                                |
| #3864        | 保留观察到的精确 bus/object 点击身份和窗口快照校验；session-owned MPX 持久化来自 MPX 总体适配，而非此身份补丁。                                        |
| #3618        | 修饰键前台拖动用真实键状态包围并清理；不支持的后台组合在派发前拒绝。                                                                                   |
| #4248        | 新 App 合同无动作后效果分类器，不会因 WM 暂存焦点把关闭 B 对话框误判无效果。精确前台恢复保留 C，不从未知 popup 推断确认；不移植上游截图/窗口变化等待。 |
| #4188        | 坐标 AX 激活排除 application/frame/window 外壳；识别 NUL 分隔和空格拼接的 Chromium helper 命令行。                                                     |
| #5139, #5158 | Unicode keysym、全文字符预检；首个事件前预留/重映射空键码，序列化临时映射，不静默漏字。                                                                |
| #3601        | master 所有权包含 boot、PID namespace、UID、进程开始身份；仅回收已证明属于本 driver 家族的过期设备。                                                   |
| #2888        | KDE 设备热插拔可能重配物理输入，因此保守拒绝 MPX；不自动改变 `/dev/uinput` 权限。                                                                      |
| #5070        | 后台键盘拒绝明确指出缺 AT-SPI bus 和正常配置路径；诊断探测有界。                                                                                       |
| #4903        | 删除 AT-SPI P2P feature/peer 调用，使用一个注册连接。                                                                                                  |
| #4984        | 仅基于有效完整屏幕 frame 重定位；拒绝不完整或零尺寸几何。                                                                                              |
| #5074        | 首次子树遍历前通过 attributes 唤醒应用。                                                                                                               |
| #4375        | 首次语义遍历两秒，之后一秒；不对不完整观察做通用整树重试。                                                                                             |
| GTK combo    | `Selection.SelectChild` 选择唯一选项，读回 selected-child 名称，不改焦点/前台。                                                                        |
| #4292        | 文本与标签分开；数字控件优先 numeric Value，不读取密码 Text。                                                                                          |
| #3758        | DirectColor 截图用 X colormap 解码，不当作 TrueColor mask。                                                                                            |
| #4281        | kill 成功等待实际退出；zombie 算已退出。                                                                                                               |
| #3814        | 精确窗口截图明确 `screenshot_frame_valid:true`。                                                                                                       |
| #4529        | overlay 未映射时准备空 input/bounding shape，仅绘制可见内容时映射，空闲帧取消映射。                                                                    |
| #4715        | 非 Linux stub 不再声明已删除截图工具；portable menu schema 不走 cursor-only 断言。                                                                     |
| #3658        | Enter/Return/KP/Numpad 别名共用终端 gate 和映射。                                                                                                      |
| #3778        | 既有 opt-in 原生浏览器工具共用 session cursor；非活动 tab 不移动可见光标，不把上游浏览器工具加入默认接口，也不改仓库 Browser SDK。                     |

fork 修复还包括按窗口保留截图缩放，不重复缩放省略位置的 mouse-up，Qt 合成 FocusIn 限 Qt5，按实际核心焦点决定 FocusOut，仅在路由需要时分类 Chromium。

### P7 Linux 临时键盘映射生命周期

在自有 GTK 主循环暂停三秒时，候选和上游都丢失重映射 Unicode：server 已送键码，driver 恢复映射，客户端之后把它译为 NoSymbol。此复现使用独立 nested Xorg，与不稳定主 GNOME 分开。

候选在修改映射或输入前准备 X11 客户端队列确认，仅需要空键码的操作付出此成本。目标或同 X client 的祖先必须声明 `_NET_WM_PING`；同进程另一连接不算。XTest 在每字及确认前后检查焦点 client。派发后收到 root 上精确 nonce 回声再释放临时映射。五秒超时恢复映射并正常返回已发送但未确认，不回放；部分输入期间发现焦点变化仍停止后续输入并报错；缺协议支持则输入前拒绝。ASCII 保留 server round-trip，不增加 ping。鼠标修饰键不在现有 map 时提前拒绝，因为借键码不能建立真实 modifier mapping。

MPX 在 ping 前还必须确认 raw-key server delivery。受控复现发现旧 last-key 谓词在六个计划事件只到两个时，把较早的重复 release 当成完成。新实现要求准确虚拟 slave 的每次有序转换，包括重复键和 Shift。旧版零 source ID 仅在 device ID 等于该 slave 时允许，不能用共享 master。相同 source 的意外转换使结果未确认；保留设备的 pending 状态，下一请求在映射、焦点或输入前拒绝，正常 session 清理随设备删除。预热也确认完整批次，且先于借键码；保留 keymap→MPX 锁顺序。独立生命周期 10/10、匹配器 13/13、下述预热校验后的 Linux 单测 16/16 通过。内核积压和物理设备仍待验；受控测试替换了 OS 边界。

预热前 XKB 必须识别准确 slave，证明 X248 所有 group/level 都无符号。占用、无效或不可读时零输入拒绝并保持 pending；不临时重映射固定键使检查通过。独立验证覆盖 20 个 map/query 和三个 pending 入口；C header 与 Rust layout 一致。真实只读 Xephyr slave 的 empty-group map 仅为形状对照，不代表新 uinput 设备。

不引入焦点 grab、输入屏障、剪贴板变更、永久映射或新 helper 进程。GTK/Chrome 证明队列机制；Chrome 回声早于 DOM 输入结束，明确不是语义成功。native-v5b 的 GTK 响应、暂停三秒、超时、错误 nonce、缺协议分别通过效果/拒绝/不确定检查。Chrome 机制检查使用 v5a；v5b 仅改不确定结果报告，另有验证。物理 MPX 未验证。

## P7：上游正确性收口

### 普通 macOS AX 遍历预算（G31 / 上游 #3882）

原 raw 和默认 App 观察仅限制深度/节点数，时间预算仅用于录制。适配上游一秒节点遍历预算，从窗口选择和 readiness 之后第一个非重复、准入节点开始。Chromium readiness、AppKit launch、原生 messaging timeout 和外层观察 timeout 分开；此协作限制不能取消挂起的原生读，也不保证整体一秒返回。

主动截断保留完整前缀，标记 truncated/incomplete。成功尝试的读保留 `read_complete`，与既有节点/深度上限一致；真实 AX 错误清除它。前缀变化时 bounded revision 返回完整替换，缺行不算删除。raw token 跨后续观察仍绑定自己的不可变对象；接受前用真实 walker 结果验证消费者。

legacy 节点预算与录制绝对期限保留。不新增公开 timeout 参数、输出字段、worker 或动作重试。先做有限慢节点复现与准备延迟对照，再实现；原生延迟另行验收。

### Windows 安装器祖先保护（G32 / 上游 #4398）

共享清理可能结束发起 `update --apply` 的 driver 和 installer 子进程，并把受保护父进程误判为 stale。独立复现执行真实 PowerShell 函数，进程/task/pipe 全部 stub，不停止真实进程或任务。

适配 live ancestor walk，父进程创建时间晚于子进程则视为 PID 重用而拒绝继续。仅清理非祖先 driver PID，survivor/repair 列表排除祖先。存在 driver 祖先时跳过 task-wide `/End`，PID filter 不能保护其免受 Task Scheduler 终止。祖先查询不可用时任何结束动作前停止。legacy migration 复用同一 helper，移除另一份 image-name tree kill；独立 `-local` 产品身份不变。

隔离 stub 验证祖先、无关进程、stale、PID 重用、cycle、查询错误及 legacy 委托。回归脚本新增 unit-only，在构建/真实任务测试前退出。此源修改本身不注册/改变任务或 Windows 权限。

### Windows 自动启动失败报告（G33 / 上游 #3180 和 #4284）

以 `Register-ScheduledTask -Force` 替换任务，避免先删。UAC 取消、无进程或无 exit code 均失败，否则转发子进程实际码；可执行文件作为 PowerShell 字面参数引用。复用状态查询验证注册；查询不可用时报告无法确认，不无条件成功。不自动重试取消或未确认的提升。

两个安装器仅在注册调用成功后提示成功。用 `CUA_DRIVER_RS_HOME` 或 `CUA_DRIVER_RS_INSTALL_DIR` 选择隔离 release 安装时，除非显式 `-AutoStart`，保留共享 daemon/task。此 guard 也包围注册前共享清理，仅保护结尾会仍杀普通安装的 daemon。默认安装与独立 local 身份保留原路由。

独立 before/after 执行真实 PowerShell payload 和 installer block，task/UAC/cleanup 为 stub；覆盖取消、null/失败子进程、注册失败保留旧任务、摘要及隔离/默认/显式参数组合。这些不是 UAC、真实注册或完整安装；后续已在独立授权下执行真实任务与自有安装生命周期测试，身份及边界见当前验收附录。

### macOS 后台窗口层序（T04）

可见层序以 on-screen CGWindow 查询为准；all-window 查询对标为 on-screen 的行仍可能排序不同。真机诊断还发现重新激活已在前台的应用，一秒后返回成功却不恢复层序。guard 改为仅对其当前 AXFocusedWindow 请求 AXRaise，核验 PID 与精确可见 layer-0 ID。WindowServer 必须仍指向同一前台应用，近期物理鼠标/修饰键活动阻止恢复；AX messaging timeout 为 100ms，引用全程持有，保留现有有界观察。不改键盘焦点或后台派发路径；API 接受不证明层序恢复。

单个自有窗口原语探测在 AXRaise 约 23ms 后恢复可见层序，保留全部模拟输入。生产 fix-2 三轮消除持续覆盖，但仍有 99.4、200.5、192.8ms 瞬态，零干扰门槛未关闭。全部模拟输入到 A；popup/context、主动激活、显式前台回归通过。后续 strict-ID 诊断在请求 mouse-down 后、mouse-up 前观察到升层，激活/预热阶段未出现；支持继续调查请求的鼠标投递，不能据此猜测移除预热。早期激活式修复失败并保留。

后续 preparation-only 一格跳过两个请求事件，未观测覆盖，但现有 guard 和采样限制该阴性结果。另一 task-only 格保留准备，仅把请求 pair 改为每事件一次公共 CGEventPostToPid；精确源 PID 事件、原生 field-editor 和强制最终 AX focus 确认点击，却仍被 SentinelA 观测到 194.110ms 覆盖，独立 WindowServer 采样口径 196.695ms。未证明此传输变化能修复，因此未入生产。十个模拟 canary 全到 A，但调用内仅一个，覆盖期间零个；不证明覆盖时真人输入安全或普遍零干扰。

### 跨 Space 窗口观察（G17 / 上游 #4996）

共享 capture 层新增上游单窗口 SkyLight backing-store 捕获。已知 off-Space 时先试私有路径，再 public SCK/shell；当前或未知 Space 保留 public-first。动态解析私有符号，返回图像从其 CFArray 独立 retain，拒绝空或全透明图，保留尺寸限制和 PNG 转换。不新增进程、权限、激活或 Space 切换。

私有路径 capture 前后校验原有 WindowCaptureIdentity，拒绝 attached-window 或不明确的 attachment 几何。与 SCK 共用一 worker gate 和三秒原生预算；未返回调用在外层超时后仍持 permit。public shell 兼容行为不变。所有消费者共用 capture 函数。backing-store 可能过时，尤其 off-Space Chromium；raw 和默认 App 观察必须说明，不能把新图当作动作效果证明。

先以受控原生边界运行真实入口，验证顺序、身份变化、attachment 拒绝、CF 所有权、透明像素和 worker 上限。这不代替真实 off-Space capture，也不代替独立精确 AX remote-token 恢复。

### 精确遗漏 AXWindow 恢复（G17 / 上游 #4068、#4085、#4509）

公共窗口、focus/main、attached-sheet 发现失败后，可用有界 remote-token 恢复指定 AXWindow。要求实时同 PID、layer-0 WindowServer 窗口，已知 off-Space 或已知当前 Space 但 off-screen；未知 membership 不允许。候选必须 AXWindow role、精确 PID、直接 SPI window ID，frame/title 近似不能证明身份。私有符号动态解析；300ms 预算被更早的 recording deadline 截短，每原生消息至多 50ms、至多 2,000 tokens，仍是协作边界。

tree 和 fresh action facts 保留完整性、owner、minimized/hidden、键盘歧义 gate。默认 App 在 public selection/reopen 后仅一次探测，且所有同 PID layer-0 窗口中仅一个候选。恢复 root 仍需解析 attached sheet；不完整、歧义或外来 sheet 拒绝。与现有 focused-window 路径一样，精确已证明的 App 表面可以在全局 AX array 不完整时被选中，但后续 tree/facts 必须满足更严格完整性检查。此恢复不发输入、不激活/切 Space、不跨请求缓存 AX 对象。

### Chromium 观察 readiness（G24 / 上游 #3783）

现代 opt-in 接受后仍为 pending，直到观测 AXWebArea。默认 App AX 观察在选窗和遍历间共用 500ms deadline。录制、动作 facts 和纯截图仅 opt-in，不轮询或消耗等待次数。正证据立即返回；pending cooldown 30 秒，每进程生命周期至多三次等待。cache 以 PID+kernel start stamp 为键，lifetime 检查与发布序列化，旧完成不能覆盖新进程 readiness。

独立受控验证覆盖 16 个 readiness、旧/新发布竞态及两个真实 core 传播测试。现有 Chrome fixture 拒绝 opt-in，accepted-path 真机未验证。500ms 不是整个观察延迟界限；另有下面的 AppKit still-launching 恢复。

### G17 验收发现的原生命名键标志

global chord、desktop held-key 与两个 PID named-key builder 覆写 flags 以隔离显式修饰键，也误删特殊键内在 Function/NumericPad 位。独立原生 event construction 无投递复现，上游 global helper 共有。保留按键码结构位，仅加显式或 session-owned modifier；不复制可能混入物理状态的 factory flags。Fn 本身仍是持有修饰键，释放不自带 Fn。Unicode 与裸转发语义不变，路由、时序、单次派发不变；真实 Space 导航另需效果 oracle。

### AppKit 启动窗口查找（G24 / 上游 #4309）

独立 AppKit 恢复使用上游默认一秒原生 lookup allowance。absolute deadline 共享现有观察起点：从 readiness deadline 减 Chromium budget，再加 launch allowance；Chromium 仍仅 500ms。没有 readiness deadline 就不等待 launch，包括录制和动作 facts；共享起点有回归测试。

仅已知 still-launching 进程的 unresolved window 重试。默认 App 等自然解析，不再 reopen；精确 tree discovery 保留 scope/owner 校验。pause 至多 50ms，给上次 attempt 耗时留余量；丢弃 attempt 释放 AX 和不完整状态，最终 attempt 决定结果。tree 跨重试至多一次 G17 remote-token。它是协作 retry allowance，不硬约束原生调用/整体观察；已完成应用 reopen、node-walk 与外层 timeout 分开。

独立 27 个 actual-function 受控场景、49 个 G17 consumer 回归通过，发现并修复 sleep-overrun：睡眠后、主动 AX retry 前再查 deadline。默认 App wrapper 仍调用普通最终 body，可能再次解析 AX。后续原生 G24 夹具确认唯一公共请求开始时仍在启动，1.056 秒后获得正确 AX 标记，并独立确认启动完成。这验证该冷启动公共链，不能确定具体哪次 retry 生效、证明旧 400ms 路径失败，或给出硬一秒上界；首个 AX IPC 本身可能等待 ready。

### 录制 AX 捕获预算（G30 / 上游 #4215）

录制 callback 在 session lock 外执行，调用方固定两秒 backstop。macOS tree 另有一秒协作 node deadline，保留已完成前缀；普通观察保留各自预算。至多四个 worker、每 PID 一个；超时后直到 provider 真返回才释放 slot，迟到结果丢弃。worker 继承请求 runtime、authorization 和 trusted session evidence，不回退 primary。callback 注册签名不变。

捕获前后检查 generation/owner；仅第二次检查和提交 artifacts 持 session lock，stop/替换不能让旧捕获写入任一新会话。截图隐私与 video stop 边界不变。增加原生线程，不增加进程或公开 budget。

新 Windows recording thread 拥有 COM apartment：成功初始化后，录制专用 raw node binding 全部释放，再 uninitialize；初始化失败或 mode 冲突不释放 apartment，不发布录制节点到 action cache。其他 UIA 调用生命周期不变。

macOS hook 同时接管 walker 对 actionable 节点的额外 retain，复用未发布 snapshot owner 在 JSON 序列化后释放，不替换 action token。实际 walker/hook 加受控 AX、真实 CF count 独立测试复现旧版每次漏一份，修复后重复完整/不完整捕获零泄漏，旧 token 有效，七份 payload 除耗时一致。三项原生回归、Mac/SDK all-target 通过。这是所有权测试，不证明 GUI、序列化失败或实际 elapsed-budget 截断。

### 快照身份（G18 / 上游 #3616 和 #3873）

上游要求快照身份与原生 binding 一致。受控并发观察复现旧 App 短 ID 命中替换对象：token 解析和窗口 cache 查找原为两步。

现有 token registry 一次发布 window、index membership、token generation 和不可变自有 native payload；解析持有其 `Arc`。平台 action 使用 bound cache，包括 Windows kind/role/geometry 和 Linux identity/actions，不读最新可变窗口 cache。覆盖默认 App、raw 及交错，无需跨观察/动作持 GUI lock。token 格式、runtime 隔离、同窗口失效和 LRU 不变，不引入上游 SnapshotStore 或新公开 API。

发布影响三端 `get_window_state` 与元素 cache；消费者包括 click/double/right、键盘、setValue、scroll、secondary action、Mac selectText。Mac `ClickTool` 和独立 `invoke_app_click` 都用 bound view。录制 marker 保留准确 binding，不重新解析裸 index。pending capture 拥有原生引用，在失败/取消时释放；runtime/target 清理 registry 所有权，已解析 action 自有 payload 到结束。

退化 Mac AX-window 观察仅撤销调用 runtime 的旧 target，不发布 unresolved tree，不撤销别的 runtime。三端 `clear_target` 同时撤销当前 runtime token。watcher 只有证明窗口/进程已关闭才跨 runtime 清理。session dispatch guard 延后 end cleanup 至观察结束；取消释放未发布 payload，不在 cleanup 后发布。

验证在竞争快照前后暂停 publication/lookup，要求旧对象身份或 stale 拒绝，覆盖跨 session/raw/App、稀疏 Linux index、Windows UIA/MSAA metadata、引用计数和 screenshot-only。原生桌面验收另计。

### 空闲清理后的隐式会话恢复（G08 / 上游 #4283）

原 idle sweep 会让仍连接的 unnamed MCP/SDK 生命周期永久结束。tombstone 记录是否来自 owner implicit lifecycle 的 idle 回收；仅同 owner 在 cleanup 完成后、原 admission 边界重建，在 tombstone lock 下复核后删旧并插入下一 episode。命名、显式 end、transport exit、revoke 保持终止。daemon adapter 早期 mirror 允许此唯一 recoverable 状态并跟随 core revive。SDK/MCP 共用 admission。

重建不恢复旧资源。snapshot 带私有 publishing session 身份，仅清理该 owner 的 binding；App 短 ID、capture scope、grant、recording 已有 owner cleanup。测试未完成 cleanup、错误 owner、命名/显式/transport 终止、并发 admission、重建后旧 raw token，再重复真实 direct MCP idle-TTL 复现。

### 原生 Electron 后台滚动（G05）

Electron 忽略后台 wheel 时，上游 #4861/#5079 通过原生辅助功能 reveal。它是应用原生动作，不用上游 browser API。先复现候选拒绝并与上游比较；native before 确认候选五次拒绝、偏移不变，stock 0.35.4 四次单请求分别使 inner+114/page+404。

适配几何与 clamped-row 选择，保留合同：证明精确窗口/原生祖先，选最内层相关容器，至多一次 `AXScrollToVisible`。不复制上游固定 150ms effect wait 或不确定派发后换容器重试。返回派发 ACK，下一观察取证；preflight 不存在可拒绝，不确定不能回放。Browser SDK 不在变更内。

只读选择限 4,000 descendants、depth80、私有一秒协作搜索；安全选择失败则派发前拒绝。native proxy 与进程 mutation lease 在 blocking worker 中保留到最终 exact gate 和唯一 AX action，包括 async caller 取消。AX 错误后返回不确定 ACK/警告，不换路由；限制不硬截止挂起的原生读。

普通 v3 通过五格真实 Electron fixture：raw inner/page×AX/pixel，加默认 App inner；每格一次请求，独立 fixture IPC 读 inner+114 或 page+404，另一层不变，保持未确认 ACK。独立 exhausted-inner 复现 v2/v3 单次 down 却向上96px。普通 v4 重跑五主格，并通过 raw/App exhausted 拒绝，真实 `sent:false`、偏移不变。七格不证明全部方向、真人并发或更短采样间隔的干扰。v2 受控43项、v3四个几何单测与 v3 受控程序启动超时分开保留。

exhausted 诊断确认容器正确，但上方旧 row 被报为底边1px sliver，reveal 使方向反转。v4 用既有 visible-leaf 集合排除文档顺序错误侧候选：down/right 在最后可见 leaf 之后，up/left 在第一 leaf 之前。不新增原生读/动作，不改真实 frame 选择。没有可见锚点时保留旧 heuristic，重排/多列 AX 图仍需另验；这是限定修复，不是普遍方向保证。

普通 v7 以源树 `70001802535ebff45ed2f9bc8a0a55b0ba7edfb6f07d1c76aae1b5eb6a002693` 和 SDK SHA-256 `4d2b048131c42055991f1716b41691715da9abf3b7b176fc125548a12dff60fe` 独立重跑七格真实 GUI，全部通过，无回放或前台回退。独立 fixture IPC 确认同样 +114px/+404px 和耗尽边界偏移不变；143 个采样保持 A 前台/顶层、鼠标位置与剪贴板计数。634 项引用已逐字核验。8.444–12.213Hz 采样不证明不存在更短干扰或真人并发。

### macOS release 替换恢复（G36）

真实 release 分支在复制失败时丢旧 bundle；两个隔离 before 场景确认复制前或部分复制失败都留下坏 executable symlink。适配 #3297 的 staged validation/backup/rollback，保留现有 bundle 路径和签名身份。动旧应用前验证下载 bundle，copied bundle 和 executable 通过前保留 sibling backup；复制/验证失败或可处理信号恢复旧字节。恢复失败保留 backup 并报路径。process kill/断电不能运行 trap，不声称自动恢复。

以旧 designated signing requirement 验证 replacement，准确报告权限连续性。不移植自动 TCC reset，安装不改授权记录；Mac local-build cleanup 延后到 replacement 成功。保留 installer、daemon、bundle location、permission owner，不引入新 service/helper 架构。验证使用隔离目录和受控系统命令，不是真实应用/权限安装。

### 其他已验证上游移植

| 来源                  | 适配和证据                                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #4967 / #4214         | Linux 顶层 frame 重定位和本地 XRes PID fallback；真实 GTK before/after 修正错行输入及无 `_NET_WM_PID` 的窗口发现，限实测 Xorg 环境。                            |
| #2907 / #4690 / #5137 | Mac 窗口点击选单一 native 路由，中键保留精确 window；mini 两轮 parent/sheet 去除重复事件。                                                                      |
| #3755 / #5125         | Mac 截图用绝对系统路径，窗口几何拒绝非有限数；窄 PATH 真截图和 CFNumber 回归通过。                                                                              |
| #5136 / #4333 / #3975 | Windows console 继承、GDI 失败清理、shortcut 环境路径解析；实际 MSVC 测试通过，交互桌面另待验。                                                                 |
| #3277 / #4985         | embedded 环境过滤保留显式 telemetry/update-check 偏好。                                                                                                         |
| #3462 / #4888         | typed schema 去 Schemars 专用 numeric format，声明用兼容 dialect，runtime 校验仍权威；声明测试/离线 MCP wire 与真实 provider 分开。                             |
| #3632                 | 录制仅 owner session/隐式 trusted connection 的动作，忽略 lifecycle；独立测试发现隐式 owner 漏洞，二次修复通过命名/隐式/外来连接/lifecycle 公共 registry 验证。 |
| #4238                 | SCK stop 等 recording-output 完成 callback；mini baseline 复现误报空文件及返回后增长，新候选五次120ms录制均立即解码，一秒后 hash 不变。                         |
| #3328                 | display scale 用当前 mode backing pixels/points；同 Retina 显示器公开值由1改2，坐标派发另有合同。                                                               |
| #3714 / #5144 / #5145 | encoder exit/timeout 明确报错；recording 时间用同一开始基线、action ISO-8601；公开 API 探测验证细节和 metadata。                                                |

此表记录已实现组，不声称每个上游提交均已收口。完整清单与原生缺口见 acceptance ledger；跨平台构建不代替真实效果/干扰。

## 验证边界

忽略的 `.qwen/e2e-tests/cua-upgrade-2026-10-artifacts/` 保存不可变 source manifest、构建日志、协议调用和 fixture 读回。[当前验收快照](cua-upgrade-acceptance-2026-10.zh-CN.md#验收口径澄清2026-10-20) 将早期受控/GNU/Xvfb 检查与后来的真实 Windows MSVC/交互桌面、Linux Xorg/uinput/Mutter、macOS 原生 fixture 分开。均不证明物理真人并发。用户澄清已观察到的 macOS 目标窗口/菜单短暂遮挡可接受；遮挡测量、恢复与功能正确性分别保留。模型成功率、token 与时长等效性仍须实际第二层证据。用户于 2026-10-20 将 OSWorld 安排在发布后，不再作为发布前门槛。

后续验收修复补充上游移植：精确 AppKit key-window records 修复已复现的 sheet Return 失败，内部含 NaN 坐标 mouse 事件，并未解决指针/窗口覆盖。Windows 隔离卸载归属检查覆盖全部 task action，进程/安装范围限选定根目录，已在真实 PowerShell 验证。有限 CLI 命令在有效遥测偏好为 false 时跳过观察 self-wrapper，保留既有偏好优先级和启用行为；该 v21 CLI 改动与未变的 SDK 后端分开验证。运行时/打包附录保留本地开发签名与 installer seam 边界，不证明官方签名/notarization 或正式发布。

### 验收驱动的输入边界修复

Linux v24 在文字前缀、首字符/命名键按下、释放及 flush 全链区分派发前拒绝与不确定送达。事件发送错误即使发生在首次请求按下也保留 sent 不确定性，输入前焦点检查仍可在派发前拒绝。MPX 仅在目标焦点准入后保留请求 pending。失败按下及焦点探测键各作有界 best-effort 释放清理，不把不确定性宣称为完整文字完成。真实定向测试和 fresh Xorg/Mutter 用例分开验证；暂停目标的不确定结果不自动重放，也不计完整送达。

Mac v25 处理同窗应用焦点 AXGroup 明确 AXFocused=false、实际文本后代持有焦点的形态，仅将此条件转入现有完整、唯一、有界的实际焦点搜索。未知焦点、跨窗焦点及其他角色保留原行为；PID/窗口检查和末尾焦点/窗口复核均不放宽。LibreOffice ASCII 插入已实际通过。原 Cmd-S/AppleEvents 保存仍 UNKNOWN；独立 v25 工具栏 Save 有真实 FODT 证据。可接受的目标窗口/菜单短暂遮挡仍保留测量。单独 AX settable/edited 标志不证明编辑生效或文件已保存。

### v26 全局指针读取目标的拒绝

真实 Calc 请求以 C5 为目标，却选中 B28。精确 LibreOffice VCL 源码用全局硬件指针计算鼠标回调坐标，而 PID 定向点击不移动硬件指针。借鉴上游 #4864 的安全原则，本 fork 通过现有 NSRunningApplication 边界识别正式 `org.libreoffice.script`，在输入前拒绝其定向像素点击、右键、双击及元素像素回退。旧 raw foreground PID 路径也拒绝，仅激活窗口不能解决坐标不兼容。已广告 AX 动作与安全的 AX 可编辑焦点/选区路径保留。这是限定应用身份的规则，不是上游通用映射库检测，不声明覆盖改名或无 bundle 的 VCL 目标。规范公开 Mac 投递仍固定后台。

v26 tree `9bb4ffe40e1801d750f5a71ae20ea354293fe8bff01f0191554a7ca1facaabe3` 相对 v25 仅改这三个 Mac 工具。独立新文档的公开契约回归返回 background_unavailable/sent:false，三次有界同窗 Name Box 读数均保持 A1。通过的是安全拒绝，不是后台 C5 选区成功；raw AXPress 真机等价仍另行判定。历史严格零遮挡判据未满足，但用户随后澄清已观察到的目标窗口/菜单短暂遮挡可接受。原生/源码/构建证据与保留的原 harness 断言失败见 v26 验收检查点。

### v27限定Writer可编辑焦点

官方 LibreOffice Writer 正文暴露无广告 action 的 AXTextArea，且 AXValue/AXFocused 可写。中间 v27 候选只允许此 bundle 的 textarea 进入默认 App 分支的可编辑焦点路径，保留两项属性门禁、精确归属、单次无修饰左键条件及保持原值的焦点读回。通用 textarea 不获得该捷径，raw 路径保持 v26 原样。mini 新实例的原生读取证明，仅增加准入仍无法建立焦点，尽管 AX setter 返回成功。

F31 在单次 AXFocused setter 前增加既有精确窗口的后台键盘焦点准备和既有只读选区查询。同版本 LibreOffice 的 caret getter 会初始化 cursor 缓存/context，这说明了该读取的目的。不写选区、不移动 caret、不替换正文、不回退像素。未查询 caret 的原 observer 在 mini 新实例的一次 App 点击前后读到同一种子正文 false→true，随后一次输入和一次工具栏 Save 得到完全一致的实时正文与已保存 XML。保守确认及 sent/unconfirmed 回执保留：先观察后续状态，不重放。准备失败前可能已发送原生焦点 records，不能据此宣称未派发。已否决的仅准备、写选区试验分别保留源码和真机证据。

准备过程保留既有键盘目标歧义门禁，因为精确窗口 records 前可能发送 PID 级 ReturnKeyFocus 通知。单独 AX 元素绑定不能证明在多个键盘目标间发送该通知安全。两个新 Writer 正例各有一个文档窗口，不通过删除安全门禁来启用或宣称任意多窗口焦点切换。
