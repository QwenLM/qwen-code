# Remote-Control Gateway — Policy Engine Part 1: Loader + Evaluator (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 13)
**Scope:** The pure, side-effect-free core of the policy engine — a YAML rule-file
loader/validator and a specificity-ordered evaluator that maps a proposed tool call
to `allow` / `deny` / `prompt`. **Part 1 of `add-policy-engine`.** No integration
yet (the gateway auto-vote wiring is cycle 14).

## Relationship to the proposal / deviation

`add-policy-engine`'s `design.md` runs the evaluator **inside the daemon's
permission handler**, synchronously before the `permission_request` SSE emit, so a
matched rule means the prompt never reaches clients. We **deviate** (zero upstream
edits): the gateway already observes `permission_request` events on its pumped SSE
(cycle 10). In **cycle 14** the gateway will evaluate policy on each such event and
**auto-vote** via the cycle-6 path (`allow`→selected, `deny`→cancelled),
suppressing the push for auto-handled calls. The difference vs the daemon design:
the prompt is emitted then resolved a beat later (clients may flash an approval card
that auto-resolves), rather than never emitted. Same security outcome; documented
timing difference.

**This cycle ships only the pure functions** — loader + evaluator — so they can be
exhaustively unit-tested before the integration cycle wires them to live events.

## This cycle's scope (and deferrals)

**In:** YAML loader + schema validation; specificity-ordered first-match evaluator
matching on `tool` (glob), `argsGlob` (glob list), `pathGlob` (glob list),
`originScope` (exact), `sessionTag` (exact); actions `allow`/`deny`/`prompt` with
`requireScope` and `reason`; `defaults`; `priority`.

**Deferred:** `timeOfDay` and `expiresAt` evaluation + `maxPerWindow` quotas
(proposal Phase 2 — needs an injected clock + stateful counters → a later cycle);
hot-reload + `qwen rc policy` CLI (Phase 3); workspace+user file MERGE and the
gateway integration/auto-vote/`policy_decision` audit+SSE (cycle 14); web UI
(Phase 4). The loader parses but **ignores** the deferred match fields and rule
fields for now (it does not reject them — forward-compat), and the evaluator skips
rules whose ONLY distinguishing match is a deferred field? No — see Decisions.

## Decisions

1. **`yaml@^2.8.1`** (added as a gateway dep, bundled types) parses the file.
2. **Defensive schema validation.** `loadPolicy(text)` parses YAML then validates:
   top-level `{version?, defaults?, rules?}`; each rule `{id?, match, action}` where
   `action ∈ {allow,deny,prompt}` and `match` is an object. Unknown fields are
   **ignored** (forward-compat). A rule missing `action` or with an invalid action,
   or a non-object `match`, makes the whole load **throw** a `PolicyError` (the
   cycle-14 caller will catch and keep the previous policy). `loadPolicyFile(path)`
   returns `null` if the file is absent (→ pure default-prompt behavior), else
   `loadPolicy(contents)`.
3. **Deferred match fields are treated as NON-matching gates this cycle, except
   they don't break specificity.** Concretely: if a rule's `match` contains
   `timeOfDay`/`expiresAt`/`maxPerWindow`, the evaluator **ignores those fields for
   matching** (treats them as "satisfied") but still counts their specificity
   weight. Rationale: until cycle 14 adds the clock/quota, honoring them is
   impossible; ignoring-as-satisfied is the safe MVP (a time-gated `prompt` rule
   still prompts; a time-gated `allow` would allow regardless of time — so the
   loader emits a one-line `console.warn` when it loads a rule using a deferred
   field, and the evaluator's `Decision` carries `usedDeferredField: true` so cycle
   14 / callers can refuse to auto-allow on such rules). **Safety guard:** the
   evaluator will DOWNGRADE an `allow`/`deny` decision to `prompt` if the matched
   rule used a deferred field (so we never auto-allow based on an unevaluated
   time/quota constraint). This keeps the MVP safe.
4. **Glob → RegExp.** A small `globToRegExp(glob)`: escape regex metacharacters,
   then `*`→`.*` (single star; `**` collapses to the same `.*` for MVP — documented).
   Anchored full-match (`^…$`). `argsGlob` matches against a whitespace-collapsed
   canonical arg string; `pathGlob` matches against `args.path`/`args.cwd`/any of
   `args.files[]`.
5. **Specificity + priority ordering** (from the proposal): weight = tool(explicit
   name 100 / glob-without-`*` 90 / `*` 10) + argsGlob 30 + pathGlob 30 +
   originScope 20 + timeOfDay 20 + sessionTag 20. Sort rules by `(priority desc,
weight desc, original-index asc)`; first match wins. No match → `defaults`
   (`action` default `prompt`, `requireScope` default `approve`).

## Components

### Types + loader (`src/policy/loader.ts`)

```ts
export interface PolicyRuleMatch {
  tool?: string;
  argsGlob?: string | string[];
  pathGlob?: string | string[];
  originScope?: string;
  sessionTag?: string;
  // deferred (parsed, not evaluated this cycle):
  timeOfDay?: unknown;
}
export interface PolicyRule {
  id?: string;
  match: PolicyRuleMatch;
  action: 'allow' | 'deny' | 'prompt';
  requireScope?: string;
  reason?: string;
  priority?: number;
  // deferred:
  maxPerWindow?: unknown;
  expiresAt?: unknown;
}
export interface Policy {
  version?: number;
  defaults: { action: 'allow' | 'deny' | 'prompt'; requireScope?: string };
  rules: PolicyRule[];
}
export class PolicyError extends Error {}
export function loadPolicy(text: string): Policy; // throws PolicyError on invalid
export function loadPolicyFile(path: string): Promise<Policy | null>; // null if absent
```

`defaults` fills in `{ action:'prompt', requireScope:'approve' }` when omitted.

### Evaluator (`src/policy/evaluator.ts`)

```ts
export interface ToolCallContext {
  tool: string;
  args?: unknown; // canonicalized internally for argsGlob/pathGlob
  originScope?: string;
  sessionTag?: string;
}
export interface PolicyDecision {
  action: 'allow' | 'deny' | 'prompt';
  ruleId?: string; // undefined for the default
  requireScope?: string; // for prompt
  reason?: string; // for deny
  usedDeferredField: boolean;
}
export function evaluate(policy: Policy, ctx: ToolCallContext): PolicyDecision;
```

- Build the canonical arg string (whitespace-collapsed JSON-or-string of `args`)
  and the candidate path set once.
- Order rules by `(priority desc, specificity desc, index asc)`.
- First rule whose AND-combined match holds → its decision; **if that rule used a
  deferred match/quota field AND its action is allow/deny, downgrade to `prompt`**
  (with `usedDeferredField:true`, `requireScope` from the rule or defaults). Else
  return the rule's action.
- No match → `{ action: defaults.action, requireScope: defaults.requireScope,
usedDeferredField:false }`.

### Glob util (`src/policy/glob.ts`)

`globToRegExp(glob: string): RegExp` and `matchesAny(globs: string|string[]|undefined,
value: string): boolean` (undefined globs → treated as matching/absent per the
evaluator's AND logic — i.e., a missing match field doesn't constrain).

## Testing strategy (TDD)

**`glob.test.ts`:** `npm test*` matches `npm test -- --watch`, not `pnpm test`;
metachars escaped (`a.b` doesn't match `axb`); `*` matches empty; `src/auth/**`
matches `src/auth/login.ts`.

**`loader.test.ts`:** valid YAML → Policy with defaults filled; missing `action` →
PolicyError; invalid action → PolicyError; unknown top-level/rule field ignored
(no throw); `loadPolicyFile` of a missing path → null; of a temp file → parsed.

**`evaluator.test.ts`:**

- allow rule (`tool:bash, argsGlob:'npm test*'`) → `npm test` ctx → `allow` with
  ruleId; `npm publish` → falls through to default `prompt`.
- deny rule (`argsGlob:'git push --force*'`) → matches → `deny` with reason.
- prompt rule with `requireScope:owner` → `prompt` + requireScope owner.
- specificity: an explicit-tool allow rule beats a `tool:'*'` prompt rule when both
  match (ordering); `priority` overrides specificity.
- pathGlob: `edit_file` with `args.path:'src/auth/x.ts'` matches `src/auth/**`.
- **deferred-field safety:** a rule with `match.timeOfDay` + `action:allow` that
  otherwise matches → decision DOWNGRADED to `prompt`, `usedDeferredField:true`.
- no rules / empty policy → default prompt.

## File boundary

All within `packages/rc-gateway/`. New: `src/policy/loader.ts`,
`src/policy/evaluator.ts`, `src/policy/glob.ts` (+ tests). Modified: `src/index.ts`
(exports), `package.json` (yaml dep — already added). No server/cli wiring, no audit
changes this cycle. Zero upstream edits.

## Follow-on

Cycle 14: integrate into the `SessionEventPump` — on a `permission_request` event,
`evaluate(policy, ctx)`; `allow`→auto-vote `selected`(options[0].optionId),
`deny`→auto-vote `cancelled`, `prompt`→fall through to the notifier (push); add a
`policy_decision` audit action; load `~/.qwen/rc/policy.yaml` (+ workspace merge) at
boot with the catch-keep-previous contract. Later cycles: timeOfDay/expiresAt +
quotas (Phase 2), hot-reload + `qwen rc policy` CLI (Phase 3), web UI (Phase 4).
