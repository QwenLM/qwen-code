# 模型可用性台账（Qoder 能力移植，选项 B）

[English](./2026-11-15-model-availability-tracking.md)

- **日期**：2026-11-15
- **状态**：提案
- **跟踪**：Qoder→main 集成，选项 B（main 架构赢，移植差异化能力）。首个移植能力：`availability`。
- **来源**：preview `packages/core/src/availability/`（tag `587e3429ca`）。自包含（4 文件 / 393 行，纯状态机）。

## 问题

main 的模型 fallback（`core/llm-chat.ts`「Model fallback chain」）是**每请求无状态**的：主模型在容量错误（429/503/529，`isFallbackEligible`）上耗尽重试预算后，链上逐个以全新预算试 fallback。没有任何东西记住某个 fallback 刚被耗尽，于是**同一轮的下一个请求又从头重试同样已耗尽的 fallback**，在再次到达健康模型前白白消耗时延与配额。本移植给链上提供**fallback 选择**的跨请求记忆：已耗尽的 fallback 在本轮剩余被跳过、下一轮重探一次。primary 仍每个请求都被尝试（它可能已恢复）；在链入口跳过不健康 primary 是另一项设计改动，不在本次范围。

## 现状（已在分支基点核实）

- `isFallbackEligible`（`utils/retryErrorClassification.ts`）：仅 status 429/503/529、非 transport、diagnosis 非 `fail-fast`/`unknown` 才 fallback。
- fallback 链（`core/llm-chat.ts` ~5800）：受 `getModelFallbacks()` 门控，unattended/persistent 模式与已产出 chunk 时跳过；最多 3 次切换；每个 fallback 经 `resolveForModel(..., failClosed)` 解析。
- main 任何地方都没有跨请求的模型健康记忆。

## 拟议改动

移植 preview 的 `ModelAvailabilityService`（按模型的健康台账），接入 fallback 链，使被耗尽的模型在本轮剩余请求里被跳过，而不是每个请求都重试。

### 服务（移植，自包含）

`packages/core/src/core/model-availability-service.ts`（按 main 约定用 kebab-case；preview 文件为 `modelAvailabilityService.ts`）。纯状态机，无 zod、无外部依赖，故无需 zod-4 改造：

- 状态：`terminal`（reason `quota`|`capacity`）与 `sticky_retry`（`retry_once_per_turn`，带 `consumed` 标志）。
- API：`markTerminal`、`markHealthy`、`markRetryOncePerTurn`、`consumeStickyAttempt`、`snapshot`、`resetTurn`，另加 main 特有的 `beginTurn(turnKey)`——仅当轮键（用户 prompt id）变化时重置 consumed 状态。main 的轮身份就是 prompt id：`Config` 已持有按交互写入的轮边界对象（`TurnBudget`，交互开始时由 `beginTurnBudget` 写入），但台账刻意只对白名单内发送的 prompt id 作键、不复用它，因为该写入方对台账必须排除的 `Notification`/`Teammate` 发送也会触发。preview 的 `selectFirstAvailable` 与 `reset` 助手刻意不移植：fallback-跳过接线中没有调用方、后续也无计划使用（primary 选择不在范围内），移植只会是死代码。`terminal` 状态与 `markTerminal` 虽在本移植中无调用方仍保留——延后的 terminal/quota 标记 follow-up 就是它们的计划调用方，这与被删的两个助手不同。
- 保留 preview 的不变量：terminal 失败绝不降级为 transient；`markRetryOncePerTurn` 在已 sticky 时保持 `consumed`（避免同轮死循环）；`snapshot` 对 terminal 或已消费的 sticky 报不可用。

### 归属与接线

- `Config` 持有一个实例（会话级），经懒加载 `getModelAvailabilityService()` getter 暴露，与 preview 的 Config 归属一致。
- 在设置门控之下，轮边界在 `sendMessageStream` 入口每请求执行一次——不在 fallback 分支内——因此即使某请求根本没进入链也生效：
  - `beginTurn(prompt_id)`：轮键（用户 prompt id）变化时对 sticky 模型重探一次；同键请求保持 consumed 状态。
  - 显式用户 Retry（`SendMessageType.Retry`，经 `LlmClient` → `Turn` → `LlmChatSendOptions` 穿为 `isExplicitRetry`）调 `resetTurn()`，使 Retry 重探失败尝试已消费的 fallback——也尽管已恢复的 primary 服务了 Retry 的第一个请求。两面在 Retry 时都已新铸 prompt id——TUI 经铸造计数器（R8-F1）、ACP 经每次 `prompt()` 的轮计数器——故新轮边界本就重探；`resetTurn()` 另保证若某 Retry 面复用 prompt id 时也重探，否则 `beginTurn` 会是同键 no-op。
  - 只有会话轮发送参与，经由台账门要求的 `isSessionTurn` 标志。成员资格由**发送方**判定，而非从「走了 `Turn`」推断：`LlmClient` 按 `messageType` 为正在进行那一轮的 `Turn` 置 `isSessionTurn`——本轮自身的发送（用户 query、cron、goal、retry、tool result、续轮）为 true，`Notification`/`Teammate`（携带全新 prompt id）为 false。并发 `/btw` 侧问、`Notification` 与 `Teammate` 另按其 prompt id 的登记表（`backgroundInteractionPromptIds`）排除：后台 flag/messageType 只在首次发送上，故其不带 flag 的 ToolResult/Hook/Steer 续发也必须按 prompt id 排除，否则会轮换实时轮的键。每个登记的 id 都唯一：CLI 在每个顶层轮新铸 id 时递增单调的 prompt-id **铸造计数器**——用户 query、cron、teammate、`Notification`、`Goal`、`Retry` 皆然——故登记的 id 不会被前台轮复用（R6-1/R7-1/R8-F1 根治）。铸造计数器与用户可见的 `Prompts` 统计（`userPromptCount`，用户 query、cron、teammate 轮——历史计为 prompt 的集合——递增，后台 notification/goal/retry 铸造不计）解耦，故后台铸造不会抬高 `/stats`、反馈阈值或 tip 节奏（R8-F3）。登记表像 `stopHookChains` 一样有界 FIFO，按插入序驱逐（R8-F11）；其安全性在于后台交互的续发在本轮内收尾，远早于 32 个更新交互驱逐其 id——该界并非收尾检查。headless CLI 中 teammate 轮新铸自己的 id，teammate 轮结束后后续前台轮恢复基础 id，故登记的 teammate id 不会丢掉之后的前台发送（R8-F2）。`Goal` 轮是台账成员（不登记），但其新铸 id 同样唯一，故它耗尽的 fallback 不会被之后从未尝试它的用户轮跳过。`Turn` 以构造参数接收（默认不设），仅在置位时转发到 send options。`turnModelRound` 构造其 `Turn` 时不带它——它的每个生产调用方都是共享会话 `Config` 的后台轮（subagent 共享 loop 与 unified-loop speculation）。ACP 会话发送置 true，`LlmChat.sendPreparedMessageStream`（hosted-harness prepared resume）在委托给 `sendMessageStream` 时硬编码置 true——二者都是真实的会话发送。ACP 轮内自动续发会把 prompt id 重写为 guard/stop-hook/background-result/mid-turn 后缀，故 ACP 发送方把该轮的基础 id 作为 `ledgerTurnKey` 传入、台账以它为键（`prompt_id` 保留其 prompt 身份）；否则每次续发都会被读成新的一轮并重置已消费标记。直接后台发送（forked 查询、legacy speculation/subagent、建议）调 `sendMessageStream` 时不带该标志。因此后台操作既不轮换正在进行那一轮的键，也不读写其标记，并保持门关闭时的 fallback 行为。这是白名单而非 prompt id 黑名单：后台发送方用的 id（如 subagent 的 `session#agent#ordinal`）任何固定黑名单都匹配不到，且共用的 `isInternalPromptId` 过滤集合不能扩展——它同时门控记录/遥测。若不排除，一次后台发送会清掉正在进行那一轮的 consumed 状态，并可能跳过一个瞬时耗尽的 fallback，使一个门关闭时链本会服务的请求失败。
- 在 fallback 链本身，只有 fallback 模型被写入/读取台账；primary 仍每请求被尝试、不被标记（标记它是死写——primary 在 fallback 链之前被尝试、从不是 fallback 候选，故跳过从不读它的标记）：
  - 尝试某 fallback 模型前查 `snapshot(model)`；跳过报不可用的模型（记入既有 skip/debug 路径）。
  - 某 fallback 在 fallback-eligible 容量错误上耗尽重试时，调 `markRetryOncePerTurn(model)` 再 `consumeStickyAttempt(model)`，使其在本轮剩余被跳过。即使该 fallback 在失败前已产出内容也会标记（链仍在那里停止以避免重复用户可见输出）；标记仍以 `isFallbackEligible` 为门，故产出后的 auth/client 错误不会被记录。
  - fallback 响应成功时 `markHealthy(model)`。
- 轮键局限：`lastTurnKey` 是会话级服务上的单个标量，且标记仅以模型为键、不记录写入它的轮。内部后台发送已被排除（见上），故残余情形是共享同一 `Config` 的两个真实用户轮并发。该并发有两个方向。失败即放开：新轮的 `beginTurn` 重置另一轮的 consumed 标记，模型被重探（改动前行为），跳过优化不生效。失败即关闭：轮 A 在飞请求于轮 B 已开始后才写入的迟到标记会绑定轮 B，使 B 跳过它从未尝试过的 fallback，并可能在门关闭时链本会尝试它的场景下失败。两个方向都限于该并发与 opt-in 门；follow-up 可给每条标记打上其请求轮的键以忽略他轮标记。
- 本次移植的错误映射刻意收窄：只有 `isFallbackEligible` 已放行的容量状态喂台账（`sticky_retry`）。terminal/quota 标记延后到 follow-up，首个 PR 不改 auth/billing 行为。

### 功能门

新增布尔设置 `experimental.modelAvailabilityTracking`，**默认 false**。关闭时 fallback 链行为与今日完全一致（不读不写台账）。首个移植保持 opt-in、可回退；待 nightly 证据充分后由后续 PR 翻默认。

## 关键设计决策

| 决策                                   | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 移植服务逻辑（删无用助手），kebab-case | 纯状态机、preview 已充分测试；无 zod 依赖故无需 zod-4 改造。`selectFirstAvailable`/`reset` 在此无调用方，故不移植。                                                                                                                                                                                                                                                                                                                                                                |
| 会话级挂 Config                        | 与 main 的按会话 Config 及 preview 归属一致；避免进程级健康单例。                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 本次仅容量→sticky_retry                | `isFallbackEligible` 已限定范围；terminal/quota 会触碰 auth/billing，延后。                                                                                                                                                                                                                                                                                                                                                                                                        |
| 设置门默认关                           | fallback 链的行为变更须先 opt-in、可回退。                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 轮边界在请求入口                       | `beginTurn`/`resetTurn` 在 `sendMessageStream` 任何模型调用前执行，故被 primary 服务的显式 Retry 仍重探已消费的 fallback。                                                                                                                                                                                                                                                                                                                                                         |
| 会话轮白名单（`isSessionTurn`）        | 成员资格由发送方判定（`LlmClient` 按 `messageType`；ACP 会话发送与 prepared resume 置 true），而非从「走了 `Turn`」推断。后台发送方（`turnModelRound` 的 subagent/speculation、forked、建议、Notification/Teammate）不打该标志；并发侧问按其登记的 prompt id 排除（覆盖其不带 flag 的续发），ACP 轮内续发保留该轮基础 `ledgerTurnKey`。用白名单而非 prompt id 黑名单，因为后台 id（如 `session#agent#ordinal`）任何固定黑名单都匹配不到，且共用 internal-id 过滤集合同时门控遥测。 |

## 涉及文件

- `packages/core/src/core/model-availability-service.ts`（新）+ 同址测试。
- `packages/core/src/config/config.ts` — 持有服务的懒加载 getter + `modelAvailabilityTracking` 参数。
- `packages/core/src/core/llm-chat.ts` — 请求入口的轮边界 + 门控下的 fallback 链查询/标记，会话轮白名单；`LlmChatSendOptions` 上的 `isExplicitRetry`、`isSessionTurn` 与 `ledgerTurnKey`（`beginTurn` 以 `ledgerTurnKey ?? prompt_id` 为键）。
- `packages/core/src/core/turn.ts` + `packages/core/src/core/client.ts` — 把显式 Retry 标志从 `SendMessageType.Retry` 穿到 send options，并在发送方判定台账成员资格：`LlmClient` 按 `messageType` 置 `isSessionTurn`，`Turn` 从构造参数（默认不设）转发；并发侧问 prompt id 登记表排除侧问不带 flag 的 tool-result 续发。
- `packages/cli/src/acp-integration/session/Session.ts` + `packages/cli/src/acp-integration/session/ledger-turn-key.ts` — ACP 发送置 `isSessionTurn`；`deriveLedgerTurnKey` 把轮内续发后缀归一化为 `ledgerTurnKey`（prompt 身份不变）。
- `packages/cli/src/ui/hooks/use-llm-stream.ts` + `packages/cli/src/ui/contexts/SessionContext.tsx` — prompt-id 铸造计数器（`promptCount`）对每个铸造的顶层轮（用户 query、cron、teammate、notification、goal、retry）递增；用户可见 Prompts 统计（`userPromptCount`）对用户 query、cron、teammate 轮（历史计为 prompt 的集合）递增，供 `/stats`（`statsCommand.ts`）、反馈阈值（`useFeedbackDialog.ts`）与 tip 节奏（`AppContainer.tsx`）。
- `packages/core/src/core/agent-loop.ts` — `turnModelRound` 构造其 `Turn` 不带 `isSessionTurn`：每个生产调用方都是共享会话 `Config` 的后台轮（subagent 共享 loop、unified-loop speculation）。
- `packages/cli/src/nonInteractiveCli.ts` — headless teammate 轮新铸自己的 prompt id；`teammateTurnActive` 标志在该轮及其续发保留它，并为下一前台轮恢复基础 id。
- `packages/cli/src/config/settingsSchema.ts` + `packages/cli/src/config/config.ts` — `experimental.modelAvailabilityTracking`（默认 false）+ 透传，CLI 接线测试镜像 `unifiedAgentLoop` 的 opt-in/opt-out/unset 形状。
- `docs/users/configuration/settings.md` + `packages/web-shell/client/settings.ts` / `settings/messages.ts` — 设置参考行、Web Shell alias 与 zh-CN label/description。

## 验收标准

- 服务单测移植并通过（terminal 不降级；sticky 每轮消费一次；resetTurn/beginTurn 重探）。
- 门关闭时 fallback 链行为逐字节不变（既有 llm-chat fallback 套件保持绿），并由一条用例钉住：注入真实 service 而门返回 false，断言耗尽的 fallback 仍被重试、getter 从未被调用。
- 门开启时，容量错误耗尽的模型在同轮下一请求被跳过、下一轮重探一次。
- 内部后台发送既不擦除正在进行那一轮的 consumed 状态，也不因跳过 fallback 而失败；被 primary 服务的显式 Retry 仍重探已消费的 fallback（`llm-chat.test.ts` 回归用例）。
- 每个基于登记表排除所依赖的 id 唯一性前提都被钉住：每个铸造的顶层轮（用户 query、cron、teammate、Notification、Goal、Retry）递增铸造计数器使下一个新铸 id 不同；铸造计数器与用户可见 Prompts 统计解耦；登记表有界 FIFO；headless 中 teammate 轮之后的前台轮恢复基础 id（`use-llm-stream.test.tsx`、`client.test.ts`、`nonInteractiveCli.test.ts` 的 R8-F1/F2/F3/F11 用例）。
- primary 即使被台账标记为不可用仍每请求被尝试；MODEL_FALLBACK 序号在台账跳过时只计实际尝试的 fallback（`llm-chat.test.ts` 的 R8-F9/F10 用例）。
- Config 钉住 false 默认值、稳定的懒加载 service 单实例，以及派生 Config（经 `deriveConfig`）在会话创建台账后通过原型链共享它。
- build + typecheck + 受影响套件绿；多轮自审。

## 范围外（follow-up）

- 在链入口跳过不健康的 **primary**（本移植只跳过 fallback；primary 仍每请求被尝试）。
- terminal/quota 标记与 `modelPolicy` 动作映射（prompt vs silent）。`markHealthy` 刻意保留——尽管在 terminal 标记落地前它无可观测效果。
- 跨会话 / 账号级健康共享。
- 翻设置默认值。
