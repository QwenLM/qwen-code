# Hosted team plans: b3d implementation

[English](2026-10-12-managed-agent-team-plans.md) | [简体中文](2026-10-12-managed-agent-team-plans.zh-CN.md)

## Status and scope

Implementation plan, not verification evidence. This slice requires the member
message capability merged into main by PR #13955 and implements decisions 9,
13 and 14 of the
[member commands design](2026-10-11-managed-agent-team-member-commands.md).
It does not add D6 cards, public Actions, a read-only shell, migrations, or a new
relay. The existing bilingual design remains the behavioral contract.

## Current gap

The command channel and member messages exist, but `plan_submit` is refused.
Named launches cannot request plan mode, and neither plan submission nor lead
approval is advertised. The earlier batches provide the fail-closed preamble
and the per-run read restriction needed for rollback safety.

## Implementation

- Use the existing `team_plan` record contract and team/child write chain.
  Submission stores the plan as a resource, cancels a superseded waiting plan,
  and opens the new revision using the command id as request id. A replay finds
  its own committed plan before applying fresh admission checks.
- Advertise `exit_plan_mode` only for an admitted team member in a plan-mode
  run. Route it through the existing durable command wait. Enforce one accepted
  submission per run from persisted command evidence, not process memory.
  An unknown or handed-over submission blocks another submission: absence of
  a reply is not proof that the leader did not accept it.
- Advertise `plan_mode_required` on named launches and `team_plan_approval` on
  the lead only when the plan domain is enabled. Keep every continuation path
  subject to the existing team/member approval rule.
- Admission for a decision precedes its commit: the newest plan must be
  waiting, the member must have settled without a stop, and its continuation
  must satisfy capacity, launch-budget and envelope constraints. Replays and
  recovery use call-keyed committed evidence. A committed decision without a
  continuation returns the split outcome with the request id and recovery
  instructions; it never claims delivery.
- Include the waiting plan in member result notifications and lead task lists.
  `show` reads waiting or decided plans without writing. Supersede, shutdown,
  deletion and a decision observing an ended/stopped member withdraw plans.
  When the plan domain is disabled, shutdown and deletion cannot withdraw:
  historical plans remain readable and waiting. Shutdown refuses a completed,
  unstopped member with a waiting plan, before effects; it also refuses if a
  normal completion outraces the attempted stop. Reenablement can still allow
  that plan to be decided after this refusal. Running-member stops and team
  deletion remain available: an ended/stopped head or inactive team blocks
  continuation. A stop before a continuation starts may fall back to its
  completed predecessor, so rollback shutdown is not a universal barrier to
  later plan decisions. Replays of an already committed submission still
  return its original answer.
- Keep TS and Java input-preview lists and their tests aligned. b3d adds the
  plan domain to the Hosted reopen whitelist ahead of its enablement.

## Integration surfaces

The runtime changes belong in `hosted-team-session.ts`,
`hosted-session-command-session.ts`, `hosted-child-agent-session.ts`,
`hosted-workspace-tool-turn.ts`, `hosted-runtime-recovery.ts`,
`hosted-harness-session.ts` and `hosted-tool-approval.ts`, with collocated tests.
Existing managed team record helpers and domain enablement provide the contract;
Java changes are limited to matching enablement and input-preview surfaces
where required by the existing implementation.

## Constraints and acceptance

- The plan, XML-escaped and JSON-encoded, must fit the 32 KiB continuation
  envelope, including description, definition, preamble, decision text and
  4 KiB feedback reserve. The lead's refusal names the plan's size after XML
  and JSON escaping and the bytes left, so the member can shorten it to fit.
- A refusal, cancellation before handover or rejection permits a corrected
  submission; an accepted, in-flight or unknown submission does not.
- A rejected member remains read-only on every continuation route; the first
  approval lifts plan mode for subsequent runs, not for the current run.
- Interrupted submission, decision and continuation paths must not duplicate
  records or launches. A late replay must not supersede a newer run's plan.
- Every serving Harness and the deployment rollback floor must include b3a.
  Once a lead has committed a `team_plan` record, every Harness that may reopen
  it and the rollback floor must carry b3d, even with the `team_plan` domain
  disabled. A Harness without b3d refuses to load that lead: it answers 409
  `hosted_turn_recovery_required` (reason `restore_verification_failed`; its
  log names `Hosted recovery domain is unsupported.`). The control plane ends a
  new Turn as `hosted_harness_unavailable` once its pre-admission retries run out;
  an admitted Turn keeps retrying until a b3d Harness serves the lead.
  Real-stack validation is required before enablement or merge, including a
  rollback that does not ask b3a to reopen unsupported lead records.

## Validation

Focused tests cover admission, bounds, persisted submission deduplication,
replay after each commit boundary, decision preflight, split recovery,
withdrawals, result rendering and all continuation routes. Run build,
typecheck, bundle and focused package tests. The physical pass uses a scripted
model on the Hosted stack: reject, revise, approve, then edit; a lead message
before approval must retain plan mode. Test rollback safety separately. A real
model enablement pass needs user approval, as required by the parent design.
Report unavailable infrastructure as a blocker, never as a passing test.
