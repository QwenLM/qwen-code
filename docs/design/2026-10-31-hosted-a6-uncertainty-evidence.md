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
  backstop for a non-commandStep plan is G1's untested clause.
- **G3 — an unavailable child ledger is answered as proven absence.**
  `fillParkedRoundAgentGaps` folds `gapText` for a stranded call when
  `children === undefined || admitted === undefined`
  (`hosted-runtime-recovery.ts:1505-1517`). The two arms are not the same evidence:
  with the ledger present, no `child_run` record is positive never-started proof
  (`admitLaunch` commits the record before `dispatchStarted`,
  `hosted-child-agent-session.ts:1383-1415`); with the ledger absent, nothing is
  known — yet the fold asserts "the call never ran"
  (`HOSTED_AGENT_CALL_NOT_REACHED_TEXT`, `hosted-workspace-tool-turn.ts:1660-1661`).
  `session.childAgents` is rebuilt deterministically from persisted session
  configuration at load (`hosted-harness-session.ts:6265-6307`), so the absent arm
  is unreachable for a stable configuration that never had the agent tool — but it
  is reachable across child-lane configuration/version drift between the crashed
  generation and the recovering one, exactly when an admitted child may still be
  running. No test distinguishes the two arms.

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

- **G1/G2 (tests only).** Behavioural cases in
  `hosted-approval-continuation.test.ts`: a non-commandStep saved plan resumed by
  a hooks-owned and by an mcp-owned tool turn must throw
  `HostedToolRecoveryRequiredError('Unsupported saved batch owner.')`, including
  the extensions-enabled combination. The gap is demonstrated first: deleting the
  owner-gate clause keeps the current suites green; after the new cases, the same
  deletion must red them.
- **G3 (one guard + tests).** In `fillParkedRoundAgentGaps`, when the gap call is
  the child-agent tool (`name === 'agent'`) and `input.children === undefined`,
  throw `HostedToolRecoveryRequiredError` instead of folding: unavailable producer
  evidence blocks (the continue route already maps the family to a retriable 409
  `hosted_turn_recovery_required`). The ledger-present/no-record arm keeps its
  honest never-admitted fold, and non-agent gap calls keep their existing answer.
  Counterexample first (absent ledger + agent gap folds "never ran" today), then
  the guard, then behavioural cases for all three arms in
  `hosted-child-wait-recovery.test.ts`, each delete-control verified.

## Design decisions

- **Block, not fold, for an unavailable ledger.** A6's first clause is about
  evidence semantics: "unknown" must not be laundered into "proven absent". The
  fold is durable and answers the model; a wrong never-ran claim can strand a
  live child's effect with no owed response.
- **Only `agent` calls change.** Their never-started proof is the child ledger
  itself; other stranded calls keep the existing gap answer, so the guard cannot
  regress sessions that legitimately have no child funnel.
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
- `packages/cli/src/serve/hosted-child-wait-recovery.test.ts` (G3 cases)
- `packages/cli/src/serve/hosted-approval-continuation.test.ts` (G1/G2 cases)
- this design doc (both languages); the parent §9.1 status note is updated when
  the focused evidence lands.

## Acceptance criteria

- G1/G2: the owner-gate deletion survives the pre-change suites (demonstrated
  gap) and reds the new cases afterwards; the extensions-enabled combination is
  covered, not just the plain hooks/mcp arms.
- G3: the absent-ledger counterexample folds "never ran" before the guard and
  throws `HostedToolRecoveryRequiredError` with no fold written after it; the
  ledger-present/no-record arm still folds the honest never-admitted answer; a
  non-agent gap call with an absent ledger is unchanged; deleting the guard reds
  exactly the new case.
- Focused suites green under a sanitized environment (agent-session env vars
  stripped), typecheck/ESLint/Prettier green; the only production change is the
  single guard.

## Open questions

- Whether a later slice packages an A6 fault arm once Hook/MCP e2e fixtures
  exist (out of scope here).
- Whether Hook/MCP-profile Turn leases should join the cleanup-debt protocol
  (adjacent C3-scope observation above).
