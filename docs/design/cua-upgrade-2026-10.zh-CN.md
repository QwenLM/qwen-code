# qwen-code Computer Use 升级方案与讨论记录（2026-10-15 ~ 10-16）

[English](cua-upgrade-2026-10.md) | [简体中文](cua-upgrade-2026-10.zh-CN.md)

本文汇总这两天讨论的背景、分析过程和全部决定，供后续实现和查阅。

- 每条决定都标了日期。细节和证据见文末"文档索引"里的分题文档。
- 标注约定：**【实测】** 有测试或数据支撑；**【推断】** 是根据代码或现象做的判断；**【待测】** 需要后续测试确认。

---

## 0. 背景

**范围**

- `packages/cua-driver`：Rust driver。从 trycua/cua 的 `cua-driver-rs-v0.20.0` fork 而来，以 qwen-cua-driver / QwenCuaDriver.app 发布。
- `@qwen-code/cua-sdk`（`packages/cua-driver/typescript`，当前 0.20.11）。
- `@qwen-code/node-repl-mcp`（`packages/node-repl`，当前 0.1.7）。
- bundled `computer-use` skill。
- 浏览器 SDK `@qwen-code/browser-use`（0.25.2），在议题 5 里纳入。

**为什么升级**

1. 市面上的方案有了新进展：
   - Codex 的 `cua_repl`：模型只看到 `js` 工具，文档在运行时下发，`getApp` 自动输出状态，动作返回 void；
   - 上游 cua-driver 到了 0.35.4，两个版本之间有 499 个提交。
2. RecreationBench 和 OSWorld-V2 实验暴露的问题：
   - **质量接近，效率差**：RecreationBench 最终 12 组、450 个结果里，我们和 Codex 官方、QoderCU 质量相当，token 接近，但用时约 1.5 倍；单轮输入在 110–130k，接近 128k 上限，所以成本几乎和轮次成正比【实测】。
   - **轮次多**：macOS stable20 第一轮里，我们的生成次数是官方的 2.47 倍，单次输入是 2.05 倍【实测】。三方都通过的 41 题，调用数分别是官方 4、Qoder 12、我们 28【实测】。OSWorld-V2 的候选方案请求数约为 direct 的 2 倍【实测】。
   - **macOS 一律前台的代价**：09-13 的提交 `0ceac09` 把 macOS 输入改成"一律先激活 B 再输入"，依据是一句被误认的 Codex Windows 文档。改后总时间 +37%；一个 cell 里 5 个动作，我们 8.61 s，官方 1.61 s【实测】。

**总目标（10-15 定）**：用尽可能少的轮次、少的 token、清晰简洁的步骤完成 computer-use 任务。

---

## 1. 总体方向（10-15 定）

1. 和 Codex 一样：运行时下发文档，替代 skill；简化 node-repl 工具（去掉 wait / cancel）。
2. 只维护一套底层服务：driver 始终可以作为底层工具直接调用；node-repl 路径就是 SDK 包装同一个 driver。和上游的同步从"代码合并"改为"移植或引用具体的修复和功能"。
3. 不跟进上游的 `run_script` / `run_steps` 和它的上层调用接口。同步只看底层操作的丰富度、稳定性和效率。
4. 前台/后台按平台单独讨论（见第 2 节）。
5. 评测目标：少轮次、少 token、步骤清晰。

**补充（10-16）**：driver 作为不经过 node-repl、直接调用的 MCP 工具，也必须完整可用。这条路径同样重要。

---

## 2. 前台 / 后台（议题 4）

场景统一为：用户在 A 里打字，Agent 要操作被 A 挡住的 B。

### 2.1 macOS（10-15 定）

**分析**

- 把输入送到 B 只有三条路：
  1. AX 辅助功能动作：按下、写值、设焦点，不需要 B 在前台；
  2. 定向事件：事件指定投给 B 的进程，必要时先单独告诉 B"你已被激活"（下称"合成焦点"），系统真实前台不变；
  3. 全局事件：B 必须先成为真前台，用户的按键和指针都会被影响。
- Codex 和上游都以 1、2 为主，我们反而以 3 为主（`0ceac09` 之后）。
- 我们每个动作后**固定等 1 s**，看有没有新窗口出现（`window_change_detector.rs:152`）。

**决定**

- 设计"AX + 定向事件"相结合的方案，借鉴 Codex 和上游。
- **前台（全局事件）路径先不出现**，Codex 和上游都不用它。
- 核实动作后的等待："如果 Codex 没有任何等待也能正确完成任务，这个等待可能就是影响效率的点"。
- 拖动先试 Codex 的定向拖动；paste 对齐 Codex。
- 设计测试任务，用 Codex 官方和上游 0.35.4 的结果作为预期，在 mini 上验证。

**mini 冒烟的观察**（10-15/16，每个用例 1 次，【实测】但只是预备数据；正式批次已跑完，结果待整理）

- **Codex 动作发出就返回，没有固定等待**：控件动作约 100–150 ms；点开 sheet 后不观察、直接在 sheet 里输入，3/3 成功。冒烟时看到的约 2 s 等待，是 Codex 服务的系统授权弹窗没人处理造成的，弹窗点掉后就消失了。
- **Codex 的合成焦点有效**：B 自认为激活、成为键盘焦点，系统前台仍是 A。靠这一步，它能在后台 `cmd+v` 粘贴、在 sheet 里按回车；上游做不到这两件事，但会明确拒绝，不假装成功。
- **Codex 的缺口**：
  - `typeText` 丢中文和 emoji（0/3），接口照样返回成功；
  - 坐标右键 A 和 B 都收不到；
  - 拖放和列表重排返回成功但没生效，而且 3 次里 2 次吞掉了用户的一个按键；只有拖滑块成功。
- **上游的问题**：
  - 弹出菜单的 setValue 能用，但文本框 setValue 不触发应用自己的变更回调；
  - AXPress 对文本框报错 -25206，而且不回退；
  - 每个动作约 1 s。
- **我们（强制前台）**：通过的用例最多，但每个动作约 1.1 s，B 被切到前台、指针被移动；还 A 时会把 B 刚打开的菜单关掉。

**据此确定的实现细则**（属于已定方向内的细化）

- 去掉动作后的固定等待，动作发出即返回；等待放进观察（见议题 3）。
- 拖放和列表重排在后台**明确拒绝**，并提示替代路径；滑块改用 setValue。不用 Codex 的瞬间拖动。
- paste 对齐 Codex：临时使用剪贴板，事后恢复。
- 输入：ASCII 走定向按键；非 ASCII 走 AX 在光标处插入并读回（避开 Codex 丢字）【待测】。
- 弹出菜单的 setValue 改为"打开菜单并选中该项"（移植上游）。
- 点击：支持"按下"动作的控件用 AXPress；其余用定向点击加合成焦点。
- 移植上游的后台保护：
  - 不给 A 发失焦记录（#4943）；
  - key_focus_guard（#4943 #4955 #5091 #5129）；
  - B 自激活后切回 A，用户 1 s 内动过鼠标或修饰键就不切（#4976）；
  - 鼠标事件显式写修饰键状态（#5051）；
  - 保存和改名用 Apple Events 并读回验证（#5057）；
  - 焦点不在文本框时拒绝打字 `no_focused_text_input`；
  - 写入未生效报 `write_not_applied`。

  这些保护要和现有的 `app_focus.rs` 合成焦点合并成一个观察者。

- Codex 的可见光标：先不做（未表态即按不做处理）。

### 2.2 Windows（10-15/16 定）

**分析**

- 把输入送到 B 有四条路：
  1. UIA 语义操作，不需要前台；
  2. 窗口消息 PostMessage，不需要前台，但 Chromium、WPF、Tk 等经常不认；
  3. 合成指针注入；
  4. SendInput，必须是真前台。
- 三方现状：
  - **Codex**：先激活 B（最多 20 轮，带 Alt 技巧），再用 SendInput；不保证还 A；有用户输入监测。
  - **上游**：后台优先，已知会被丢弃的组合直接返回 `background_unavailable`。
  - **我们 App**：一律激活 B + SendInput（连元素点击都跳过 UIA Invoke），再同步还 A，依赖签名的 UIAccess worker。
- 我们 fork 其实已经带着上游的后台实现（丢弃判定表等），只是 App 层强制成了前台。
- 已知缺陷：
  - 前台打字只等 40 ms 就还 A，末尾的字可能进 A；
  - 文本一次发完，中途不检查前台；
  - **Windows 默认 npm 安装是坏的**：发布的 worker 未签名，安装器却要求签名有效（`install-native.mjs:157`）。

**决定：混合模式**

1. 先走上游式后台：UIA 语义 → 窗口消息 → 合成指针。**只有返回 `background_unavailable`（派发前拒绝，还没有副作用）时，才激活 B 并用 SendInput**。已派发但效果未确认的，报"未确认"，不重试。
2. 还 A：保留"读回确认，用户已切到 C 就不拉回"，补上 #4500（等 B 读完输入再还）和 #4901（逐字检查前台）。
3. 前台段期间用户在操作：与 Codex 一致，检测到就停下报错，不拦截物理输入。
4. 权限：先改用上游的"高权限 daemon + 它启动的应用用普通用户 token"。UIAccess 代码保留，签名在申请中。
5. 语义：`typeText` 一律在光标处插入；`setValue` 一律整体替换。

其余小修：#3671（超时不回退，避免双击）、#4774（combo box 真实选择）、Tk 点击拒绝、VK_LWIN 标志、worker 管道读取加超时。

### 2.3 Linux（10-16 定）

**分析**

- X11 和 Wayland 是两种显示协议。
  - X11 有中心的 X server，应用之间不隔离，可以给别的窗口发事件、截屏、模拟全局输入。
  - Wayland 由合成器统一管理，应用相互隔离，自动化只能靠各家合成器开的口子。
- Codex：只做 X11（26.1007 文档和代码里没有 Wayland）。
- 上游：X11 完整支持；Wayland 默认关闭，打开后也很受限。
- X11 上把输入送到 B 有四条路：
  1. AT-SPI 语义操作；
  2. 定向事件 SendEvent 加 FocusIn（Codex 的做法；GTK、Chromium 常常不认）；
  3. 虚拟第二指针 MPX + uinput（上游的做法，需要真实 Xorg 和 uinput）；
  4. 前台 XTest（我们现在的做法）。

**决定**

- **完全放弃 Wayland，只支持 X11**：
  - 删除 fork 的 Wayland 后端，共 21 个文件（`platform-linux/src/wayland/*`、`video_wayland.rs`、`wayland-helper/`、libei 示例、Wayland 测试和文档）；
  - 纯 Wayland 会话直接报"只支持 X11"；
  - XWayland 下的 X11 应用照常支持；
  - 不再同步上游的 Wayland 提交。
- **按真实使用场景设计**：要考虑共享桌面，测试机只是测试环境。前台段保留"还 A + 检查 C"。
- **与 Windows 同一结构**：
  1. AT-SPI；
  2. 虚拟第二指针（机器支持时）；
  3. 只有返回 `background_unavailable` 时才转前台 XTest；
  4. 前台段期间检测到用户输入就停下；
  5. 已派发未确认的不重试。

  定向事件只用于已知能认的 Qt / Tk / Xt 应用。

- **同步上游 0.20.0 之后的 X11 / AT-SPI 修复**（逐个核对 fork 是否已有）：
  - 输入：#3882、#3761、#3762、#3864、#3618、#4248、#4188、中文丢字 #5139 / #5158；
  - MPX：#3601、#2888、#5070；
  - AT-SPI：#4903、#4984、#5074、#4375、GTK combo set_value、#4292；
  - 其他：#3758、#4281、#3814、#4529、#4715、#3658、#3778。
- fork 自身的缺陷一起修：
  - FocusIn 只对 Qt5 发，FocusOut 按 Codex 的条件发；
  - X11 激活失败后还原焦点；
  - 09-17 发现的坐标缩放按窗口区分（164 / 76 px 偏移）、`mouse_button_up` 重复缩放、X11 的 Page_Up / Page_Down、Chromium 进程分类按需执行。

---

## 3. 总议题 1–7（10-16 定）

### 议题 1：运行时文档替代 skill + 简化 node-repl —— 全部与 Codex 一致

- **工具**：模型只看到 `js`（`code`、`timeout_ms` 默认 30 s、`title`）和 `js_reset`。`add_node_module_dir` 只由宿主配置。删除 wait / cancel，超时行为照 Codex。
- **引导**：
  - MCP instructions 只有一句话；
  - `js` 工具描述只讲入口；
  - 第一次执行时自动 import SDK、建好全局 `cua`，输出核心文档（只输出当前平台的部分）；
  - 上下文压缩后由模型调 `cua.rewriteDocumentation()`。
- **入口**：`getApp` 自动输出状态；观察方法默认自动显示，`emit:false` 关闭。
- 改完之后，从 bundled skill 里删掉 computer-use 和 browser-use 两个 `SKILL.md`。这是"不动 qwen-code 本体"的唯一例外，只删内容文件。

**依据**：历史上"只为拿结果"的 wait 请求有 1008 次、1.3 亿 token；Codex 的五层引导经 MCP 握手实测。

### 议题 2：driver 是唯一底层，SDK 只做包装

- **2a 下沉到 driver**：
  - 应用和窗口的解析：动作直接接受 `app`，一次往返完成；现在 SDK 每个动作至少 3 次往返；
  - 短 ID；
  - 观察的渲染、字符上限和 diff；
  - 前后台策略；
  - 结构化错误。

  SDK 只保留全局 `cua`、类型化方法、自动显示、运行时文档和同一应用的串行。一份接口说明同时生成 MCP 工具描述和运行时文档。

- **2b 精简工具面**：默认只暴露类似 Codex 的核心十几个工具。上游的大量工具（录屏、光标主题、zoom、轨迹回放、管理类、`browser_*`）默认关闭，按需打开。
- **2c** MCP 工具名和参数与 JS 方法一一对应。

### 议题 3：观察

- 照 Codex 拆成 `getAXState / getScreenshot / getAXStateAndScreenshot`，返回字符串，去掉 `.elements`，默认自动显示。
- 只要文本时不截图：去掉 SDK 固定传的 `includeScreenshot:true`。Linux 上每次观察能省 1.6–2 s【推断，依据 09-18 定位】。
- 动作发出即返回；观察时等界面稳定再采集，上限按测试数据定，先从 300–500 ms 起步。
- 首次 `getApp` 和切换窗口时给全量，只输出 AX、不带截图；之后默认 diff。**三平台都用 diff**（有意不跟 Codex：Codex 在 Linux / Windows 上始终全量）。
- 一并修复：
  - 截图坐标映射按窗口区分；
  - AX 不完整时不自动重截（Chrome 上 4.4–5.3 s）；
  - 图片 MIME 声明与实际一致；
  - Chromium 的 AT-SPI 首次读树前先唤醒（#5074）。

### 议题 4：动作返回值和错误

- 成功返回 `void`，去掉 `effect`。结果靠同一次调用里的观察确认。
- 失败抛出 `{code, reason, sent: true/false, 下一步建议}`。driver 给出，SDK 原样透传，MCP 路径字段相同。初始错误码：

  | 错误码                                 | 含义                           |
  | -------------------------------------- | ------------------------------ |
  | `element_stale`                        | 编号来自旧快照，没发送         |
  | `not_settable`                         | 该控件不能直接写值             |
  | `write_not_applied`                    | 写入后读回没变                 |
  | `no_focused_text_input`                | 焦点不在文本框                 |
  | `target_occluded`                      | 点击点被挡住                   |
  | `unsupported_on_platform`              | 本平台不支持该操作             |
  | `user_input_detected`                  | 前台段检测到用户在操作，已停下 |
  | `foreground_unavailable`               | 转前台失败，没发送             |
  | `app_not_running` / `window_not_found` | 应用没运行 / 找不到窗口        |

  `background_unavailable` 不暴露给模型（driver 会自动转前台）。

- 元素编号只在该窗口最新一次快照内有效，用旧编号在发送前报错。
- "已发送但确认不了"不抛异常：动作照常返回，输出里加一行"已发送但未确认生效，重试前先看状态"。

**依据**：mac 冒烟里三种不同的失败被 SDK 改写成同一句通用文案，模型只能再观察一轮去猜。

### 议题 5：能力缺口

- **5a 浏览器**：直接引用、迁移仓库里的 `@qwen-code/browser-use`。它已经跑在 node-repl 里：Playwright 经 CDP 连到 Qwen Chrome 扩展，再到用户的 Chrome；动作返回 void，错误带错误码。在 `cua` 下以 `getBrowser / getTab / createBrowserTab` 接入，**不做功能改动**，不用上游 cua-driver 的浏览器内容。暂不补 Windows，暂不加 diff。
- **5b** 加显式的 `cua.desktop`：全屏截图和按屏幕坐标的输入。天然走前台，只在明确操作桌面时使用。
- **5c** 补"点击时按住修饰键"（`click(p, {key})`）和 `key_down / key_up`。
- **5d** 不做按应用授权。

### 议题 6：分发与版本

- **6a** 这次不动 qwen-code 本体（cli/core）。node-repl 仍作为单独注册的 MCP。
- **6b** SDK、原生包、浏览器 SDK 统一一个版本号。driver 不再跟上游版本号，changelog 里写"移植自上游 #xxxx"。
- **6c** 原生包按需下载，校验 sha256（沿用现有机制）。

### 议题 7：评测

- 工具层与模型层分别记录；用户于 2026-10-20 将 OSWorld 评测安排到发布后：
  - **第 1 层：工具层，不用模型**。同一套用例对比新方案、Codex 和上游，看正确性、每个动作耗时、打扰项、返回成功但没生效的次数。作为 driver 改动的合入门槛：至少达到 Codex 和上游中较好的那个。用户于 2026-10-20 澄清，已观察到的 macOS 目标窗口/菜单短暂遮挡可接受且符合预期；逐项记录遮挡与恢复，不再以严格零遮挡阻塞。错误目标输入、改变点击语义或不确定后重放仍不被接受。
  - **第 2 层：发布后的小规模模型/OSWorld 评测**。主指标是**轮次、token、墙钟时间**，前提是成功率不降。此项为发布后跟进，不再作为发布前门槛；实际执行前不声称性能提升或成功率不回退。
- **任务集**：
  - mac 和 Windows 用 AP 上两个 group 筛过的 OSWorld-V2 20 题（`sh-prod-1`，scaffold 为 Qoder + Node REPL，模型 `azure.gpt-6-astra`）：
    - `group-5cff67aa55934a09a45160e3194b5801-s1`：macOS，平均 0.26，满分 1 题；
    - `group-bc7a3539903b4735bc3508e04e5791d5-s1`：Windows，平均 0.12，满分 0 题。
  - 两组是同一组题号：task_v2_001、010、020、022、027、038、044、046、051、052、055、059、060、067、076、080、088、096、101、107。
  - Linux 计划用同样这 20 个题号，缺的或不适用的从 Linux 全集补齐【待核实】。
- **规则**：
  - 每次只改一个变量；
  - 基础设施失败单独记录、剔除重跑；
  - usage 缺失的轮次只算下限；
  - 对照组复用已有轨迹。

---

## 4. 实施清单（按包）

**cua-driver（Rust）**

- 前后台：macOS（2.1）、Windows 混合（2.2）、Linux X11 混合（2.3）。driver 自动决策，不再接受 SDK 强制前台。
- 删除 Wayland 后端；纯 Wayland 会话直接报错。
- 下沉：应用 / 窗口解析、短 ID、观察渲染与 diff（三平台）、等待逻辑（动作即返回，观察里等）、结构化错误码。
- 精简默认 MCP 工具面；工具和 JS 方法一一对应；一份接口说明生成工具描述和运行时文档。
- 新增：`desktop` 操作、点击按住修饰键、`key_down / key_up`。
- 移植上游修复：mac 保护、Windows 修复（#4500 #4901 #3671 #4774 等）、Linux X11 / AT-SPI 修复清单。
- Windows 改用高权限 daemon 形态；安装不再依赖签名。

**cua-sdk（TS）**

- 变成薄包装：全局 `cua`、类型化方法、自动显示（`emit:false`）、运行时文档（按平台）、`rewriteDocumentation()`、同一应用串行。
- 删除 App 层的业务逻辑：强制前台、通用错误改写、固定截图。
- `cua.getBrowser / getTab / createBrowserTab` 包装 browser-use。

**node-repl-mcp**

- 工具改为 `js` + `js_reset`，默认 30 s，删 wait / cancel；`add_node_module_dir` 只由宿主配置。
- 启动 banner 预载 `cua` 并输出文档。

**browser-use**：只做引用和迁移，不改功能。

**qwen-code 本体**：只删两个 bundled `SKILL.md`（computer-use、browser-use），代码不动。

**版本**：统一版本号；changelog 记录移植来源。

---

## 5. 测试环境现状（截至 10-16）

| 平台    | 机器                                                    | 状态                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | mini（30.221.187.223），`/Users/tutu/cua-fgbg-20261015` | harness 已修好 5 个问题。正式批次（三方 × 3 次，fixture 用例加 TextEdit / Excel / Finder / Chrome）**已跑完，结果待整理**。上游的 T13 / T14 / T16 需要人工点 Automation 授权，未跑；T15 因 mini 没装 LibreOffice 未跑                                                                                               |
| Windows | windows-ecs-new（8.217.1.105），`C:\cua-fgbg-20261016`  | 上游 0.35.4 和我们 0.20.11 已就绪：换了新的测试签名证书 `83923F67…AB98`，有效到 2027-01-14，worker 已签名并带时间戳。SentinelA / UserTyper / Sampler 已编译。**卡点：测试进程要在交互桌面 session 2 里运行**，借令牌的启动器没跑通，需要选一种方式（一次性计划任务 `schtasks /it`，或用户在远程桌面启动常驻执行器） |
| Linux   | linux-ecs（47.76.93.28）                                | 新起了容器 `cua-fgbg-osworld-20261016`（OSWorld-V2 镜像，QEMU 软件模拟，端口 127.0.0.1:50916 / 58916），不影响已有容器。harness 待搭                                                                                                                                                                                |

AP：mini 上的 ap-client 已从 ArtLab 升级到 0.5.1，版本检查通过；两个 group 的导出在 mini 的 `/Users/tutu/cua-fgbg-20261015/ap-groups/`。

---

## 6. 讨论过程中的更正

- "Codex 动作后有约 2 s 的条件等待"是错的：冒烟时 Codex 服务的授权弹窗没人处理，截图卡到超时。正式批次里没有这个等待。
- `0ceac09` 改成一律前台时引用的"官方：输入方法自行激活目标窗口"，出自 Codex 的 **Windows** SDK，不是 macOS。
- Windows 上借 explorer 令牌的启动器，实测子进程仍在 session 0，之前在那上面跑出的 fixture 结果作废。

---

## 7. 文档索引

| 文档                                                                       | 内容                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| `BRIEF.md`                                                                 | 调研任务说明                                       |
| `findings/code-architecture.md`                                            | 现有代码结构                                       |
| `findings/codex-latest-delta.md`                                           | Codex 26.924 → 26.1007 的变化                      |
| `findings/upstream-delta.md`                                               | 上游 0.20 → 0.35.4 的差异与同步模拟                |
| `findings/design-discussions.md`                                           | 历史设计讨论账本（09-17 / 09-21 两次决定的冲突等） |
| `findings/fgbg-mechanics.md`                                               | 三平台前后台机制（代码级）                         |
| `findings/fgbg-evidence.md`                                                | 前后台相关的实验与决策证据                         |
| `findings/rb-final-comparison.md`、`rb-sdk-rounds.md`                      | RecreationBench 对比与轮次分析                     |
| `findings/osworld-stable20.md`                                             | OSWorld-V2 与 macOS stable20 证据                  |
| `topic4-fgbg/codex-fgbg-2026-09-29-reconstructed.md`                       | 09-29 Codex 三平台前后台逆向（重建版）             |
| `topic4-fgbg/macos.md`、`macos-test-plan.md`、`macos-shakeout-20261015.md` | macOS 分析、测试方案、冒烟记录                     |
| `topic4-fgbg/windows.md`、`windows-test-plan.md`                           | Windows 分析与决定、测试方案                       |
| `topic4-fgbg/linux.md`                                                     | Linux 分析与决定                                   |

## 8. 当前执行范围（2026-10-19）

用户现阶段优先前四项验证：macOS、Windows、Linux X11 真机验收，以及运行时、安装与打包检查。用户于 2026-10-20 明确将 OSWorld 评测放在发布后，未来模型运行改用 `gpt-6-sol`。用户于 2026-10-20 要求重新进行同机 Codex 工具对照，并澄清已观察的 macOS 短暂遮挡可接受；剩余真机 GUI 测试均在 mini 执行。上方 10-16 环境表为历史快照。当前证据与候选身份见[验收账本](cua-upgrade-acceptance-2026-10.zh-CN.md#验收口径澄清2026-10-20)。用户现已授权推送此功能分支并向 main 提交本次 PR。OSWorld 结果不再是发布前置条件；正式发布执行为独立动作，未将任何评测结果标为通过。
