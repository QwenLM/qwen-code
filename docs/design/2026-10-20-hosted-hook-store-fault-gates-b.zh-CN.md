# Hosted Hook 存储故障门禁 FG13b

[English](2026-10-20-hosted-hook-store-fault-gates-b.md) | [简体中文](2026-10-20-hosted-hook-store-fault-gates-b.zh-CN.md)

> 注入缝与首两格已在 #14817 合入。结果提交与 plan 结果提交两格在本 PR
> 交付；注册结算需要注入缝尚无的 catalog phase，因此归入 FG13a store acks
> 那一片，而不是在这里再长出一套接缝。

## 问题与范围

FG13b 在真实 Session store 事务内逐一拒绝 Hook 的持久化提交：执行 intent、
`dispatch_started`、执行结果、plan 记录的结果、以及注册结算。被拒绝的写入必须
不产生物理调用、不产生重复执行，且记录保持可重试。

## 注入缝

`StoreFaultGate`（仅测试用）新增四个 Hook phase：`HOOK_INTENT`、
`HOOK_DISPATCH_STARTED`、`HOOK_SETTLED`、`HOOK_PLAN_SETTLED`。它按
`hookExecutionId` 匹配 `hook_execution` 记录，并用 `hookId == "__plan__"`
区分 plan marker。`HOOK_PLAN_SETTLED` 还要求 `eventName == "PreToolUse"`：
`SessionStart` 与 `UserPromptSubmit` 在没有匹配 Hook 时同样会提交一个已结算
的空 marker，只判 `__plan__` 会先拒掉那个无关记录。
`FaultingExtensionRecordStore` 已经包住 store bean；Hook IT
通过测试用 `@Configuration` 注册它，因此每次提交仍在真实事务中执行。

## 用例

| 用例                                                        | 注入                          | 期望                                                    |
| ----------------------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `fg13bHookIntentStoreRejectionDispatchesNothingOnMySql`     | 拒绝 intent 提交              | 注入确实触发；零物理调用。                              |
| `fg13bHookDispatchStoreRejectionDispatchesNothingOnMySql`   | 拒绝 `dispatch_started` 提交  | 注入确实触发；零物理调用。                              |
| `fg13bHookResultStoreRejectionSettlesFromTheReceiptOnMySql` | 拒绝已结算提交                | 一次物理调用；后续 status 读取按 worker 回执结算。      |
| `fg13bHookPlanResultStoreRejectionRebuildsTheMarkerOnMySql` | 拒绝 plan marker 的已结算提交 | 由已保存回执重建 marker。                               |
| 注册结算（移交 FG13a）                                      | 拒绝 catalog 结算             | 重试沿用原 operation id；需要注入缝新增 catalog phase。 |

## 变异见证

以下均在 `hosted-harness-mysql` 车道上单点改造实测。

- arm 一个永不匹配的 phase，或不 arm：`attempts` 恒为 0，用例以该等待的
  `ConditionTimeout` 变红。
- arm 比用例预期更早的 phase（结果格用 `HOOK_INTENT`）：`attempts` 会触发、
  Turn 进入 recovery-blocked，但 Hook 从未运行，用例红在「一次 `hook.call`」
  断言上（`Expected size: 1 but was: 0`），而不是红在等待上。
- 只匹配 MCP 域，Hook 提交永远不会被拒绝：注入不触发，同样是 `attempts`
  等待的 `ConditionTimeout`。
- gate 仍 arm 但让每次提交通过：现装的 2–3 秒窗口太短看不见，用例保持绿。
  把窗口放宽到 25–30 秒才在零 `hook.call` 断言上变红，可见窗口本身就是活性
  界，而不是断言。

## 验证

在 Linux、MySQL 8.4 与委派 cgroup v2 根上跑完整的 `hosted-harness-mysql`
车道即证据。被跳过的用例不算通过。
