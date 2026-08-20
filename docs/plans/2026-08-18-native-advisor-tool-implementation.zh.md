# 原生 Advisor Tool 执行清单

- 状态：Ready for review
- 日期：2026-08-18
- 目标 issue：#9036
- 相关 issue：#6542

## 执行规则

每完成一项功能实现后，把该项从 `- [ ]` 改成 `- [x]`。验证、测试和自审单独列在第 13-18 节，只有实际跑过并通过后再勾选。 如果实现过程中发现某项需要拆分，优先在本文件新增子项，而不是把未完成工作藏在提交说明里。

首个 PR 只做 #9036 要求的可观察 executor/advisor 行为；Anthropic provider-native protocol、redacted result、`pause_turn`、prompt caching、自动 checkpoint 和强制 tool choice 都留到后续阶段。

## 当前进度

- 已完成：core 侧 Advisor tool、tool registry 运行时注销、Config 侧 Advisor model/max uses 状态、executor instruction 注入、evidence builder、evidence 长文本截断与旧 transcript 降级、forked Advisor cache path、基础错误处理、CLI/settings 入口迁移、`/advisor` 命令迁移、`/advisor status` 状态查询、settings hot reload 语义、Advisor API usage 的 `advisor` 归因、parent prompt id / consultation ordinal / cache creation token 记录、latency / request status / stable error code 记录、按 `modelPricing` 对 Advisor source 独立估算 cost、context gauge 隔离验证、permission 隔离验证、Advisor 运行中 abort signal 收束验证、headless SIGINT cancellation 验证、手动 review 使用当前有效 Advisor model、跨 provider Advisor picker egress 提示、headless settings / `--advisor` bundle 验证、ACP 启用/咨询/继续/关闭 bundle 验证、interactive TUI 无参 picker / 启用 / 咨询 / 关闭 / 手动 review bundle 验证、focused unit tests、mock provider integration tests、typecheck、lint、build、bundle、`git diff --check`。
- 未完成：无。
- 当前阻塞：无。
- 观察到的缺口：无。真实 TUI Advisor 无参 picker、enable/use/off flow 和 `/advisor review [focus]` manual review flow 已通过 `integration-tests/interactive/advisor-interactive.test.ts` 验证；稳定点是等待 TUI 进入 `YOLO mode` 后再提交 slash command，并在 slash completion 接受 selector 后发送第二次 Enter。

## 1. 准备与基线

- [x] 确认当前分支基于最新 `origin/main`。
- [x] 阅读并确认中文 spec 中的范围、非目标和验收标准没有新的冲突。
- [x] 在 `.qwen/e2e-tests/` 新建 E2E 测试计划。
- [x] 使用全局 `qwen` 记录当前未实现原生 Advisor 的 baseline。
- [x] 记录已有手动 `/advisor` 行为，作为迁移到 `/advisor review [focus]` 的回归基线。全局 `qwen` 0.21.13 没有公开 `advisor` / `--advisor` help 项，安装包中未找到 `/advisor` 手动 review 的可复查实现字符串；本分支用现有手动 review tests 迁移到 `/advisor review [focus]` 作为回归证据。

## 2. Settings 与 CLI 配置入口

- [x] 在 settings schema 中更新 `advisorModel` 描述，明确 opt-in、transcript egress 和不回退主模型。
- [x] 在 settings schema 中新增 `advisorMaxUses`，类型为正整数，`requiresRestart: false`。
- [x] 在 CLI 配置解析中新增 `--advisor <model-selector|off>`。
- [x] 实现 `--advisor <selector>` 的 session-only override，不回写 settings。
- [x] 实现 `--advisor off` 的 session-only disable，不回写 settings。
- [x] 实现 persisted setting、session override、runtime command 的有效值合并。
- [x] 保证空字符串、纯空白和 `off` 都规范化为 disabled。
- [x] 保证未配置 Advisor 时不会回退主模型。

## 3. `/advisor` 命令迁移

- [x] 将无参数 `/advisor` 改为 interactive TUI model picker。
- [x] picker 中包含可选 Advisor 模型和 `Off`。
- [x] `/advisor <model-selector>` 复用现有 model selector 解析和 settings scope。
- [x] `/advisor <model-selector>` 成功后持久化并立即更新当前 session。
- [x] `/advisor off` 在当前 settings scope 写入空字符串并立即关闭当前 session。
- [x] selector 解析失败时返回配置错误，不退化成 manual review。
- [x] `/advisor status` 显示当前 Advisor 状态，不被误解析为模型 selector。
- [x] ACP 中无参数 `/advisor` 返回需要显式 selector 的可操作提示。
- [x] Headless 不增加交互 picker，只使用 settings 或 `--advisor`。
- [x] 将现有手动结构化 review 入口迁移为 `/advisor review [focus]`。
- [x] 保留手动 review 的四字段 JSON、`runForkedAgent` 和 `AdvisorMessage` 展示。
- [x] 更新相关命令帮助、snapshot 和 release-note 文案。

## 4. Core Config 与运行时启停

- [x] 在 `ConfigParameters` 中增加 `advisorModel?: string`。
- [x] 在 `ConfigParameters` 中增加 `advisorMaxUses?: number`。
- [x] 在 `Config` 中增加 Advisor model 和 max uses 的私有状态。
- [x] 实现 `getAdvisorModel()`，返回 trimmed selector 或 `undefined`。
- [x] 实现 `getAdvisorMaxUses()`，未配置表示 unlimited。
- [x] 实现 `setAdvisorConfig({ model, maxUses })`。
- [x] `setAdvisorConfig` 更新 model、max uses 和 tool registry 状态。
- [x] settings hot reload 在没有 model override 时同步 persisted Advisor model。
- [x] settings hot reload 在存在 model override 时保留 session model，但刷新 `advisorMaxUses`。
- [x] stale invocation 在 Advisor 关闭后返回 `disabled`，不发模型请求。

## 5. Tool Registry 与暴露条件

- [x] 在 tool names 中新增 `ToolNames.ADVISOR = 'advisor'`。
- [x] 在 display names 中新增 `ToolDisplayNames.ADVISOR = 'Advisor'`。
- [x] 给 `ToolRegistry` 增加窄接口 `unregisterTool(name)`。
- [x] `unregisterTool` 删除同名 eager tool。
- [x] `unregisterTool` 删除同名 lazy factory。
- [x] `unregisterTool` 使未完成 lazy factory 失效，防止关闭后重新注册。
- [x] Advisor 仅在 `advisorModel` 非空时注册。
- [x] Advisor 在 bare mode 不注册。
- [x] Advisor 在 `forSubAgent` registry 不注册。
- [x] Advisor 受现有 `PermissionManager.isToolEnabled('advisor')` 控制。
- [x] `/advisor off` 后下一次 executor 请求不包含 Advisor tool declaration。

## 6. Advisor Tool Contract

- [x] 新增 `packages/core/src/tools/advisor.ts`。
- [x] Tool name 为 `advisor`，display name 为 `Advisor`。
- [x] Tool 参数 schema 是无参数 object，并拒绝额外字段。
- [x] Tool kind 使用 `Kind.Think`。
- [x] Tool 输出使用 markdown。
- [x] Tool output 非 streaming。
- [x] `shouldDefer` 为 `false`。
- [x] 默认 permission 为 `allow`。
- [x] `toolLocations()` 返回空数组。
- [x] Tool 自身不调用 read、shell、MCP、workspace service 或其他可执行工具。

## 7. Executor Instruction

- [x] Advisor 启用时注入独立 Advisor instruction block。
- [x] Advisor 关闭时完全不注入该 instruction block。
- [x] Instruction 指导复杂任务在方案承诺前咨询。
- [x] Instruction 指导卡住、重复失败或改方案时再次咨询。
- [x] Instruction 指导长任务或高风险任务完成测试后、最终回复前再次咨询。
- [x] Instruction 明确简单短任务不需要咨询。
- [x] Instruction 明确 Advisor tool 必须单独调用，不能和其他 tool calls 并列。
- [x] Instruction 明确 advice 只是参考，不构成用户批准或 permission。
- [x] 更新对应 prompt snapshot tests。

## 8. Advisor Evidence Builder

- [x] 从当前 session 的 `GeminiChat` 和 active generation config 构建 evidence。
- [x] evidence 包含 executor system instruction。
- [x] evidence 包含当前 active tool declarations。
- [x] evidence 使用 `chat.getHistory(true)` 的完整 curated history。
- [x] evidence 包含当前 assistant turn 中 Advisor 调用前的 text parts。
- [x] evidence 在末尾添加 `advisor_consultation` marker。
- [x] 找不到当前 Advisor function call 时返回 `incomplete_transcript`。
- [x] 当前 model entry 包含 sibling function call 时返回 `invalid_call_order`。
- [x] 保留 user/model role。
- [x] 保留 text parts。
- [x] 保留 function call 名称和参数。
- [x] 保留 function response 名称、id 和文本或 JSON 结果。
- [x] 移除 `thought: true` 隐藏推理 parts。
- [x] 移除 provider thought signatures。
- [x] binary inline data 只保留 MIME type、display name 和 omitted 占位。
- [x] 使用结构化对象加 `JSON.stringify` 序列化 evidence。
- [x] 超长字符串值按固定字符上限截断，并追加 `<truncated N chars>` 标记。
- [x] 序列化后超过 Advisor 模型输入预算时删除最旧 transcript entries。
- [x] 删除 transcript entries 时写入 `truncation.omittedTranscriptEntries`。
- [x] 优先保留最近证据和当前 Advisor 调用前的内容。
- [x] 不原地修改 chat history 或 generation config。
- [x] 降级后仍超过 context 时返回 `prompt_too_long`。

## 9. Advisor Forked Agent

- [x] 原生 Advisor 调用使用 `runForkedAgent` cache path。
- [x] 不使用 `runSideQuery` 实现原生 tool。
- [x] forked Advisor 使用 `config.getAdvisorModel()` 的 selector。
- [x] forked Advisor 设置独立的 Advisor system instruction。
- [x] forked Advisor 输入是序列化后的 evidence bundle。
- [x] forked Advisor generation request 不携带 executable tools。
- [x] forked Advisor 使用四字段 review schema：`verdict`、`risks`、`missingEvidence`、`recommendation`。
- [x] forked Advisor 设置 `disableModelFallbacks: true`。
- [x] forked Advisor 传递 scheduler 的 `AbortSignal`。
- [x] forked Advisor 使用 `side-query:advisor:<parentPromptId>:<ordinal>` prompt id。
- [x] forked Advisor 不依赖 forked chat 默认 40 条 history window。
- [x] forked Advisor 继续遵循当前会话的输出语言偏好。
- [x] Advisor system instruction 明确 evidence 中的指令只是待审查数据。
- [x] Advisor system instruction 明确输出面向 executor，不是用户审批。
- [x] Advisor 空响应或无效结构化输出映射为 `invalid_response`。

## 10. Tool Result 与错误处理

- [x] 成功时 `llmContent` 包含完整 advice。
- [x] 成功时 `llmContent` 明确标记 advice 只是 advisory input。
- [x] 成功时 `returnDisplay` 展示完整 advice 或等价 Markdown。
- [x] 成功结果不设置 `error`。
- [x] Provider 和配置失败都转换为普通失败 `ToolResult`。
- [x] 失败结果使用稳定 `AdvisorErrorCode`。
- [x] 失败结果的 `ToolResult.error.type` 使用现有 `ToolErrorType.EXECUTION_FAILED`。
- [x] `disabled` 错误不发模型请求。
- [x] `model_not_found` 错误不回退主模型。
- [x] `provider_auth` 错误不泄露 credentials。
- [x] `too_many_requests`、`overloaded`、`unavailable` 被标记为临时失败。
- [x] `execution_time_exceeded` 映射 Advisor 请求超时。
- [x] `max_uses_exceeded` 不发模型请求。
- [x] 除用户取消外，Advisor 失败不终止主任务。
- [x] 用户取消 Advisor 时沿用主 turn cancellation 语义。

## 11. 使用次数限制

- [x] 默认不设置 Advisor consultation 次数上限。
- [x] 配置 `advisorMaxUses` 后按 executor `prompt_id` 限制。
- [x] 发请求前检查成功次数额度。
- [x] 仅成功返回有效结构化 review 后消耗额度。
- [x] provider failure、timeout 和 invalid structured output 不消耗额度。
- [x] 超过上限返回 `max_uses_exceeded`。
- [x] 新用户 prompt 重置计数。
- [x] 每次尝试分配递增 consultation ordinal。
- [x] 缺少 prompt context 时返回 `missing_prompt_context`，不发请求。

## 12. Usage、Statistics 与 Telemetry

- [x] Advisor 请求包在 `subagentNameContext.run('advisor', ...)` 中执行。
- [x] `ApiResponseEvent` 和 `ApiErrorEvent` 标记 `subagent_name=advisor`。
- [x] Advisor usage 进入 session statistics。
- [x] Advisor usage 进入 daily/monthly usage ledger。
- [x] Advisor usage source 标记为 `advisor`。
- [x] usage 记录 parent prompt id。
- [x] usage 记录 consultation ordinal。
- [x] usage 记录 resolved advisor model 和 provider。
- [x] usage 记录 input、output、cache read tokens。
- [x] usage 记录 cache creation tokens。
- [x] usage 记录 latency、成功/失败和稳定错误码。
- [x] provider 支持价格时按 `main` / `advisor` source 展示独立 estimated cost。
- [x] Advisor usage 不写普通 chat transcript。
- [x] Advisor usage 不污染 executor context occupancy gauge。
- [x] 保持其他 internal side query / forked query 的 ledger 行为不变。

## 13. 单元测试

- [x] 增加 `packages/core/src/tools/advisor.test.ts`。
- [x] 覆盖 tool schema、kind、输出类型、permission 和 locations。
- [x] 覆盖 forked Advisor 参数、model selector、`disableModelFallbacks` 和 abort signal。
- [x] 覆盖 evidence 的完整 history、tool declarations、tool calls 和 tool results。
- [x] 覆盖当前 turn 截断到 Advisor 调用前。
- [x] 覆盖超长 function response 文本截断。
- [x] 覆盖超预算 evidence 删除最旧 transcript entries 并保留最近证据。
- [x] 覆盖 sibling tool call 返回 `invalid_call_order`。
- [x] 覆盖 thought、signature 和 binary payload 规范化。
- [x] 覆盖成功 structured review 格式化后回注。
- [x] 覆盖 provider/model 错误映射。
- [x] 覆盖空响应或无效结构化输出错误映射。
- [x] 覆盖 `advisorMaxUses` unlimited、limit、失败不消耗和新 prompt 重置。
- [x] 覆盖缺失 prompt context。
- [x] 增加或更新 `packages/core/src/config/config.test.ts`。
- [x] 覆盖 trim、空值规范化和正整数 max uses。
- [x] 覆盖 persisted setting、`--advisor` 和 runtime command 优先级。
- [x] 覆盖 enable、disable、bare、subagent 和 permission gate。
- [x] 覆盖 lazy factory 关闭竞态。
- [x] 覆盖 settings hot reload 与 session override。
- [x] 覆盖 stale invocation 关闭后不发请求。

## 14. CLI 与交互测试

- [x] 增加 `/advisor` picker 测试，确认包含 `Off`。
- [x] 增加 `/advisor <selector>` 解析、持久化和 runtime 更新测试。
- [x] 增加 `/advisor off` 持久化空字符串和 runtime 关闭测试。
- [x] 增加 selector 拼写错误测试。
- [x] 增加 `/advisor status` 当前状态、已配置状态、多余参数和 completion 测试。
- [x] 增加 `--advisor <selector>` session-only 测试。
- [x] 增加 `--advisor off` session-only 测试。
- [x] 迁移现有手动 review 测试到 `/advisor review [focus]`。
- [x] 确认 ACP 中 `/advisor`、`/advisor <selector>`、`/advisor off` 和 `/advisor review [focus]` 的 command result 行为。
- [x] 确认 headless 使用 settings 或 `--advisor` 生效。

## 15. Mock Provider 集成测试

- [x] 构造 executor 首次响应调用 `advisor {}` 的 mock 流。
- [x] 验证 Advisor 请求使用配置模型。
- [x] 验证 Advisor 请求不含 executor executable tools；JSON schema 使用 response schema config。
- [x] 验证 Advisor 请求包含规范要求的 evidence 类别。
- [x] 验证 Advisor 请求包含当前 turn 前置文本。
- [x] 验证 advice 作为 function result 返回 executor。
- [x] 验证 executor 在同一用户任务中继续并生成最终回复。
- [x] 验证同一 prompt 两次 consultation 都有唯一 usage 记录。
- [x] 验证第二次 evidence 包含第一次 Advisor call/result 和后续 tool results。
- [x] 验证 Advisor provider 失败后 executor 继续。
- [x] 验证 Advisor advice 不绕过正常 permission deny 规则。
- [x] 验证 `advisorMaxUses: 1` 时第二次调用不发 provider 请求。
- [x] 验证 Advisor 正在运行时收到 headless abort signal 会终止主 turn。
- [x] 验证用户取消 Advisor 时整个主 turn cancellation。
- [x] 验证运行时关闭后下一次 executor 请求没有 Advisor declaration 或 instruction。
- [x] 验证关闭后没有 Advisor model request。
- [x] 验证 Advisor usage 进入 statistics、ledger 和 telemetry。
- [x] 验证 Advisor usage 不增加 executor context gauge。

## 16. E2E 验证

- [x] 使用本分支 bundle 验证 interactive TUI 启用 Advisor。
- [x] 使用本分支 bundle 验证 interactive TUI 咨询并继续执行。
- [x] 使用本分支 bundle 验证 interactive TUI `/advisor off` 后工具消失。
- [x] 使用本分支 bundle 验证 ACP 启用、咨询、继续和关闭。
- [x] 使用本分支 bundle 验证 headless 通过 settings 启用。
- [x] 使用本分支 bundle 验证 headless 通过 `--advisor` 启用。
- [x] 使用本分支 bundle 验证 provider 失败的非致命行为。
- [x] 使用本分支 bundle 验证 cancellation。
- [x] 使用本分支 bundle 验证 usage 展示或可观测记录。
- [x] 将 E2E 输入、输出摘要、provider 请求要点和结论写回 `.qwen/e2e-tests/`。

## 17. 最终验证与自审

- [x] 运行改动相关的 focused unit tests。
- [x] 运行 mock provider integration tests。
- [x] 运行 `npm run build`。
- [x] 运行 `npm run bundle`。
- [x] 运行 `npm run typecheck`。
- [x] 运行必要的 formatting/lint checks。
- [x] 运行 `git diff --check`。
- [x] 阅读完整 diff，包括新增未跟踪文件。
- [x] 第一轮自审：逐项确认实现是否满足 spec。
- [x] 第二轮自审：反向验证测试是否真的覆盖对应行为。
- [x] 更新本清单，把已经完成且验证通过的项目勾选。
- [x] 准备 PR 描述和 Reviewer Test Plan。

## 18. 首个 PR 验收总表

- [x] `/advisor` picker、selector 和 `off` 可配置 Advisor。
- [x] `--advisor` 可以 session-only 覆盖 Advisor。
- [x] 配置优先级、scope 和 hot reload 有测试。
- [x] 启用后 executor 看见无参数 `advisor` tool 和 Advisor instruction。
- [x] 关闭或未配置时 executor 看不见 Advisor tool 或 instruction。
- [x] Advisor 使用配置模型，不能静默回退主模型。
- [x] Advisor 请求没有 executable tools。
- [x] Evidence 包含 system、tools、完整 curated turns、tool calls/results 和当前调用前内容。
- [x] Advice 经现有 tool-result continuation 回到 executor。
- [x] Advice 不改变 permission 行为。
- [x] Provider failure、invalid response 和 use limit 都不终止主任务。
- [x] 默认允许同 prompt 多次咨询；配置上限后严格限制。
- [x] 混合 sibling tool calls 不会产生缺失结果的 Advisor evidence。
- [x] Advisor usage/cost 独立归因到 `advisor`。usage ledger 记录 `source=advisor`；配置 `modelPricing` 时 `/stats model` 按 source 展示独立 estimated cost。
- [x] 用户取消 Advisor 会取消主 turn。
- [x] TUI、ACP 和 headless 核心行为一致。
- [x] `/advisor review [focus]` 手动 review 回归通过。
- [x] build、typecheck、focused unit tests 和 integration tests 通过。

## 19. PR / Release Note 草稿

Release note 草稿：Native Advisor can now be configured with `/advisor <model>` or `--advisor <model>` to expose an opt-in read-only `advisor` tool to the executor. The previous manual second-opinion command moved to `/advisor review [focus]`; `/advisor off` disables the native tool without falling back to the main model.

Reviewer Test Plan 草稿：

- Verify `/advisor` in the interactive TUI opens the Advisor model picker and includes `Off`.
- Verify `/advisor <model>` and `/advisor off` immediately change the next executor request's Advisor tool declaration.
- Verify `/advisor review [focus]` still produces the manual structured review output.
- Verify headless `--advisor <model>` enables Advisor for only the current session, while `--advisor off` disables it.
- Verify an Advisor provider failure returns a non-fatal tool result and the executor continues.
- Verify token usage records separate `main` and `advisor` sources, including parent prompt id and consultation ordinal.
