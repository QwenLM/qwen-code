# Design — policy-decision "why" (P4)

**Goal:** Let a remote owner see _why_ the policy engine auto-decided a
tool call — at a glance on the live decision feed, and in full on demand —
without a shell on the workstation.

**Scope:** Entirely inside `packages/rc-gateway/`. No daemon change
(`packages/cli/src/serve`, `packages/core` untouched). P4 of the
permissions arc (P3 was remote approval-mode).

## Background: what already exists

**Two distinct `policy_decision` records.** Do not conflate them:

1. **Daemon SSE event** `policy_decision` on `GET /session/:id/events` —
   `{ ruleId, action, toolCall, reason, matchedAt, quotaRemaining? }`,
   owned by `add-policy-engine`. Emitted by the daemon. **Out of scope,
   untouched.**
2. **rc-gateway audit action** `policy_decision` — written by
   `packages/rc-gateway/src/policy/enforcer.ts` when the gateway enforcer
   auto-votes a permission request on the owner's behalf. Detail today:
   `{ requestId, action, ruleId?, voted, decisionSource, quotaRemaining? }`
   — metadata-only, streams live on the owner-only audit feed
   (`GET /rc/events`). **This is Component A's target.**

**The enforcer's decision state.** `enforcer.ts` calls
`evaluate(policy, ctx, now, oracle)` → `PolicyDecision { action, source:
'policy'|'default', ruleId?, requireScope?, reason?, usedDeferredField }`.
It writes the audit record at five sites: an eval-error catch branch
(no `PolicyDecision` in scope), an allow branch (voted / not-voted, with
optional quota consume), a deny branch (voted / not-voted), and a prompt
fall-through. The record already carries `action`, `decisionSource`
(= `source`), `ruleId`, and `quotaRemaining?`.

**`explainPolicy`.** The evaluator also exports
`explainPolicy(policy, ctx, now, quota): { decision, trace: RuleTrace[] }`
— the authoritative decision plus a per-rule trace. `RuleTrace` =
`{ index, id?, status, reason (token), action?, downgraded?,
quotaNotEvaluated? }`. It backs the local `qwen rc policy explain` CLI.
The gateway enforcer holds one policy (`this.policy`, swappable for
hot-reload) anchored to one project root via `projectRootFn` — so
evaluation is **gateway-global**, not per-session.

## Component A — Compact decision `reason` on the audit record

Add a single closed-enum `reason` field to the `policy_decision` audit
detail, derived at each audit site from state the enforcer already holds.
The existing fields (`action`, `decisionSource`, `ruleId`,
`quotaRemaining`) are unchanged; `reason` is purely additive.

**Vocabulary and site mapping** (all site-derivable — no trace recompute):

| Site / state                                  | `reason`                   |
| --------------------------------------------- | -------------------------- |
| eval-error catch branch (no `PolicyDecision`) | `eval-error`               |
| `source === 'default'` (any resulting action) | `default`                  |
| `source === 'policy'` and `usedDeferredField` | `rule-downgraded-deferred` |
| `source === 'policy'`, action `allow`         | `rule-allow`               |
| `source === 'policy'`, action `deny`          | `rule-deny`                |
| `source === 'policy'`, action `prompt`        | `rule-prompt`              |

**Why this is the right cut.** The two cases P4 exists for are invisible
today and a boolean cannot fix both:

- `eval-error` vs `default`: the catch branch emits `action:'prompt',
decisionSource:'default'` — byte-identical to a real no-match. There is
  no `PolicyDecision` in that branch, so only a distinct token (not a
  `usedDeferredField` boolean) can disambiguate it.
- `rule-downgraded-deferred` vs `rule-prompt`: surfaces the
  `usedDeferredField` distinction (matched-but-unevaluable-condition)
  through the same token, rather than as a second field.

**Explicit A/B boundary.** Near-miss causes on which a rule _falls through_
to the default — `quota-exhausted`, `expired`, `outside-time-window` — are
**not knowable at the audit site**: an exhausted or expired rule yields
`source:'default'`, so the enforcer would have to recompute the full trace
to label them. Putting a trace in every record was the rejected
"full-trace-per-decision" option (audit bloat). Those causes are surfaced
only by Component B's on-demand trace. The audit record stays a lean live
signal; the explain pull is the full picture.

No new SSE event, no new owner-event arm, no new notification kind — the
enriched record rides the owner audit feed the client already receives, so
Component A adds zero new notification noise.

## Component B — Remote policy-explain endpoint

`POST /policy/explain`, **`owner` scope**, gateway-global (no `:id`).

- **Body:** `{ tool, args?, path?, operation?, scope?, tag? }` — the
  simulated call, mirroring the CLI's `parseExplainArgs` inputs. Parsed
  into the evaluator's `ToolCallContext`.
- **Evaluation:** reuse `explainPolicy(this.policy, ctx, now, quota)`
  verbatim — the same function and policy instance the enforcer uses, so a
  dry-run cannot drift from real enforcement.
- **Anchoring:** `ctx.projectRoot` / `ctx.cwd` come from the gateway's own
  `projectRootFn` (what the running gateway would actually match against).
  The body **cannot** override the project root — a caller must not be
  able to move the `pathGlob` anchor.
- **Response:** `200 { decision, trace }` — the `PolicyExplanation`
  verbatim.
- **No daemon call, no mutation.** Pure read.

**Auth rationale.** `owner`, because the ruleset is owner configuration and
the decision feed this complements is already owner-only. The endpoint is
read-only, so no `write` semantics apply; `owner` is the sensitivity gate.

**Metadata safety (the whole-endpoint invariant).** `explainPolicy`'s
output reflects the caller's `path`/`args` only as _classifications_, never
as values: every `RuleTrace.reason` is a closed-enum token
(`tool-mismatch`, `path-mismatch`, `quota-exhausted`, `earlier-rule-won`,
`matched`, …); `RuleTrace.id` and `PolicyDecision.reason`/`ruleId` are
operator-authored config, a different trust category from session input;
all other fields are enums, numbers, or booleans. The simulated `path` and
`args` are consumed for matching and never appear in the response. This is
the same output the CLI already prints to the operator.

## Audit — `policy_explained`

A successful explain writes exactly one `policy_explained` audit row:
`{ tool, decision, ruleId? }` plus the actor token id — records that the
owner probed the policy, never the simulated args/path/scope/tag. `tool`
is a tool identifier (not content), consistent with P3 auditing the `mode`
enum.

## Security invariants

1. Confined to `packages/rc-gateway/`; daemon untouched.
2. `reason` and the explain response carry only ids, enum tokens,
   operator-config strings, and booleans — never session args, paths, or
   prompt text.
3. `/policy/explain` requires `owner`; read-only; no daemon call.
4. The dry-run anchors to the gateway's project root; the body cannot move
   the anchor.
5. `explainPolicy` reuses the enforcer's live policy instance — the dry-run
   cannot diverge from real enforcement.
6. `policy_explained` audit detail is metadata-only.

## Spec artifacts (qwen-code-remote)

Ships as OpenSpec change `add-policy-decision-why` (proposal, design,
tasks, `specs/policy-decision-why/spec.md` — three ADDED requirements:
compact decision reason, remote explain endpoint, policy-explain audit).
Shared-registry footprint is a single **direct** edit — **1 audit-action
row** `policy_explained` in `add-remote-control`'s pairing-auth registry
(no `## MODIFIED` fragment). No new SSE event, no notification kind. The
`policy_decision` `reason` enrichment is specified in this change's own
capability (the gateway enforcer's audit detail is not otherwise
registered).

## Out of scope / follow-ups

- Full per-rule trace on every live decision (rejected — audit bloat).
- Surfacing near-miss tokens (`quota-exhausted`, `expired`,
  `outside-time-window`) on the live record (needs a per-decision trace).
- Any daemon read (the deferred `GET /session/:id/approval-mode`
  precedent).

## Implementation phasing (fork, `packages/rc-gateway`)

- **B — enforcer `reason`.** Add the `reason` field at the five audit
  sites in `enforcer.ts`; unit-test each token including the eval-error
  and deferred-downgrade cases. Security-relevant (audit hygiene).
- **C — explain route.** `routes/policyExplain.ts` +
  `createPolicyExplainRoute`; parse body → `ToolCallContext` (reuse the
  CLI's arg-normalization where practical) → `explainPolicy` → `200`.
  Owner scope, project-root anchoring, no-daemon-call. Security-relevant.
- **D — audit + mount.** `policy_explained` in `auditLog.ts`
  (`AuditAction` + `AUDIT_ACTIONS`); mount in `server.ts` with the
  owner-scope middleware chain; audit row on success.
- **E — integration test.** Real `createGatewayApp`: owner explain → full
  trace, no state mutation; the metadata-safety assertion (no echoed
  path); write-scope → 403.
