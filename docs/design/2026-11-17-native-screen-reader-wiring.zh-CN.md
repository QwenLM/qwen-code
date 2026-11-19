# Native screen-reader 呈现接线

[English](2026-11-17-native-screen-reader-wiring.md) | [简体中文](2026-11-17-native-screen-reader-wiring.zh-CN.md)

## 状态与问题

历史初始检查点：基于 main fdd 的 CLI 候选完成了本地验证，与信号或 watcher 改动独立。这些结果属于较早候选，后续变更需要各自验证。build、typecheck、lint、格式和 bundle 通过，21 个完整测试文件共 1,148 项通过。四个有界真实 PTY 用例通过：Native screen-reader 基础交互、工具批准与历史、普通图形回归、安装后的 Node26 → 私有 Bun screen-reader 交互。它们仅资格化下列流程，不代表全部无障碍或最终已合并 main 候选。真实 VoiceOver/NVDA 验收仍为 NOT_RUN。

Root 较早的全局 qwen 0.22.0 基线完成 screen-reader /help、返回输入、输入标记及 quit，自然退出 0，未请求模型（71824/34a6850）；它校准现有 Ink 行为，不证明实验性 Native selector 支持。

本候选之前，请求 screen-reader 时 Native 回退到 Ink，strict Native 下报错。npm 私有 Bun handoff 也拒绝该模式。本候选之前，plain-text、policy、writer helper 没有 Native 生产消费者，纯测试并未提供可访问的应用。Native 隐藏 banner 是已经存在的较小行为。

### 公开 API 可行性 checkpoint

2026-11-17，隔离公开 API 见证在 Bun 1.4.4、OpenTUI 0.5.10 下通过真实 PTY 输入 `ab`、Tab、`c`、Enter 完成。两个真实 InputRenderable 改变焦点和值，已有 plain writer 追加输出。setup、交互、teardown 共 131 个捕获字节均无 ESC、图形标记或 alternate-screen 切换；进程自然退出 0，无清理信号。它证明该有界配置下真实键盘输入与 plain 输出可共存，不证明生产 screen-reader 验收。

独立完成帧见证 21033/3bc55b/0 保留上述输入，在变更后取得公开 `frameId: 2` 资格；公开 `frame` 事件在 native render 返回 `rendered` 后发出。131 个捕获字节无 ESC 或图形标记，进程自然退出。它仅资格化本 Bun/macOS 公开 API 通道，Native 应用状态、reader 可用性和其他平台须另取证。`pause()`/`stop()` 不保证停止绘制，`suspend()` 会断开输入。因此候选使用 `bufferedOutput: 'memory'`、`screenMode: 'main-screen'`、passthrough 输出、关闭鼠标/console overlay，且 shutdown 不清屏。

## 目标与边界

为核心键盘会话提供真实、无 DOM 的 Native 呈现：prompt 输入、完整与流式消息、工具权限决策、焦点变化、错误、help、取消及退出。复用已有 command、permission、session 和 model owner，不能以固定公告或第二套 dispatcher 代替。

第一工程门槛是在真实 strict Native 进程中完成核心流程，不等于全部无障碍、全部 dialog、VoiceOver/NVDA 验收或移除 Ink 完成。未覆盖的交互能力必须明确列为验收缺口，不得静默执行权限动作，也不得将截断的功能集称为完整实现。

## 当前 owner 与接入点

| Owner         | 现有源码                                                                                 | 拟承担责任                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Flag/settings | config/top-level-options.ts；config/config.ts；现有 Config getter                        | 保留 CLI 优先于 settings 及 restart-only 设置，不增 Core 字段                                       |
| 启动选择      | utils/npm-runtime.ts；opentui/renderer-selection.ts；llm.tsx                             | 仅在 Native 通路真实实现时协调两个 screen-reader veto，保留运行时不支持及启动失败行为               |
| Native 启动   | opentui/start-opentui-ui.tsx / OpenTuiEntryApp                                           | renderer 创建前解析策略；拥有唯一 writer、生命周期、启动警告、replay 和流式投影                     |
| Shell/交互    | opentui/opentui-app-shell.tsx；input-prompt-model.ts；input-submission.ts；dialog models | 复用真实 submit、command、permission 动作及当前 focus state，将真实控件留在内存，输出其公开语义文字 |
| 输出          | a11y-screen-reader.ts；a11y-plain-text.ts                                                | 复用清洗与静态追加，按 owner 抑制未变的语义文字                                                     |
| 退出          | 现有 exit-lifecycle.ts 及共享信号                                                        | 释放呈现与输入订阅，保留 cleanup、确认窗口和退出码                                                  |

不引入 React DOM、Ink render、Core 私有 import、screen-reader 检测猜测、新 flag、通用 event bus 或 settings schema。

## 呈现与输入

真实 entry 为其 renderer 拥有唯一 `ScreenReaderPresentation` 与 writer。在公开完成帧读取语义 getter（`TextBufferRenderable.plainText`、编辑值/光标、`MarkdownRenderable.content`、select 选项/index、table content），不读取已绘制 cell buffer，也不解释颜色。现有 shell、composer、dialog 保持输入及权限动作所有权；绑定真实选中状态的明确 ID 标记自定义 tab/option，用户文本中的箭头不能推断为选中。

现有 transcript 组件仍是历史呈现来源，包括 Mod 替换、工具结果、警告、图像文字占位及 help notice。screen-reader 模式复用现有行窗口和 spacer，包括最多 400 个原生挂载条目的兜底限制；完整历史仍保留在会话模型。沿用 Shift+Up/Down、PageUp/Down、Ctrl+Home/End 滚动命令，在同一 scrollbox 中访问历史且不移动输入焦点，窗口变化时播报实际条目范围，与之相邻的不变导航提示只播报一次。对话框、待批准权限和已聚焦 shell 保留其按键。较早消息在对应窗口挂载时仍从原 Mod 渲染子树读取，不另建 formatter。kind/ID/tool segment 身份绑定精确语义子树；不重复输出未变文字。assistant 正文等待 streaming=false，thinking/tool 正文等待 done=true，再于已完成帧播报当前完整语义子树一次；task 与 retry 卡片没有结算形态（模型在其结束时移除），因此各播报一次，之后的进度 tick 与倒计时重绘保持不动；原取消/错误结算保留已产出的部分文字。结算后同 ID 的实质编辑仍可追加带 Revision 标签的完整内容。不写任意字符串后缀，因为按行输出会把单词拆碎（Hel → Hello）。活动工具输出不反复回放，其真实权限对话框和 working 控件仍保持可用。历史键盘导航的真实 PTY 与 reader 可用性仍须验证，不能据此宣称完整无障碍。保留原卡片级展开及内容限制，不是无限制导出。历史与已结算控件使用 writer 的 appendStatic，不擦行；实时可编辑值（输入框与对话框输入行）使用其动态块，只替换自己此前的行，因此一次按键不会追加整份字段的副本。静态输出按终端宽度硬折行。控件在 Config/session 范围按真实 renderable owner 比较，只追加改变的语义值，抑制未变选项和 spinner/计时动画；dialog 打开/关闭及真实焦点返回 prompt 有明确反馈。API-key 输入与 sensitive extension setting 在遍历子树之前输出 Protected input，不读取其值；原 preview 的 API-key/header mask 保留。
复用已有 Native 按键解析和输入/提交模型。可打印文本、光标/编辑键、Enter、Tab/方向键、Escape 与退出必须到达图形路径相同的应用 callback。批准/拒绝必须恰好结算原 pending 请求一次，不能从输出通道推断批准。

screen-reader 分支将现有真实 controller/renderable 树保留在内存，不能在 plain writer 旁写出图形输出。`screenMode: main-screen`、`useMouse: false` 和 passthrough external output 是公开 OpenTUI 选项，但本身不能证明输出非破坏性。公开组件见证先资格化 memory 通道，下列真实 entry 用例验证了 writer 与实际状态/动作在有界流程中共存，不证明每个可达交互或 terminal 组合。不能伪造 WriteStream 或调用私有 renderer 实现来强行达成；若必要流程无法使用公开 0.5.10 通道，应在该发布边界保留 Ink，并精确记录缺少的能力交上游评审。

writer 清洗不可信 model/tool 转义。本候选生成的擦行控制仅来自动态块对实时可编辑值的自我替换，历史与已结算控件仍为只追加；早于呈现通道的原终端协议探测独立，不据此宣称整个进程原始输出零 ANSI。不得以 alternate-screen 切换、鼠标报告、装饰性重绘或优化 wrapper 干扰可读历史。真实 reader 验证决定动态更新是否可用。

## Session 与清理

每个存活的 Config/session owner 只有一个 writer。owner 替换或卸载后拒绝旧异步完成，包括 A→B→A。明确保持 clear/resume 语义：新 owner 的 replay 一次，resize 不重放未变的语义文字，布局引起的卡片文字变化仍可能作为修订播报，clear 清除当前语义 transcript，不得复活旧 owner 消息。不能为通过输出测试而改变持久化或工具授权。

退出前释放精确 keyboard、focus、output 订阅，不加 keepalive timer。复用原 quit、Ctrl+C/Ctrl+D 和 OS signal 策略。现有 Native 信号失败独立保留，screen-reader 实现不得放宽窗口。

## Gate 协调与安全回退

不得单独发布删除任一 veto 的改动。仅在同一候选真实提供呈现通路后，同时更新 renderer selection 和 npm handoff，覆盖 direct Bun 与公开 npm/Node→private Bun 入口。若 screenReader 参数的全部读取已消失，应同步移除，而非保留死 capability 开关。

运行时不支持或 Native 启动失败时，保留现有 non-strict Ink 回退与 strict 报错。strict Native 成功必须记录真实 Native，不能提供 Ink 却播报 Native 标签。开发期间已有 Ink 用户保留可用路径。若发布更小能力子集，需维护者明确同意并诚实限定范围，不能据此关闭完整 Native screen-reader 门槛。

## 验证与验收

1. 实现前以全局安装 qwen、隔离 settings 且无真实凭据 dry-run，记录实际已支持的 Ink screen-reader 交互；实验性 Native selector 不受旧版本支持时不能据此推断其 fallback/strict 合同；它仅校准计划，不证明候选。
2. 测试真实 entry/shell 消费及 Native 按键事件：flag 优先级、策略选项、history/stream owner、聚焦 prompt/permission/help、取消和清理。纯转换测试仍只是辅助证据。
3. 执行 build、typecheck、受影响完整测试文件、lint/format、bundle。有界 strict Bun 公开 PTY 用例须验证 Native 身份、一次受控响应及真实权限结算、可读顺序、去重、owner reset、正常退出。公开 npm handoff 另测，不手写 GC flag。
4. 确认不支持运行时回退及普通图形 Native 行为不变。不能从模拟策略描述符推断 Windows 或 Linux 验证。
5. 真实 VoiceOver/Terminal 或 NVDA/terminal 会话检查朗读顺序、prompt/focus 可发现性、重复播报和全键盘完成；记录设备、terminal、reader 版本及未测组合。PTY 断言不能证明该结果。

## 实现顺序与决策

先用公开 API 建立真实终端输出/输入可行性见证，再以聚焦回归测试接入已有语义 owner 与 writer，最后协调启动 gate 并执行公开/辅助设备验收。这些是顺序门槛，不授权一次实现全部 dialog。

### 本地验证

已验证的生产源码 tree 为 `fcdbcccfeeaddf1a520d22e4000b990451618417`；本文后续修改仅同步验证状态。编译入口 SHA-256 为 `f1f6792c03434768a40174185f46325d2e444c614e468d2bf7e5efc3ba42ef60`。它们是本地候选身份，不代表最终已合并 main 的结果。

| 流程                      | 实际结果                                                                                                                             | 边界                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Native screen-reader 基础 | help/焦点返回、prompt 与完整 URL 光标编辑、受保护 API-key 取消；27 阶段、0 模型 HTTP，helper 清理前自然 0                            | 源码 bundle，Darwin ARM64，Bun 1.4.4/OpenTUI 0.5.10                                         |
| Native 工具/历史          | 一轮用户输入、三次模型 HTTP 均关闭、真实 allow-once shell 执行及精确 owned 文件、help 重绘前后完整回复一次、自然 0                   | 不含 deny/clear/resume 或实际朗读资格                                                       |
| 普通图形 Native           | 真实 alternate screen 和 composer、help、编辑/取消及自然 0；0 模型 HTTP                                                              | 仅 screen-reader false 回归                                                                 |
| npm 安装入口              | 真实 Node26 launcher、已安装私有 Bun 与映射的已安装 native 库、受保护输入流程、捕获的身份在原 5s 内且 helper 前自然消失；0 模型 HTTP | owned Node26.4.0/兼容 npm11.17，安装使用 `--ignore-scripts`，不代表启用生命周期或全平台覆盖 |

软件光标回归先因 `hello world` 被拆行且空白丢失而失败；七处真实输入行接入原始公开文字拼接后，原断言通过。准备失败另行保留：Root 的路径排序检查与输出父目录遗漏都发生在应用启动前，不是产品失败，也没有删除负面结果。

旧候选曾重复播报 `/quit`。后续候选（源码 71b98f88a9f7eb7241b8f3bf0497243edabe7b0f，入口 e0acc54e80fd5b18bdfadb183d9dc58c4bc7542f6b43dfc36695080424dae816）的回归及正常检查通过（355 项相关测试及构建、类型检查、lint 和 bundle）；新 strict Native 工具/历史 PTY 流程观察到退出调用与摘要各播报一次，保留真实批准的 shell 文件效果及三次已关闭模型 HTTP 响应，并在 helper 前自然退出（新 owned PTY：自然退出 0，无 helper 终止）。原重复结果保留，不据此宣称全部历史或真实 reader 可用性。

Root 仍拥有以下后续项：clear/resume、真实 reader 可用性、长历史及其他平台仍待验收。不能用全局文本去重吞掉有意重复的消息。发布边界与这些呈现取舍需维护者评审，不得据此宣称完整 screen-reader parity。

install、build、typecheck、测试和公开 PTY 均由 Root 执行。真实辅助设备可能需要用户或设备会话，未取得不能宣称通过。维护者评审应决定呈现兼容性和发布边界，而不是让可审查候选停留 Draft 的理由。

开放问题：生产交互/可读性覆盖、现有卡片展开及动态更新的可用性，以及首批支持哪些真实 reader/terminal 组合？本提案不代表全部 a11y 通过。

### 评审修正检查点

已真实复现两项回归（23133/181354）：活动 assistant 前缀在结算前被播报，以及 2,500 条历史绕过原生挂载上限。上述修正复用真实结算字段和既有窗口/导航模型。组合修正候选通过 13 个完整文件的 1,033 项测试，以及完整 build、typecheck、lint 和 bundle，包括 16 项内存 C1 边界用例及 transcript 生产者到 presentation 的回归。应用自有语义模板与 18 种历史角色标签使用既有九语言加载器，真实中文提示输入/光标流程已通过。同一 source-bundle 的五组 Native 流程在 helper 清理前自然退出 0：2,500 条记录恢复、首中末导航、清空后新会话身份，真实工具授权与历史，未保存密钥输入保护与撤销，普通图形交互，中文 Unicode 光标播报 3/0/1。独立英文 Unicode 用例虽然观测到正确的 3/0/1、一次 quit 播报及摘要，却未满足原五秒自然 PTY 退出条件。一次带身份观察的诊断自然退出而未重现该失败，不能据此关闭原生命周期失败或判定原因。较早的 UI 多出一项（2,501，而磁盘仍为原 2,500 条）尚未分类；两次清空观察器错误与产品改动分别保留。真实 reader 可用性、生命周期稳定性、支持平台、最终安装产物及最终合并 main 候选仍待完成。
