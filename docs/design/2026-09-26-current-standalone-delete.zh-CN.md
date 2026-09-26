# 从侧栏删除当前无工作区会话

[English](2026-09-26-current-standalone-delete.md) | [简体中文](2026-09-26-current-standalone-delete.zh-CN.md)

状态：针对 [Issue #12669](https://github.com/QwenLM/qwen-code/issues/12669) 已完成本地实现和验证。四个定向测试文件通过 1570/1570 项测试，全仓类型检查与最终全量构建均通过，并观察到隔离真实 daemon 的单标签与双标签流程。

## 1. 问题与现状

在修复前基线中，Web Shell 侧栏会列出无工作区会话，但当前行的 Delete 被禁用。仅移除禁用条件仍会失败：当此标签页仍附着或提示正在运行时，无工作区批量删除路由会对该会话返回逐项 `session_busy` 错误。[PR #12636](https://github.com/QwenLM/qwen-code/pull/12636) 保留了安全的禁用状态，把“确认 → 离开 → 删除”留给本 issue。维护者此前在真实 daemon 上验证 New task 解除附着后成功删除两次；该结果与下文的本次改动验证分别记录。

`StandaloneRecents` 负责确认框和批量删除请求。`WebShellSidebar` 提供行操作及 New task 操作。`App` 通过 `createNewSession({ kind: 'global' })` 实现全局 New task，并调用会话的 `clearSession()`。在修复前基线中，`clearSession()` 虽等待 detach，却只记录并吞掉 detach 错误；因此 New task 返回 `true` 不能证明 daemon 已解除客户端附着。传给 `StandaloneRecents` 的 New task 包装函数也会丢弃其 Promise。SDK 在缺少 `clientId` 时会把 detach 当作空操作，因此该调用完成也不能证明已解除附着。

## 2. 目标与范围

- 让用户从侧栏两个 Delete 入口删除空闲的当前无工作区会话，操作仍需确认。
- 仅在此标签页成功 detach 后删除确认时选定的会话；保留 daemon 对仍在使用的会话的保护。
- 保持取消确认、删除非当前无工作区会话以及普通 New task 的行为不变。
- 改动仅限 Web Shell 侧栏及其会话操作；`/delete` 选择器、daemon 路由和其他会话来源不在本 issue 范围内。

## 3. 已实现流程

1. 侧栏两个 Delete 入口共用一套禁用规则：操作正在进行，或当前会话有运行中的工作时，仍禁用；空闲的当前无工作区行可以点击。对当前行，即使侧栏摘要已过期，也要使用 App 的实时提示、活动工作和流式输出状态。不要依列表中的 `clientCount` 禁用：列表不会持续轮询，过期的计数可能长期挡住已可删除的会话。
2. 点击 Delete 仅打开现有确认框，不离开会话。确认时固定选中会话的 ID。若它已非当前会话，走现有非当前批量删除路径；若仍为当前会话，则用该预期 ID 调用 App 提供的删除专用、可等待回调。回调在确认时复查实时运行状态；若工作是在打开对话框后开始的，则在离开或删除前停止并显示警告。
3. 回调复用 `createNewSession({ kind: 'global' })`，并传入范围很窄的严格清理选项。清理前校验当前附着会话与预期 ID 一致，且 SDK 会话和连接都持有相同的非空 `clientId`。本次调用中，`clearSession()` 遇到缺失或不匹配的附着状态、缺少 `clientId` 或 detach 失败时必须拒绝，不能返回成功。这项检查必不可少，因为 SDK 在缺少 `clientId` 时会把 detach 当作空操作。普通 New task 仍保持现有尽力清理语义。成功的 detach 响应是发起删除的顺序屏障；不增加延迟、重试或第二次 detach。
4. 仅在成功离开后，`StandaloneRecents` 才发送 `deleteStandaloneSessions([capturedId])`。现有逐项结果处理只在 `removed` 或 `notFound` 时移除行。离开失败时不发删除请求。删除失败（包括其他标签页或竞态导致的 `session_busy`）时保留行、报告错误并刷新列表，让附着状态保持最新。最终以 daemon 判定为准。
5. 操作锁覆盖离开和删除的全过程。若其他导航取代了离开操作，不能删除另一个会话，也不能把该导航当作预期会话已 detach 的证明。现有 New task 错误提示不应被侧栏重复报告。

## 4. 约束与风险

- `clearSession()` 目前先清理本地状态，再等待 detach。严格 detach 失败后，标签页可能已显示新草稿，旧行仍在；界面不能宣称删除成功，应显示失败。需保留原行并验证导航后的状态。
- 侧栏摘要可能落后于当前会话的提示或流式输出状态。当前行必须受 App 实时状态控制，并在离开前的确认步骤复查。
- 列表中的 `clientCount` 可能过期，多标签使用时尤其如此。此标签页 detach 后，另一个标签页仍可能使会话保持忙碌；应展示批量响应的 `errors[]`，不要假设它表现为 HTTP 错误状态，也不要绕过 daemon 守卫。
- 选中 ID 在确认时固定。确认框打开期间或异步离开期间切换会话，都不能把删除目标改成新的当前 ID。

## 5. 验证

- 四个 Web Shell 定向测试文件（`App.test.tsx`、`StandaloneRecents.test.tsx`、`WebShellSidebar.workspace-removal.test.tsx`、`actions.test.ts`）共 1570/1570 项通过。其回归用例覆盖严格 detach 的顺序与拒绝、当前行控制、实时运行状态复查、失败提示和导航竞态。全仓类型检查通过。
- 在隔离的真实 daemon 单标签测试中，确认后先收到 detach HTTP 204，再收到对原 ID 的批量删除 HTTP 200，结果含 `removed`，原行消失。双标签测试中，第一个标签页 detach 后 `clientCount` 从 2 降至 1；批量删除返回 HTTP 200，`errors[]` 中有该 ID 的 `session_busy`；原行保留且页面显示错误。第二个标签页通过 New task 离开后，计数降至 0；第一个标签页在原确认框重试 Delete，成功删除原会话。这些是本次改动的 E2E 观察，与维护者先前的 2/2 结果分开记录。
- 真实 daemon 测试未注入 detach 故障或活动提示，这些分支由定向单测覆盖。最终全仓 `npm run build` 与 `npm run typecheck` 均退出 0。本机未安装全局 `qwen`，因此无法按仓库惯例先用全局 CLI 做基线演练。真实 daemon 测试使用隔离的临时 Conversations 与 discovery 路径。

## 6. 验收标准

- 对空闲的当前无工作区会话确认 Delete 后，离开该确切会话、等待使用有效 `clientId` 确认 detach，且只对确认时固定的 ID 发起一次删除请求。
- 实时运行状态禁用当前行，并在确认时再次检查。取消或离开失败时不发删除请求；删除失败时保留行并解释原因。daemon 继续保护其他客户端和活动提示。
- 非当前无工作区会话删除、普通 New task 和 `/delete` 选择器维持原有行为。面向用户的英文与中文文案，以及本设计的两种语言版本保持一致。
