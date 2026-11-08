# Hosted A3 — mixed-sibling approval crash window

[English](2026-10-31-hosted-a3-mixed-sibling-approval.md) | [简体中文](2026-10-31-hosted-a3-mixed-sibling-approval.zh-CN.md)

Status: proposed, 2026-10-31. Part of [#14481][issue] (G3 Step 3 recovery-matrix
acceptance, tracks #12380). Extends the packaged fault arms of the
`hosted-failover-e2e` CI job described in
[G3 Step 3 recovery](2026-10-09-hosted-g3-step3-recovery.md). This slice packages
the **native mixed-sibling** half of matrix row A3; the rewritten-input / Hook
half is a deliberate follow-up (see Scope).

## Problem

Matrix row A3 reads: _"Earlier decisions persist; pending sibling IDs/order
survive; reapproved inputs never inherit an earlier Allow; completed Hooks are
not rerun."_ Today A3 is focused/integration evidence only — there is no
packaged arm that crashes a replacement inside a multi-call approval batch and
proves the surviving siblings recover from MySQL alone.

The four clauses do not live in one recoverable path. A native multi-call batch
continuation proves the **first two clauses** (earlier decisions persist; pending
sibling IDs/order survive), plus a related native observation: a pending sibling
still requires its own Allow and is never auto-allowed by an earlier sibling's
decision. Matrix clause 3 ("reapproved inputs never inherit an earlier Allow") is
specifically about a _rewritten_ input being reapproved, and clause 4 about Hooks;
**input rewrite and Hook no-rerun only exist on the Hook/commandStep path**, and a
native continuation explicitly refuses Hook/MCP sessions. This arm never rewrites
an input (`inputRevision` stays 1), so it does **not** cover clause 3's
rewritten-input property — the pending-sibling observation above is narrower and
must not be folded into the A3 coverage ledger as clause 3. Bundling all four into
one arm is not possible without a production change to support mixed native+Hook
continuations (maintainer-only core work, out of scope for a test-arm slice). This
slice therefore packages the native mixed-sibling half and defers the
rewritten-input/Hook half to a commandStep follow-up.

## Current state (verified on `main` at `0c1b42fa31`)

- **Mixed calls.** A batch is the N `functionCall` parts of one assistant
  message, committed whole, then driven through approval one call at a time in
  model order (`hosted-workspace-tool-turn.ts:8421` `approve()`, skipping
  `index < nextOrdinal` and already-refused calls). Each `ask()`
  (`hosted-workspace-tool-turn.ts:8835`) mints a fresh
  `tool_approval_<hex>` Action ID, publishes a stage=`approval`
  `hosted-approval-continuation` snapshot whose `approvalOrdinal` is the call
  being asked (`captureNativeBatch('approval', requestId, ordinal)`), then
  `commitDurableWait` writes the `await_action` checkpoint and the ACTION row
  `requested`. The ordered `calls[]` with per-member `runtimeCallId`,
  `partIndex`, `prepareKey`, `requestDigest`, `actionId`, `refusal` is the
  durable record of sibling identity and order.
- **Recovery discriminator.** `findHostedApprovalContinuation`
  (`hosted-approval-continuation.ts:385`) is the approval analog of
  `findHostedCommittedModelOutput`; it requires v3 options (any v1/v2 aborts the
  whole resume) and `readHostedApprovalContinuation` deep-validates session /
  definition / snapshot pins, `requestDigest`, `argsDigest`, verdict consistency
  and stage/ordinal — any mismatch throws `HostedToolRecoveryRequiredError`
  (block, never replay).
- **Pending sibling is re-attached, not re-minted.** On a stage=`approval`
  resume the load route (`hosted-harness-session.ts:3577`) takes
  `plan.actionId` (the original pending Action), re-hangs its waiter with the
  **original `options.expiresAt`** (deadline not reset), applies the verdict
  only to `index === plan.approvalOrdinal`, and then calls
  `resumeSavedNativeBatch(plan, plan.approvalOrdinal + 1)`
  (`hosted-harness-session.ts:3875`). The `approve()` loop therefore skips every
  already-decided sibling and continues after the pending one.
- **Native multi-call capture is supported for file profiles.**
  `captureNativeBatch` loops over all `batch.requests` and accepts
  `read_file`/`write_file`/`edit`/`glob`/`todo_write`/`web_fetch`
  (`hosted-workspace-tool-turn.ts:3621`). It returns `undefined` for
  `(!commandStep && (this.hooks || this.mcp))` and for a multi-call shell profile
  without `publicChildren`; `resumeSavedNativeBatch` throws
  `Unsupported saved batch owner.` for the same Hook/MCP condition
  (`hosted-workspace-tool-turn.ts:3500`). The existing single-`write_file` arms
  capture successfully, which (write_file is not `planExit`) implies the fixture
  session runs a **non-shell file profile**, so a multi-call file-tool batch
  captures under the same profile.
- **Allow is never inherited by a rewritten input.** Producers hardcode
  `inputRevision: 1` (`hosted-workspace-tool-turn.ts:8765`, `:8873`); versioning
  is by a **new Action + new inputRef**, and `hostedActionAllowed`
  (`hosted-tool-approval.ts:296`) requires the decision digest to match
  `(optionId, inputRevision, policyRevision)`. A pending sibling is never
  auto-allowed by an earlier sibling's Allow: recovery re-hangs a waiter on the
  pending Action and requires its own decision.
- **Runner fixture is single-call.** Evidence collection enforces
  `originalApprovalPlan.calls?.length !== 1` → throw
  (`run-managed-agent-server-e2e.ts:2064`); the fake model returns one
  `write_file` toolCall for the continuation marker
  (`run-managed-agent-server-e2e.ts:1559`); execution-identity assertions assume
  one execution. Only two `QWEN_E2E_*` hooks exist, both in
  `hosted-harness-session.ts` (`QWEN_E2E_CRASH_BEFORE_ASSISTANT_COMMIT`,
  `QWEN_E2E_DROP_LOAD_REPLY`); **no approval-stage hook exists**.

## Goals and scope

**In scope.** A packaged `hosted-failover-e2e` arm that crashes a replacement
Harness inside a two-call native approval batch — sibling[0] decided,
sibling[1] still `requested` — and proves, from MySQL alone after scrashing the
crashed generation's disk:

1. earlier decisions persist (sibling[0] is not re-asked or re-decided);
2. pending sibling IDs/order survive (the recovered plan deep-equals the saved
   plan; the pending Action ID is preserved across the replacement, deadline
   unchanged);
3. the pending sibling is not auto-allowed by the earlier Allow (it still
   requires its own decision) — the native pending-sibling observation, narrower
   than matrix clause 3's rewritten-input property, which stays out of scope;
4. each call executes exactly once with its original execution identity, in plan
   order, and the Turn projects exactly one terminal with the recovered answer.

These are the arm's own acceptance observations; only items 1–2 map directly to
matrix clauses 1–2. Item 3 must not be recorded as matrix clause 3 coverage.

**Out of scope.** Rewritten-input + Hook-no-rerun coverage (a commandStep
follow-up arm); mixed native+Hook recoverable continuations (would require a
core production change); real-provider acceptance; full-owner restart; a
Deny-on-sibling[1] variant (Allow-only first, matching the other approval arms).

**No production behavior change.** The only production-source edit is a
test-gated fault hook that is inert unless its env var is set to the exact
session ID; it is never set outside the E2E runner.

## Proposed solution

### Window choice

Crash in the **sibling approval gap** (sibling[0] `decided`, sibling[1]
`requested`), not in the partial-prepare gap. The partial-prepare gap has every
sibling already decided, so it cannot exercise clause 3 ("pending sibling not
auto-allowed") or the pending-Action re-attachment that clause 2 pins. The
approval gap is the only window where a pending sibling must survive a
replacement and still earn its own decision.

### Crash choreography (three generations)

- **gen1 (original).** Drives the batch, `ask()` sibling[0] → `requested`. The
  runner crashes gen1 here (as the existing arms crash at the first
  `await_action`). Saved evidence: a two-call plan, `approvalOrdinal = 0`,
  `originalApprovalId = Action[0]`.
- **gen2 (replacement, armed).** Attaches, re-hangs Action[0] via the load route
  (not via `ask()`). The runner verifies Action[0] is still `requested` with its
  original deadline, then POSTs Allow[0]. The `approve()` loop advances to
  ordinal 1, so **gen2's first `ask()` call is sibling[1]**. The fault hook fires
  there: after `commitDurableWait` (Action[1] `requested` is durable) and before
  the waiter blocks, it holds on an abort-aware promise. The runner confirms the
  barrier (Action[1] `requested` in MySQL + the stderr line), crashes gen2, and
  scrashes its disk.
- **gen3 (recovery, unarmed).** Attaches, re-hangs the **original** Action[1]
  with its original deadline. The runner verifies Action[1] `requested`,
  deadline unchanged, and Action[0] still `decided` (not re-asked), then POSTs
  Allow[1]. gen3 resumes from ordinal 2, captures the final plan, prepares and
  dispatches both calls, and settles the Turn.

### Test-gated hook

`QWEN_E2E_HOLD_PENDING_SIBLING_APPROVAL` in `ask()`
(`hosted-workspace-tool-turn.ts`), mirroring the B3a hook: module-scope read of
the env var + a process-wide fire-once latch; fires only when the value equals
the current session ID; armed only on gen2 via a new
`startReplacementHarness(name, holdPendingSiblingApproval = false)` parameter
(gen3 passes nothing). After `commitDurableWait` it logs
`qwen serve: E2E holding pending sibling approval for Session <id> call <callId>`
and parks on a promise that rejects when the abort signal fires, so a leaked
flag cannot wedge a real Session un-cancelably. A `process-env-guard.test.ts`
allowlist entry pins the new key with its exact access count.

### Fixture extension (gated on the A3 fault)

All multi-call behavior is gated on the new fault name so the existing
single-call arms are untouched:

- the fake model returns **two `write_file` toolCalls to distinct paths** (two
  distinct physical write effects) for the continuation marker only when the A3
  fault is active;
- evidence collection accepts a two-call plan for this fault and records both
  Action IDs and the saved plan;
- the runner posts **two** decisions (Allow[0] to gen2, Allow[1] to gen3) at the
  choreography points above, and before answering Allow[1] it reads Action[0] and
  requires it still `decided` with its original deadline (so a recovery that
  re-asks the decided sibling reds before the terminal converges);
- execution-identity assertions check **two** executions, each `SETTLED`,
  `dispatch_generation = 1`, with its own original `prepareKey` /
  `requestDigest`, and require their `settled_at` non-decreasing in plan order (so
  a reverse dispatch reds); both file effects are asserted; exactly one terminal;
  the recovered plan deep-equals the saved plan (order, `runtimeCallId`,
  `partIndex`, Action IDs).

### Runner, CI and contract pins

A new `approvalFaults` entry (allow-only overlay, like the other approval arms),
a barrier branch in the exhaustive crash-arm guard (a new arm without a barrier
must error), an npm script and a `sdk-java.yml` step, and a bump of the
`hosted-failover-e2e` arm ceiling and timeout in `hosted-process-ci.test.js`.
Contract pins in `managed-agent-server-e2e.test.js` pin the gen2-only arming, the
two call sites and default, the barrier→crash slice, and the two-execution
identity assertions; any new top-level runner helper gets a behavioural test on
injected inputs (the `finishedBeforeCommitWindow` pattern).

### Documentation

Update [G3 Step 3 recovery](2026-10-09-hosted-g3-step3-recovery.md) §9.1 in both
languages: twelve → thirteen packaged arms, move the native mixed-sibling half
of A3 from focused to packaged, and record the commandStep follow-up for the
rewritten-input / Hook half.

## Design decisions and rationale

- **Approval gap over partial-prepare gap** — only the approval gap has a pending
  sibling that must earn its own decision (clauses 2–3).
- **Fire-once hook in `ask()`, no ordinal counting** — gen2 re-attaches
  sibling[0] through the load route, so its first `ask()` is necessarily
  sibling[1]; a fire-once latch armed on gen2 lands in the exact window without
  tracking ordinals.
- **Multi-call gated on the fault name** — the fake model and the shared
  evidence/identity assertions are used by every approval arm; gating keeps the
  single-call arms byte-for-byte unchanged.
- **Pin Action-ID preservation, not re-minting** — recovery re-attaches the
  original pending Action; the arm asserts the ID and deadline survive, and that
  sibling[0] is never re-asked. `inputRevision` stays 1; the Allow-not-inherited
  guarantee is pinned via the distinct pending Action and its required decision,
  not a revision bump.

## Constraints and risks

- **Shared fixture regression.** The fake model and execution-identity
  assertions are shared; the multi-call path must be fully gated and the
  single-call arms re-run green.
- **Profile assumption.** Multi-call native capture rests on the fixture being a
  non-shell file profile (deduced from existing single-call capture); the .75
  head run must confirm the two-call plan actually captures.
- **Hook inertness.** The hook must never affect production: env never set
  outside the runner, fire-once, abort-aware hold. Inertness is pinned by the
  source-text contract pins (default-off flag, env passed only to the crashing
  generation, the allowlisted `process.env` read) and the real-stack M1 red; the
  non-optional `sessionId` type means an unset env can never match a real
  session. A dedicated behavioral unit test (matching/non-matching/abort) is
  deferred — see Open questions.
- **CI budget.** One more arm raises the `hosted-failover-e2e` ceiling and
  timeout; the contract test pins both.

## Validation plan

- **.75 real stack** (qwen-managed-e2e container, real Java/MySQL/Broker/Runtime,
  fake model): head arm green — two executions each once with original identity
  and `settled_at` in plan order, one terminal, recovered plan deep-equal, Action
  IDs and deadline preserved, sibling[0] still decided before Allow[1] and not
  re-asked, recovery from MySQL alone after scrash.
- **Demonstrated mutation reds** (green evidence requires a red). Real-stack:
  M1 hook disabled → barrier timeout; M2 pending sibling's decision skipped →
  terminal timeout; M3 recovered plan reversed → recovery blocked. Fast-tier
  contract pins: R1-4 the decided-sibling state check (`decided` → `requested`)
  reds the pre-answer pin; R1-5 the execution-order column (`settled_at`)
  mutation reds the plan-order pin; R1-6 a first-match plan-link selection → the
  behavioural ascending-link case reds; R1-7 a narrowed execution-count branch →
  the anchored contract pin reds. The R1-4/R1-5 checks are defense in depth, not
  the first guard a real-stack mutation hits: a re-applied verdict keeps
  Action[0] `decided` and a re-opened/cancelled Action[0] is caught by the load
  route's cancelled/expired guard first, while a reverse dispatch reds at
  recovery adoption (`Saved native request digest conflicts`) before reaching
  the `settled_at` check. Their load-bearingness is therefore proven by the
  fast-tier pins above, not by a real-stack red at the new assertion.
- Contract suite + behavioural test green; serve `process-env-guard` green;
  `npm run build && npm run typecheck && npm run bundle`. A dedicated hook unit
  test (matching/non-matching/abort) is deferred — see Open questions.

## Acceptance criteria

- A packaged arm in `hosted-failover-e2e` whose runner asserts observations 1–4
  above from MySQL alone after scrashing the crashed generation.
- Each green signal has a demonstrated mutation red.
- Bilingual design docs aligned; CI green; no production behavior change beyond
  the inert test-gated hook.

## Resolved during implementation

- Fault name is `sibling-approval`. The second tool is a **second `write_file`**
  to a distinct path (not `read_file`): the write_file schema is already proven by
  the existing fixture, and two distinct physical effects strengthen the
  "each sibling executes once" proof.
- The after-results model count is **1** (one initial two-call round + one
  after-results round; approval recovery reissues no inference), confirmed by the
  .75 head run (`initialRequests=1`, `modelAfterResults=1`).
- The non-shell file-profile assumption held: the .75 head run captured the
  two-call plan (`approvalOrdinal=1`, two calls in plan order). Plan order is
  request order — `captureNativeBatch` builds `plan.calls` from
  `batch.requests.entries()` — not necessarily the model's part order, so the
  arm's order assertion is a plan-order assertion.

## Open questions

- Whether a later Deny-on-sibling[1] variant is worth a second arm (deferred).
- A dedicated hook unit test (matching/non-matching/abort) in the tool-approval
  fixture is deferred to review iteration; the hook is currently covered by the
  real-stack arm, the M1 mutation red, the env-guard access count and the contract
  pins, and its abort-aware hold mirrors the unit-tested B3a pattern.

[issue]: https://github.com/QwenLM/qwen-code/issues/14481
