# Daemon ACP Capacity Admission — PR1

[English](daemon-acp-capacity-admission-pr1.md) | [简体中文](daemon-acp-capacity-admission-pr1.zh-CN.md)

## 1. Status and scope

Design proposal dated 2026-09-15, checked against `df864bea6a930d31faf8b35fc5e57bac98a25e20`. Implemented as an opt-in mode in the accompanying change. It records the updated discussion: reuse the existing startup budget to limit ACP process admission, then add idle reclamation and user-directed closure in separate PRs.

PR1 provides an opt-in process-count limit and an actionable capacity error. It does not adjust child heap flags, sample free memory for admission, reclaim idle workspaces, interrupt existing work, or implement a workspace chooser. The existing reaper continues to operate independently. The requested simplification applies to the future reclamation mechanism; PR1 reuses the existing synchronous reservation sequence without adding a lock, queue, or distributed admission protocol.

Suggested implementation PR title: `feat(serve): add budget-based ACP child admission`.

The three-stage proposal is tracked in [#11907](https://github.com/QwenLM/qwen-code/issues/11907). This document specifies its first stage; idle reclamation and user-directed closure remain separate follow-ups.

[#8182](https://github.com/QwenLM/qwen-code/issues/8182) is open and still requires fixed-heap enforcement plus representative evidence. [#11386](https://github.com/QwenLM/qwen-code/issues/11386) is closed, as read on 2026-09-15. PR1 is related follow-up work; use `Related to #8182` and reference #11386 as background, without closing keywords. Count admission alone does not complete #8182.

## 2. Current behavior and gap

| Existing component          | Verified behavior                                                                                                        | PR1 use                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `resolveDaemonMemoryBudget` | Resolves the host/cgroup total, configured/effective budget, root reserve and child pool at startup.                     | Reuse the values and rounding rules unchanged.                                |
| `createChildHeapPolicy`     | `off` publishes no partition; default `observe` calculates a fixed partition and counts hypothetical refusals.           | Add a count-admission mode using the same calculated limit.                   |
| `ProcessRegistry`           | Counts attached children and outstanding spawn reservations; tracked teardown remains counted until registry release.    | Use `committedProcessCount`, not registered workspaces or live channel count. |
| `createSpawnChannelFactory` | Reserves before checking the policy; ignores the policy's refusal today; cancels the reservation on a synchronous error. | Reject inside this existing sequence before `spawn()`.                        |
| `runQwenServe`              | Shares a registry and policy across primary, startup-secondary and dynamically constructed workspace factories.          | Apply one daemon-wide limit across these factories.                           |
| Session/channel reapers     | Already close eligible abandoned sessions and empty ACP channels. Connected sessions are not merely abandoned sessions.  | Retain current behavior; explicit capacity-driven reclamation belongs to PR2. |
| REST/ACP/UI errors          | Capacity causes can be hidden by runtime/standalone wrappers; some Web Shell 503 load failures enter reconnect retries.  | Preserve the specific cause and stop automatic capacity retries.              |

An ACP can retain several sessions. Opening another session in an existing child does not necessarily need another process slot. Conversely, preheat, MCP operations, channel replacement, restoration and background work can start a child without a new workspace registration. Admission belongs at the common child-spawn boundary.

### 2.1 Budget calculation

With default configuration on the previously measured 7265 MiB host:

| Quantity                  | Calculation                                  | Result   |
| ------------------------- | -------------------------------------------- | -------- |
| Effective budget          | `floor(7265 * 0.5)`                          | 3632 MiB |
| Root reserve              | `clamp(floor(3632 * 0.1), 256, 1024)`        | 363 MiB  |
| Child pool                | `3632 - 363`                                 | 3269 MiB |
| Modeled slots             | `min(floor(3269 / 512), 25)`                 | 6        |
| Modeled per-child ceiling | `min(floor(3269 / 6), legacyChildCeilingMb)` | 544 MiB  |

Reuse the complete existing implementation, including explicit `--memory-budget-mb`, host/cgroup capping, tiny-host handling and the legacy ceiling check. Do not reimplement the formula in routes or the frontend. If no partition meets the 512 MiB model floor, the existing model produces zero slots and a null ceiling.

Only the slot count becomes an admission limit in PR1. The 544 MiB value remains modeled; actual child heap arguments still follow `getAcpMemoryArgs()`. Six slots mean a configured concurrency limit, not proof that six arbitrary workloads fit in RAM. Startup `availableMemoryMb` is the resolved host/container total, not a live free-memory reading. Existing heap calibration remains relevant to a later fixed-heap change, but is not a prerequisite for this separate count-only mode.

## 3. Configuration and compatibility

Extend the existing `--child-heap-mode` option and `ChildHeapMode` with `admit`; add no environment variable, standalone budget formula, per-workspace divisor or separate maximum-process setting.

| Mode                          | Calculates/reports partition | Rejects excess ACP starts | Applies modeled heap ceiling |
| ----------------------------- | ---------------------------- | ------------------------- | ---------------------------- |
| `off`                         | No                           | No                        | No                           |
| `observe` (unchanged default) | Yes                          | No                        | No                           |
| `admit` (new, opt-in)         | Yes                          | Yes                       | No                           |

Example after implementation: `qwen serve --child-heap-mode admit`. An existing `--memory-budget-mb` override affects the modeled limit through the current calculation and also retains its existing journal-budget effects. It is not a dedicated concurrency knob. Budget and mode remain fixed for the daemon lifetime; switching requires restart. Do not introduce `enforce` in PR1 or imply that `admit` enforces a heap/RSS budget.

Update the fast parser, full CLI choices/help, programmatic options, policy type and SDK status mirror together. Retain `off`/`observe` behavior, legacy child arguments, workspace registration limits and per-workspace/global session limits. Upgrading without opting in must not introduce capacity rejection.

Support the managed `runQwenServe` spawn path. Reject `admit` with an injected bridge or an unwired direct-embed factory rather than silently accepting an ineffective option. A public admitting spawn factory must receive an explicit shared registry. Direct `createServeApp` callers without managed admission wiring must reject `admit`; pass the actual shared registry/policy references through the managed server construction, rather than treating a status-only snapshot callback as proof of enforcement. Keep ordinary direct-embed, IDE and standalone `qwen --acp` behavior unchanged.

A zero-slot `admit` configuration is unusable. Validate it before starting the listener or preheat and report the budget/model failure as a configuration error. `off` and `observe` retain their existing tiny-host behavior. After valid startup, bootstrap status remains explicitly unwired until the registry/policy are installed.

## 4. Admission and lifecycle

Reuse the current spawn transaction:

1. Reserve in the one shared `ProcessRegistry`.
2. Call the policy with `committedProcessCount`, including this reservation.
3. In `admit`, if this count exceeds `maxConcurrentChildren`, throw `AcpChildCapacityExceededError` before `spawn()`; the existing catch cancels the reservation.
4. Otherwise spawn with the existing memory arguments and attach to the reservation.
5. Retain current exit, failure, abort and teardown release behavior.

Before reservation the rule is `committed < limit`; after reservation it is `committed <= limit`. For a six-slot limit, five committed processes permit one more, while six cause rejection of a seventh. Keep reserve/check/spawn synchronous with no new `await` between them. Two starts racing for the last slot must not both pass.

No session-level admission is added when the child can be reused. Existing session limits still apply. Primary preheat consumes a slot while retained; temporary workspace-control children and managed background starts consume slots too. Admission decisions do not inspect whether another child is active or idle in PR1.

During channel replacement, the old process remains committed until registry release. Full occupancy can therefore reject a replacement. Do not add a temporary extra slot, kill another workspace or retry a replacement in a loop. Preserve the initiating operation's existing drain/rollback outcome. A refused spawn itself starts no new child; this does not mean its whole request performed no earlier filesystem or lifecycle changes.

Keep registry cleanup semantics unchanged: a signal or closed stream is not itself a released slot, and tracked root/known ownership release is not proof that every possible descendant was observed or terminated. No descendant accounting rewrite is part of PR1.

## 5. Errors and ownership

Add one shared typed error in the existing bridge-error surface, exported through existing package entrypoints. Use stable wire code `acp_child_capacity_exhausted`, REST status 503, and the existing ACP error envelope with equivalent machine-readable code/status metadata. Include `maxConcurrentChildren` and `committedAcpChildren` at rejection; the committed value excludes the rejected reservation and includes tracked teardown. A bounded error snapshot is informational, not a reservation for a later retry.

For an ordinary REST rejection, put the code and counters in the existing JSON error body. For ACP, use `RPC.INTERNAL_ERROR` with `data.errorKind: 'acp_child_capacity_exhausted'`, `data.httpStatus: 503` and the same counters. The existing SDK keeps this payload under `DaemonHttpError.body.data`; the frontend recognizer must support both `body.code` and `body.data.errorKind`, without matching message text or rewriting transport normalization. For an already-started stream, preserve the existing terminal error framing and the capacity reason; do not attempt to change the HTTP status after headers were sent.

Do not send `Retry-After` for this error or imply a timed recovery guarantee. Do not globally change the behavior of unrelated 503, authentication, rate-limit or transport errors. Callers may retry after deliberate user action or a later independent operation; there is no automatic wait queue, immediate fallback or daemon capacity retry loop.

| Consumer / operation                                    | Ownership                                      | Required behavior                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status and shared policy                                | Process-global                                 | Report the same global limit/count for all managed workspace factories.                                                                                             |
| Workspace registration / stored history listing         | Persisted-workspace scoped                     | No new capacity gate when no ACP starts; registration remains independent.                                                                                          |
| Primary preheat / legacy-primary endpoints              | Legacy-primary                                 | Count the child; preserve startup diagnostics and primary ownership.                                                                                                |
| Session creation, runtime ensure, workspace MCP control | Selected-runtime                               | Return the capacity cause for that runtime; never fall back to primary.                                                                                             |
| Live prompt/attach, restore, fork and recovery          | Live-session-owner or selected persisted owner | Reuse a live child without extra count; enforce when the operation actually spawns. Preserve the resolved owner across awaits.                                      |
| Conversations standalone creation                       | Standalone session's resolved runtime/owner    | Preserve capacity as a reason through rollback; do not erase existing creation-outcome metadata.                                                                    |
| Channel workers and scheduled execution                 | Their selected runtime/session owner           | ACP starts share the gate; external workers themselves are not counted as ACP. Surface failure through existing task reporting without adding capacity retry loops. |

Preserve causes across `WorkspaceRuntimeInitializationError` and `StandaloneSessionSpawnError`. In known wrapper paths, detect and retain capacity after existing cleanup/outcome handling. Generation-closed, removed, untrusted, draining and uncertain-dispatch/rollback outcomes keep their existing priority; capacity must not turn an unsafe whole-request retry into a safe one. Do not recursively unwrap arbitrary unrelated exceptions or replace all wrapped failures with 503.

For runtime initialization, let a capacity cause reach the specific mapper before generic `runtime_initialization_failed` and its current `Retry-After: 5` response. For standalone creation, retain `standalone_creation_rolled_back`, the session ID and existing outcome fields; add a bounded `capacity` object containing the capacity code and counters only after `!dispatched` and persisted-session absence are verified. Recognize this nested cause in the same UI helper. Post-dispatch failures or failed absence checks retain the existing unknown-outcome/quarantine path. Do not bypass these checks merely because the nested factory error is a capacity error.

Only this verified capacity-related standalone rollback changes from the existing 500 response to 503 and omits `Retry-After`; ordinary rollback responses remain unchanged. Carry `capacity` through both REST body and RPC data. The UI helper also recognizes `body.capacity.code` and `body.data.capacity.code`, while preserving the outer rollback classification. Preserve the existing retryability/outcome meaning for deliberate retries; the new capacity UI branch stops automatic retry regardless of that flag.

Verify REST session creation/load/fork/recovery, runtime ensure, MCP preparation/mutation, Conversations, direct ACP dispatch, preheat and background entrypoints. A 503 alone is insufficient: assert the capacity code or preserved capacity reason and the owner-specific outcome.

## 6. Status and Web Shell

Keep `limits.memory.enforced: false`, explicitly meaning that the modeled child heap ceiling is not applied. Within `limits.memory.childHeap`, add `admissionEnforced: boolean`; it is true only for the fully wired managed `admit` path. Retain `mode`, `maxConcurrentChildren`, modeled `perChildCeilingMb` and `refusals`. Under `observe`, refusals remain hypothetical; under `admit`, they count actual admission rejections. A zero counter does not prove memory safety.

Add `runtime.memory.committedAcpChildren` from the shared registry. Keep `activeAcpChildren` and RSS/reporter coverage unchanged; they count live channels and exclude outstanding reservations and dying channels. Use null where registry-backed reporting is unavailable, and optional fields in the SDK for older daemons. Bootstrap has no constructed policy: keep `childHeap` null and do not invent a live zero count. Wire the getter through the same managed server/status construction used by the shared policy.

Use existing Web Shell error/banner and draft-session surfaces. Proposed Chinese copy:

> 已达到当前服务的并发容量上限，暂时无法启动此会话。请稍后重试，或取消本次操作。

Proposed English copy:

> The service has reached its concurrent process limit and cannot start this session. Try again later or cancel this operation.

Use “capacity limit”, not a claim that live RAM is exhausted or every workspace is busy. PR1 does not choose another workspace to close. Reuse the existing cancel/dismiss flow: stop local pending/reconnect attempts, preserve the draft and attachments for a new session, and preserve the selected session/history when restoration fails. Cancelling does not delete a registered workspace or persisted session. A request that has already failed is not a queued background creation.

Special-case the machine code before Web Shell's generic 503/session-load retry path. No repeated reconnect, automatic create fallback, or prompt replay on capacity rejection. Manual retry repeats only the appropriate operation after its existing side-effect/outcome checks. Session create, restore, first-message and command shortcuts must all show the same understandable reason; capability diagnostics may retain technical counts, but raw policy/heap identifiers should not enter the user flow.

The connection provider uses an explicit readable English capacity fallback because the primary provider sits outside App's language context; App action errors and MCP notices use the active UI language. The concrete reuse points are the action notice/ToastHost for creation, the connection error state for failed loading, and the MCP manager's existing inline management notice. Classify capacity before `actions.ts` emits its generic notice and marks the error `_alreadyDispatched`; changing only App's `reportError` would be suppressed. `DaemonSessionProvider` needs a capacity branch before its ordinary workspace-load 503 backoff, rather than treating capacity as a missing session. Normal first-prompt and inline `!shell` submissions already defer composer clearing; the no-session `/goal set` path currently accepts before asynchronous creation and needs the same deferred acceptance on failure. Preserve existing navigation semantics: selecting a different target may detach the old pane; cancellation does not promise transactional restoration of that previous attachment. Do not reuse `SessionRecoveryBanner`, which is for a connected session's transcript recovery.

## 7. Implementation footprint

| Area              | Expected files / integration points                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy and spawn  | `packages/acp-bridge/src/child-heap-policy.ts`, `spawnChannel.ts`, `bridgeErrors.ts`, public exports; reuse `process-registry.ts`.                                                                                                                                                                                                                                |
| CLI and wiring    | `packages/cli/src/commands/serve.ts`, `serve/fast-path.ts`, `serve/types.ts`, `serve/run-qwen-serve.ts`, `serve/server.ts`, `serve/daemon-status.ts`.                                                                                                                                                                                                             |
| Cause propagation | `serve/server/error-response.ts`, `serve/acp-http/dispatch.ts`, `serve/workspace-runtime-coordinator.ts`, `serve/conversations/standalone-session-service.ts` and their existing typed errors.                                                                                                                                                                    |
| SDK and UI        | `packages/sdk-typescript/src/daemon/types.ts`; Web Shell `daemon/session/httpErrors.ts` or the existing code helper, `daemon/session/DaemonSessionProvider.tsx`, `daemon/session/actions.ts`, `App.tsx`, MCP management notice and existing locale resources. The SDK already retains error bodies; change transport implementation only if a test exposes a gap. |
| Documentation     | This bilingual design; daemon configuration/operations, REST integration and serve protocol docs; reconcile the earlier fixed-heap design's delivery boundary.                                                                                                                                                                                                    |
| Tests             | Collocated policy/factory, parser/wiring, error mapping, runtime/standalone and UI tests; focused managed-daemon E2E.                                                                                                                                                                                                                                             |

Do not rename unrelated modules, add a new scheduling abstraction or revise the budget arithmetic as cleanup. Exact affected files should follow verified call sites during implementation; avoid mirroring every error at every route when a shared typed path already works.

## 8. Validation and acceptance

1. Budget values remain unchanged, including explicit overrides, cgroup/host capping, six slots on 7265 MiB, the 25-slot ceiling and zero-slot cases. Both parsers accept `admit`; defaults and legacy modes remain unchanged.
2. At limit N, at most N managed ACP children/reservations are admitted across different factories; an N+1 request returns the exact capacity cause. Failure/cancellation releases reservations. A terminating tracked child still consumes capacity until registry release.
3. Accepted child command lines are unchanged across `observe` and `admit`, including inherited Node settings. No test substitutes the modeled 544 MiB value for the actual argument. No claim of an aggregate heap/RSS bound is made.
4. Registration and existing-child session reuse work at capacity. Reuse still obeys existing session limits. A genuinely new child is denied from REST, ACP, runtime/MCP, restoration and managed background paths; owner, auth and draining semantics are preserved.
5. Wrapper/outcome tests cover successful rollback, uncertain side effects, generation changes and preheat failures. Capacity is not hidden by `runtime_initialization_failed` or a generic reconnect error, and does not override a more important rollback outcome.
6. Web Shell shows the capacity reason once, ends the spinner/retry loop and preserves new-session text/attachments or restoration state. Cancel has no delete side effect. A deliberate retry after a slot is released works without duplicated prompts or worktrees.
7. Status accurately separates count admission from modeled heap values, handles bootstrap/direct-embed/older-server fields, and reads the same shared registry used at spawn.
8. Run build, typecheck and focused package tests for implementation. Run the E2E baseline first with global `qwen`, then the bundled implementation in isolated directories with a deterministic local provider. Model load/heap calibration is not needed to demonstrate slot accounting and error UX.

The detailed E2E plan is stored at `.qwen/e2e-tests/daemon-acp-capacity-admission-pr1.md`. Validation combines the global CLI baseline, focused package tests and isolated bundled-daemon process checks. Results and remaining verification limits are recorded in that plan. Earlier heap calibration runs do not validate this admission implementation.

## 9. Delivery sequence and limits

PR1 ships the opt-in count limit and error/cancel UX together. PR2 can try eligible idle-child reclamation when admission fails, reusing current close protections; the initial reclamation design remains the agreed single eligibility check without a new locking mechanism. PR3 adds an explicit choice of workspace to close when no eligible idle candidate exists. Neither follow-up is a prerequisite for PR1's refusal behavior.

Keep the default `observe` during initial rollout; changing the default is a later product decision. The unchanged model can reduce concurrency substantially when opted in, and full occupancy can block restart/MCP operations even if measured free memory is ample. Existing children can still grow toward their legacy heap limits. This is a predictable process-count policy, not an OOM guarantee or a completed fixed-heap enforcement design.
