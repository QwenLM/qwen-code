# rc-gateway — workspace `policy.yaml` override (cycle 38)

## Context

`add-policy-engine` spec (`specs/policy-engine/spec.md:7-23, 93-101`): the engine
loads `~/.qwen/rc/policy.yaml` then `<workspace>/.qwen/policy.yaml`, the workspace
file's rules layered so they OVERRIDE user rules of equal specificity. The
normative scenario: user rule `safe-tests` (action `prompt`) + a workspace rule
with the SAME match block (action `allow`) → the workspace rule wins, and the
decision audit records the workspace rule's id.

Cycle 13/14/22 shipped the user-level policy (loader + evaluator + enforcer
auto-vote + Phase-2a time conditions); cycle 14 explicitly deferred the workspace
merge. This is the symmetric counterpart to cycle 36's routing workspace override.

## Deviation from the daemon-centric spec

Daemon-centric spec → delivered gateway-side: cli.ts merges the two files at boot
and hands the merged `Policy` to the existing `PolicyEnforcer`. No upstream edit.

## Decisions

- **D1 — PREPEND workspace rules; ZERO evaluator change (and a documented
  spec-reconciliation).** Our evaluator (cycle 13, `evaluator.ts:182-193`) sorts
  `(priority desc, specificity desc, index ASC)` — i.e. on a full tie, the
  EARLIER-index rule wins. To make the workspace rule win an equal-specificity tie
  (the spec's normative scenario), the merged array is `[...workspace.rules,
...user.rules]` so workspace rules get the lower indices. **NOTE: the spec's
  prose says workspace rules are "appended after"; but its own precedence text
  ("source order, earlier wins, workspace considered later") would then make USER
  win — contradicting the override scenario. The SCENARIO is the normative truth
  and matches the feature's purpose ("so its rules can override"), so we deliver
  workspace-overrides via prepend. Array position is an implementation detail given
  our earlier-wins tiebreak; the observable — workspace wins at equal specificity —
  matches the scenario exactly.** Changing the evaluator tiebreak to "later wins"
  - literal append was rejected: it ripples to shipped cycle-13/22 behavior
    (user-only same-specificity order would flip) for no observable gain.
- **D2 — `mergePolicies(workspace, user)` is pure.** `workspace === null` →
  returns `user` unchanged (no workspace file → today's behavior byte-identical).
  Else `{ defaults: user.defaults, rules: [...workspace.rules, ...user.rules] }`.
- **D3 — Workspace `defaults` block is IGNORED (only its RULES merge).** The
  default action stays the user file's (or the built-in prompt). This is the
  fail-closed choice: a workspace file cannot silently flip the GLOBAL fallback to
  `allow` for every unmatched tool call — it can only add targeted rules a reader
  can see. (A workspace allow still overrides via a matching rule, which is the
  intended, auditable surface; a blanket default flip is not.)
- **D4 — Per-file fail handling matches policy's fail-CLOSED posture.** A malformed
  WORKSPACE `policy.yaml` (`PolicyError`) is logged and IGNORED — keep the user
  policy (the more-restrictive layer), never apply unparseable `allow`s, never
  crash boot. A malformed USER file keeps cycle-14's behavior UNCHANGED (the
  loader throws → boot fails) — out of scope to soften here. So
  `loadLayeredPolicy` throws ONLY on a malformed user file (preserving current
  behavior); the workspace layer never throws.
- **D5 — Workspace cwd resolved ONCE at boot, shared with cycle-36 routing.**
  cli.ts already resolves `workspaceCwd` via `daemon.capabilities()` (caught) for
  the routing override; reuse that same value for policy — no second
  `capabilities()` call. A failure → no workspace layer (user policy only).
- **D6 — Existing safety is preserved; workspace supremacy is intended.** The
  evaluator is untouched, so the deferred-field downgrade-to-prompt (cycle 13/22),
  the `selectAllowOnceOptionId` guarantee (cycle 14 — auto-votes `allow_once`,
  NEVER `allow_always`), and the fail-closed default all still apply to merged
  rules. **Precisely: a user `deny` beats only a LESS-specific or LOWER-priority
  workspace `allow`. At equal specificity AND equal-or-higher priority the
  workspace rule wins — INCLUDING over a user `deny` (prepend → lower index →
  earlier-wins tiebreak). There is NO user rule unconditionally safe from a
  workspace file; that is workspace supremacy, the spec's intent, and the trust
  model below is the mitigation — not any in-engine guarantee.**

## Trust model (security)

A workspace `<cwd>/.qwen/policy.yaml` CAN auto-approve tool calls a user policy
would have prompted — OR denied — this is the spec's explicit intent
(operator-managed config, "same lifecycle"). The trust assumption, stated plainly:
the workspace policy file is trusted exactly as the daemon trusts the workspace
cwd it was launched in. An operator who does not trust a repo should not run an
auto-approving gateway inside it. The widening is real (workspace supremacy at
equal specificity+priority, over user `prompt` AND user `deny`) but mitigated:
auto-votes remain one-time (`allow_once`, never a standing grant); a deferred
condition still downgrades to prompt; and the audit records the winning rule's id
(cycle-14 `policy_decision{ruleId}`), so a workspace-rule auto-approval is
attributable after the fact. The mitigation is the trust boundary + auditability,
NOT any in-engine cap on what a workspace rule may override.

## Safety / fail-safe

- Runtime hot path (enforcer/evaluator/auto-vote) UNCHANGED — it still receives a
  single `Policy`. Only the BOOT construction of that policy changes.
- `mergePolicies` is pure; `loadLayeredPolicy` throws only on a malformed user
  file (today's behavior); the workspace layer + `capabilities()` are caught.
- Fail-safe commit order: docs → pure `mergePolicies` + `loadLayeredPolicy`
  (exported, INERT — cli still uses the old single-load) + unit tests + barrel →
  cli.ts wiring LAST (boot-only).

## Tests

- `mergePolicies`: workspace null → returns user (identity); both → workspace
  rules first; user `defaults` retained, workspace `defaults` ignored.
- `loadLayeredPolicy` (temp files): neither workspace file → user policy;
  workspace `allow` + user `prompt` SAME match → compiled `evaluate` returns
  `allow` with the WORKSPACE rule id (the spec scenario, end-to-end through the
  real evaluator); a MORE-specific user `deny` still wins over a broad workspace
  `allow`; **workspace supremacy: workspace `allow` overrides a user `deny` at
  EQUAL specificity+priority → `allow`** (the sharp edge, pinned executably);
  malformed workspace → logged + ignored, user policy intact; malformed user →
  throws (behavior preserved); absent user file → default-prompt policy.

## Deferred (policy, unchanged)

Phase 2b quotas (`maxPerWindow` counter + WAL), Phase 3 hot-reload (250 ms
debounce) + `qwen rc policy` CLI + `policy_load_error` SSE, Phase 4
`policy_decision` SSE frame + web UI, per-rule `decision_source`
(workspace/user) audit tag.
