# Qwen Code Computer Use 竞品源码对比

## 状态

- **报告日期：** 2026-09-06
- **Qwen Code 基线：** `60ccd1a75e`
- **Codex 基线：** `9587c9ef36`
- **Hermes Agent 基线：** `245e48008f`
- **分析类型：** 当前源码与本机已安装产物的静态审计
- **运行时边界：** 未执行真实桌面或浏览器 E2E

Hermes Agent 的本地 `main` 比已知的 `origin/main` 落后 21 个提交，但这些
提交没有修改 `tools/computer_use/**`、`tools/computer_use_tool.py`、
`toolsets.py` 或 Computer Use 依赖，因此不影响本文的 Computer Use 比较。

本文采用以下证据分类：

- **源码事实：** 可以从当前源码、类型声明或配置直接确认。
- **实现推断：** 由多个调用点共同支持，但没有真实 GUI E2E 证明。
- **建议：** 面向 Qwen Code 的目标设计，不代表当前已实现。
- **未验证：** proprietary 二进制或缺少运行环境，无法从源码完整确认。

## 结论

Qwen Code 当前的 Computer Use 可以概括为：

> native 自动化内核与状态协议领先，但宿主安全集成、浏览器产品化、安装体验和
> 运维诊断落后。

最大的差距并不在 Rust 平台后端。Cua Driver 已经拥有跨平台窗口自动化、完整
桌面截图、浏览器 CDP、剪贴板、菜单、窗口管理、权限模式和丰富的验证信息。
问题是当前 `@qwen-code/cua-sdk/computer-use` facade 只暴露其中一个较窄的
窗口控制子集，Qwen Code 宿主也没有把 nested Computer Use action 纳入逐动作
审批、风险审核和用户接管体系。

相对于 Codex，Qwen Code 的主要劣势是完整产品与安全闭环。相对于 Hermes
Agent，主要劣势是安装、诊断和非视觉模型适配。Qwen Code 的主要优势则是
revision 正确性、稳定元素身份、动作证据、确定性 postcondition 验证、直接
同进程 SDK 和完整开源的跨平台 native 实现。

## 三套架构

### Qwen Code

```text
user task
  -> bundled computer-use Skill
  -> external @qwen-code/node-repl-mcp
  -> model-authored JavaScript
  -> @qwen-code/cua-sdk/computer-use
  -> generated UniFFI/N-API bindings
  -> same-process Rust Cua Driver runtime
  -> AX / UIA / AT-SPI / capture / input
```

当前 Qwen Code 只内置
[`computer-use` Skill](../../core/src/skills/bundled/computer-use/SKILL.md)。
Node REPL、SDK 和 native payload 都不随 Qwen Code 主包交付。首次使用时，
Skill 执行精确版本的 MCP 注册和 workspace-local npm 安装；首次添加 MCP
server 后需要重启 Qwen Code。

`ComputerUse.create()` 创建一个同进程 Rust runtime 和绑定的 `standard`
trusted session。它不启动 daemon，也不通过第二层 MCP 调用 Driver。当前 facade
公开的主要能力是：

- `listApps`、`listWindows`、`getWindow`
- `observeWindow`
- `click`、`doubleClick`、`rightClick`
- `drag`、`scroll`
- `setValue`、`typeText`、`pressKey`、`hotkey`
- `performSecondaryAction`
- `verifyState`、`actAndVerify`

接口定义见
[`typescript/computer-use/index.d.ts`](../typescript/computer-use/index.d.ts)。

### Codex

```text
user task
  -> openai-bundled unified-computer-use plugin
  -> cua_repl MCP: js / js_reset
  -> @oai/cua TinySkyAlt
  -> trusted browser service and Sky Computer Use service
  -> browser runtime / proprietary native app runtime
```

Codex 仓库主要实现插件发现、MCP 调度、配置要求、确认策略转发、Guardian
审核和 lifecycle cleanup。实际 Computer Use runtime 以 bundled plugin 和
ChatGPT Desktop 资源交付，不完整存在于 Codex 开源仓库。

本机审计到的已安装版本是：

- `unified-computer-use`: `26.901.22334`
- `@oai/cua`: `0.2.4`
- `@oai/sky`: `0.6.26`
- `@oai/browser-desktop`: `0.1.1`

统一 `cua` 对象同时公开 App、Browser 和 Tab：

```ts
await cua.getState();
const app = await cua.getApp("Example App");
const browser = await cua.getBrowser({ url });
const tab = await cua.createBrowserTab(browser.browserId, url);
```

App 和 Tab 共享 `getAXState`、`getScreenshot`、`click`、`paste`、
`selectText`、`setValue` 等交互接口。浏览器还提供 Playwright、DOM、WebMCP、
history、文件上传下载、tab claim、visibility、bot detection、browser auth、
`markDeliverable` 和 `markHandoff`。

Codex 的 host integration 还包括：

- 按 app identity 查询 allow/deny/forbidden policy
- session/always 级持久审批
- 将 browser/computer confirmation policy 转发到 actor MCP
- Guardian 对 `node_repl`/`cua_repl` 请求和输出进行风险审核
- 将 REPL 文本与截图作为有界、untrusted evidence 提供给 reviewer
- Stop、Interrupt 和 SubagentStop 时调用 `turn_ended`
- 用户物理停止、用户接管和锁屏错误

Codex native Sky Service 是 proprietary 二进制。本文只对可读 JavaScript、
类型声明和 Codex host 代码作结论，不推断其内部 AX、截图或输入算法。

### Hermes Agent

```text
user task
  -> one computer_use(action=...) model tool
  -> Python dispatcher and approval layer
  -> per-session CuaDriverBackend
  -> MCP stdio / private daemon proxy
  -> upstream Cua Driver
```

Hermes 使用一个约 6 KB 的固定 function schema，把 14 个动作放在
`action` discriminator 下：

- `capture`
- `click`、`double_click`、`right_click`、`middle_click`
- `drag`、`scroll`
- `type`、`key`、`set_value`
- `wait`
- `list_apps`、`list_windows`
- `focus_app`

每个 Hermes session 缓存一个 backend、一个调用锁和独立审批状态。普通模式
连接 Cua Driver MCP；`bounded` 或 `unrestricted` 模式会创建 session-owned
private daemon 和私有 socket。

Hermes wrapper 额外提供：

- action 与 `delivery_mode` 级审批
- dangerous key combo 和 shell-like typed text 硬阻断
- timeout 后不重放 mutation
- read-only transport failure后的 CLI fallback
- stale session 重建和 public session 恢复
- `capture_after`
- screenshot media cache 和大 AX tree spill 文件
- 非视觉模型的 auxiliary vision 路由
- `hermes computer-use doctor`
- runtime contract、版本和 update 检查
- macOS CuaDriver.app bundle ID、签名 team 校验
- provider secret 环境变量清理

## 能力矩阵

| 维度 | Qwen Code | Codex | Hermes Agent |
| --- | --- | --- | --- |
| 模型入口 | 按需 Skill + persistent Node REPL | bundled plugin + persistent CUA REPL | 一个固定 function tool |
| native desktop | macOS、Windows、Linux | surfaced App API 主要为 macOS；另有 Windows/Linux 低层接口 | macOS、Windows、Linux |
| browser | Driver 已实现，但 facade/Skill 未暴露 | AX、DOM、Playwright、WebMCP、IAB、Chrome/Edge | 独立 browser toolset |
| app launch | Skill 要求用普通 Node process API | App binding 自动启动；Windows 有 typed launch | model schema 只有 `focus_app`；backend 有内部 launch helper |
| full desktop | Driver/SDK 有，facade 无 | Linux full-desktop API；其他平台依 runtime | `app="screen"` wrapper |
| target API | 手工 PID + window ID | App/Browser/Tab object handles | sticky active target |
| semantic reference | opaque stable element token | fresh element index | model index + wrapper-internal token |
| coordinate reference | exact window-local coordinates | target coordinates；Windows 可绑定 screenshot ID | sticky window + coordinates |
| observation diff | explicit caller-owned revision | runtime-owned automatic diff | 未启用 revision protocol |
| diff validation | replay validation，diff 必须更小 | 未见等价公开 contract | 未见等价逻辑 |
| action result | closed effect/route/delivery/evidence/escalation | 高层 action 多数返回 `void` | 保留部分 effect/escalation/path |
| postcondition | native `verify_state` + stable samples | fresh AX/screenshot，由模型判断 | fresh capture，由模型判断 |
| app policy | Driver 能力存在，facade 未配置 | app allow/deny/forbidden + persistent approval | capability manifest + wrapper approval |
| nested action review | 无 host-visible structured nested action | confirmation policy + Guardian | 每次 typed function call 可见 |
| physical stop | 未见等价集成 | user stop/intervention + lock screen signal | 未见等价 native user-stop contract |
| setup | npm install + MCP registration + restart | bundled/app-managed | installer + tools UI + doctor |
| text-only model | AX tree | 模型/宿主绑定 | auxiliary vision 可转成文本 |
| implementation transparency | Rust/TS 完整开源 | host 开源，native service proprietary | Python wrapper 开源，依赖 upstream Driver |

## Qwen Code 的优势

### 1. Observation revision 是三者中最严格的

Qwen 的 `accessibility.observation_revision.v1` 明确要求 caller 指定实际被消费
的 base revision。Driver 不猜测哪个 observation 到达了模型。响应是
`full`、`diff` 或 `no_change`，并携带实际 base、lineage、serializer、
projection 和 resync reason。

同一个 native element 在 rename、value change、reorder 和 reparent 后保留
稳定 ID。删除并重建的 look-alike 获得新 ID。candidate diff 必须能够从 base
重放成 canonical current full rendering，且必须比 full rendering 更小，否则
返回 full。

实现见
[`observation_revision.rs`](../rust/crates/cua-driver-core/src/observation_revision.rs)。

Codex 的公开 API 有自动 diff，但仍要求模型重新获取 fresh element index；公开
contract 没有 caller-owned base 和 diff replay guarantee。Hermes 当前没有向
`get_window_state` 发送 observation revision。

### 2. Stable element token 更能防止 stale action

Qwen revision token 绑定：

- runtime scope
- trusted session
- transport session
- PID
- exact window
- lineage
- current native element

跨 session、跨 runtime、跨 target、stale lineage 或消失元素都会在 native
dispatch 前失败。实现见
[`element_token.rs`](../rust/crates/cua-driver-core/src/element_token.rs)。

Hermes 会保存 Driver 返回的 token，但模型侧仍以 index 操作，由 Python wrapper
在 action 时重新附加 token。Codex surfaced API 主要依赖 fresh element index；
Windows coordinate action 可用 `screenshotId` 约束截图快照，但没有公开等价的
跨 diff stable element token。

### 3. Action truth 与 task success 分离得最清楚

Qwen action result 明确公开：

- `effect`
- `route`
- `delivery`
- `evidence`
- `escalation`
- wrapper operation lifecycle

`confirmed` 必须有 value readback 或 window change evidence。投递成功但没有
可信 readback 时只能是 `unverifiable`，不能伪装成 task success。

完整 contract 见
[`action-result-contract.md`](action-result-contract.md)。

Codex 高层 target action 多数返回 `Promise<void>`，依赖下一次 AX state 或
screenshot 进行模型判断。Hermes 保留 `effect`、`escalation`、`path` 等部分
字段，但没有完整公开 route、delivery evidence 和 operation lifecycle。

### 4. Native postcondition verification 领先

Qwen `verify_state` 支持一到八个 AND predicate，包括：

- window existence 和 bounds
- element role/label selector
- value equality
- enabled
- selected
- stable sample count

`unknown` 和 `stable:false` 永远不是成功。`actAndVerify` 只有在 action effect
可接受并且 postcondition 稳定满足时返回成功。

Codex 和 Hermes 都要求模型根据 fresh observation 判断最终结果，没有公开等价
的 native structured stable-sample verifier。

### 5. SDK 路径更短、更容易推理

Qwen 默认路径是：

```text
Node REPL
  -> generated TypeScript bindings
  -> same-process Rust runtime
```

Hermes 路径包含 Python sync wrapper、async bridge thread、MCP stdio、可选 private
daemon、socket proxy 和 CLI fallback。Hermes 的恢复逻辑丰富，但也反映出更大的
transport 和 lifecycle 故障面。

### 6. 发布可复现性更好

Qwen Skill 固定 Node REPL 与 SDK 版本。SDK postinstall 下载相同版本的 native
release archive，并使用 release `checksums.txt` 验证 SHA-256。

Hermes installer 默认获取 upstream 最新 release，只使用 `>=0.20.0` runtime
contract gate。用户可以通过 `HERMES_CUA_DRIVER_CMD` 自己固定 binary，但默认
安装路径不是 immutable version pairing。

### 7. 未使用时的模型 schema 成本更低

Qwen 将 Computer Use 作为按需 Skill，避免把整组 native action schemas 放入
每次模型请求。Hermes 的单一 schema 已经比几十个独立工具紧凑，但在启用
Computer Use 的 session 中仍会随每次请求发送。

## Qwen Code 的主要缺陷

### 1. 宿主审批只看见外层 JavaScript

这是当前最高优先级的问题。

Node REPL 能执行 model-authored JavaScript，并拥有普通 Node.js authority。
Qwen MCP approval 能看到的是一个 REPL cell，而不是 cell 内每一次
`computer.click()`、`setValue()` 或 `typeText()` 的结构化语义。一个 cell
还可以批量执行多个动作。

同时，`ComputerUse.create()` 固定创建 `standard` session：

- `allowedModes` 只有 `Standard`
- capability manifest 为 `undefined`
- 没有安装 `DriverAuthorizationHost`
- ordinary automation 在 `standard` 中是 promptless

因此当前安全边界主要依赖：

1. 模型遵守 Skill；
2. 用户审查整段 JavaScript；
3. Driver 的平台权限和 residual authorization。

这弱于 Codex 的 app policy、nested elicitation、confirmation policy 和 Guardian，
也弱于 Hermes 每次 typed model tool call 都可被 host 直接分类和审批的结构。

### 2. Browser runtime 已存在，但 Qwen Computer Use 不可达

Cua Driver 已经实现：

- `get_browser_state`
- `browser_prepare`
- `browser_navigate`
- `browser_click`
- `browser_type`
- `browser_dialog`
- `browser_set_input_files`
- `browser_download`
- `browser_pointer`

这些工具有 exact target、session-scoped tab/ref、CDP endpoint ownership、origin
authorization 和 structured refusal。实现位于
[`cua-driver-core/src/browser`](../rust/crates/cua-driver-core/src/browser/)。

但是 generated typed SDK 只为 desktop contract 生成 named methods。Browser
工具当前只能通过 generic `call_tool` 访问，而 bundled Skill 明确禁止模型调用
generic `callTool`。因此底层 browser implementation 并没有形成 Qwen Code
Computer Use 的用户可用能力。

Codex 已把 App、Browser 和 Tab 合并为同一个 CUA object，并提供 AX、DOM、
Playwright、WebMCP、file chooser、download 和 tab lifecycle。这是当前最大的
功能差距。

### 3. 高层 desktop facade 只覆盖 Driver 能力的一部分

以下能力已经存在于 Driver 或 root SDK，但不在当前 `ComputerUse` facade：

- full desktop state
- application launch/activation
- bring-to-front
- window frame
- native menu invocation
- clipboard read/write
- paste with clipboard restoration
- selected-text operations
- permission and health inspection
- recording and cursor controls

Skill 甚至要求模型用 ordinary Node process API 启动未运行的应用。这绕过了
Driver 对 app identity、launch result、session ownership 和跨平台行为的统一
抽象。

### 4. 首次使用需要修改 workspace 并重启

当前 bootstrap：

1. 修改 user MCP configuration；
2. 在 workspace `node_modules` 写入 SDK；
3. 下载 native payload；
4. 要求重启 Qwen Code；
5. 在下一 session 继续任务。

这会导致：

- 第一次任务无法端到端完成；
- 不同 workspace 重复安装；
- read-only workspace 或受控环境不可用；
- SDK resolution 与启动 workspace 耦合；
- 权限归属可能落到 terminal 或 IDE，而不是稳定产品 identity。

Codex 通过 bundled plugin、专用 Node runtime 和签名 native app 消除了这些
步骤。Hermes 虽然也需要安装 Driver，但提供 tools UI、installer、status、
doctor、repair 和 update nudge。

### 5. 缺少 independent physical stop 与 takeover signal

Qwen wrapper 支持 `AbortSignal`，并正确区分 pre-dispatch cancellation 和
post-dispatch ambiguity。但 AbortSignal 仍由 host/model tool lifecycle 发起，
不是用户对 native automation 的独立紧急停止机制。

Codex runtime 暴露 user stopped、user intervened 和 screen locked 等错误，并
有独立 lock-screen guardian。Qwen 当前集成中没有找到等价的 physical Escape、
takeover 或 lock-screen boundary。

### 6. 缺少 Computer Use 专用的 untrusted UI evidence 审核

页面、邮件、聊天、文档、截图和 accessibility text 都可能包含 prompt
injection。Qwen Skill 没有像 Codex Browser Safety 那样明确规定：

- UI 内容只能提供事实，不能授予权限；
- 数据 transmission 必须核对具体数据、目标和时机；
- nested tool output 必须作为 untrusted evidence；
- reviewer 可以同时检查 REPL action、文本结果和截图。

Qwen 的 generic tool-output trust model 仍然存在，但 Computer Use 缺少独立的
action-time policy 和 reviewer evidence pipeline。

### 7. 缺少统一的健康诊断与恢复 UX

Driver 本身拥有 health、permission、manifest 和 version 信息，但当前 Qwen
Computer Use 文档主要建议：

- 重启 Qwen Code；
- 运行 `qwen mcp list`；
- 检查 workspace SDK import；
- reset 后重新 bootstrap。

缺少面向用户的一条命令来回答：

- native binary/library 是否匹配；
- Accessibility、Screen Recording、UIA、AT-SPI 是否可用；
- 当前 display/session 是否可捕获；
- MCP、SDK、native payload 分别在哪一步失败；
- 是否有兼容更新。

### 8. 非视觉模型没有截图转译路径

Qwen 可以使用 AX-only workflow，但当 AX 不完整且必须依赖 screenshot 时，没有
内置 auxiliary vision 路由。Hermes 会根据 provider/model capability 决定：

- 将 screenshot 作为 multimodal tool result；
- 或交给配置的 auxiliary vision model；
- 再把 visual description 和 element list 合并成文本。

这让 Hermes 能服务更多普通 tool-calling 模型。Qwen 的优势是不给视觉模型增加
额外调用，但在 text-only model 上会直接失去视觉 fallback。

## Hermes `som` 声明漂移

Hermes schema 声称：

> `som` 是在每个可交互元素上绘制编号覆盖层的 screenshot。

当前 wrapper 实现并没有绘制覆盖层：

- `mode == "vision"` 调 screenshot-only path；
- 其他 mode 都调用同一个 `get_window_state`；
- 返回的 image 直接来自 Driver；
- tests 只验证文本 summary 含 `#1`，没有验证 image pixels 含编号。

当前 Cua Driver 说明还明确指出：

- `get_window_state` 默认同时返回 tree 和 screenshot；
- `capture_mode` 已废弃并被忽略；
- 不再存在 native `ax`、`vision`、`som` capture choice。

因此 Hermes 的 `som` 不是可确认的竞品优势，而是 schema 与实现漂移。Qwen
不应复制这套 vocabulary，除非真正实现可验证的 overlay renderer。

## 优先级与 ROI

### 评估标准

Priority 综合考虑：

- 用户安全与越权风险
- 与竞品的能力差距
- 真实任务成功率
- 是否阻塞 Desktop/enterprise 使用
- 是否能复用现有 Driver 能力

ROI 是定性工程评估：

- **极高：** 用户影响大，且可复用大部分现有 native 实现。
- **高：** 用户影响大，但涉及 host/runtime/package work。
- **中高：** 明显改善覆盖率或体验，但不是基础安全和主流程 blocker。
- **中：** 优化易用性、成本或长尾兼容。

| 优先级 | 工作项 | 影响 | 工作量 | ROI |
| --- | --- | --- | --- | --- |
| P0 | Trusted CUA REPL + nested structured approval | 安全、企业策略、action-time confirmation | 高 | 极高 |
| P0 | Typed browser facade 与 Skill | 最大功能缺口，直接对齐 Codex | 中高 | 极高 |
| P1 | Restartless、产品 identity 稳定的交付 | 首次成功率、权限稳定性、Desktop UX | 高 | 高 |
| P1 | 扩充 desktop facade | full desktop、launch、clipboard、menu、window | 中 | 极高 |
| P1 | Physical stop、takeover、lock-screen guard | 用户控制和误操作止损 | 中高 | 高 |
| P1 | `qwen computer-use doctor` | 安装和环境问题自助定位 | 低中 | 极高 |
| P1 | UI prompt-injection policy + reviewer evidence | 数据泄漏和 consequential action 风险 | 中高 | 高 |
| P2 | Auxiliary vision routing | text-only model 与 provider 兼容 | 中 | 中高 |
| P2 | App/Window/Tab object handles + progressive docs | 降低 PID/window/revision 认知负担 | 低中 | 高 |
| P2 | Tab deliverable/handoff lifecycle | 跨 turn 浏览器工作流 | 中 | 中高 |
| P3 | Browser history、WebMCP、bot detection 等高级能力 | 长尾 browser productivity | 中高 | 中 |

## 推荐实施顺序

### Phase 1：先建立可信执行边界

建议引入 Computer Use 专用 REPL/MCP runtime，而不是继续把 generic Node REPL
当成最终产品安全边界。

最低要求：

1. 每个 nested Computer Use action 必须以 structured operation 到达 Qwen host。
2. host 可以基于 app、window、origin、action、data 和 delivery mode 审批。
3. `DriverAuthorizationHost` 由 trusted host 实现，不暴露给 model-authored code。
4. user/session/persistent approval 必须作用于明确 scope。
5. UI、screenshot、AX 和 browser output 标记为 untrusted evidence。
6. 支持 independent user stop 和 user takeover。
7. action audit 与 screenshot evidence 有界保存。

这一步是 browser expansion 和 unattended automation 的安全前提。

### Phase 2：将已有 Driver 能力提升为 typed facade

优先加入：

1. `getDesktopState`
2. `launchApp` / `activateApp`
3. `bringToFront`
4. `clipboardRead` / `clipboardWrite` / safe paste
5. `invokeMenu`
6. `setWindowFrame`
7. `healthReport` / `permissionStatus`

这些能力大多已经存在，ROI 高于重写平台 backend。

### Phase 3：完成 typed browser product surface

不要直接向 Skill 暴露 generic `callTool`。应先：

1. 将 browser input/output 纳入 portable typed contract；
2. 为 generated SDK 生成 named browser methods；
3. 在 high-level facade 提供 `Browser` 和 `Tab` handles；
4. 保留 exact native window -> target -> tab binding；
5. 保留 origin、profile 和 existing-session authorization；
6. 暴露 dialog、upload、download 和 ref stale semantics；
7. 最后更新 Computer Use Skill。

Codex 的 unified object ergonomics 值得借鉴，但 Qwen 应继续保留自己的 exact
binding、closed result 和 fail-closed contract。

### Phase 4：完成产品交付和运维

建议为 Desktop/standalone 提供：

- bundled 或 app-managed CUA REPL
- version-paired SDK/native payload
- restartless server registration
- signed native permission host
- install/status/doctor/repair/update UI
- physical stop indicator
- per-session active automation visibility

CLI 仍可保留当前 transparent external installation，作为轻量和可审计路径。

### Phase 5：扩展模型兼容与高级浏览器能力

在安全和主流程完成后，再加入：

- auxiliary vision
- model capability routing
- progressive API documentation
- browser tab deliverable/handoff
- browser history
- WebMCP
- bot detection 和 browser auth helpers

## 不建议复制的设计

### 不要直接复制 Hermes 的大 wrapper

Hermes 的 wrapper 解决了许多真实集成问题，但也包含：

- 多层 transport 和 recovery
- legacy payload parsing
- markdown regex fallback
- process-global callbacks/cache
- MCP SDK 版本兼容
- CLI fallback
- daemon lifecycle

Qwen 已有同进程 typed SDK，不应为了对齐 Hermes 而重新引入这些复杂度。应把
诊断和恢复能力放进 typed SDK/host，而不是复制 Python glue architecture。

### 不要为了 ergonomics 放弃 exact target

Codex 的 `getApp()`/`getTab()` object API 很易用，但 Qwen 不应退回 ambient
"current app/current tab"。object handle 内部仍应保留：

- exact PID/window
- runtime generation
- session ownership
- revision lineage
- stale refusal

### 不要把 action success 简化为 `void`

Codex 的 facade 便于使用，但 `Promise<void>` 丢失了 Driver 已经能够提供的
effect、route、delivery 和 evidence。Qwen 应在提供 object API 时继续返回
closed action result。

### 不要宣称不存在的视觉 overlay

如果未来引入 Set-of-Marks：

- overlay 必须由真实 screenshot renderer 生成；
- index、bounds 和 pixels 必须来自同一 snapshot；
- tests 必须检查 image pixels，而不只是文本 summary；
- downscale 必须携带 coordinate transform；
- overlay 不得覆盖敏感内容或导致错误点击。

## 验证记录

### 已运行

```text
node --test computer-use/test/computer-use.test.mjs
```

结果：27/27 通过。

覆盖：

- observation revision
- typed discovery/action methods
- force-full behavior
- refusal preservation
- pre/post-dispatch cancellation
- committed operation evidence
- read-only reconnect
- mutation 不自动 replay
- malformed target refusal
- close/reconnect lifecycle

### 未完成

Qwen root build 和以下检查已经尝试，但因当前 checkout 缺少
`@modelcontextprotocol/client` / `@modelcontextprotocol/core` 或对应 `dist`
产物而未完成：

```text
npm run build
cd packages/core && npx vitest run src/skills/bundled/computer-use/SKILL.test.ts
cd packages/cua-driver/typescript && npm run typecheck:computer-use
```

Hermes focused test runner 已尝试启动，但本地没有带 pytest 的项目 venv，
因此没有进入测试执行阶段。

Codex test command 已尝试启动，但本地没有仓库要求的 `just` 命令，因此没有
进入测试执行阶段。

没有执行三套产品的真实 GUI、浏览器、权限、焦点保持或跨平台 E2E。因此本文
不能证明：

- 当前 release artifact 在每个平台都可用；
- advertised background action 在本机真实投递；
- proprietary Codex native service 的内部实现；
- 三者的真实 latency、token cost 或 task success rate。

## 主要证据

### Qwen Code

- `packages/core/src/skills/bundled/computer-use/SKILL.md`
- `docs/users/features/computer-use.md`
- `packages/cua-driver/typescript/computer-use/index.js`
- `packages/cua-driver/typescript/computer-use/index.d.ts`
- `packages/cua-driver/rust/crates/cua-driver-sdk/src/lib.rs`
- `packages/cua-driver/rust/crates/cua-driver-core/src/observation_revision.rs`
- `packages/cua-driver/rust/crates/cua-driver-core/src/element_token.rs`
- `packages/cua-driver/rust/crates/cua-driver-core/src/browser/`
- `packages/cua-driver/rust/crates/cua-driver-contract/src/verification.rs`
- `packages/cua-driver/docs/action-result-contract.md`

### Codex

- `codex-rs/config/src/computer_use.rs`
- `codex-rs/config/src/browser_use.rs`
- `codex-rs/config/src/browser_computer_use_requirements.rs`
- `codex-rs/core/src/mcp_tool_call.rs`
- `codex-rs/core/src/context/node_repl_review_evidence.rs`
- `codex-rs/ext/guardian-v2/`
- `codex-rs/plugin/src/bundled_hooks.rs`
- installed `openai-bundled/unified-computer-use`
- installed `@oai/cua`, `@oai/sky`, `@oai/browser-desktop`

### Hermes Agent

- `toolsets.py`
- `tools/computer_use_tool.py`
- `tools/computer_use/schema.py`
- `tools/computer_use/tool.py`
- `tools/computer_use/backend.py`
- `tools/computer_use/cua_backend.py`
- `tools/computer_use/cua_backend_capture.py`
- `tools/computer_use/cua_backend_input.py`
- `tools/computer_use/cua_backend_session.py`
- `tools/computer_use/cua_backend_daemon.py`
- `tools/computer_use/cua_backend_driver.py`
- `tools/computer_use/permissions.py`
- `tools/computer_use/doctor.py`
- `tools/computer_use/vision_routing.py`
