# 模型可用性台账（Qoder 能力移植，选项 B）

[English](./2026-11-15-model-availability-tracking.md)

- **日期**：2026-11-15
- **状态**：提案
- **跟踪**：Qoder→main 集成，选项 B（main 架构赢，移植差异化能力）。首个移植能力：`availability`。
- **来源**：preview `packages/core/src/availability/`（tag `587e3429ca`），集成清单中归为 NEW-相邻 / 承重 ALTERNATIVE。自包含（4 文件 / 393 行，纯状态机）。

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
- API：`markTerminal`、`markHealthy`、`markRetryOncePerTurn`、`consumeStickyAttempt`、`snapshot`、`selectFirstAvailable`、`resetTurn`、`reset`，另加 main 特有的 `beginTurn(turnKey)`——仅当轮键（用户 prompt id）变化时重置 consumed 状态；main 没有显式轮边界钩子，故用 prompt id 作轮键。
- 保留 preview 的不变量：terminal 失败绝不降级为 transient；`markRetryOncePerTurn` 在已 sticky 时保持 `consumed`（避免同轮死循环）；`snapshot` 对 terminal 或已消费的 sticky 报不可用。

### 归属与接线

- `Config` 持有一个实例（会话级），经懒加载 `getModelAvailabilityService()` getter 暴露，与 preview 的 Config 归属一致。
- 在 fallback 链中、设置门控之下：
  - `beginTurn(prompt_id)`，让新一轮对 sticky 模型重探一次。只有 fallback 模型被写入/读取台账；primary 仍每请求被尝试、不被标记（标记它是死写——链上两处同模型守卫把它排除在跳过之外）。
  - 尝试某 fallback 模型前查 `snapshot(model)`；跳过报不可用的模型（记入既有 skip/debug 路径）。
  - 某 fallback 在 fallback-eligible 容量错误上耗尽重试时，调 `markRetryOncePerTurn(model)` 再 `consumeStickyAttempt(model)`，使其在本轮剩余被跳过。
  - fallback 响应成功时 `markHealthy(model)`。
  - 显式用户 Retry（`SendMessageType.Retry`，经 `LlmClient` → `Turn` → `LlmChatSendOptions` 穿为 `isExplicitRetry`）是一个轮边界：调 `resetTurn()`，使 Retry 重探失败尝试已消费的 fallback——尽管 Retry 复用 prompt id。
- 本次移植的错误映射刻意收窄：只有 `isFallbackEligible` 已放行的容量状态喂台账（`sticky_retry`）。terminal/quota 标记延后到 follow-up，首个 PR 不改 auth/billing 行为。

### 功能门

新增布尔设置 `experimental.modelAvailabilityTracking`，**默认 false**。关闭时 fallback 链行为与今日完全一致（不读不写台账）。首个移植保持 opt-in、可回退；待 nightly 证据充分后由后续 PR 翻默认。

## 关键设计决策

| 决策                                | 理由                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------- |
| 逐字移植服务逻辑，重命名 kebab-case | 纯状态机、preview 已充分测试；无 zod 依赖故无需 zod-4 改造。                |
| 会话级挂 Config                     | 与 main 的按会话 Config 及 preview 归属一致；避免进程级健康单例。           |
| 本次仅容量→sticky_retry             | `isFallbackEligible` 已限定范围；terminal/quota 会触碰 auth/billing，延后。 |
| 设置门默认关                        | fallback 链的行为变更须先 opt-in、可回退。                                  |
| 轮首 resetTurn                      | 新一轮应对 sticky 模型重探一次；与 preview 语义一致。                       |

## 涉及文件

- `packages/core/src/core/model-availability-service.ts`（新）+ 同址测试。
- `packages/core/src/config/config.ts` — 持有服务的懒加载 getter + `modelAvailabilityTracking` 参数。
- `packages/core/src/core/llm-chat.ts` — 门控下的 fallback 链查询/标记；`LlmChatSendOptions` 上的 `isExplicitRetry`。
- `packages/core/src/core/turn.ts` + `packages/core/src/core/client.ts` — 把显式 Retry 标志从 `SendMessageType.Retry` 穿到 send options。
- `packages/cli/src/config/settingsSchema.ts` + `packages/cli/src/config/config.ts` — `experimental.modelAvailabilityTracking`（默认 false）+ 透传，CLI 接线测试镜像 `unifiedAgentLoop` 的 opt-in/opt-out/unset 形状。

## 验收标准

- 服务单测移植并通过（terminal 不降级；sticky 每轮消费一次；selectFirstAvailable 跳过不可用；resetTurn 重探）。
- 门关闭时 fallback 链行为逐字节不变（既有 llm-chat fallback 套件保持绿）。
- 门开启时，容量错误耗尽的模型在同轮下一请求被跳过、下一轮重探一次。
- build + typecheck + 受影响套件绿；多轮自审。

## 范围外（follow-up）

- 在链入口跳过不健康的 **primary**（本移植只跳过 fallback；primary 仍每请求被尝试）。
- terminal/quota 标记与 `modelPolicy` 动作映射（prompt vs silent）。`markHealthy` 刻意保留——尽管在 terminal 标记落地前它无可观测效果。
- 跨会话 / 账号级健康共享。
- 翻设置默认值。
