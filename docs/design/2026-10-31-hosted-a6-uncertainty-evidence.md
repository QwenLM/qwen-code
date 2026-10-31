# Hosted A6 — block on uncertain producer evidence

Status: implemented. Slice of Issue #14481 (G3 Step 3 recovery matrix), row **A6**
("MCP/Hook/child uncertainty"). Per the parent design's §9.1, A6 stays focused or
integration evidence: this slice adds focused behavioural evidence and one small
recovery guard. No new CI arm, no new continuation support, no change to the
Hook/MCP refusal policy itself.

Parent: [G3 Step 3 recovery](2026-10-09-hosted-g3-step3-recovery.md).
中文版：[2026-10-31-hosted-a6-uncertainty-evidence.zh-CN.md](2026-10-31-hosted-a6-uncertainty-evidence.zh-CN.md).

## Problem

A6 requires three observations: missing or unknown producer evidence blocks; no
external call is recreated; no Workspace lease is silently released. An
investigation of main `35daec35ea` (two parallel code surveys, key claims
re-verified by hand) shows the second and third clauses are already thickly
guarded and tested, while the first clause has three concrete evidence gaps:

- **G1 — the Hook/MCP saved-batch refusal arm has zero tests.**
  `resumeSavedNativeBatch` refuses a non-commandStep plan owned by a Hook/MCP
  session with `HostedToolRecoveryRequiredError('Unsupported saved batch owner.')`
  (`hosted-workspace-tool-turn.ts:3508-3517`). The string appears nowhere in any
  test; the approval-continuation fixtures never construct a hooks/mcp resume.
  Deleting the clause is predicted to keep every suite green.
- **G2 — the extensions-enabled entry combination is unpinned.** The takeover
  continuation entry (`hosted-harness-session.ts:7124-7129`) admits sessions with
  `session.extensions?.enabled` even when `session.hooks || session.mcp`; the only
  backstop for a non-commandStep plan is G1's untested clause. (Resolution scope:
  this slice pins the tool-turn backstop in both gate directions; the entry's
  `extensions?.enabled` clause itself is a route-level surface recorded as a
  follow-up below — a focused fixture cannot reach it without a full
  hooks-session takeover, and a row that cannot fail is worse than no row.)
- **G3 — an unavailable child ledger is answered as proven absence.**
  `fillParkedRoundAgentGaps` folds `gapText` for a stranded call when
  `children === undefined || admitted === undefined`
  (`hosted-runtime-recovery.ts:1505-1517`). The two arms are not the same evidence:
  with the ledger present, no `child_run` record is positive never-started proof
  (`admitLaunch` commits the record before `dispatchStarted`,
  `hosted-child-agent-session.ts:1383-1415`); with the ledger absent, nothing is
  known — yet the fold asserts "the call never ran"
  (`HOSTED_AGENT_CALL_NOT_REACHED_TEXT`, `hosted-workspace-tool-turn.ts:1660-1661`).
  The ledger family is `agent` AND `workflow`: the module's other readers already
  treat the two names as one (`hosted-runtime-recovery.ts:790, 1913`,
  `JOURNAL_ONLY_ANSWERABLE_TOOLS`), and workflow admission requires the child
  funnel. `session.childAgents` is rebuilt deterministically from persisted
  session configuration at load (`hosted-harness-session.ts:6265-6307`), so the
  absent arm is unreachable for a stable configuration that never had the agent
  tool — but it is reachable across child-lane configuration/version drift
  between the crashed generation and the recovering one (reproducible at route
  level via `suppressChildAgents` on a version-0 lane), exactly when an admitted
  child may still be running. No test distinguishes the two arms.

## Verified code facts (main 35daec35ea)

- Producer evidence is durable and pre-dispatch for all three producers: Hook
  `hook_execution` records and MCP `mcp_operation` records run
  `intent → dispatch_started → settled | outcome_unknown | not_started_proven`,
  with `dispatch_started` committed before the physical dispatch
  (`hosted-hook-session.ts:1187-1193, 1362-1378`;
  `hosted-mcp-session.ts:865-882`); child runs commit `child_run` before dispatch.
- Uncertain Hook/MCP results are lookup-only (`hook-status` / status polling);
  non-settled lookups commit `recovery_blocked / outcome_unknown` and throw the
  family recovery error. No path recreating an uncertain external call was found
  (dispatch only from `intent`; `reconcileEffects` cancels intents, never
  redispatches; child admission is evidence-idempotent).
- Clause 3 is guarded by persistent evidence, not tool lists: Java release
  refuses while any execution row is non-terminal
  (`JdbcToolExecutionRepository.hasActiveByRuntimeSession`), descendant half
  evidence blocks retirement (`ManagedRuntimeRetentionGuard.childRunUnsettled`),
  and the CLI fast-settle path requires a non-empty all-settled list. Tested
  witnesses include `hosted-mcp-session.test.ts:846, 1762` (unknown outcome keeps
  the owner / blocks replacement), `hosted-hook-session.test.ts:892` (unknown
  result keeps the mount), and `HostedMonitorRunFaultGatesIT` (uncertain worker →
  `runtime_session_held`, binding stays READY).

## Changes

- **G1/G2 (tests only).** A four-row owner-gate matrix in
  `hosted-approval-continuation.test.ts`: a non-commandStep saved plan under a
  hooks-owned and under an mcp-owned turn is refused with the
  `'Unsupported saved batch owner.'` cause; a commandStep plan whose
  `configRevision` no longer matches the turn's `extensionConfig.revision` is
  refused by the gate's second arm; and a matching-revision commandStep plan
  under a hooks owner proceeds PAST the gate (its rejection is the wrapped
  transport failure, never the owner cause) — pinning the over-blocking
  direction that keeps the A3 commandStep follow-up working. The gap is
  demonstrated first: deleting the owner-gate clause keeps the pre-change
  suites green.
- **G3 (one guard + tests).** In `fillParkedRoundAgentGaps`, an owed fold
  (`foldOwed`) for a ledger-family call (`agent` or `workflow`) with
  `input.children === undefined` and a live (non-aborted) signal throws
  `HostedToolRecoveryRequiredError` instead of folding. Three boundaries keep
  the guard honest: an already-journaled gap stays a silent replay; the cancel
  route and the interrupted-turn settle funnel PRE-ABORT this fill so they
  terminate at once, and their abandonment folds keep the pre-A6 story (a
  throwing fill there would wedge cancel in a deterministic 503 loop and the
  wake in a busy retry — only the continue route, whose catch maps the family
  to a retriable recovery block, blocks); non-family gap calls keep their
  existing answer. Witnesses: fill-level cases for the agent arm, the workflow
  arm, the non-agent arm, the replay silence and the pre-aborted exemption in
  `hosted-child-wait-recovery.test.ts`, plus two route-level cases in
  `hosted-harness-session.test.ts` that build the drift into the load
  (`suppressChildAgents` on the orphan parked shape): continue answers a
  retriable 409 `hosted_turn_recovery_required` with no fabricated fold, and
  cancel still settles with its pre-A6 abandonment fold. Every clause has a
  verified single-clause delete-control.

## Design decisions

- **Block, not fold, for an unavailable ledger.** A6's first clause is about
  evidence semantics: "unknown" must not be laundered into "proven absent". The
  fold is durable and answers the model; a wrong never-ran claim can strand a
  live child's effect with no owed response.
- **The ledger family, not just `agent`.** `workflow` launches ride the same
  child-run ledger (the module's other readers treat the two names as one
  family), so the same unavailable-evidence block covers both. Other stranded
  calls keep the existing gap answer, so the guard cannot regress sessions
  that legitimately have no child funnel.
- **Abort exemption for the terminating routes.** Cancel and the interrupted
  settle funnel deliberately pre-abort the fill ("settles at once … instead of
  holding the cancel hostage"); the guard exempts an already-aborted signal so
  those paths keep their pre-A6 abandonment folds and always terminate. The
  residual trade-off is explicit: under drift, those two paths still fold an
  approximate abandonment answer rather than block — blocking them would wedge
  a cancelled Turn forever, which is worse than the approximate story their
  own ledger-keeping children can still recover from.
- **No packaged arm, no continuation support.** §9.1 classifies A6 as focused or
  integration evidence, and native continuation refuses Hook/MCP sessions by
  design (the commandStep follow-up is A3's other half). Packaging a Hook/MCP
  crash arm would need new e2e fixtures and is a separate slice.
- **Lease-side observations stay out of scope.** Hook/MCP-profile Turns do not
  enter the HOSTED_CLEANUP debt protocol (`!hooks && !mcp` gates), so the C3
  scanner does not re-drive their leases; that is a cleanup-coverage question
  (a stuck lease is not a silent release), recorded here as an adjacent
  observation for a future C3 slice, not an A6 defect.

## Files affected

- `packages/cli/src/serve/hosted-runtime-recovery.ts` (the G3 guard)
- `packages/cli/src/serve/hosted-child-wait-recovery.test.ts` (G3 fill-level cases)
- `packages/cli/src/serve/hosted-harness-session.test.ts` (G3 route-level cases)
- `packages/cli/src/serve/hosted-approval-continuation.test.ts` (G1/G2 matrix)
- this design doc (both languages); the parent §9.1 status note is updated when
  the focused evidence lands.

## Acceptance criteria

- G1/G2: the owner-gate deletion survives the pre-change suites (demonstrated
  gap) and reds the refusal rows afterwards; removing `!plan.commandStep &&`
  reds exactly the matching-revision acceptance row; removing the second
  (revision) arm reds exactly the stale-revision row. The harness entry's
  `extensions?.enabled` clause is NOT claimed as pinned (follow-up below).
- G3: the absent-ledger counterexample folds "never ran" before the guard and
  throws with no fold written after it, for both `agent` and `workflow`; the
  ledger-present/no-record arm still folds the honest answer; a non-family gap
  call is unchanged; a journaled gap replays silently; a pre-aborted fill keeps
  its abandonment fold. At route level under built-in drift: continue blocks
  retriably (409) with no fabricated fold, and cancel still settles. Each
  guard conjunct (family, foldOwed, abort exemption) has a delete-control that
  reds exactly its named case.
- Focused suites green under a sanitized environment (agent-session env vars
  stripped), typecheck/ESLint/Prettier green; the only production change is the
  single guard.

## Open questions

- Pinning the harness takeover entry's `session.extensions?.enabled` clause at
  route level (needs a hooks-session takeover fixture with a durable v3
  continuation; the tool-turn backstop it gates is already pinned both ways).
- Whether a later slice packages an A6 fault arm once Hook/MCP e2e fixtures
  exist (out of scope here).
- Whether Hook/MCP-profile Turn leases should join the cleanup-debt protocol
  (adjacent C3-scope observation above).
