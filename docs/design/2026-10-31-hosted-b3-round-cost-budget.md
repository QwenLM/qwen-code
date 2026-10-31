# Hosted B3 — round and cost budget across a replacement

[English](2026-10-31-hosted-b3-round-cost-budget.md) | [简体中文](2026-10-31-hosted-b3-round-cost-budget.zh-CN.md)

Status: proposed, 2026-10-31. Part of [#14481][issue] (G3 Step 3 recovery-matrix
acceptance, tracks #12380). Extends the packaged fault arms of the
`hosted-failover-e2e` CI job described in
[G3 Step 3 recovery](2026-10-09-hosted-g3-step3-recovery.md). This slice packages
matrix row **B3 ("after earlier tools")**: a crash after several tool rounds must
recover the logical round and the turn cost ledger without resetting them.

## Problem

Matrix row B3 reads: _"Request uses saved results/history; each previous execution
occurs once; round and cost budget do not reset."_ Today B3 is focused/integration
evidence only. The existing `after-result` arm crashes after a **single** tool round
and proves the saved request is reissued deep-equal, but nothing crashes after
**several** tool rounds and proves the numeric round counter and the turn cost
ledger survive the replacement. A recovery that restarts the round at 0 (letting a
Turn run past its configured round limit) or zeroes the token ledger would pass CI.

**What "cost budget" actually is here (verified).** There is no free-standing
cumulative cost counter. The recoverable cost state is the `TurnBudget` snapshot
(the output-token budget parsed from a user `+Nk` directive, plus
`outputTokensAtTurnStart`) and the per-model session token metrics (uiTelemetry),
both persisted on the `model.attempt` route/usage resources and restored on a cold
load. The `toolOutputBatchBudget` is stateless per-generation config (harmless to
recompute) and the checkpoint `budgetConsumed` field is a constant-0 placeholder;
neither is a B3 assertion target. So "cost budget do not reset" is proven as
**snapshot + ledger restoration fidelity**, not as a hard spend gate in the main
model loop (the loop does not stop on token spend; only workflow/agent dispatch
consumes the budget).

## Current state (verified on `main` at `b3e9ce0cd1`)

- **Logical round.** The model loop starts at
  `round = input.resumeModel?.round ?? input.initialRound ?? 0`
  (`hosted-harness-model.ts:979`) and enforces
  `maxRounds > 0 && round >= maxRounds → HostedModelRoundLimitError`
  (`hosted-harness-model.ts:991`). `maxRounds = config.getMaxSessionTurns()` defaults
  to **-1 (unlimited)**. Because the round index is absolute, the round limit alone
  does not cleanly detect a reset, so this arm detects a round reset through the
  exactly-once, deep-equal and round-continuity assertions rather than the limit.
  The round is persisted two ways:
  the `hosted-model-request` resource carries `round`
  (`hosted-model-recovery.ts:33`), and the `hosted-approval-continuation` plan
  carries `round` (`hosted-approval-continuation.ts:88`, set from `logicalRound` at
  `hosted-workspace-tool-turn.ts:3738`). On recovery the loop resumes from
  `resumeModel.round` (saved-request path) or `initialRound = plan.round + 1`
  (`hosted-harness-session.ts:3981`).
- **Cost ledger.** `bindBudget` (`managed-hook-activation.ts:83-135`) on a cold load
  reverse-scans `model.attempt` events, reads `budget` and `models` from the
  `usageRef`/`routeRef` resources, restores the `TurnBudget` snapshot and calls
  `restoreSessionModelMetrics`. It begins a new snapshot only when
  `shared.snapshot?.promptId !== this.turnId`, so a same-turn recovery does not
  restart the ledger. Each attempt writes the route resource (`budget`) and usage
  resource (`budget` + `models`) (`managed-hook-activation.ts:176-183, 230-241`).
- **Exactly-once / saved results.** The saved-request replay is pinned by
  `requestDigest` and refused if any assistant commit or `tool.intent` follows the
  snapshot's `throughSequence` (`hosted-model-recovery.ts:213-222`); the tool-turn
  fold is keyed on the functionResponse id (`hosted-workspace-tool-turn.ts:1666`),
  and `resumeSavedNativeBatch` re-validates the original definition/argument digests
  and reuses the original `runtimeCallId`/`prepareKey`.
- **Runner observability.** The round is NOT in the provider request body or the
  public feed; it lives in the `hosted-model-request` / `hosted-approval-continuation`
  MySQL resources. The budget/models live in the `managed-hosted-model-route` /
  `managed-hosted-model-usage` resources. The runner already has both readers (journal
  HEX parse and `ma_resource` inline read). There is currently **no** runner assertion
  on the numeric round or the budget content.

## Goals and scope

**In scope.** A packaged `hosted-failover-e2e` arm that runs a **multi-round** tool
fixture (two earlier tool rounds), crashes the replacement while a later post-tool
model request is held, and proves, from MySQL alone after scrashing the crashed
generation's disk:

1. the recovered model request resumes at the **same logical round** as the saved
   request (not restarted at 0/1);
2. the turn **cost snapshot and per-model token ledger** are restored, not zeroed or
   re-baselined;
3. each earlier tool execution occurs **exactly once** with its original execution
   identity, and the reissued request is deep-equal to the saved one;
4. the Turn projects exactly one terminal with the recovered answer.

**Out of scope.** A hard token-spend gate in the main model loop (none exists); the
`toolOutputBatchBudget` (stateless config); the checkpoint `budgetConsumed`
placeholder; the skill-only / manual-continue recovery paths that carry no
`initialRound` (their reachability in a packaged native-tool arm is unverified and
left as a follow-up); real-provider acceptance; full-owner restart.

**No production behavior change.** The crash is held on the fake-model side (the
existing `holdUntil` mechanism), so this arm needs **no new serve hook** — unlike
A3/B3a. The only production-source edit, if any, is test-gated and inert.

## Proposed solution

### Window choice (W2)

Crash in the **after-result window of a later round**: the Nth (N≥2) post-tool model
request has been published (snapshot + `model.attempt: started` durable) and is held
by the fake model before it finishes. This is the lowest-risk window — it reuses the
`after-result` hold/barrier machinery, the hold point is on the fake-server side (no
new serve hook), and the saved request already carries the round and budget, so
recovery must restore them. (The alternative W1 — between a tool-result commit and
the next snapshot — may not be stoppable and could route to a round-resetting path;
it is deferred pending a dry-run. W3 overlaps B3a's boundary and adds only the
multi-round/budget dimension, folded into W2's assertions.)

### Multi-round fixture

The fake model decides by the count of `"role":"tool"` messages: the first two
requests return a `write_file` tool call each (two distinct paths/effects), and the
third returns the held final answer. The prompt carries a `+Nk` directive so the
`TurnBudget` snapshot is non-null and its restoration is numerically assertable.
Each response also charges non-zero usage (300/300/100 completion tokens): the fake
server's default usage is all zeros, which would leave the token ledger numerically
empty, and the earlier rounds outweigh the final round so a zeroed restore totals
less than the crash-boundary ledger instead of re-counting the same sum.

### Recovery assertions (new, on top of the after-result template)

- **Round continuity**: read the saved `hosted-model-request.round` before the crash
  and the recovered request's round after; require equality (and ≥2, so a reset to 0
  reds). A reset that re-runs the earlier rounds is additionally caught by the
  exactly-once execution count and the deep-equal request parity.
- **Cost ledger continuity**: read the route/usage resource `budget` and `models`
  before and after; require the crash-boundary snapshot to be non-null (a null one
  would let a dropped restore pass vacuously as null == null) and deep-equal after
  recovery, and every crash-boundary model's output-token total to survive (after ≥
  before). The crash-boundary ledger must be non-empty, so a fixture that never
  charged the ledger reds instead of passing vacuously.
- **Exactly-once + deep-equal**: two earlier executions, each `SETTLED` /
  `dispatch_generation=1` under the original Runtime identity (binding / generation /
  runtimeSessionId); the first approval plan carries only tool A, so the two physical
  file effects give the per-tool evidence; the reissued post-tool request deep-equal
  to the saved one; one terminal; recovered answer.

### Runner, CI and contract pins

A new `approvalFaults` entry (allow-only overlay), a barrier branch in the exhaustive
crash-arm guard, an npm script and a `sdk-java.yml` step, and a bump of the
`hosted-failover-e2e` arm ceiling and timeout. Contract pins pin the multi-round
fixture, the round/budget readers and their assertions; any new top-level runner
helper gets a behavioural test on injected inputs.

### Documentation

Update [G3 Step 3 recovery](2026-10-09-hosted-g3-step3-recovery.md) §9.1 in both
languages: thirteen → fourteen packaged arms, move B3 from focused to packaged, and
record the "cost budget = TurnBudget snapshot + token ledger" clarification.

## Design decisions and rationale

- **W2 over W1/W3** — W2 reuses the proven after-result hold with no new serve hook;
  W1's recovery routing is unverified and may be unstoppable; W3 duplicates B3a's
  boundary.
- **Cost = snapshot + ledger, not a spend gate** — matches the actual mechanism; the
  arm asserts restoration fidelity, which is what "do not reset" means here.
- **Explicit `+Nk` directive** — the default null budget makes a ledger reset
  unobservable; the fixture opts in so the snapshot restoration is numerically
  assertable. No `maxSessionTurns` is set: the absolute round index means the limit
  does not cleanly detect a reset, so reset detection rests on the exactly-once,
  deep-equal and round-continuity assertions.
- **Multi-round gated on the fault name** — the shared fake model and assertions are
  used by every approval arm; gating keeps the single-round arms unchanged.

## Constraints and risks

- **Shared fixture regression.** The fake model and execution-identity assertions are
  shared; the multi-round path must be fully gated and the single-round arms re-run
  green. Every gate the arm shares with `after-result` — arming AND releasing the
  hold, capturing the published prefix, and the retraction proof — must enumerate
  both fault names: a release gated to `after-result` alone left the recovery
  generation's reissued request held forever (caught by the first .75 head run).
- **Round/budget readers must mirror recovery.** The round/budget assertions read the
  same durable resources recovery reads; a behavioural test on injected rows proves
  the readers, and a mutation must red them. Resources are read as `HEX(inline_bytes)`
  and decoded in the runner: `mysql --batch` escapes backslashes, which corrupts the
  saved request's `\"` sequences (the request carries the full system prompt).
- **Ledger shape (confirmed).** An unrestored ledger is `{}`, not null —
  `getMetricsForSession` falls back to `createInitialMetrics()` — and `{}` is truthy,
  so a null check alone would let a zeroed restore pass. The assertion therefore
  compares per-model output-token totals (after ≥ before, the ledger grows as the
  held round completes) and requires a non-empty crash-boundary ledger.
- **CI budget.** One more arm raises the `hosted-failover-e2e` ceiling and timeout.

## Validation plan

- **.75 real stack**: head arm green — round continuity, cost ledger continuity, two
  earlier executions once each, deep-equal reissue, one terminal, recovery from MySQL
  alone after scrash.
- **Demonstrated mutation reds**: reset the recovered round to 0 → round-continuity
  red; zero the restored models ledger → ledger red; drop the `+Nk` snapshot restore
  → budget red (each killed at its named assertion on the .75 real stack). The
  execution-count assertion is defense-in-depth in W2: three mutation cells
  (empty fold predicate; broken replay routing; both together) all SURVIVED, because
  exactly-once here rides three independent layers — the saved-request replay
  routing, the continuation route's settled-batch adoption, and the Runtime's
  runtimeCallId idempotency (Java-side, unreachable from CLI mutations). Reddening
  the count would require a cross-language compound; that is recorded as a
  follow-up. The count/identity assertions are shared with the packaged,
  CI-proven sibling-approval and after-result arms.
- Contract suite + behavioural tests green; `npm run build && npm run typecheck &&
npm run bundle`.

## Acceptance criteria

- A packaged arm in `hosted-failover-e2e` whose runner asserts round continuity, cost
  ledger continuity, exactly-once earlier executions and one terminal from MySQL alone
  after scrashing the crashed generation.
- Each new round/budget/ledger signal has a demonstrated named mutation red; the
  shared exactly-once count/identity assertions are defense-in-depth in W2, with
  survived-mutation evidence documenting the independent guard layers.
- Bilingual design docs aligned; CI green; no production behavior change.

## Open questions

- Resolved: the fault name is `after-earlier-tools` and the directive is `+500k`
  (the .75 crash-boundary evidence pins the snapshot at `budget: 500000`,
  `outputTokensAtTurnStart: 0`).
- Whether the skill-only / manual-continue round-reset paths are reachable in a
  packaged arm (deferred; would be a separate gap if confirmed).

[issue]: https://github.com/QwenLM/qwen-code/issues/14481
