# Computer Use 升级验收记录（2026-10-16）

[English](cua-upgrade-acceptance-2026-10.md) | [简体中文](cua-upgrade-acceptance-2026-10.zh-CN.md)

实现以 [讨论结论](cua-upgrade-2026-10.md) 和 [平台移植清单](cua-upgrade-platform-ports.md) 为准。工作位于 `lazzy/cua-upgrade-2026-10`，基于 `a8eb74fdf5b60851e1fc4a8e258e043273df4411`。版本 `0.26.0` 是开发目标，尚未发布；F31 原生检查点完成时尚未推送、创建 PR、合入共享分支或运行发布工作流，隔离的本地合并验证提交分别记录于下文。此后的 PR 提交决定见下一节。

## PR 提交与评测安排（2026-10-20）

用户已授权提交本次功能 PR，并明确将 OSWorld 评测放到发布后。下文原生/运行时验收事实保留原候选身份和边界，未执行的评测不记为通过。发布审计还将三个 Computer Use npm 包从 CLI 版本更新及发布中排除，保留其统一 0.26.0 及依赖发布顺序。本次提交步骤没有要求执行正式发布。

## 验收口径澄清（2026-10-20）

用户确认 mini 已解锁，澄清此前观察到的 macOS 目标窗口/菜单短暂遮挡可接受且符合预期，并要求重新对比 Codex。严格零遮挡不再是阻塞项。下文历史严格判据的失败仍作为真实遮挡测量保留，不表示遮挡已消失，也不证明 macOS 无法避免它。功能正确性、精确目标归属、请求修饰键语义、不确定后不重放与恢复分别核验。

剩余真机 GUI 测试和新对照均在 mini 上执行。此前本机 Writer 准备阶段未发送文档动作；随后放弃的本机对照准备也未发送 Codex 动作，并已清理。本地工作限于源码、编译、包及合并验证。OSWorld/模型评测仍延期。不可变澄清记录与新用例报告保留在工作树的忽略证据目录。

已采纳的 F31 修复通过 mini 两个新实例的 Writer 后台流程：原 observer 在一次公开 App 点击前读取精确种子正文未聚焦，点击后读取已聚焦；一次输入改变正文且文件不变；一次工具栏 Save 将完全一致的正文保存为有效 FODT XML。此前 v27 负例及已否决的 F28/F30 试验分别保留。F31 在既有 AXFocused 写入前使用现有原生焦点准备和只读 caret 查询；公开回执仍保守，未确认动作不重放。原生 tree 为 `6abc23df3e6066a73f5110bfe77c041def4cc90852b5c5d6bde9ae537033eec3`（453 项原生加 12 项支持输入）。两个成功 Writer 用例各有一个文档窗口；既有键盘目标歧义保护保留，不据此宣称任意多窗口焦点切换成功。

mini 新 v27 画布、下拉和右键菜单原生效果 3/3 通过，接收修饰键及恢复均有记录；F31 改动仅限官方 LibreOffice 文本区。新要求的官方 Codex 对比结论为无法比较：即使使用当前安装包匹配的 bundled CLI 和 mini 既有消费者 profile，仍在应用绑定阶段以 app-server exit `-10005` 退出，未派发任何原生动作。另行普通 stdio 初始化成功，原因尚未确定。不据此推断 Codex 功能失败、性能差异或零遮挡。对照自有服务、socket 和夹具已清理，共享远程服务保留。

## 本地实现

P1–P6 的代码和打包改动已落在独立 worktree。Node REPL 只暴露 `js/js_reset`，默认 30 秒，预载全局 `cua` 和当前平台文档。Driver 管理应用/窗口解析、短 ID、三平台观察 diff、截图坐标和派发错误；直接 MCP 默认 19 个操作。macOS 保留后台 AX/定向事件；Windows/Linux 仅在明确派发前拒绝时转前台。显式桌面输入和 held keys 绑定会话，正常结束/reset 等待释放。浏览器接口直接返回仓库 browser-use SDK 的对象，未修改浏览器功能。

Native Wayland 实现已删除，X11 应用（包括 XWayland 中的 X11 应用）保留。SDK、原生、browser-use 和 Node REPL 统一为 `0.26.0`；独立 npm 安装使用固定版本依赖，原生包按校验和下载。Windows 默认安装无需签名 UIAccess worker；显式 opt-in 仍校验签名和安全安装路径。Qwen CLI/core 的产品差异只有删除两个 bundled `SKILL.md`。

本地检查点：P1 `cf89555254`、P2 `d2995a50c5`、P3 `b7c4d9c86c`、P4 `56a3ec2ba5`、P5 `fcc473d4a6`；P6 由本记录所在提交承载。

## 已取得的证据

| 范围              | 结果与边界                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库构建/类型     | 根目录 build、typecheck 通过；最终 browser-use 类型检查通过。                                                                                                                                                       |
| Node REPL         | 68 个相关测试通过，含真实子进程 reset/dispose 异步清理。独立 tarball 在无仓库依赖的消费者目录安装，通过文档预载、变量持久化和 reset 验证。                                                                          |
| SDK / browser-use | SDK 51 通过、6 跳过；浏览器 594 通过。浏览器包装测试使用原 SDK，无 Chrome GUI 成功声明。三个 npm 包均实际打包，仅执行 publish dry-run。                                                                             |
| Linux 原生        | 独立 ARM64 容器中 locked all-target check、SDK/driver 构建通过。规范坐标测试 38、Computer Use 测试 5 通过。Xvfb 真实桌面链 96/96、App 坐标链 29/29；实际 display resize 跳过。                                      |
| Linux 首次安装    | 实际 archive/checksums HTTP 下载、缓存命中、残缺修复、坏 SHA 拒绝、缺 checksum 拒绝及 postinstall 14/14；从下载缓存加载真实 SDK/桥并完成 GTK 输入/截图/按键释放链 14/14。不是 native override 或开发 symlink 验收。 |
| macOS 原生        | all-target check、ARM64 和 Intel SDK/桥构建通过，组合的两个 universal 文件均包含 arm64/x86_64。仅在 ARM64 主机执行加载；未声称 Intel 运行或 notarization 验证。                                                     |
| Windows           | GNU 交叉 all-target check 通过；未执行 Windows 桌面/UAC 测试。派发后 UIA 错误和 worker 断连的纯状态回归确认不再发送第二次点击。                                                                                     |
| 发布配置          | 同版本约束、依赖发布顺序和 production gate 测试通过。工作流没有被触发。                                                                                                                                             |

收尾审查修复了三个消费者问题：旧归一化环境变量重复变换规范像素坐标；Windows UIA 派发后错误被当成可再次点击；直接 MCP initialize 仍给出旧工具和归一化说明。对应失败复现与修复后证据分别保留。

最终原生源清单为 P6 v5：688 文件，树 SHA-256 `c8a662cdc5c53eaa4cbbd14b146b8e844a86fc060d1b8f16a8f7bb4014c7dbee`。v5 再次通过 Linux/Windows GNU all-target、真实 MCP initialize/list 11/11、精确桌面链 96/96、实际下载 14/14 和缓存加载 SDK GUI 链 14/14。v5 SDK/driver 重新构建；桥因源和 ABI 未变，明确复用 v2 的 fresh build。早期 v2/v3/v4 证据仍保留各自版本。

详细原始日志与独立测试报告保存在当前 worktree 的 `.qwen/e2e-tests/cua-upgrade-2026-10-artifacts/`，主报告为 `.qwen/e2e-tests/cua-upgrade-2026-10.md`，P6 报告为 `p6-validation.md`；自审记录位于 `.qwen/investigations/cua-upgrade-2026-10/parent-self-audit.md`。

完整差异和消费者自审在修复后连续两轮无新发现，独立测试工程师的 P6 边界复核为 CLEAN。当前环境未提供 Codex `/review` 工作流，未使用 Qwen Review 代替。

## P7 历史检查点（2026-10-19）

mini 已解锁，并通过既有 GUI Node 宿主执行真实 AppKit 输入、截图和按键生命周期测试。Windows 已完成真实 MSVC driver、SDK 和固定版本 Node bridge 构建；Linux 在 ECS 内的 Ubuntu Xorg guest 执行真实 GTK/AT-SPI 测试。早期“锁屏”与“仅交叉编译”的限制不再描述全部当前状态，但 P6 的历史结果仍按原产物保留。

上游 `0.20.0 → 0.35.4` 的核对发现 P4 清单之外仍有适用修复。当前源改动及证据包括：

| 修复                                          | 证据及剩余边界                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux 左上角窗口坐标偏移（#4967）             | GTK 同场景修复前点到相邻行，修复后精确命中目标行。                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Linux 缺少 `_NET_WM_PID`（#4214）             | 同窗口移除属性后，修复前丢失发现与观察，修复后通过 XRes 保持正确 PID、窗口、AX 和截图。                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Linux 临时键盘映射生命周期                    | 候选与上游共有：目标 GTK 主循环忙碌 3 秒时丢失 remapped Unicode。队列屏障候选在 GTK/Chrome 忙碌场景完整输入；最终 v5b 对超时正常返回 sent/unconfirmed，无回放；无协议支持在输入前拒绝。未代替物理 MPX 或所有 toolkit/IME 验收。                                                                                                                                                                                                                                                                                           |
| macOS 非有限窗口尺寸（#5125）                 | 真实 CFNumber 测试修复前失败、修复后通过，保留正常和负坐标。                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| macOS 截图 PATH（#3755）                      | 真机窄 PATH 复现 ENOENT；新候选在窄 PATH 和正常 PATH 均返回真实 1920×1080 PNG。                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| macOS raw 点击（#2907/#4690/#5137）           | 同 PID 父窗/sheet 复现中键丢窗口和双份事件；新候选两轮真机复测恢复精确窗口与正确目标事件对数。默认 App 中键原本正常，未混为同一路径。                                                                                                                                                                                                                                                                                                                                                                                     |
| macOS Electron 后台滚动（#4861/#5079）        | 正常 v4 SDK 七格真机通过：raw page/inner × AX/pixel 和默认 App inner 保持页面 +404px、内层 +114px，另一滚动区不动；内层到底时 raw/App 均真实拒绝、sent:false、两偏移不变。此前 v2/v3 的 down 逆向 -96px 保留为 before；只读原生诊断确认上方 ROW35 被误报为底边片段，v4 以可见文档顺序排除错误候选。每格一次请求，无重放、前台回退或浏览器接口，主路径仍为未确认 ACK。六项几何单测通过；v2 受控 43 项与后续受控程序启动超时独立保留，未称 44 项通过。普通 v7 独立重跑七格并全部通过；不是全部方向、AX 布局或真人并发验收。 |
| 元素 token 与原生对象绑定（#3616/#3873）      | 真实 core/token/cache 受控交错复现旧 token 读取新对象；新候选通过 capture/resolve/reverse 三种交错，三端消费者编译通过；Windows native-v2 MSVC 缓存回归 5 通过、2 明确跳过，token 30 项通过。该复现未执行 GUI 点击。                                                                                                                                                                                                                                                                                                      |
| MCP schema（#4888）                           | 默认 19 与 EXTRA 70 个真实 wire 声明通过离线兼容检查；运行时仍拒绝非法目标组合。未请求真实模型 provider。                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Windows GUI 宿主控制台（#5136）               | MSVC 测试确认无控制台宿主不弹控制台，有控制台宿主保留继承。                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Windows 截图失败资源清理（#4333）             | 实际 GDI 分配及失败注入测试通过，连续失败无 handle 增长；交互桌面截图尚未验收。                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Windows 快捷方式环境变量（#3975）             | 真实 IShellLink 修复前返回不可用字面路径，修复后解析目标且保留参数。                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 隐式会话空闲恢复（#4283）                     | 同一真实 MCP 连接等待约 34 秒后恢复调用；显式结束/命名会话保持终止，旧元素 token 失效。                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 录制归属/停止/时间（#3632/#3714/#5144/#5145） | 公共入口验证命名归属、encoder 错误和时间修复；独立复测发现隐式连接遗漏，二次修复通过同连接/跨连接/lifecycle 回归。                                                                                                                                                                                                                                                                                                                                                                                                        |
| macOS 录屏完成时机（#4238）                   | 真机修复前出现 false empty 和成功返回后文件增长；新候选 5 次 120ms 短录制均立即可完整解码，一秒后文件 SHA 不变。                                                                                                                                                                                                                                                                                                                                                                                                          |
| 录制 AX 预算与会话锁（#4215）                 | 真实 ToolRegistry 加受控 provider 的独立 before/after 证明：挂起的 after 捕获不再阻塞 state/stop；2 秒返回上限、同 PID 忙碌拒绝、迟到结果丢弃和 stop→start 隔离共 6 项通过。Windows 录制线程 COM 初始化/节点释放顺序两项原生 MSVC 测试及全目标检查通过；不是 GUI AX 挂起验收。                                                                                                                                                                                                                                            |
| macOS Retina 缩放元数据（#3328）              | 同一真实显示模式 3600px/1800pt，公共接口修复前返回 1，修复后返回 2；未据此推断默认点击坐标错误。                                                                                                                                                                                                                                                                                                                                                                                                                          |
| macOS 辅助应用识别（#3456）                   | mini 同一已安装 accessory 应用，修复前 default/running_only 均丢失运行状态；native-v3 两个公共入口均返回实际 PID 9402。保留精确安装路径与所有运行实例，不以同 bundle ID 误认其他副本。                                                                                                                                                                                                                                                                                                                                    |
| 输出路径含目录符号链接（#4210）               | manifest 与公共 ToolRegistry 分别验证：修复前拒绝实际 `/tmp` 等目录别名下的新文件，修复后规范化授权路径并仅派发一次；目录外、断链和文件父节点仍拒绝。不是 GUI 截图验收。                                                                                                                                                                                                                                                                                                                                                  |
| Windows named pipe 错误清理（#4279）          | 私有 Win32 pipe 复现创建失败与释放后恢复；源码加入有界重试及统一 PID/SDK 清理。native-v4 实际 MSVC driver/SDK 构建通过，缓存 6 项、token 30 项通过；生产 daemon 重试/清理运行验收仍待交互桌面入口。                                                                                                                                                                                                                                                                                                                       |
| 卸载 MCP 配置归属（上游 `ff770f5d5` 等）      | 独立临时 fixture 验证五类 foreign 配置不再误删，按本次选定待删除 payload 的真实可执行路径清理。没有执行完整卸载；后续删除失败时配置可能已先提交，原字节备份可恢复。                                                                                                                                                                                                                                                                                                                                                       |
| typed schema 数值格式（#3462）                | 上游回归用例修复前失败、修复后通过；输入/输出保留合法格式与字面值，contract 37 项及生成器 1 项通过。                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Windows 安装器祖先进程保护（#4398）           | 独立 12 项受控清理/legacy 委托验证通过；按 PID 清理并保护祖先，存在 driver 祖先时跳过任务级 End。密封 UnitOnly 通过，未改变用户 PATH 或执行真实任务/完整安装。                                                                                                                                                                                                                                                                                                                                                            |
| Windows 自动启动与隔离安装（#3180/#4284）     | 32 项独立受控测试、MSVC 11 项原生单测、补齐编译夹具后的全目标检查通过。取消/null 不再报成功、替换前不先删除任务、隔离 release 安装保留共享任务。真实 UAC、Task Scheduler 原子性、登录启动和完整安装仍未验。                                                                                                                                                                                                                                                                                                               |
| macOS release 安装失败恢复（#3297）           | 两项实际 shell 分支 before 复现复制失败丢旧应用；适配后 18 个隔离场景及 350 项独立核验通过，涵盖 staged/复制后校验、复制/rename/link 失败、恢复失败保留备份、首次安装、TERM 与重复清理。已加入旧字节恢复等长期回归测试。只验证受控文件事务，没有执行真实安装/签名/权限操作；不移植自动 TCC reset，不声称 SIGKILL/断电自动恢复。                                                                                                                                                                                           |
| Chromium AX readiness（#3783）                | 16 项实际函数受控测试、2 项旧/新发布竞态对照、2 项实际 core 预算传播测试通过；共享 500ms readiness 预算，不为动作/截图/录制新增轮询。真实 Chrome 拒绝 opt-in，accepted 路径尚未验收。                                                                                                                                                                                                                                                                                                                                     |
| AppKit 启动窗口恢复（#4309）                  | 1 秒主动查找额度共享原观察起点；27 项实际函数受控验证和 G17 外层消费回归 49 项通过。修复睡眠后预算已耗尽仍主动重试的问题；Mac 单测 1 项及 Mac/SDK 全目标检查通过。最终 App body 和原生 IPC 不受此硬限时约束，真实 AppKit 启动时序尚未验收。                                                                                                                                                                                                                                                                               |
| 普通 macOS AX 遍历预算（#3882）               | 真实遍历函数受控 before 确认普通 raw/App 在 1 秒后继续读取；修复后 27 个遍历场景和 3 个节点准入控制通过，准备时间独立、完整树恰好到期不误报截断，录制绝对预算和 legacy 节点上限行为保留。真实 core ToolRegistry、默认 App、Mac 版本/cache/token 消费链完成 6 次受控快照与 22 项独立核验，旧 ID 拒绝、已解析绑定不漂移、部分结果警告及清理均通过。Mac 树 6 项、缓存 4 项、core 版本比较 27 项单测及 Mac/SDK 全目标检查通过。完整平台/SDK/GUI 路径仍待验收；没有整体调用 1 秒硬截止或真机慢 AX 延迟结论。                   |
| macOS backing-store 截图（#4996）             | 独立受控 after 32 项通过；当前 Space 下 public/private raw/App 四链返回正确 PNG。后续正常候选在 B 位于 Space68、前台 A 位于 Space1 时，raw/App 截图内容与五处 ROI 通过，二者字节一致；capture 段 120 个采样均保持 Space1 和 A 前台/顶层，模拟输入 6/6 到 A。正常库未记录实际私有路由，不能据此归因；全屏退出按钮预置不成立使通用整轮结果仍为 FAIL，自有进程终止后清理通过。                                                                                                                                               |
| macOS 遗漏 AXWindow 恢复（#4068/#4085/#4509） | 四个原生文件已补精确 PID/SPI ID、受限 remote-token 和默认 App/树/facts 消费者；Mac 单测 3 项与 Mac/SDK 全目标检查通过，独立探测边界 24 项与外层实际消费函数 49 项通过。真实遗漏 AXWindow 验收尚未完成。                                                                                                                                                                                                                                                                                                                   |
| macOS 特殊键标志                              | 真机 Space 准备失败后，无投递原生复现确认候选和上游共有结构位丢失；四条 named-key builder 修复后通过原生 128 键码对照、显式修饰/释放与环境隔离验证，原生单测 11 项及 Mac/SDK 全目标检查通过。正常新候选单次 Ctrl+Left 后，独立 Space oracle 在调用起点后约 638ms 确认返回 Space1；没有补发，B 未收到被系统消费的 Left，不推定其真实事件 flags。                                                                                                                                                                           |

Linux 稳定 nested Xorg 的焦点/结束会话批次 31 项通过，一项 TCG 时序不足保留为 inconclusive；正常响应时 Unicode 与映射恢复通过。后续受控暂停 GTK 主循环 3 秒时，候选和上游都出现 13 个 remapped Unicode 按键变为 NoSymbol，已独立定位临时映射恢复过早；原主 GNOME 冻结批次仍单独保留为环境混杂。客户端 ping 实验在 GTK/Chrome 通过，但 Chrome 回应早于 DOM 输入完成，不能作为语义成功证明；native-v5a/v5b 已分别验证机制与最终返回契约，超时仍可能丢字，必须先观察再决定下一步。

MPX 已改为确认准确虚拟键盘的完整有序批次；未确认/发送失败的设备保留 pending，下一请求在改映射、焦点或输入前拒绝。首次设备预热也须完整确认，并先于临时键码规划。独立受控生命周期测试由 before 的 7/10 违反变为 after 10/10 通过，13 项事件匹配回归、12 项 Linux 原生单测及全目标检查通过。真实内核跨批延迟、设备热拔插和物理 MPX 仍未验收。

macOS T04 在 native-v3 的三轮独立真机测试中均发生目标窗口升层，持续覆盖用户窗口至测试结束（约 3.1–3.3 秒）；用户窗口保持 front/key，模拟输入全部到达。双查询诊断确认全窗口列表与实际可见层序不同；第一版改为可见列表后，重新激活应用仍返回成功却未恢复层序，首轮失败。第二版只提升当前前台的 AXFocusedWindow，三轮已消除持续覆盖，但仍有 99.4、200.5、192.8 ms 瞬时覆盖，**零干扰门槛未通过**。后续一次只发准备事件的独立诊断未观察到覆盖，不能排除采样及现有 guard 掩盖短暂升层。另一次仅把请求 pair 改用公共 CGEventPostToPid：精确源 PID 的 mouseDown、原生 field editor 与强制最终 AX 焦点均确认点击生效，但 A 自身仍观测到 194.110 ms 覆盖，独立 WindowServer 层序口径为 196.695 ms；公共 publisher 未显示补救效果，未改生产代码。该格 10/10 模拟按键到 A，实际点击调用内仅一键、已观测覆盖期间零键，不证明覆盖时真人输入安全。T06 菜单、T10 目标自激活回归通过；显式 Desktop 前台 Unicode 输入精确读回。后续精确窗口 SPI 校验收紧仍须归入新候选验证，不混用前述产物证据。独立双顶层窗口夹具尚未成功启动，父窗/sheet 测试不替代该场景。

Electron 后台原生滚动已完成上述主路径移植及七格真机验证，包括已复现的内层逆向边界。无可见锚点时保留原几何策略，重排或多列 AX 图谱仍不在此次证明范围。普通 macOS AX 树的有界部分结果及实际消费者受控验证已完成，完整平台/SDK 真机慢 AX 边界待验。跨 Space 截图已有上述真机效果证据；准确 AX 窗口恢复、Chromium accepted readiness 和 AppKit 启动恢复仍须完成各自真机边界。此次跨 Space 公共 AX 返回 85 个元素但明确不完整，未证明 remote-token 实际恢复。默认 App 选窗、动作前校验和观察结果转发均属于核验范围，不能只改 raw walker 就报完成。其余可选原生/安装路径的取舍见逐提交覆盖台账。

全差异自审还发现 macOS 录制钩子未接管可操作节点的额外原生引用。独立测试复用实际 walker、hook 与缓存，受控 AX 数据加真实 CoreFoundation 引用计数证明：修复前三次调用累计泄漏 1、2、3 份，修复后完整及不完整树的重复调用均归零，既有 token 保持有效，七份 JSON 除耗时外一致。修复复用现有未发布快照的所有权对象，不注册或替换动作 token；三项原生回归测试通过。39 项证据已逐字核验；不将受控引用测试计为真实 GUI/AX 验收，也未验证序列化失败或真实预算截断。

同轮独立测试用完整实际工具模块配合受控 provider，复现 raw 双击和右键在语义效果发生后返回 AX 错误时继续投递像素动作。已尝试的 AXOpen/AXShowMenu 现在直接返回 sent/unconfirmed 正常响应和警告，不回放；成功语义路径及未提供语义动作时的像素路径保留。完整原生工具模块的双击六格、右键四格受控复验通过，三项不确定响应经真实 core 公开投影和 typed 校验后仍为 unverifiable/accessibility，警告保留。复核发现的 foreground 请求被误记为实际前台方式也已修复：未执行前台事务的 AX 路径明确报告 background。新增原生投影回归与既有路由单测通过。默认 App 提前转发是对照，不推定默认 App 受影响；尚无真实 AX 服务器“生效后报错”的 GUI 证明。

G34 的 #5124/#4856 一律禁止 native omnibox 粘贴/换行策略明确不采纳：已定合同允许 selected App/window 当前焦点的合法原生输入，ASCII Return 与非 ASCII AX 插入分开验证，插入读回不证明导航。hotkey、pressKey、paste 三个入口分别核对。#4835 的冷前台字段/选区差异仅属 raw/EXTRA，默认 App 不可达，保留窄范围待复现，未引入 AllWindows 或固定稳定等待。

G07 最新生产入口实测表明 SSH Session0 在 SDK 创建时就因缺少交互用户会话而退出（23ms），尚未进入 named-pipe 接受循环；私有 pipe 不存在，共享驱动未变。管道本身可运行于 Session0，但这不等于当前生产入口可达。G23 第二版独立启动诊断正常编译，唯一启动 8 秒无 readiness 或阶段日志。后续同一 binary、相同普通 Node 启动路径的一格诊断，原 8 秒窗口结束后仍未就绪；一次 1 秒进程采样 exit0，仅得到 89 条 `_dyld_start +0` 主线程采样，映像信息不可用，不能定位具体等待机制。独立 Electron 宿主加任务自有 native addon 夹具正在准备；此前两格仍未执行，两格均未派发 AXPress，后续诊断完全不创建 SDK/AX 会话，没有据此推断 TCC/EDR 原因或修改安全设置。

499 条上游变更已完成逐项分类，原“证据不足”和“仅引用 P4 未复核”项已归零；仍有适用差异待复现、移植或明确取舍，分类完成不等于验收完成。2026-10-19 最新 JavaScript 整库 build、typecheck 通过，SDK 测试 51 通过、6 明确跳过；缺少 corepack 的首次构建失败保留，后续使用任务内入口和本机已有工具/固定缓存版本完成，未全局安装。当前普通 v7 的 453 文件统一原生清单通过 Mac/SDK、Linux/driver/SDK 和 Windows GNU/driver/SDK all-target 检查，默认 SDK 构建通过；12 个精确编译支持文件另列，树为 `70001802535ebff45ed2f9bc8a0a55b0ba7edfb6f07d1c76aae1b5eb6a002693`。Linux x64 和 Windows MSVC 的 driver/SDK release 均从此清单构建通过；Windows 本轮 2 项 COM、11 项 autostart、1 项有界捕获回归通过。Linux 当前正常 direct-MCP GUI 批次 GTK 7/7、Chrome 3/3 通过。相对 G05 v4 新增上述录制引用及 raw 语义错误不回放修复；v7 独立七格滚动真机全部通过，使用 SDK SHA-256 `4d2b048131c42055991f1716b41691715da9abf3b7b176fc125548a12dff60fe`。独立 fixture IPC 确认 inner +114px/page +404px、耗尽边界偏移不变；143 个层序/鼠标/剪贴板计数采样均保持 A，自有进程和 LaunchAgent 已清理，共享进程生命周期不变；主代理逐字核验 634 项引用。8.444–12.213Hz 采样不证明零瞬时干扰或真人并发。未变更 core 沿用八项通过的精确源检查点。12 个精确编译支持文件另附清单，早期遗漏夹具的失败保留。P7 第一轮已覆盖 89 个当前变更路径并发现上述问题；后续完整一轮干净审查之后，第二轮发现设计文档缺少双语版本，补齐翻译后连续干净计数重置。最终更新范围的完整两轮干净自审尚未完成。三端完整真机回归仍在进行。详细 before/after、无效批次与产物身份保存在 `.qwen/e2e-tests/cua-upgrade-2026-10-artifacts/p7-*`；不得把历史 P6 检查结果用于证明后续 P7 改动已全部通过。

## 外部验收历史检查点

Windows 普通 SSH 已恢复，当前 console/runner/共享驱动生命周期已核验。用户明确批准独占临时任务 `\QwenCuaP7Acceptance`：无触发器、现有 Administrator InteractiveToken、Limited、不保存密码、最长两小时，完成后核验并删除；当前 v7 交互验收正在准备。未借用其他进程令牌。用户也批准 mini 现有 Node 控制 Finder/TextEdit 的正常 Automation 对话框，以及本任务所需的测试机权限；无需修改 TCC 数据库。Linux 独占的真实 uinput/evdev/Xorg 链与原 nested guest 分开记录，nested Xorg 本身不证明物理用户输入、MPX 或 XWayland 验收。

工具层三方对照与 OSWorld 20 题模型评测尚未完成。此前两个模型的 provider 400 保留为历史失败记录；2026-10-19 当前配置的 gpt-6.1-sol 已通过全局 qwen 0.25.2 文本预检和真实 CLI→MCP→Node REPL 单次代码执行。合成图像预检第三次有效调用返回实际 PNG，模型正确识别四项颜色、形状和位置（2 次模型请求、1 次工具调用）；前两次超时/代码转录拒绝均未输出图像，独立保留。未创建原生桌面会话，不能视为 GUI 验收。20/20 个本地题目定义已定位并冻结，均默认 Linux，仅两题有明确 Windows 分支；历史 macOS/Windows 适配正在恢复。mini 两处既定线索的有界只读核查覆盖 1003 个非凭据文本文件，未命中目标组；已有 stable20 是另一版题目与 scaffold，不能替代。执行数为 0，当前模型与历史基线的 gpt-6-astra 不同。用户已明确批准只读导出历史 macOS 组 `group-5cff67aa55934a09a45160e3194b5801-s1` 与 Windows 组 `group-bc7a3539903b4735bc3508e04e5791d5-s1`。每次真实 AP 请求均通过 mini 官方 AP Client 0.5.1 的准确入口门禁，已取回 group/jobs/eval，artifact 导出进行中。原始导出仅留 mini 私有目录，不向本仓库或本地证据复制凭据。两组各有 20 个 terminal Succeeded job，但不等于题目成功：Mac 均分 0.2613、1/20 通过，Windows 0.1206、0/20 通过。模板提交分别为 `d1b8341d17659205b9aa735e0390f54301be0dc7` 与 `b70f9f90b3df26f177d78279bc942490f7cc37e7`，二者均用 azure.gpt-6-astra，与当前预检模型不同。未授权或执行任何新 AP 提交、重试或取消，没有匹配条件下成功率、token、轮次、耗时或 Codex/上游改进结论。这些发布前验收条件仍然有效。

## P7 v13 历史验收快照（2026-10-19）

本节是 v13 当时取代早期检查点的历史快照。其中身份和开放项仅描述该检查点，当前范围及后续验证见下方。

### 当前候选与分发

当前原生冻结版为 v13：453 个生产/构建输入和 12 个精确编译支持文件，tree SHA-256 为 `c43e1b300706eff833a9999f889b7f7c418a414b6863d3b3c102ca339770f83c`。Linux 使用新编译的 v13 CLI/SDK。macOS 测试使用正常默认特性的 v11 SDK（`4131a02af8d64a88572e981dbd9dfa5e7d0eaa9ec5ac5509be341c159d59ce9d`）；Windows 使用原生 MSVC v10 可执行文件（`c5ca0054810eb4512986aef0f6231e81497ada15d1809bcb9bd5521016ef3fca`）与 SDK（`91f871c885e13e856ee8284af0efed149232abbf58d9c7fc4584dee3d1f02283`）。中间仅 Linux 的改动仍需逐目标编译输入等同性审计，才能让其他平台的产物支持当前验收。

三个待发布包的 npm pack 本地 dry run 均通过，版本统一 0.26.0：CUA SDK 34 文件、Browser Use 9 文件、Node REPL MCP 46 文件。全库 JavaScript build/typecheck 通过，SDK 51 项通过、6 项明确跳过。完整当前工作树快照与 main `a250fd033941cab10c88d6eb8beb5756405193b9` 的合并无冲突；该检查仅创建 Git 对象，没有更新分支/ref，没有 push、PR 或发布。最终格式检查和两轮完整连续干净的源码自审仍待完成。

### 原生修复与实际效果

- macOS G23 已取得真实 AppKit AX server 证据：v10 四格覆盖 raw/default App，handler 切换状态后返回 NO 或抛 NSException。每格仅一次请求、一次效果。异常返回正常 sent/unconfirmed，不重放指针。返回 NO 仍可能得到 AX 成功，单独保留。v11 回归待执行。
- macOS 默认 App T04 对支持的原生文本框，单次无修饰左击走精确可编辑 AX 焦点。v11 三次 fresh 点击用例独立确认 field editor 与 fresh AX 焦点、值不变、未观察到遮挡。已观察的 canary 字符均到 A，但三次 click 请求窗口都没有新 keyDown，不能证明输入并发。完整 click 后 type 回归通过，正在补高频重叠测试。仍抬高 B 的纯指针诊断变体未采用，也不计修复通过。
- Linux MPX 成功派发现在携带明确 background/LinuxUinput 执行记录，避免实际文字已到达后公共接口返回 action_outcome_mismatch。完整有序 raw-key 确认、pending 设备拒绝与会话清理阻止超时后的重放。
- Openbox 3.6.1 将虚拟 master 的 core FocusIn 提升为全局激活。fresh 零按键对照归因到 WM/Xorg 行为。v12 对该已识别 WM 在映射、创建设备和输入前拒绝 MPX 键盘；六项原生请求返回 background_unavailable/sent:false，零输入。公共 hybrid 路径随后可仅一次走 foreground。原前台、core focus、指针、映射和层序最上窗口恢复；低层窗口顺序仍发生可观察变化，不计后台零打扰。Mutter 42.9 对应后台测试保持更强的完整层序。
- Linux AT-SPI InsertText 的长度单位为 UTF-8 字节，而 caret offset 仍是字符位置。旧实现与上游 0.35.4 都会截断真实混合文本。v13 在派发前修复共享长度换算。十项 native/public/SDK/facade 用例精确回读中文、emoji、组合字符与非零 caret 插入，零 raw-key 事件。读回不改变运行时保守的 sent/unconfirmed 投影。

### 平台验证与剩余原生工作

Windows v10 完成 14 项原生回归、68 项 direct MCP/SDK/native/Edge 检查、10 项生产 Node REPL kernel 检查和 12 项普通私有 production serve 检查。后两者分别验证真实 kernel 生命周期及管道归属，并非 Node REPL MCP wire GUI 会话或注入后续 pipe instance 创建失败。普通 serve 支持低层 CuaDriver.connect；保留的 ComputerUse.connect 仍要求认证会话归属，不能绑定该普通 serve，文档已写明。WinForms 后台样本保持 A 与指针；Edge 输入按合同走唯一允许的 foreground fallback。上游 0.35.4 的 12 项 native 与 8 项 Edge 检查达到各自预期。没有可核验的 Windows Codex 入口。

Linux v13 的 53 项 focused native 测试、all-target 检查和 release 构建通过，一个既有 ignored 测试保留。十项语义 Unicode/caret 用例及 real-kernel MPX smoke 通过。v12 在私有真实 Xorg 显示上另行覆盖 native/SDK/Node facade 的响应、阻塞、超时、pending 拒绝、forget 后 fresh 生命周期。外部输入中止使用独立自有 uinput 设备，并非真人物理设备。软件渲染 Mutter 容器与 nested Xorg 均不冒充共享 GNOME、原生 Wayland、真人并发或 VM 性能证据。

macOS v11 完整 fixture 矩阵已执行，详细独立复核仍在进行。剩余观察保留为失败或限制：sheet 输入被 same_pid_keyboard_ambiguity 拒绝；WKWebView 输入被 no_focused_text_input 拒绝；两项短层序重叠样本待归因。非文档原生文本框 AXValue 已替换，但 fixture delegate 回调缺失；该更强回调 oracle 仍为 false，不增加第二次输入制造回调。正常 TextEdit 保存与 Finder 重命名仍需完成已获批的 Automation 回归。仅凭剪贴板 generation 不能证明内容已恢复。

Windows 临时任务已删除并读回 absent，runner 已退出，自有辅助进程均清理。Limited 任务配置与内置 Administrator 实际 High integrity 分开记录。共享 driver/进程寿命保持。Linux 输入进程与临时设备已移除，私有显示 fixture 保留供最终清理。macOS 持桌面互斥锁，仅清理精确归属本轮的进程与 LaunchAgent 身份。合成 canary 与采样的焦点/层序观察始终与物理真人证明区分。

### 匹配模型评测

已获批的只读 AP 导出完成，每次实际请求前都对 mini 上官方 AP Client 0.5.1 执行版本门禁。含凭据的原始导出仅在 mini 私有位置保留。两组历史评测使用 qodercli 1.1.52 和 azure.gpt-6-astra，镜像/template 版本不同。macOS 平均分 0.26128、1/20 passed；Windows 0.12058、0/20 passed。任务状态 Succeeded 不等于任务成功。历史 token 是不可用的零填字段，不是零消耗；Windows 仅 13 条 trace 有完整最终轮次/时间指标。

已找回精确 baked macOS pilot cases/plugins，20 项指令均与 AP 导出相同。Windows 19/20 相同：历史 001 指令写 Calendar.app，而恢复的 Windows override 正确指定 Thunderbird Calendar。基础镜像层的 seed、真正 runner/generic scorer、网站与依赖正在按完整 layer hash 和各平台 overlay 恢复。setup 必须保护现有文件/profile，仅清理本轮 listener/进程；Calendar 持久化、应用、codec 或网站依赖缺失必须让 preflight 失败。scorer/gold 不提供给自主模型。

fresh 匹配比较必须固定 harness、任务 seed 字节、指令/rubric、模型/provider 与预算，只改变预定的新旧工具栈。历史 Qoder 结果仅为参考，不能充当该控制基线。当前 gpt-6.1-sol 的全局 Qwen CLI 文字、真实 Node REPL 和合成图片传输检查通过。mini 独立部署的生产 Node REPL MCP 也已通过现有 SSH 连接验证 initialize、精确 js/js_reset 列表、真实 kernel/preload、reset 与 EOF 清理，未转移模型凭据、未创建原生 GUI 会话。当前候选 OSWorld 实际执行数仍为零。成功率不回退与轮次/token/耗时门槛继续开放；未宣称性能提升或三方持平。

## 历史前四项范围（2026-10-19）

用户现阶段优先要求完成 macOS、Windows、Linux X11 真机验收，以及运行时、安装与打包检查。Codex/上游比较及 OSWorld/模型评测延后。未来模型调用已配置为 `gpt-6-sol`，本范围不新增模型/AP 任务。前四项通过不等于延后的模型门槛通过，也不授权发布。

### 候选身份与已完成检查

已验证的 v21 原生源码冻结版本包含 453 个生产/构建输入与 12 个支持文件，tree SHA-256 为 `11b0fafab2419448a16542a73cde08cea58ee67b3a7b922fdfe12fee456f9dad`。相对 v20 仅 CLI 入口改变：有效遥测偏好为 false 时直接执行有限命令，省去无用的观察子进程。偏好优先级与启用路径保持。macOS 后端仍为 v20 SDK：签名前 SDK 二进制 SHA-256 为 `886bf05463a6c8273d0125b28482ee4f5ba8e9c1cffe5b4d5230e5fef2e77eee`，候选 Developer ID 签名后为 `134b334ea8b7e912e51ac0c27383d71b6c245e17b8f99f69cbee6e08c07fb064`，代码段等同性已独立核验。Windows/Linux 后端输入与各自 v19 验收产物逐目标等同；新 CLI 检查保留自己的版本标签。

- macOS v20 fresh 通过 sheet 输入与单次 Return 确认、WebKit 点击/输入/提交、精确粘贴与剪贴板类型/字节恢复，以及双窗安全拒绝/正向输入。生产 Node REPL MCP 的八项真实 wire/生命周期检查通过，部署源码/依赖身份精确。C9 TextEdit Unicode 保存与 Finder 语义重命名另有独立磁盘读回。Finder inline 键盘重命名无法证明原生 parent/window 归属时安全拒绝。内部 key-window 准备包含 NaN 坐标 mouse records；旧 Swift JSON logger 会漏记，先前“无内部鼠标事件”的说法已撤回。
- Windows v19 实际 MSVC 检查/构建、37 项 focused 测试通过，保留各自明确身份的原生 GUI 回归。生产 MCP wire 动作在 WinForms 一次真实生效后超时，没有重放，reset/EOF 清理通过。完整 CI 形态包通过自有 fresh、正式旧字节布局升级、repeat、uninstall/purge。显式部署 unsigned UIAccess 被拒绝，不声称真实 signed UIAccess 或 ARM64 原生执行。当前隔离卸载器通过 14 项实际 Windows PowerShell 回归，包括 owned Exec 与 foreign ComHandler 混合 task。共享进程受保护，临时任务已删除。
- Linux v19 的 53 项 focused 测试、一个明确 ignored 测试、实际 release 构建，以及 native MCP 初始化并列出 19 项工具通过。真实 Mutter/Xorg/uinput 输入保持完整采样焦点/层序并精确输入 Unicode；生产 Node MCP 的 15 项真实 AX 读回检查通过。CLI 安装与 SDK 冷/热缓存测试使用完整包。Openbox fallback 恢复原前台/最上窗口，但低层层序改变，不计后台零打扰。自有合成输入与物理真人并发分开。
- 三个 npm 包在 0.26.0 的 dry run 通过；SDK 51 项通过、六项明确跳过。修复后的 Node MCP preload 测试先将 SDK 求值阻塞在已观察的 barrier 后再触发超时，并验证下一次真实请求；整个 MCP 文件八项通过，保留批次共覆盖 113 项 Node 测试。独立 mutation 证据能检出迟到 continuation。安装器 Python 检查 57 项通过、五项明确跳过、四项 subtest。

后续 v22 冻结版本（`de5d5030e7dbf5b3f64c7946dc8d335ee2d988db14e8fe0994226d2f6f980245`）新增仅 Excel 的 Apple Events 兼容修复，并修正窗口层序注释。Excel 使用 full-name1773 和 saved1842，替代缺失的 Standard Suite 路径/modified 属性；唯一保存前严格匹配完整路径及大小写。精确路径和不匹配路径的只读 argv 检查通过。六项既有 Apple Events 单测、Mac/SDK/CLI all-target 检查与 ARM release 构建通过；SDK 二进制哈希为 `04d996ff2b51337bf07a72da408dee0ea0b987081b209bb680e28e8eb3f92499`。ARM 与 Intel release 构建通过。fresh v22 原生 Excel 保存也已通过：唯一保存 316.586 毫秒返回，modified 从 true 变为 false，独立 XLSX oracle 确认 A1 精确标记且 B1 不变；两个旧 dirty 文档未改。该格点击仍观察到 48.937083 毫秒覆盖，因此只计保存功能通过，不计零打扰。以下更新后的 v22 Mac 包检查也已在披露范围内通过。Windows/Linux 目标输入未变。

### 运行时、安装器与包验证

v21 Windows/Linux CLI 附录现已通过实际构建、既有遥测偏好/关闭测试、默认关闭与显式关闭有限命令、native MCP 初始化/列表/EOF 和当前自有安装/repeat/purge。287 份文件与四个完整包已由主控独立核验哈希及成员。

mochi 上一致的 v22 macOS 候选对 CLI、theme、SDK 与 bundle 使用现有产品 Developer ID 团队 `NF4574S59H`，无时间戳、未公证。签名后 SDK 哈希为 `5a0dd6d011e633fee9bd6b751444ee82430cc0c8632a5ab43e5c4143cfa93946`，打包代码段与 fresh ARM/Intel 输入相同。ARM 与 Rosetta Intel 的有限命令/native MCP、安装后 ARM、SDK 冷热安装和生产 Node MCP 十二项均通过。新装、实际完整签名 0.17 bundle 私有副本升级、重复安装共十四项断言通过，替换产物满足旧签名要求；原全局 bundle 与 v21 产物不变。主控独立核验了全部 636 个普通证据文件（tar 总共 738 个条目，含 102 个目录）、四个包及其成员、原生身份，以及 CLI/theme/SDK/app 的全架构签名。未改动的 CI NAPI 产物保留其 Intel slice 未签名的已披露边界。

这些检查在披露的自有/本地候选范围内完成 v22 第四项：macOS ARM 加 Rosetta Intel，Windows/Linux x64 通过目标输入未变核验。安装测试采用已记录的目标路径/可写性/下载/stop-helper seams，文件系统、签名与替换操作真实执行。两项真实 rollback 故障用例保留自 v21，安装器源码未变，不冒称本轮 fresh v22 故障测试。共享服务受保护，证据不延伸为 stock 全局替换、Windows signed UIAccess、ARM 硬件覆盖或正式公证。此前 installed ad-hoc ARM 启动失败仍保留，一致 Developer ID 候选无需改变安全策略即可通过该安装后运行路径。原有绝对路径 nested-local SDK 导入缺陷保留，base/current loader 字节相同；installed bare-package 与全局 `cua` consumer 另行通过。

### 剩余门槛与证据边界

macOS 画布指针输入仍使目标覆盖 A 约 100–200 毫秒，虽然前台身份与 canary 到达保持。菜单覆盖也仍开放。实际效果正确、最终恢复不满足零覆盖。authentication、public-post、key-preparation、默认 mouse subtype 与 PrivateSource 诊断变体仍有覆盖，均已否决；私有变体不替换正常产物。PrivateSource 虽然原生效果精确一次，仍覆盖约 199 毫秒。只读因果复核不能证明系统不可实现；这些指针因子都没有处理 AX-only popup 覆盖。后续 fresh 完整省略 preparation 的反事实仍覆盖约 206 毫秒，并丢失原生画布效果，因此也否决该候选。之后的只读复核没有找到有证据支撑的下一项外部 driver 修复假设；这不证明系统不可实现。

正常 v20 fresh 滑块替代路径通过：唯一 `setValue('80')` 同时得到 value80 与独立原生 callback80，未观察到打扰。Excel 原有选中网格状态与 LibreOffice 刚打开文档的状态均在派发前返回 `no_focused_text_input`，不计文档保存成功；Excel Edit 后续通过原生公式编辑栏 description 确认输入标记，通过 A2 确认 Return。首次保存遇到 Automation 弹窗及 caller deadline，结果未知；正常授权后，新文档唯一保存明确返回 `automation_failed (-50)`、`sent:true`，磁盘没有标记；以上 v22 原生保存修复已验证，指针覆盖仍为独立失败。LibreOffice 公共正文 click 后仍聚焦 group；另一次只读正文检查确认 AXValue/AXFocused 可写，但实际焦点为 false。不以替代写入或保存成功计分。原生 still-launching 公共链现已通过：独立确认的已安装 accessory 夹具在唯一 `getApp` 开始时仍未完成启动，真实启动延迟尚余 900 毫秒以上；1.056 秒后返回精确 AX 标记，独立观察随后确认启动完成。动作加 settle 的 20 份层序采样未见自有窗口遮挡，六次合成 canary 均到 A。这不能证明具体执行了哪次 retry，也不能证明旧 400 毫秒实现失败：首个 AX IPC 本身可能阻塞至 ready。先前无请求与 scratch helper 被排除的尝试单独保留。MCP 一项 overlap 前采样有外部 System Settings 窗口在 A 上方，缺少逐 RPC 绝对时间，不能归因给候选，也不能称全程 A 在最上。

不可变报告、失败原始文件和 manifest 保留在 `.qwen/e2e-tests/cua-upgrade-2026-10-artifacts/`，包括 `p7-normal-v20-native-regression-independent-report.md`、`p7-windows-first4-final-v19-20261019.md`、`p7-linux-final19-first4-acceptance.md`、`p7-mac-zero-cover-causal-boundary-review.md` 及各版本打包附录。仅证据的 clean pass 不计入最终完整源码连续两轮自审。先前 main 合并检查属于历史记录，最终源码验证和可合并性仍需覆盖完成后的整树。没有 push、PR、merge 或 release。

### 历史 v25 检查点（2026-10-20）

当前453个原生输入加12个支持文件的 tree SHA-256 为 `6faac284650aeffaa64c5fa6b220ab1799ae25f69f0e68845e21159bf7d50e5a`。Linux v24 修复前缀/首字符/按键释放/flush 的部分派发分类、MPX 焦点准入后的 pending，以及失败按下/探测键释放清理。实际 Linux 定向测试、all-target、CLI/SDK release、私有安装、有限 MCP 及 SDK 冷热检查通过。fresh Xorg/Mutter 四例覆盖公开 CLI 中文/命名键、当前 SDK C ABI trusted-session 路径，以及暂停自有目标后的单次不确定请求。最后一例恢复后仅得到 `a`，回执正确保持已发送未确认；返回、等待1.7秒及结束会话三点没有新增物理事件，不算完整文字送达。主控核验38份证据、原回调、不同旧/新 Xorg 完整日志及自有容器清理；早期尾部片段计数夸大保留原件和勘误。

v25 相对 v24 只改 Mac 精确焦点解析。真实 LibreOffice 失败显示：同窗应用焦点指向明确 AXFocused=false 的 AXGroup，而正文实际 AXFocused=true。仅此精确条件转入现有有界、完整且唯一的文本焦点证明；PID/窗口绑定、跨窗拒绝和末尾复核均保留。ARM 与 Intel CLI/SDK release、六项既有精确目标测试及 all-target 检查通过；新 ARM SDK 的 Developer ID 签名已核验。一致的通用 Developer ID 新包已通过 ARM/Rosetta 有限命令与直接 MCP、打包 SDK 冷热安装、生产 Node MCP，以及14项自有新装/正式0.17升级/重复安装断言。主控独立核验四份归档及全部38个普通文件成员实例、11份结果报告、465个源码/支持 pin 和五项全架构签名。签名保持离线、无时间戳/公证，安装使用已披露私有 prefix/本地下载 seam。完整当前源码自审与最终合并准备仍独立进行；该 Mac 修复未改 Windows/Linux/共享输入。

fresh 原始 T15 的一次公开 ASCII 插入，经独立正文 AXValue 和选区读回确认。唯一 Save 因等待系统 Automation 权限超时，报告 sent:true，独立磁盘没有标记；未重放 Save。LO 即使正文已改变仍报告 AXEdited=false，不能把该属性当保存 oracle。本机 canary 进程没有投递权限：121次 posting 尝试与接收端零 keydown 不能证明 canary 送达或用户输入不中断。数值前台/顶层/指针采样只保留其有界观察范围。上方 LO 焦点结果保留历史身份；正向插入现已通过，文稿落盘验收仍开放。

严格指针/菜单零遮挡仍失败。fresh 签名自有窗口 bit21 正控中，Set 返回0但该位读数未变，随后一次 Clear 返回0且基线精确恢复；不能采用为外部窗口修复。早期无签名 helper 的 SIGKILL/空日志仍阶段未知，不据此断言整个系统不可能。真机门槛、最终检查及当前树合并准备未全部通过前，整体验收和 PR 准备均未完成；没有授权 push、PR 或发布。

### v26 LibreOffice 指针安全检查点（2026-10-20）

上面的 v25 检查点属于历史记录。当前 v26 原生 tree SHA-256 为 `9bb4ffe40e1801d750f5a71ae20ea354293fe8bff01f0191554a7ca1facaabe3`，465项输入 manifest 为 `f16523c3823554f6d0e74d257ee232d768b7b8cebe17a80bf6b787d2591b4042`。相对 v25 仅改三个 Mac 点击工具，Windows、Linux、共享原生输入与 JavaScript SDK 均未改变。

新建 Calc 文档的一次默认公开点击请求以 C5 为目标，但三次同窗独立 Name Box 读数均为 B28。原请求已发送未确认，未重放。精确 LibreOffice 26.2.6.3 源码通过全局 `NSEvent.mouseLocation` 计算 VCL 鼠标回调位置；本次截图坐标反算一致。这确立了全局指针读取与定向事件不兼容的机制，尚不能唯一证明产生 B28 的具体原生回调。

本修复借鉴上游 #4864 的拒绝原则，使用本 fork 现有 NSRunningApplication 身份识别 `org.libreoffice.script`。其 PID 定向像素点击、右键、双击及元素像素回退不再作用于无关的硬件指针位置；已广告 AX 动作与安全的可编辑焦点/AX选区路径保留。旧 raw foreground 指针后端没有移动硬件指针，因此也拒绝。该识别比上游映射库检测更窄，不覆盖改名或无 bundle 的 VCL 进程。规范公开 Mac 动作仍固定后台，不新增 JavaScript foreground 选项。

另一个新文档的 v26 请求明确返回公开 `background_unavailable`、`sent:false` 和请求级 `committed:false`，三次有界同窗 Name Box 读数均保持 A1。通过的是安全拒绝验证，不是后台 C5 选区成功，也不是 raw AXPress 真机等价。原严格 harness 因错误期待公开错误投影不会保留的内部 effect/toolkit 字段而失败，原输出与独立按现有 code/reason/sent/next 契约作出的判定分别保留。SDK 的 `operation.dispatched:true` 仅表示进入 FFI 请求生命周期，不是物理输入证据。

当前 ARM click14、AX-dispatch1、double-click1 定向测试、all-target 检查及 CLI/SDK release 构建通过，ARM SDK 离线 Developer ID 签名已核验。当前源码的包验证与其他真机回归另行记录。临时本地验证提交 `a9fe798b6dac938392f450f2edf55456a6dfc6e0` 保留固定主线 `5dcf7c7cb162e825d95d531081f67ee60da3c0e1` 的实际干净合并；完整8GiB构建脚本201.876秒、正常root typecheck72.948秒均通过，后者含integration且不带NODE_OPTIONS。这些是验证耗时，不是性能对比。此前默认4GiB合并候选/主线失败均保留，v26未重跑或宣称该命令通过。

独立 v25 公开工具栏保存已通过实际 FODT XML 核验，原 Cmd-S/AppleEvents 保存仍 UNKNOWN、从未重放。后续自有窗口 bit21 正控通过，但已信任宿主以正常 caller 修改外窗的试验未改变该位，精确恢复后否决。历史 Codex 画布样本在调用未指定修饰键时收到 Command，来源未知，不能作为普通无修饰点击基线；其 popup/context 组合样本也保留实际遮挡失败。严格 Mac 指针/菜单零遮挡仍 FAIL。源码自审、真机验收和 PR 就绪分别判定；未形成最终 P7 发布提交，没有 push、PR 或 release。

### 历史 v27 Writer 焦点候选——未经真机验收（2026-10-20）

v26包检查点已完成：ARM/Intel构建、定向检查、一致通用归档与全部11组非GUI运行时/安装报告通过。新独立读回核验92份证据、38个归档普通成员、465项源码输入和5项全架构签名。这些包/协议结果不关闭Writer或零遮挡验收。

受控源码切片执行实际v26谓词，确认官方LibreOffice的无广告action AXTextArea即使value/focus属性可写仍会被拒绝。另一次针对保留v25 Writer进程的目标限定只读查询，确认唯一同窗正文、空action及AXValue/AXFocused settable成功且为true。应用级focused element为AXGroup，正文却报告AXFocused=true。这是旧实例真实属性，不是当前动作通过。

中间v27候选相对v26只改click.rs：默认App的单次无修饰左键分支可通过既有可编辑焦点路径聚焦已识别的官方LibreOffice AXTextArea，保留两项settable及当前PID/窗口归属检查，其他应用的textarea仍排除；raw点击实现、通用角色helper及原测试与v26逐字节相同。焦点/值确认规则未放宽：AXGroup不匹配仍可返回未确认，之后须观察；没有像素fallback、重放、光标位置改写或更强成功声明。原生tree为`c52f7cb6ac11aa65a9d7a226c5d4e38f55ee52820bcc4085ed4314b006b40538`，manifest SHA-256为`a3aed6e4f6b77b532395729b611f9817de06bac65c6d64c4811e0ed17c870ad1`，共465输入。定向构建/review与尚未完成的fresh Writer点击/输入GUI验收分开。

最新Writer Stage1因自有sentinel无法取得前台，在LibreOffice及文档动作启动前停止。Computer Use拒绝访问该系统app，系统窗口内容仍未知，没有换通道绕过；mini经新认证只读检查仍锁屏。指针/菜单严格零遮挡仍FAIL。完整8GiB构建/typecheck成功属于本地合并检查点a9fe798b，不是开发checkout全库构建通过。仅计划将之后四份Markdown更新与该Mac Rust增量同步至本地验证快照；继承构建证据时须明确此边界；新验证提交还会改变构建生成的Git commit常量，不能声称编译输入严格逐字节等同。没有最终P7发布提交、push、PR或release。

## F31 原生与分发检查点（2026-10-20）

已采纳 Writer 源码相对 v27 的 click.rs 增加九行受门禁保护的逻辑，与 mini 实测 SDK `091df63289f3542c8d1518f0be0db458863b7f87d4002de281579fca377509ab` 完全对应。两个新文档均在一次 App 点击后，独立读到正文 AXFocused=false→true；各自一次输入和一次工具栏 Save 保存精确 XML，文件 hash 分别为 `83d5fd0c80a0e654d18f55b6d181bfb6be6ca1463a09b1885cad45393071cdb2` 和 `c4d557fa50ab5d7f449891d8fd139f0da24334880a44b31268bdd911f7ab01d1`。主控核验全部 46 份封存证据及每例首次原生读回。指针与文本剪贴板保留各例起始值；最大 122.5/118.1ms 采样间隙不证明全程零遮挡。此前 v27 桌面点击/输入/保存属于另一显式前台流程；原 Cmd-S/AppleEvents 请求仍 UNKNOWN，从未重放。

F31 ARM/Intel CLI 与 SDK release 构建、相关原生及 all-target 检查通过。一致通用包通过全部 11 组非 GUI 报告：ARM/Rosetta 有限命令及直接 MCP、packed SDK 冷热安装、生产 Node MCP、私有自有安装/替换，以及安装后 ARM/Rosetta 命令/MCP。最终 manifest 保留精确 slice/归档/签名身份，并保留离线 Developer ID 签名和私有安装器 seam 边界。一次任务自加的 caffeinate 身份预检在这些检查启动前失败，勘误与随后实际完整运行分别保留。Windows v21 与 Linux v24 保留原真机身份，此后 Mac 改动未改变其目标输入。

新差异的正式 Codex review 提出一项多窗口疑问，已记录并 triage，不宣称零反馈。现有准备会发送进程级焦点 records，因此保留键盘歧义门禁；两个单窗口正例不证明任意多窗口支持。此前完整源码自审保留固定范围；最终更新差异自审、最新 main 默认构建/typecheck、源码等价与 PR 草稿另存忽略的最终就绪证据。本地源码/构建结果不代替原生效果。

前四项范围为三平台原生效果及运行时/安装/分发验证，保留已记录的安全拒绝和不确定性边界。G17/G18/G24 accepted-opt-in 原生覆盖、later-instance 管道故障注入及物理真人并发仍分别未经验证。新要求的 Codex 行为对照在动作前受阻，无法比较；同条件模型/OSWorld 成功率、token、轮次与耗时仍延期。均不默记通过，也未授权发布。
