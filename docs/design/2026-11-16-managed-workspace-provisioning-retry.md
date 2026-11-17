# Serial Runtime preparation before Turn admission

[English](2026-11-16-managed-workspace-provisioning-retry.md) | [简体中文](2026-11-16-managed-workspace-provisioning-retry.zh-CN.md)

Status: implemented; local builds, focused regressions and selected real-process MySQL checks passed. Full CI and deployed-provider acceptance remain pending. Tracks [#17380](https://github.com/QwenLM/qwen-code/issues/17380).

## Problem

The coordinator previously started Runtime warm-up and immediately opened the Harness Session. A Workspace still being prepared could refuse the load and exhaust five admission retries, buying only 31 seconds of default backoff. Extending retry exemptions requires correlating daemon refusal codes with Broker state and maintaining another wait cap.

Instead, prepare the Runtime before an unsubmitted Workspace Turn loads its Harness Session. Preparation is an explicit step in execution order, rather than an inference from a failed load.

## Execution order

1. Keep optional Session-create warm-up asynchronous; it may start preparation early.
2. Before an unsubmitted, non-cancelling Workspace Turn loads the Harness, start or join the Broker's existing warm operation and wait for completion.
3. Once warm completion and its `environment.ready` publication have finished, load the Harness Session. This still checks that the daemon Workspace is active; Broker warm completion alone does not prove daemon activation.
4. Submit the original Turn through the existing admission and journal fences.

The production dispatcher already uses virtual threads. A bounded future wait does not occupy a fixed dispatch worker pool, and the existing independent scheduler continues renewing the Turn lease.

## Preparation policy

Reuse `qwen.managed-agent.harness.load-timeout` as the preparation wait ceiling, currently 120 seconds. Validate that it is positive; add no setting, schema, readiness cache or Workspace-specific retry budget. The wait uses monotonic time and does not mutate or cancel the Broker's shared future.

Split future waits and retry backoff into intervals of at most one second so the loop can check the current durable Turn and dispatch lease. Verify both the renewal signal and the row's owner and lease expiry. An unsubmitted cancellation settles through the existing fenced cancellation write. A missing or terminal Turn stops the drive. Recheck cancellation and lease ownership after warm completes before loading, and before starting a replacement warm attempt. A late warm callback only emits environment events; it never resumes a cancelled Turn.

Pending preparation does not call Harness load and does not increment execution retry counters. Retryable `RuntimeBrokerException` failures retry preparation within the same wait ceiling, paced by the existing initial retry delay, regardless of wire code. Non-retryable Broker failures preserve their code and message. Unknown warm failures become `runtime_warm_failed`; expiration becomes the terminal `runtime_preparation_timeout`. Interruption restores the thread interrupt flag and returns through existing dispatch failure handling.

The ceiling applies to one claimed preparation attempt. After a process restart the new owner asks the Broker again and relies on the persisted original binding, operation ownership and Broker provisioning deadline. There is no new persisted preparation timer and no claim of an unchanged coordinator wall-clock deadline across restarts.

## Compatibility and scope

Disabled warm-up skips preparation. Unbound text Turns keep optional asynchronous warm-up: an enabled Broker does not imply that a text response requires its worker. Already-submitted Turns keep their existing asynchronous warm-up and recovery behavior; cancelling Turns bypass new preparation entirely.

After successful preparation, any load refusal uses the ordinary retry policy. The named 503 `workspace_runtime_unavailable` already retains its code. Preserve the legacy 409 `workspace_unavailable` at exhaustion as well. A permanently blocked daemon Workspace therefore still terminates. Do not extend pool/ownership exemptions, generation churn limits or post-admission retries.

No daemon route, tenant check, Workspace grant, storage claim, API schema or database operation changes. The intentional cost is that an unsubmitted Workspace Turn waits for enabled Runtime preparation even if its eventual response would not use a tool.

## Validation and acceptance

Focused regression coverage must establish preparation-before-load ordering, no retries charged while pending, exactly one submission after readiness, bounded never-completing warm-up, retryable preparation recovery, actionable permanent errors, cancellation during the wait and after late completion, cancellation during retry backoff without re-warming, lease loss, disabled warm-up, unbound-text and submitted-Turn compatibility, and current/legacy load refusals after readiness.

Local verification on macOS passed JDK 21 compilation, Checkstyle, all 20 new preparation cases and all 152 existing coordinator cases. The current checkout also passed `npm run build`, `npm run typecheck`, `npm run bundle`, 83 E2E-runner regression tests, ESLint and formatting checks.

Two selected Hosted tests passed on macOS against disposable MySQL 8.4.11, the production Broker, a real daemon and a native worker, using a controlled loopback model and registered native storage. They hold worker startup for two seconds while shortening ordinary admission backoff to 30 milliseconds. Pending preparation must leave load, submission and retry counters untouched; releasing the worker must complete the original Turn with one submission and three settled file tools. Every model HTTP request must observe committed `environment.ready`. Cancellation must remain terminal after the worker and late readiness event arrive, without model or tool execution.

These results establish the selected local paths, not a 45-second cloud provisioning run or a live upstream model. Preparation across a process restart, full unit/SpotBugs/MySQL/Hosted/fault profiles, Linux qualification and deployed-provider acceptance remain pending their respective CI or environment checks.
