# Web Shell 助手反馈遥测

[English](web-shell-assistant-feedback-telemetry.md) | [简体中文](web-shell-assistant-feedback-telemetry.zh-CN.md)

状态：本次改动中实现。

建立在 [Web Shell 助手回答的满意/不满意标记](web-shell-assistant-feedback.zh-CN.md)
之上——那篇设计把逐轮满意/不满意标记实现为宿主可选开启、仅存浏览器的界面状态，
不发遥测。

## 问题

独立版 Web Shell——`qwen serve` daemon 提供的那个应用——根本不显示标记：它的入口
（`packages/web-shell/client/main.tsx`）从不传 `assistantFeedback` 配置项，原设计也
刻意没有开启它，因为独立应用当时没有宿主可通知。现在的产品要求是：读者在独立应用里
对某一轮给出的好/坏标记要进入遥测管线，让 TUI 已经在上报的 `user_feedback` 信号
也能从 Web Shell 对话中收集到。

有两个事实决定了解法形状：

- 标记 UI、本地存储与宿主通知钩子已经存在且有测试。缺的是独立版的开启，以及一条
  从浏览器到遥测 logger 的通路。
- daemon 会话的 `Config`——所有遥测 logger 都需要的对象——在会话的 ACP 子进程
  （`qwen --acp`）里，不在 daemon 进程里。daemon 只持有 bridge。daemon 驱动的轮次
  今天已经从那个子进程发遥测（例如
  `packages/cli/src/acp-integration/session/Session.ts` 里的 `logUserPrompt`），
  所以 sink 一侧是被验证过的；新的只有"客户端到子进程"这一段。

## 目标

- 在独立版 Web Shell 的已完成助手轮次上显示既有标记，用 daemon capability 门控，
  让旧 daemon 的回答底部与今天完全一致。
- 把每一次满意/不满意标记送进该会话的遥测管线，成为一条 `user_feedback` 事件：
  rating 正确、model 与 approval mode 取自会话的权威值、带上该轮的 `promptId`。
- 标记本身保持即时且终局：遥测是尽力而为的副作用，永远不能回滚或阻塞界面状态。
- 嵌入式宿主、TUI、本地标记的存储契约零变化。

## 非目标

- 不做标记的服务端持久化。`localStorage` 仍是界面状态的唯一来源；遥测事件是通知，
  不是客户端读回的记录。跨设备标记同步仍在范围外（原设计的后续事项）。
- 不新增遥测事件类型。原样复用既有的 `UserFeedbackEvent`
  （`packages/core/src/telemetry/types.ts`）。
- 不发"已取消"遥测。事件类型没有取消态；取消标记仍是纯本地变化。
- 不改 TUI 反馈弹窗，包括它既有的 rating 错位缺陷（原设计后续事项里已记录）。
  新通路显式映射 rating，不得继承那个缺陷。
- 不做 Managed Agent 等价物。capability parity 矩阵把该 tag 记为 Managed 侧
  刻意缺席。

## 设计

### 端到端路径

```
浏览器点击
  → 既有标记 UI + localStorage（不变）
  → customization.assistantFeedback.onRate（既有通知钩子）
  → App.tsx 独立版接线（新增）：fire-and-forget 会话 action
  → DaemonSessionClient / DaemonClient（新增 SDK 方法）
  → POST /session/:id/feedback（新增 daemon 路由，live-session-owner）
  → runtime.bridge → ACP extMethod qwen/control/session/feedback（新增）
  → acpAgent.extMethodInternal 分支（新增），手里就是会话 Config
  → logUserFeedback(config, UserFeedbackEvent)（既有 core logger）
  → sinks（既有）：ui_telemetry 会话记录、QwenLogger RUM、OTel
```

### 线协议契约

`POST /session/:id/feedback`

- Body：`{ "promptId": "<非空字符串>", "rating": "up" | "down" }`。
- 可选 `clientId` 头，解析方式与 `POST /session/:id/model` 完全一致。
- 注册为 `app.post(path, mutate(), withOwnerMutableSession(...))`——所有权
  scope 为 **live-session-owner**，与 model 路由同一个包装器。未知、不可信、
  歧义、draining、已移除的会话状态都走该包装器既有的失败语义，绝不回落到
  primary runtime。
- `200` → `{ "recorded": boolean }`。`recorded: false` 表示会话设置关闭了反馈
  收集（`ui.enableUserFeedback === false`），没有发出事件；`recorded: true`
  表示事件已交给 `logUserFeedback`。
- `promptId` 缺失/为空，或 `rating` 不在 `up`/`down` 之内 → `400`。
- 路由转发到新增的 `AcpSessionBridge.rateSessionTurn(sessionId, req, opts?)`
  方法，实现复用 bridge 既有的会话 extMethod 请求助手（超时 + 通道关闭竞态），
  与其他控制面方法同型。

### ACP ext method

- 注册表：`packages/acp-bridge/src/status.ts` 里
  `SERVE_CONTROL_EXT_METHODS.sessionFeedback = 'qwen/control/session/feedback'`。
- `qwen/control/session/` 前缀使它在 `acpAgent.isSessionScopedExtMethod` 里
  自动成为会话级方法，与兄弟方法一样在该会话的 id 上下文中执行。
- SSH workspace：允许。该方法只发遥测、无 workspace 副作用，因此不加入
  `ssh-workspace-guards.ts` 的 `unsupportedSessionMethods`。
- 处理器（`acpAgent.extMethodInternal`）：校验参数、解析会话
  （`sessionOrThrow`）、经既有的缓存设置路径读取会话 workspace 的合并设置；
  `ui.enableUserFeedback === false` 时直接返回 `{ recorded: false }`，不发事件。
  否则映射 rating、用会话自己的 `Config` 构造事件、调用 `logUserFeedback`。

### rating 映射

| Web Shell 标记 | `UserFeedbackRating` | 数值 |
| -------------- | -------------------- | ---- |
| `up`           | `GOOD`               | 3    |
| `down`         | `BAD`                | 1    |

映射按枚举成员显式写出。TUI 弹窗的缺陷——选项编号 `GOOD: 1, BAD: 2, FINE: 3`
直接裸强转进顺序为 `BAD = 1, FINE = 2, GOOD = 3` 的枚举——不得复现：单元测试
按数值钉死 `up → 3`、`down → 1`。

### 事件载荷

daemon 一侧从活会话 `Config` 填写所有身份字段；客户端只发 `promptId` 与
`rating`：

- `session_id`：`config.getSessionId()`。
- `rating`：映射后的枚举值。
- `model`：`config.getModel()`。
- `approval_mode`：`config.getApprovalMode()`。
- `prompt_id`：请求里的 `promptId`——daemon 准入时铸的逐轮 uuid，与标记存储
  用的键、轮次路由寻址用的身份是同一个值。

这样陈旧客户端状态就进不了事件：点击那一刻，子进程的 `Config` 是 model 与
approval mode 的权威。

### 门控

三道相互独立的门，各有其主：

1. **Capability**——`SERVE_CAPABILITY_REGISTRY` 新增基线 tag
   `session_turn_feedback: { since: 'v1' }`。legacy daemon 无条件广告；不带
   `hostedPersona` 标志，因此不进 hosted persona。独立版客户端只在
   `connection.capabilities.features` 含该 tag 时启用标记，旧 daemon 的回答
   底部与今天完全一致。
2. **反馈收集设置**——会话 workspace 合并设置里 `ui.enableUserFeedback ===
false` 时跳过发射（`recorded: false`）。TUI 读同一个键来抑制弹窗；在这里
   遵守它，让这个设置对用户只有一个含义。标记本身仍作为本地展示状态可见。
3. **使用统计**——不变，由 `QwenLogger.getInstance(config)` 内部强制：用户
   退出（`privacy.usageStatisticsEnabled`、env `QWEN_USAGE_STATISTICS_ENABLED`）
   时 RUM 上报 sink 不存在。本地 `ui_telemetry` 会话记录与 OTel sink 的行为
   与任何其他 `logUserFeedback` 调用方完全一致；本改动不新增隐私面。

### 客户端接线

- `App.tsx` 计算生效的 `assistantFeedback` customization：宿主传入的配置项
  原样优先（嵌入式宿主保持完全控制，包括 `enabled: false`）；否则，在独立版
  运行且 capability 存在时，提供一个 `onRate` 去触发会话 action。独立版入口
  （`main.tsx`）无需改动。
- `onRate` 忽略 `rating: null`（取消是纯本地操作），其余情况 fire-and-forget
  调用新增的 `rateAssistantTurn` 会话 action：失败只记录日志并吞掉。通知运行
  之前标记已经落到界面与存储里——这是既有的通知契约——通路上的任何事情都
  改变不了它。
- action 解析当前会话；没有会话时是 no-op。快速切换会话沿用 action 层既有的
  owner 守卫，迟到的响应不会把标记归到别的会话。
- SDK：按 daemon SDK 约定手写类型——
  `packages/sdk-typescript/src/daemon/types.ts` 里的
  `RateSessionTurnResult`；`DaemonClient.rateSessionTurn`
  以 `setSessionModel` 为模板（带超时的 fetch、JSON body、clientId 头、
  `failOnError`）；再加一个 `DaemonSessionClient` 包装。

### sinks 与可观测性

`logUserFeedback`（既有）写三个 sink：

- `uiTelemetryService` 内存 UI 事件。
- 一条 `system` / `ui_telemetry` 会话记录，事件放在 `systemPayload.uiEvent`，
  由 chat recording service 追加进会话 JSONL。这是"事件带着正确字段穿过了
  logger"的本地可观测证明，也是 E2E 的断言缝。
- `QwenLogger.logUserFeedbackEvent` → RUM action 事件 `user` /
  `user_feedback`（受使用统计门控），SDK 初始化时再加 OTel log。

## 决策与理由

- **经由拥有会话的 ACP 子进程，而不是 daemon 进程。** 每个遥测 logger 都要
  会话 `Config`，而 daemon 进程没有——在那里合成一个 Config 会让 model、
  approval mode 与设置脱离会话的权威。子进程今天已经在为 daemon 驱动的轮次
  发遥测；新 ext method 加入这条被验证过的路，而不是另开一条。
- **复用 `extMethod`，不新增标准 ACP 方法。** 控制面的所有会话变更本来就都
  走这条路（`SERVE_CONTROL_EXT_METHODS`），超时、通道关闭竞态、会话 id
  上下文、SSH 守卫都由共享机制处理。为一个 qwen 特有信号去提标准方法，只会
  徒增协议面。
- **model 与 approval mode 由 daemon 填。** 客户端对两者的视图可能滞后
  （模型切换、模式变更）；点击那一刻子进程的 `Config` 是最新的。客户端载荷
  保持最小：两个字段。
- **取消不发事件。** `UserFeedbackEvent` 没有取消态，为一个界面细节去发明
  一个会改动共享遥测 schema。取消→再标记的序列按每次标记变化发一条事件，
  与通知钩子"每次变化都通知"的语义一致。
- **客户端 fire-and-forget。** 原设计的核心不变量是宿主只做监听者、不做
  权威。等待通路结果或失败回滚，会让图标依赖一次网络往返。尽力而为的投递
  与其他所有遥测 sink 的契约相同。
- **capability 门控的开启放在 App 内，而不是入口。** 入口没有会话客户端；
  App 本来就承载 capability 门控的独立版行为（auto-recap 是先例）。宿主
  配置项保持权威，嵌入式宿主看到零行为变化。
- **`promptId` 只校验非空字符串。** 标记只提供给 transcript 携带准入 id 的
  轮次，诚实客户端发来的总是真值。给一个纯遥测面加轮次索引核对会引入一次
  扫描；daemon 有 token 鉴权且在本机。

## 约束

- 通路要求活的拥有会话。会话子进程退出后再点标记，会失败于路由的所有权解析；
  标记在本地保持点亮，事件被丢弃（尽力而为）。
- 独立标签页各自发各自的点击；跨实例不去重，与本地存储既有的多实例约束一致。
- SplitView 分屏继承独立版配置项，但拥有与 app 级派发目标不同的会话。接线会
  丢弃 `sessionId` 与 app 级会话不一致的载荷：分屏标记只在本地点亮、不发遥测，
  而不是把外来的 `promptId` 与 app 会话的身份错配。分屏遥测等待能触达分屏自己
  会话客户端的派发方式。
- hosted persona 与 Managed 通道不广告该 tag；对着这样的 daemon 的独立版
  客户端不显示标记。
- `recorded: true` 证明的是事件进入了 `logUserFeedback`，不是 RUM 已送达：
  RUM flush 是周期性、尽力而为的，使用统计退出会整个移除该 sink。

## 风险

- 有缺陷或恶意的本地客户端可以发任意 `promptId` 污染分析数据；由 token 鉴权
  与非空校验缓解，作为纯遥测面接受。
- 子进程重启或请求超时时，fire-and-forget 会静默丢事件。这与遥测既有的
  尽力而为契约一致；界面标记不受影响。
- 独立版 `onRate` 给通知钩子加了第二个消费者；未来若有宿主复用独立版入口的
  行为，必须保持宿主优先（有测试覆盖）。

## 涉及文件

| 文件                                                                     | 改动                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `packages/cli/src/serve/routes/session.ts`                               | 新增 `POST /session/:id/feedback` 路由（live-session-owner）。                   |
| `packages/sdk-typescript/src/daemon/capabilities.ts`                     | `session_turn_feedback` 注册表 tag（注册表在 SDK 里，serve 模块再导出）。        |
| `packages/cli/src/serve/capability-parity.ts`                            | parity 行：无 Managed 等价物。                                                   |
| `packages/cli/src/serve/server.test.ts`                                  | 预期广告 features 清单。                                                         |
| `integration-tests/cli/qwen-serve-routes.test.ts`                        | 预期广告 features 清单。                                                         |
| `packages/acp-bridge/src/status.ts`                                      | `SERVE_CONTROL_EXT_METHODS.sessionFeedback`。                                    |
| `packages/acp-bridge/src/bridgeTypes.ts`                                 | `AcpSessionBridge.rateSessionTurn` + 请求/结果类型。                             |
| `packages/acp-bridge/src/session-control-plane.ts`                       | 基于会话 extMethod 助手的 bridge 实现。                                          |
| `packages/cli/src/acp-integration/acpAgent.ts`                           | `extMethodInternal` 分支：门控、映射、`logUserFeedback`。                        |
| `packages/cli/src/serve/server/telemetry.ts`（+ `.test.ts`）             | 反馈路由的目录条目（`handler_resolved`）与审计路由计数。                         |
| `package.json` + `scripts/tests/no-ak-integration-ci.test.js`            | 集成套件的 no-AK CI 登记（列表与钉死的 argv 同提交）。                           |
| `integration-tests/cli/_daemon-harness.ts`                               | `envDrop` 选项，供隔离 rig 剔除宿主会话环境泄漏。                                |
| `packages/sdk-typescript/src/daemon/index.ts`                            | 桶文件再导出 `RateSessionTurnResult`。                                           |
| `packages/sdk-typescript/src/daemon/types.ts`                            | `RateSessionTurnResult`。                                                        |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts`                     | `rateSessionTurn` POST 方法。                                                    |
| `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`              | 会话句柄包装。                                                                   |
| `packages/web-shell/client/daemon/session/actions.ts`                    | `rateAssistantTurn` action。                                                     |
| `packages/web-shell/client/daemon/chat-capabilities.ts`                  | 穷举的 feature→region 映射条目：该 tag 不翻转任何 chat region。                  |
| `packages/web-shell/client/App.tsx`                                      | 独立版、capability 门控的 `assistantFeedback` 接线，宿主优先，含跨会话派发守卫。 |
| `docs/developers/qwen-serve-protocol.md`                                 | 路由 + capability 文档，紧邻轮次状态一节。                                       |
| `docs/design/web-shell/web-shell-assistant-feedback.md`（+ `.zh-CN.md`） | 更新独立版开启与遥测状态，链接到本文。                                           |

测试按仓库约定与每个改动的源文件同目录放置。

## 验证计划

单元测试（逐层、同目录）：

- 路由：body 校验矩阵（缺失/空 `promptId`、非法 `rating`、合法 body）、
  clientId 头解析、bridge 转发、所有权包装器行为继承自共享助手。
- agent 处理器：按数值钉死 `up → GOOD(3)`、`down → BAD(1)`；事件字段取自
  会话 Config；`ui.enableUserFeedback === false` → `{ recorded: false }`
  且不调 logger；会话缺失 → invalid params；使用统计退出时 RUM 缺席
  （既有 `QwenLogger` 门，在处理器边界断言）。
- bridge：ext method 名、参数形状、超时/通道关闭的传播。
- SDK：请求 URL、方法、body、clientId 头、错误传播。
- Web Shell：无会话时 action no-op 与错误隔离；App 接线矩阵——capability
  缺席 → 无标记；capability 存在 → 有标记且 `up`/`down` 触发通路调用、
  `null` 不触发；宿主配置项优先，包括 `enabled: false`。

E2E（真实 daemon + 真实浏览器；计划在 `.qwen/e2e-tests/`）：

- 基线缺口：今天的独立版页面不显示标记；`POST /session/:id/feedback` 无路由。
- 实现后：完成一轮，点"满意" → HTTP 200 `{ recorded: true }`；会话 JSONL
  新增一条 `system/ui_telemetry` 记录，其 `systemPayload.uiEvent` 满足
  `event.name === 'qwen-code.user_feedback'`（`logUserFeedback` 盖的规范名；
  事件类自身携带的是 `user_feedback`）、`rating === 3`、`prompt_id` 等于该轮
  准入的 promptId。点"不满意" → `rating === 1`。取消点亮的标记 → 无新记录、
  无通路调用。
- workspace 设置 `ui.enableUserFeedback: false` → `{ recorded: false }`、
  无记录；标记仍在本地正常点亮。
- 不对着线上端点断言 RUM 送达本身（那会向生产 sink 发真实数据）；会话记录
  加单元级 logger 断言，覆盖到既有共享 RUM 入队为止的路径。

## 验收标准

- daemon 广告 `session_turn_feedback` 时，独立版 Web Shell 在已完成的交互
  轮次上显示标记；点击立即点亮，并恰好发出一条 `user_feedback` 事件，rating
  映射正确、带该轮 `promptId`。
- 事件的 `session_id`、`model`、`approval_mode` 来自活会话 Config，而不是
  客户端。
- 取消标记不发事件；嵌入式宿主与旧 daemon 的行为与之前完全一致。
- `ui.enableUserFeedback === false` 抑制发射但保留本地标记体验；使用统计
  退出继续移除 RUM sink。
- 通路失败绝不回滚、阻塞或延迟可见的标记。

## 开放问题

无阻塞项。标记本身的服务端持久化仍是原设计的后续事项，本次不动。
