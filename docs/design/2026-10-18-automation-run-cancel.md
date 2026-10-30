# Cancel one Managed Automation run

[English](2026-10-18-automation-run-cancel.md) | [简体中文](2026-10-18-automation-run-cancel.zh-CN.md)

## Status and problem

Proposed implementation for [#14460](https://github.com/QwenLM/qwen-code/issues/14460), based on main `b3c5d3ed1e67`. Automation runs appear as tasks, but cannot advertise or accept cancellation. Existing run settlement already maps the committed Turn outcome to `cancelled`.

## Goals and boundaries

Cancel one run through the existing public and WebShell task routes. Preserve the schedule, future occurrences, sibling runs and unrelated foreground Turns. Keep `automation.enabled` defaulting to `false`. Do not add a public route, operation kind, record field, schema migration or UI control. General `CANCEL` recovery, Automation observability, `per_run` Sessions and the complete FG11 fault round remain separate work.

## Design

### Control plane

Add `automation_run` to the cancellable task kinds. Durable admission, authorization, idempotency and operation leasing continue to use `TASK_CANCEL`. The coordinator sends a private `cancel_run` Automation operation naming the original run, schedule and occurrence; the Hosted route verifies that the immutable pair derives that exact run before addressing its Turn. A mismatch is refused without cancelling any run. The Hosted connector uses stop authorization and passive attachment, rather than new-work authorization or session-wide cancellation takeover. A reload may start a queued run before Hosted accepts the stop; Java admission alone does not promise physical cancellation.

### Hosted authority

Serialize cancellation with the Automation funnel's fire and settlement writes. A claim still at `intent` can settle `cancelled/not_started_proven` immediately: no input was admitted. A dispatched run commits a turn-scoped `cancel.requested` event, coalesced by the original run identity. This is durable authority acceptance, not physical settlement. After the append, abort only a currently active controller whose prompt identity matches that run's Turn.

The wake runner rechecks the committed cancellation after its awaited attempt read, while holding its Turn slot and before calling the model. An unattempted cancelled input writes its own cancelled Turn result without calling the model, and follows normal run settlement. If this write fails, the slot is released and the scheduler retries the same input without blocking the Session or inventing an error result. A queued input waits behind any other active Turn; it does not interrupt it. Reopen derives cancellation from the journal again. An input already attempted keeps the existing interrupted-Turn recovery path: absence of a live controller never proves cancellation.

### Proof and races

Java completes this kind's cancel operation only when the committed `automation_run` is `cancelled`. A wire acknowledgment or a missing controller cannot complete it. A natural completed/failed outcome wins and remains unchanged; the operation reports `task_already_settled`. A lost reply retries the same target, and a lost run-settlement write reconciles from the original Turn result. Unproven outcomes retain the existing bounded attempts and `recovery_blocked` record-only reconciliation; a parked operation is never re-delivered.

The wake runner claims its slot and checks cancellation synchronously, with no intervening await. Cancellation arriving after that claim aborts the matching controller after committing its request. Cancellation arriving earlier is read by the runner before model start. Any attempted run whose crash leaves no terminal proof remains subject to the existing honest `failed/outcome_unknown` recovery semantics.

## Affected components

The control-plane task projection, cancel coordinator and Hosted connector route the stop. The Hosted Automation funnel commits it; the shared wake runner consumes queued cancellations. The OpenAPI task capability documentation and generated WebShell types describe the capability. Existing task UI and SDK entry points need no additional API. Focused tests cover each layer and the actual Hosted route.

## Validation and acceptance

First attempt the E2E plan with the global `qwen` baseline; then verify the local bundle and Java service. Cover claim-only and queued cancellation, active matching cancellation, sibling and foreground isolation, natural-completion races, repeat/reopen, unknown recovery, authorization, public/WebShell idempotency and parked reconciliation. Run affected TypeScript tests, root build/typecheck/bundle, Java focused tests and `mvn verify`; use disposable MySQL 8.4 and matching Hosted profiles for integration evidence. Record unavailable platform or deployed-environment acceptance explicitly.

For [#14446](https://github.com/QwenLM/qwen-code/issues/14446), FG11d must now expect per-run task cancellation and an unchanged schedule, rather than `task_action_unavailable`. That tracker update accompanies the PR; it does not claim the complete fault round has run.

## Risks and open questions

The main risk is cancelling or settling a different Turn across asynchronous boundaries; immutable target identity and the wake slot protect it. A queued cancellation may remain pending while unrelated work owns the Session. A cancellation acknowledgment can precede the physical result, while this kind's public receipt deliberately waits for positive cancelled-run evidence. No open contract decisions remain.
