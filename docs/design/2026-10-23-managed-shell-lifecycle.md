# Public Shell Session Lifecycle

[English](2026-10-23-managed-shell-lifecycle.md) | [简体中文](2026-10-23-managed-shell-lifecycle.zh-CN.md)

## Problem and scope

Issue #15078 requests close, archive, unarchive and delete for public Shell Sessions. The control plane, Harness resource settlement and WebShell actions already implement these operations, but a generic Harness advertises no Shell lifecycle support unless configured. The unified `hosted-workspace-shell/1` profile should include its existing lifecycle support by default.

Issue #15011 exposes a related handoff failure. Lifecycle admission fences ordinary writer renewal before the Harness receives the lifecycle claim. A writer can exhaust its remaining lease before the first effects request arrives. Effects correctly requires a live lease, so the admitted operation then fails even though the original writer has not changed.

This change reuses lifecycle v2, its durable operation and its original Runtime proofs. It adds no public route, schema, force-close option or automatic cancel-and-close workflow. Files lifecycle and explicit MCP enablement retain their existing contracts.

## Admission and writer handoff

When an initial v2 close or delete installs the lifecycle fence, preserve a currently live writer until at least one configured Session Store writer-lease duration after admission. Use database time and the existing writer-lease setting. Update the existing head in the admission transaction; do not change writer identity, generation, journal revision or content.

Only a live, active writer receives this finite handoff period. An already-expired writer is not revived. Idempotency replay, failed-operation resubmission, claim acquisition, claim renewal and claim takeover do not extend it. A missing head or writer gains no writer. Files v1 and protocol 0 do not use it.

Ordinary renewal, seal and commit remain fenced after lifecycle admission. Effects authorization and claimed renewal still require an unexpired lease. A request arriving after the handoff period fails closed. DRAINING retains its existing, separate cleanup-only expired-lease exception and exact token, generation and current-claim checks.

This is a bounded allowance for the admission-to-effects delivery interval, not an unlimited promise to preserve a writer while the coordinator is unavailable. It closes the reported interval after the original remaining lease without permitting stale effects or unbounded lease extension.

## Capability and user behavior

If `QWEN_HOSTED_LIFECYCLE_V2_PROFILES` is absent, advertise exactly `hosted-workspace-shell/1`. An explicit value remains the complete list: the empty string disables v2, and MCP requires explicit inclusion. Unknown or duplicate profiles remain startup errors. Java still requires original-Worker stop support and current owner/read authorization. Existing public-child and ordinary Shell MCP admissions also consume this capability: newly qualified Sessions can gain those existing features through their unchanged eligibility checks; saved Session scope is not rewritten.

The existing WebShell actions and operation polling remain the interface. A live foreground Turn, a cancelling Turn or a pending approval refuses close/delete with `turn_active`; the user cancels that original Turn, waits for actual settlement and requests close again. Background Shell, Monitor and child Sessions use the existing drain and cascade paths. Uncertain execution, output or stop evidence keeps the operation blocked for recovery.

Close retains history and outputs. Archive follows a completed close; unarchive restores CLOSED. Delete settles the active Session when needed, then commits its tombstone and retirement. An accepted request or a cancellation acknowledgement is not completion.

## Affected components

- Java lifecycle admission and its H2/MySQL regression consumers.
- Harness capability defaults, explicit-override tests and lifecycle refusal tests.
- Current public Shell, lifecycle and operator documentation in both languages.
- The existing profile consolidation described in [its design](2026-10-23-managed-shell-profile.md).

## Verification and acceptance

Reproduce the default capability gap and delayed first-claim failure before changing production code. Then verify delayed claim renewal inside the handoff period, unchanged generation/revision, ordinary-write refusal, expired-before-admission and post-handoff refusal, idempotent replay, resubmission, stale claims, replacement writers and files v1 compatibility.

Run selected H2 and real MySQL cases within the shared local Java budget. Reuse matching SDK and bundle evidence where applicable. Run focused CLI checks, build, typecheck and bundle for changed TypeScript. Keep the original failed attempts in `.qwen/issues/issue-15011.md`, `.qwen/issues/issue-15078.md` and the E2E report.

Linux CI must exercise the source-matched public Shell lifecycle and `HostedShellLifecycleRecoveryIT` fault cases, including resource settlement, original Worker stop, retained output and deletion retirement. Historical green CI and fast-tier skipped jobs do not establish acceptance of this revision. No local macOS check replaces Linux cgroup and process-fault acceptance.

## Release and open questions

Deploy matching Java, SDK, Harness and Runtime artifacts together. The default changes only the Shell advertisement; unsupported Runtime configurations still refuse public close. An explicit empty lifecycle list remains available to disable new admission while preserving existing operation recovery rules. Do not downgrade consumers with unfinished v2 operations.

There are no open product decisions. Local verification and required CI outcomes must be recorded before declaring release acceptance.
