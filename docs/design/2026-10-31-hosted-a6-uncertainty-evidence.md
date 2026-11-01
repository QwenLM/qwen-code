# Hosted A6 — block on uncertain producer evidence

Status: implemented. Slice of Issue #14481 (G3 Step 3 recovery matrix), row **A6**
("MCP/Hook/child uncertainty"). Per the parent design's §9.1, A6 stays focused or
integration evidence: this slice adds focused behavioural evidence, guards every
recovery writer against uncertain child evidence, and keeps a bounded cancel
escape for the resulting block. No new CI arm, no new continuation support, no
change to the Hook/MCP refusal policy itself.

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

- **G1/G2 (tests only).** A five-row owner-gate matrix in
  `hosted-approval-continuation.test.ts`: a non-commandStep saved plan under a
  hooks-owned and under an mcp-owned turn is refused with the
  `'Unsupported saved batch owner.'` cause; a hooks owner with
  `extensionConfig` and no commandStep is refused by the same first arm; a
  commandStep plan whose `configRevision` no longer matches the turn's
  `extensionConfig.revision` is refused by the gate's second arm; and a
  matching-revision commandStep plan under a hooks owner proceeds PAST the gate
  (its rejection is the wrapped transport failure, never the owner cause) —
  pinning the over-blocking direction that keeps the A3 commandStep follow-up
  working. The gap is demonstrated first: deleting the owner-gate clause keeps
  the pre-change suites green.
- **G3 (recovery writers + a bounded cancel escape).** On a live signal, an
  owed fold for a ledger-family call (`agent` or `workflow`) with
  `children === undefined` refuses in `fillParkedRoundAgentGaps`,
  `fillParkedRoundCommandGaps`, and the hosted resumed-turn answer. The common
  `HostedChildLedgerRecoveryRequiredError` subtype marks exactly this evidence
  block for the route. Already-journaled gaps stay silent, non-family gaps keep
  their existing answers, and a present ledger's missing record remains positive
  never-started proof. Pre-aborted terminating fills and the `'all'` settlement
  write `HOSTED_CHILD_LEDGER_UNKNOWN_TEXT` with `executionStatus: 'unknown'`,
  never a fabricated never-ran or cancelled outcome. Route witnesses build the
  drift into the load (`suppressChildAgents` on the orphan parked shape):
  continue blocks retriably with no fabricated fold, then managed-runtime cancel
  settles that same blocked Turn, writes the cancelled terminal, clears the
  recovery block, and lets the public cancel replay answer 204. A different
  recovery block still refuses cancel with 409 `turn_blocked`.

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
  those paths always terminate. Their ledger-less family folds say the outcome
  is unknown and retain the record; they never claim the call never ran or was
  observed cancelled.
- **A bounded terminal escape after the block.** Only the A6 subtype arms
  `recoveryCancelPromptId`; only that Turn's managed-runtime cancel bypasses
  the blocked refusal. The failed continue's admission is removed so it cannot
  replay as a cancellation, and the block lifts only after a cancelled terminal
  is durable. Other recovery blocks keep their 409 refusal and lease behavior.
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

- `packages/cli/src/serve/hosted-runtime-recovery.ts` (G3 writer guards and the
  A6 error subtype)
- `packages/cli/src/serve/hosted-harness-session.ts` (the bounded cancel escape)
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
  call is unchanged; a journaled gap replays silently. Pre-aborted fills and the
  `'all'` settlement write the unknown outcome; the settlement's own answering
  pass pins `executionStatus: 'unknown'`. At route level under built-in drift:
  continue blocks retriably (409) with no fabricated fold, then cancel settles
  that same Turn and clears the block; an unrelated recovery block still
  refuses cancel. Each new guard or escape clause has a delete-control that
  reds its named case.
- Focused suites green under a sanitized environment (agent-session env vars
  stripped), typecheck/ESLint/Prettier green; production changes stay limited to
  the recovery writers and the bounded cancel escape.

## Open questions

- Pinning the harness takeover entry's `session.extensions?.enabled` clause at
  route level (needs a hooks-session takeover fixture with a durable v3
  continuation; the tool-turn backstop it gates is already pinned both ways).
- Whether a later slice packages an A6 fault arm once Hook/MCP e2e fixtures
  exist (out of scope here).
- Whether Hook/MCP-profile Turn leases should join the cleanup-debt protocol
  (adjacent C3-scope observation above).

## R2 review round (4 Suggestions — all fixed)

- **Sibling writers (R2-1)**: the same never-ran fabrication survived at two
  sibling writers on the recovery paths. `answerAbandonedTurnCalls` (hosted
  mode, the continue route's resumed-turn answer) now refuses a ledger-less
  family call — its caller's family catch maps the refusal to the retriable
  block; the terminating `'all'` settlement keeps folding but on the honest
  wording (below). `fillParkedRoundCommandGaps` (which never reads the
  ledger) refuses the same shape on a live signal; its continue-route caller
  passes the live signal, the cancel and settle callers pre-abort.
- **Honest exempted wording (R2-3)**: the exempted (pre-aborted) folds and the
  `'all'` settlement answer a ledger-less family call with a new dedicated
  `HOSTED_CHILD_LEDGER_UNKNOWN_TEXT` — "outcome is unknown … record is
  retained", `executionStatus: 'unknown'` — never "never ran" and never
  "cancelled". The funnels still terminate without throwing.
- **One family fact (R2-4)**: `CHILD_LEDGER_TOOL_NAMES = new Set(['agent',
'workflow'])` lives in `hosted-workspace-tool-turn.ts` beside the answer
  constants; all six former inline two-name literals (four in recovery, two
  in the tool-turn mount-validation arms) read `.has(name)` from it. Not
  `JOURNAL_ONLY_ANSWERABLE_TOOLS` — that set also holds the team names whose
  gap answer is their own funnel.
- **The extensions row (R2-2)**: the owner-gate matrix gained the row its
  comment claimed — a Hook owner with `extensionConfig` and NO `commandStep`
  is refused by the first arm; smuggling `&& !this.extensionConfig` into the
  gate reds exactly that row.

R2 delete-controls (quiet tree, failure-list adjudication): the family
constant hollowed to `agent`-only at the fill guard; the resumed-answer
refusal removed; the `'all'` settlement's unknown wording reverted; the
command-gaps refusal removed; the extensions exemption smuggled into the
gate — every row KILLED at exactly its named case, restores byte-identical.

## R3 verification round (1 Major + 3 Suggestions — all fixed)

- **Terminal escape (F1)**: the new route sequence was reproduced red before
  the fix — continue blocks, then managed-runtime cancel answers 409. Only the
  A6 subtype now arms a same-Turn cancel exemption; the failed continue's
  admission is deleted so it cannot replay as a cancel, and a durable cancelled
  terminal lifts the block. The witness asserts the unknown fold, cancelled
  terminal, cleared status, and public-cancel 204. The pre-existing generic
  recovery-block control still answers 409 `turn_blocked`.
- **Settlement status (F2)**: the settle case now selects `call-3` — the call
  answered by the settlement's own pass, not a sibling fill — and asserts its
  `executionStatus: 'unknown'`.
- **Debug residue (F3)**: the command-wait case's projection `console.log` is
  removed.
- **Stale description (F4)**: the PR body and both design versions describe
  the five-row matrix, all recovery writers, honest unknown folds, and the
  bounded cancel escape rather than the pre-R2 single-guard shape.

R3 delete-controls (quiet tree, one selected test per row): the first blocked
gate, second blocked gate, continue-admission deletion, terminal block lift,
and A6 subtype each red the block-then-cancel witness; broadening the marker
to every family error reds exactly the generic blocked-cancel control;
reverting the settlement status reds exactly the `call-3` case. All 7 rows
KILLED, every restore sha256-identical.

Gates: 8 focused suites, 1587/1587 (the harness file's 686 tests completed in
two explicit groups, 175 + 511, after the default full-file run reached the
10-minute runner limit without a test failure); typecheck RC=0; ESLint and
Prettier green.
