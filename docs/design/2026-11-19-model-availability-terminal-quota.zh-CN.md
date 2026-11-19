# 模型可用性：fallback 链的永久配额（terminal quota）标记

- **日期：** 2026-11-19
- **状态：** 已实现（待评审）
- **基于：** [2026-11-15-model-availability-tracking.md](./2026-11-15-model-availability-tracking.md)（已在 #17377 合入，squash `3755d5e7af`）
- **English version:** [2026-11-19-model-availability-terminal-quota.md](./2026-11-19-model-availability-terminal-quota.md)

## 问题陈述

已合入的可用性移植（#17377）会把耗尽**瞬时容量**错误（429/503/529，
`isFallbackEligible`）的 fallback 模型记为 `sticky_retry`：本轮内跳过、下一轮
重探。台账还定义了 `terminal` 态（`markTerminal(model, 'quota' | 'capacity')`），
它跨 `resetTurn` 存活且永不降级，但移植时刻意让 `markTerminal` 没有调用方。

缺口：fallback 模型若以**永久配额**错误失败，今天根本不被记录，于是后续每一轮
都重探它——即便它在配额重置（可能数天后）之前不可能成功。每次重探都为一个早已
注定的结果浪费一次请求与延迟。

### 为什么永久配额今天到不了台账

`classifyRetryError` 把永久配额形状标为 `fail-fast`：

| reason 字面量                | 信号                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `qwen-oauth-free-tier-quota` | QWEN_OAUTH + `isQwenQuotaExceededError`（429 `insufficient_quota`，"free allocated quota exceeded"） |
| `allocated-quota-exceeded`   | provider code `Throttling.AllocationQuota`                                                           |
| `permanent-provider-code`    | provider code/type 命中永久模式，含 `insufficient_quota`                                             |

`isFallbackEligible` 排除 `fail-fast`（与 `unknown`）诊断，所以在 fallback 的
`catch` 块里这些错误的 `canTryNextFallback` 为 `false`，而既有的
`markRetryOncePerTurn` / `consumeStickyAttempt`（以 `canTryNextFallback` 为门）
永不执行。链停止（正确：永久错误不该级联），但耗尽的模型不留任何台账痕迹。

带重置时间的配额错误（百炼 token-plan "1-week quota has been exhausted, will
reset at …"，由 `isQuotaExhaustedError` 检测）也可能从某个 fallback 自己的流
进入 fallback `catch`。按其形状，它或分类为 `fail-fast`/`unclassified`（链停、
未标记），或分类为 `rate-limit` 可重试（记 `sticky_retry`、下轮重探）。对一个
只在指定未来时间重置的配额，两者都不对。

primary 自己的 mid-stream 重置时间配额 fast-fail（`llm-chat.ts` 的
`isQuotaExhaustedError` 分支）抛一个无 status 的格式化 `Error` 并显式跳过模型
fallback；该路径在此不变。

## 提议改动

当 **fallback** 模型以永久配额错误失败时，把它标记为 `terminal`、reason 为
`quota`，使链入口的 snapshot 在本会话剩余时间跳过它，而不是每轮重探。

### 1. 永久配额判定谓词

在重试分类旁（`packages/core/src/utils/retryErrorClassification.ts`）新增
`isTerminalQuotaError(error, classification)`。它按以下顺序恰对永久配额信号返回
true：

- `classification.reason === 'qwen-oauth-free-tier-quota'` 或
  `'allocated-quota-exceeded'`（两个 fail-fast 配额 reason），或
- `isQuotaExhaustedError(error)`——重置时间配额信号，从错误消息读取。此臂在 code
  臂**之前**、独立于分类 reason 运行：429 分类为 `rate-limit`（`isRateLimitError`
  先于分类器的 permanence 臂），永久非配额 code 否则会提前 return，故须先查消息。
  无论错误以原始形状还是格式化 fast-fail `Error` 到达都能捕获。
- `insufficient_quota` code（大小写/分隔符不敏感）出现在
  `classification.providerCode`、provider fields 的 `providerCode`/`providerType`
  （`getProviderFields`）、消息内解析的 `getRateLimitErrorDetails` 的
  `providerCode`/`providerType`、或错误对象自身 `.type`/`.code` 任一处。此读取
  **独立于 `classification.reason`**：canonical OpenAI `429 insufficient_quota`
  分类为 `rate-limit`、绝非 `permanent-provider-code`，若把 code 臂门控在该 reason
  上就会漏掉它。provider fields 覆盖 SDK 把 `insufficient_quota` 放在 `.type`、
  `code: null` 的形状；解析 details 覆盖嵌套报文的 `type` 为 `insufficient_quota`
  而同级 `code` 为非配额的形状（分类器从 `details.providerType` 读取永久性）。
- 上述消息与 code 检查沿**有界 cause 链**运行（错误本身及至多四层 `cause`）。
  retry 层把配额错误包装成无 status Error：QWEN_OAUTH 免费层替代错误剥去配额措辞、
  仅以 `cause` 保留原始错误，故须穿过包装读信号，而非只读抛出错误本身。

非配额的永久错误（审核 `data_inspection_failed`、鉴权、`insufficient_quota`
以外的计费、畸形请求）**不**命中：它们的 code 都不是 `insufficient_quota`，消息
也无重置时间配额信号。瞬时容量（429/503/529 可重试，如 TPM 限流）不命中，保持既有
`sticky_retry` 行为。分类器本身不变：429 仍 `rate-limit`/`retryable`，因为有界重试
阶梯与 `isFallbackEligible` 都依赖它；配额信号是叠加在该分类之外，而非把 429 重新
推理为 fail-fast。

### 2. 接进 fallback catch 块

在 `llm-chat.ts` 的 fallback `catch` 中，把单一的 sticky 标记分支换成 terminal
优先的判定（仍以绑定的 `availability` 为门——opt-in 门关闭或发送非会话轮时它
为 `undefined`）：

```
if (availability) {
  if (isTerminalQuotaError(fallbackError, fallbackClassification)) {
    availability.markTerminal(fallbackRouteKey, 'quota');
  } else if (canTryNextFallback) {
    availability.markRetryOncePerTurn(fallbackRouteKey);
    availability.consumeStickyAttempt(fallbackRouteKey);
  }
}
```

terminal 优先于 sticky：恰好分类为可重试的重置时间配额被记为 `terminal` 而非
`sticky_retry`。台账键是解析后的路由身份（`fallbackRouteKey`），与既有标记完全
一致，故同模型不同路由的健康仍彼此独立。

### 3. 无需新增读取或恢复路径

- 链入口 snapshot 已对 `terminal` 报 `available: false`，故 terminal fallback
  在本会话后续每个请求都被跳过。
- `resetTurn` 已保留 `terminal`（只重置 `sticky_retry.consumed`），故跳过跨轮
  边界存活。
- `startNewSession` 已丢弃服务实例，故 terminal 健康是会话级的，新会话从头重探。
- fallback 成功路径已调 `markHealthy(fallbackRouteKey)`，它清除含 terminal 在内
  的任何状态；这正是上一份设计刻意保留的恢复 API。terminal fallback 在入口被
  跳过、会话内不再被尝试——terminal 按设计是会话永久的，与「terminal 失败永不
  降级」一致。

## 关键设计决策

| 决策                             | 理由                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仅 fallback，不含 primary        | primary 每请求必试（primary-skip 范围外，#17377）。给 primary 写 terminal 是没有读取方的死写。                                                                                                                                                                                                                                                            |
| 仅 reason `quota`                | 窄切片接配额信号。台账上的 `terminal` reason `capacity` 仍可用但无调用方（main 无永久容量分类；529 可重试）。                                                                                                                                                                                                                                             |
| terminal 优先 `else if`          | 避免重置时间配额恰好分类可重试时的双重标记；`markRetryOncePerTurn` 本就拒绝降级 terminal，`else if` 让意图显式。                                                                                                                                                                                                                                          |
| 谓词独立于分类 reason 读配额信号 | 两个 fail-fast 配额 reason 取自分类；重置时间消息臂（`isQuotaExhaustedError`）优先、独立于 reason；`insufficient_quota` code 跨 `classification.providerCode`、provider fields 的 code/type、错误自身 `.type`/`.code` 读取——不门控在 `permanent-provider-code`，因为 canonical `429 insufficient_quota` 分类为 `rate-limit`。分类器不变（429 仍可重试）。 |
| 门不变                           | 标记以绑定的 `availability` 为门（`isSessionTurn && isModelAvailabilityTrackingEnabled?.()`）；gate-off 行为逐字节不变。                                                                                                                                                                                                                                  |
| 不做 `modelPolicy` action map    | preview 的 prompt-vs-silent `ModelPolicy` UI 是独立关注点，范围外（Option B：main 架构赢）。                                                                                                                                                                                                                                                              |

## 涉及文件

- `packages/core/src/utils/retryErrorClassification.ts`——新增
  `isTerminalQuotaError`；从 `quotaErrorDetection.js` 导入 `isQuotaExhaustedError`。
- `packages/core/src/utils/retryErrorClassification.test.ts`——谓词单元语料
  （每个配额信号 true；鉴权/审核/瞬时容量 false）。
- `packages/core/src/core/llm-chat.ts`——fallback `catch` 的 terminal 优先标记。
- `packages/core/src/core/llm-chat.test.ts`——gate-on 集成：fallback 命中永久
  配额被记 terminal，并在下一轮与下一个请求被跳过；gate-off 台账不被触碰；瞬时
  容量仍走 sticky_retry。
- `docs/design/2026-11-15-model-availability-tracking.md`（+ zh-CN）——落地后把
  terminal/quota 标记移出「Out of scope」；注明 `markHealthy` 恢复角色生效。
- `packages/cli/src/config/settingsSchema.ts`（+ 重生成
  `packages/vscode-ide-companion/schemas/settings.schema.json`、web-shell
  `messages.ts` / `i18n-zh-tw.ts`）——若措辞变化，刷新
  `modelAvailabilityTracking` 描述，提及配额耗尽 fallback 的会话永久跳过。

## 范围边界

- 不做链入口的 primary-skip（仍每请求尝试）。
- 不做 `modelPolicy` prompt-vs-silent 用户交互。
- 不做跨会话/账号级健康共享。
- 不改 opt-in 默认值（`experimental.modelAvailabilityTracking` 仍 `false`）。
- 不改 primary mid-stream 配额 fast-fail，也不改重试预算。

## 验证计划

- 谓词单元语料，每个信号配被杀变异（删任一分支 → 对应用例转红）。
- 经真实 fallback 接线、由真实分类器驱动的 gate-on 集成测试：canonical
  `429 insufficient_quota`（rate-limit/可重试、不被 fast-fail）被标记 terminal、
  fallback B 服务，同轮第二个请求与新轮请求都跳过 A（terminal 跨 `resetTurn`
  存活）；无 status 的 fail-fast 配额停链但仍标记 A terminal，新轮直达 B；瞬时
  容量 fallback 仍下轮重探（sticky 不变）。
- gate-off 见证：注入真实 service 而门 false，断言无 `markTerminal` 调用且
  fallback 行为逐字节不变。
- 永久 real-HTTP 测试（真实本地 OpenAI 兼容服务器 + 真实 SDK + 真实
  `ModelAvailabilityService`）：fallback A 返回重置时间配额 body。retry 层的
  stop/continue 决策通过把配额 fast-fail 委托给真实源函数
  （`isQuotaExhaustedError`/`formatQuotaExhaustedMessage`，复刻 `retry.ts`）钉住：
  真实 `retryWithBackoff` 无法在真实 socket 上跑，因其瞬时 429 rate-limit 阶梯用
  真实 1-5 分钟延迟、而 fake timers 会冻结 socket I/O。请求 1 把配额 fast-fail 成
  无 status 格式化 Error，链停（B 未被调用）但 A 被标记 terminal；新轮跳过 A、经
  真实 socket 由 B 服务。变异见证（禁用 terminal 标记 → 观察到重探）。
- core typecheck + lint + 受影响套件绿；多轮自审。

## 开放问题 / 残余

- `makeFallbackStream` 是否共享 primary 的 mid-stream `isQuotaExhaustedError`
  fast-fail，决定到达 fallback `catch` 的确切错误形状（格式化无 status `Error`
  vs 原始 429）。谓词两者都处理；集成测试钉住观察到的形状。
- #17377 记录的单标量 `lastTurnKey` 并发局限不变；terminal 标记继承同一会话轮
  白名单。
- 后台模型轮（subagent 轮、unified-loop 推测）刻意不绑定台账，故仍会尝试被配额
  标记的 fallback。跳过适用于对话自身的会话轮；设置描述已如此说明。让后台轮只读
  台账而不写入是可能的细化，不在本切片。
- terminal 标记在会话内无解除途径：重置时间在会话中途过去的配额、或同一路由键上
  的凭据更换（路由身份只取 `authType` + `baseUrl` 摘要），会使 fallback 被跳过直到
  新会话。这是刻意的会话永久范围；描述指明新会话是唯一重探。在标记上携带重置截止
  时间并于其过去后重探、或在凭据重建时清除 terminal 标记，是更大的恢复增强，不在
  本切片。
- terminal 标记在 post-output `break` 之前运行，故先流式输出部分 chunk 再因配额
  失败的 fallback 仍被记 terminal；专门测试钉住此点（把标记门控在
  `!currentFallbackYieldedAnyChunk` 后即红）。
