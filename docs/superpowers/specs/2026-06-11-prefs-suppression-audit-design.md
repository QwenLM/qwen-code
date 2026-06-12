# Cycle 53 — Audit per-subscription prefs suppression (`reason:'prefs'`)

Proposal: `add-notification-routing` (R6 "operator sees why no push
fired" / task 5.2 `push_suppressed` advertisement). Closes the last
silent operator-visible suppression path in the notifier.

## The gap

The notifier's suppression reasons split on one axis:

- **Boundaries** — the token fundamentally can't / mustn't receive this
  push: scope mismatch (no scope for the kind) and session-lock mismatch
  (a share token locked to another session). These stay SILENT: they are
  permission/security boundaries, not choices, and auditing every
  fan-out against every ineligible token would be noise (and the
  session-lock one edges toward cross-session leakage).
- **Decisions** — "we could have sent, we chose not to": `snoozed`,
  `routing_rule` (event-global + per-sub), `quiet_hours`,
  `working_device`. These all audit `push_suppressed{kind, reason,
subscriptionId}`. That audit IS R6's "why no push" — and since cycle
  49 it streams live on `/rc/events` and is queryable via `/rc/audit`.

**Per-subscription `prefs` filtering is a DECISION misfiled as a
boundary.** A prefs allowlist (`prefs:['permission.required']`) is an
operator-configured per-device choice — the same category as
`quiet_hours`/`working_device`, which sit on either side of it and both
audit — yet cycle 16's `return` is silent, its comment reasoning
"matching the cycle-9 scope-skip posture." That comment is the error:
scope-skip is a boundary, prefs is a decision. So when an operator who
muted a kind on their phone later asks "why didn't it ping," the feed
has no answer. This cycle adds the audit and rewrites the comment.

(Note: "prefs is static config, so it could stay silent" does NOT hold —
`routing_rule` is also static routing.yaml config and audits per event.)

## Change

In the prefs branch, before the suppressing `return`, emit
`push_suppressed{kind, reason:'prefs', subscriptionId}` — byte-identical
in shape to the adjacent `quiet_hours`/`working_device` audits. `reason`
is a detail VALUE, so NO new `AuditAction` (no union/array change).

## Decisions

1. **Per-event, NOT once-per-transition.** Its siblings (`quiet_hours`/
   `working_device`/`routing_rule`) all audit every event; a `firstDrop`-
   style once-per-(sub,kind) audit (as the rate limiter does) would make
   prefs the NEW inconsistency. Match the siblings exactly.
2. **Accept the volume, describe it honestly.** Unlike time-bounded
   `quiet_hours` or active-only `working_device`, a prefs allowlist is
   always-on, so a mute on a high-frequency kind makes `prefs` the
   highest-volume suppression reason — it can dominate the live
   `/rc/events` stream. That is acceptable and correct: the operator
   asked "why no push," and the honest answer is "this filter,
   repeatedly." Cycle-49 backpressure degrades the live stream
   gracefully and `/rc/audit` stays complete; no rate-limiting of the
   audit itself.
3. **Boundaries stay silent.** Scope-mismatch and session-lock keep
   their silent skips (unchanged) — they are not "why no push" the
   operator can act on, and auditing them is noise / a leak risk.

## Verification

The prefs gate is on the `notify` fan-out path (NOT `notifyToken`, the
un-gated `/test` path), so the e2e push-test does not exercise it; this
is a notifier UNIT-test slice: a prefs-mute event emits one
`push_suppressed{reason:'prefs'}` and is not sent; a prefs-allowed event
sends and emits no such audit. e2e unchanged.

## Deferred

Unchanged from add-notification-routing: `routing_decision` bespoke SSE
frame, urgency/mentions/policy-awareness rule fields, "why no push" web
UI (now playwright-verifiable — the next high-value frontier), the
`push_routed` positive-route audit (N/A to the suppress-only model — a
successful send already audits `push_sent`).
