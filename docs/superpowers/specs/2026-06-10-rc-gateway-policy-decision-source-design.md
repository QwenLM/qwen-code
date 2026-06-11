# rc-gateway — audit `decisionSource` (policy / default / client) (cycle 39)

## Context

`add-policy-engine` spec (`specs/policy-engine/spec.md:184-201`): "Every audit
entry corresponding to a tool call SHALL include `decision_source: "policy" |
"client" | "default"` and `rule_id`." Scenarios: an allow-decided-by-rule call →
`decision_source: policy`; a no-rule-match call a human then approves →
`decision_source: client`. Cycle 14 shipped the enforcer's `policy_decision`
audit with `ruleId` but no source; this cycle adds the source.

This also strengthens cycle 38's stated mitigation: the auditability that makes a
workspace-rule auto-approval attributable is exactly this kind of source labeling.

## Deviation from the daemon-centric spec

Daemon-centric spec → delivered gateway-side: the gateway's `PolicyEnforcer`
(auto-vote path) and the cycle-6 permission-vote route are where our tool-call
audit entries originate. No upstream edit. `decisionSource` rides in the existing
`detail` object (free-form `Record<string, unknown>`) alongside `ruleId` — NO
`AuditAction`/`AUDIT_ACTIONS` change (the actions `policy_decision` /
`permission_voted` already exist).

## Why `ruleId` alone is insufficient (the load-bearing reason)

`rule.id` is OPTIONAL in the schema, so a matched rule can have `ruleId ===
undefined` — indistinguishable, by `ruleId` alone, from the no-rule-match
default fall-through (also `undefined`). So the evaluator must EXPLICITLY signal
whether a rule decided. Hence a new `source` field on `PolicyDecision`, not a
`ruleId != null` inference.

## Decisions

- **D1 — `PolicyDecision.source: 'policy' | 'default'`** (required, additive).
  The evaluator sets `'policy'` in BOTH rule-matched returns (the normal
  allow/deny/prompt return AND the unevaluable→downgrade-to-prompt return — a rule
  WAS the cause), and `'default'` in the final no-match fall-through. Existing
  evaluator tests assert individual fields (`.action`/`.ruleId`/`.usedDeferredField`),
  never a whole-object `toEqual`, so the new field is non-breaking.
- **D2 — Enforcer stamps `decisionSource: d.source` on all three
  `policy_decision` audit records** (allow / deny / prompt branches). So a
  no-rule-match prompt audits `decisionSource:'default'` while a matched
  allow/deny/downgraded-prompt audits `'policy'` — the distinction `ruleId`
  couldn't carry. Enforcer tests use `toMatchObject`, so this is non-breaking.
- **D3 — The cycle-6 permission-vote route stamps `decisionSource: 'client'`** on
  its `permission_voted` audit detail. A vote through that route is always a human
  decision → `client` is unconditional and correct, completing the spec's third
  value. (Route tests use `toMatchObject` → non-breaking.) We do NOT add a
  synthetic `ruleId: null` — `permission_voted` simply carries no `ruleId`, which
  is the faithful equivalent of "rule_id: null" for a human vote.
- **D4 — Privacy unchanged.** `decisionSource` is one of three fixed enum tokens —
  no tool args/paths/prompt text. The detail stays `{requestId, action, ruleId?,
voted, decisionSource}` (enforcer) / `{requestId, outcome, accepted,
decisionSource}` (route). `AuditLog.record()` still never throws.

## Mapping to the spec's three values

| Spec value | Our source                                           | Where emitted              |
| ---------- | ---------------------------------------------------- | -------------------------- |
| `policy`   | a rule decided (allow/deny, or a rule-caused prompt) | enforcer `policy_decision` |
| `default`  | no rule matched → policy default action              | enforcer `policy_decision` |
| `client`   | a human voted via the prompt route                   | route `permission_voted`   |

(The `default`-then-`client` sequence for a no-match call that a human later
approves produces two audit rows — a `policy_decision{default}` and a
`permission_voted{client}` — each correctly sourced, satisfying "every entry
carries decision_source".)

## Safety / fail-safe

- Purely additive metadata: a new pure-function field + three audit-detail
  additions. No control-flow change, no new throw path, no AuditAction change, no
  hot-path behavior change (the evaluator/enforcer decisions are byte-identical;
  only the recorded detail grows).
- Fail-safe commit order: docs → evaluator `source` + evaluator tests
  (self-contained; unread by the enforcer yet → inert) → enforcer + route audit
  stamping + their tests.

## Tests

- evaluator: a matched rule → `source:'policy'`; no match → `source:'default'`;
  an unevaluable-downgraded rule → `source:'policy'` (rule-caused).
- enforcer: allow/deny via a rule → `decisionSource:'policy'`; a no-match prompt
  → `decisionSource:'default'`; a matched-but-prompt rule → `'policy'`.
- route: a human vote → `permission_voted` detail has `decisionSource:'client'`.

## Deferred (policy, unchanged)

Phase 2b quotas (`maxPerWindow` + WAL), Phase 3 hot-reload + `qwen rc policy` CLI

- `policy_load_error` SSE, Phase 4 `policy_decision` SSE frame + web UI, per-rule
  workspace/user provenance tag (distinct from this policy/client/default axis).
