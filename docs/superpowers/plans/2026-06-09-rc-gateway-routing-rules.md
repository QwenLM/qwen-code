# Plan — rc-gateway notification routing rules (cycle 25)

Design: `docs/superpowers/specs/2026-06-09-rc-gateway-routing-rules-design.md`.

**Branch:** `add-remote-control-spec` — stay on it. Run all git/npm from repo
root `/home/evan/projects/qwen-code` with absolute paths. No `--no-verify`.
NodeNext ESM `.js` extensions. No `any` (read YAML fields defensively, mirror
`policy/loader.ts`). License header on every new `src/*.ts`. Commits end with
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

Done directly (no implementer subagent). **Fail-safe commit order: the pure
module + tests are commits 1–2 (inert, unimported); the wiring is the LAST
commit.** Reuse `globMatch`/`matchesAny` from `policy/glob.ts` — do NOT write a
new matcher. Mirror `policy/loader.ts` for the YAML validation style.

## Task 1 — `routing/rules.ts` + tests (pure, inert)

New `src/routing/rules.ts`:

```ts
export interface RoutingRuleMatch {
  kind?: string | string[];
  sessionTag?: string | string[];
}
export interface RoutingRule {
  id?: string;
  match: RoutingRuleMatch;
  route: { drop?: boolean };
}
export interface RoutingConfig {
  version?: number;
  rules: RoutingRule[];
}
export class RoutingError extends Error {
  /* name='RoutingError' */
}
export interface RoutingMatcher {
  firstDrop(ev: { kind: string; sessionName?: string }): string | null;
}
export function loadRoutingConfig(text: string): RoutingConfig;
export async function loadRoutingConfigFile(
  path: string,
): Promise<RoutingConfig | null>; // ENOENT→null
export function compileRouting(config: RoutingConfig): RoutingMatcher;
```

- `loadRoutingConfig`: `parse(text) ?? {}`; doc must be a plain object else
  RoutingError; `rules` defaults to `[]`, must be a sequence; each rule must be
  a mapping with an object `match` and an object `route`; `match.kind` if present
  must be string or string[] (else RoutingError); `match.sessionTag` likewise;
  `route.drop` if present must be boolean. Unknown fields ignored. Keep `id`
  (String()) and `version` (if number). **Deferred-field warn-once** (module
  `let warnedDeferred=false`, mirror policy loader): fire a single `console.warn`
  if any rule's `match` has keys other than `kind`/`sessionTag` OR `route` has
  keys other than `drop` — message names the unhonored fields.
- `loadRoutingConfigFile`: readFile; ENOENT→null; else delegate (may throw).
- `compileRouting`: precompute `dropRules = rules.filter(r => r.route.drop === true)`.
  `firstDrop(ev)` returns the first dropRule whose `matchKind(rule.match.kind, ev.kind)`
  AND `matchSessionTag(rule.match.sessionTag, ev.sessionName)` both hold, returning
  `rule.id ?? '<unnamed>'`; else null.
  - `matchKind(spec, kind)`: undefined→true; string→`spec===kind`; array→`spec.includes(kind)`.
  - `matchSessionTag(spec, name)`: undefined→true; else if `name===undefined`→false;
    else `matchesAny(spec, name)` (from `policy/glob.js`).

Tests `routing/rules.test.ts`:

- loader: valid doc → config; `{}`/empty → `{rules:[]}`; non-object doc → RoutingError;
  `rules` not a sequence → RoutingError; rule without object `match` or `route` →
  RoutingError; `match.kind` a number → RoutingError; `route.drop` a string →
  RoutingError; unknown top-level/rule fields ignored. Deferred warn: a rule with
  `match.policy` or `route.urgency` triggers ONE console.warn (spy; use
  `vi.resetModules()` + dynamic import to defeat the module latch, as cycle 22
  did for the policy loader); a clean drop-only doc triggers none.
- `loadRoutingConfigFile`: absent path → null (write to a tmpdir, point at a
  missing file); present malformed → rejects RoutingError.
- evaluator (`compileRouting(...).firstDrop`): kind equality / list-membership /
  absent-matches-any; sessionTag glob (`*scratch*`) / list / absent; sessionTag
  present but `sessionName` undefined → null (no drop); first-matching-drop
  rule's id returned; a rule with `route:{}` (no drop) never suppresses; unnamed
  drop rule → `'<unnamed>'`.

Commits:

- `test(rc-gateway): routing rules loader + evaluator`
- `feat(rc-gateway): routing.yaml drop-rule loader + matcher (inert)`

## Task 2 — wire the drop gate into the notifier (LAST — the only behavior change)

`src/webpush/notifier.ts`:

- Import `type { RoutingMatcher } from '../routing/rules.js'`.
- Add a 7th ctor param `private readonly routing?: RoutingMatcher` (after
  `workingDevice`).
- In `notify()`, immediately AFTER the snooze suppression block and BEFORE
  `const need = KIND_SCOPE[...]`:
  ```ts
  const dropRuleId = this.routing?.firstDrop({
    kind: payload.kind,
    sessionName: ctx.sessionName,
  });
  if (dropRuleId) {
    void this.audit?.record({
      action: 'push_suppressed',
      target: ctx.sessionId,
      detail: {
        kind: payload.kind,
        reason: 'routing_rule',
        ruleId: dropRuleId,
      },
    });
    return;
  }
  ```
- `notifyToken` unchanged (NOT gated).

`src/server.ts`:

- `GatewayDeps`: add `/** Compiled routing matcher; notifier drop-gating wires only when set. */ routing?: RoutingMatcher;` (import the type).
- Thread `deps.routing` as the 7th arg of `new PushNotifier(...)` (after `workingDevice`).

`src/cli.ts` (fail-OPEN load):

- After the snooze open, before `createGatewayApp`:
  ```ts
  let routing; // RoutingMatcher | undefined
  try {
    const cfg = await loadRoutingConfigFile(
      join(homedir(), '.qwen', 'rc', 'routing.yaml'),
    );
    routing = cfg ? compileRouting(cfg) : undefined;
  } catch (err) {
    console.warn(`[routing] ignoring routing.yaml: ${(err as Error).message}`);
    routing = undefined;
  }
  ```
  Pass `routing` in the `createGatewayApp({...})` deps. Track rule count for the
  banner (e.g. compute `cfg?.rules.length`); add a banner line
  `routing: ${n} rule(s)` / `none`.

`src/index.ts`: export `loadRoutingConfig`, `loadRoutingConfigFile`,
`compileRouting`, `RoutingError`, and the `RoutingRule`/`RoutingConfig`/
`RoutingMatcher` types.

Tests `src/webpush/notifier.test.ts` (extend): with a stub `RoutingMatcher`
returning a ruleId for a given kind → `notify` makes NO `sender.send` call and
records `push_suppressed{reason:'routing_rule', ruleId}`; with a matcher
returning null → delivery unchanged (existing scope fan-out still sends);
`notifyToken` ignores routing. Confirm the drop gate is AFTER snooze (a snoozed
event still audits `reason:'snoozed'`, not routing_rule).

Commit: `feat(rc-gateway): notifier honors routing drop rules (suppress fan-out)`.

## Task 3 — verification sweep (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

e2e: should stay green; the notifier isn't exercised headlessly (no model turn),
so unit coverage is authoritative. Confirm `git diff --name-only <cycle-start>..HEAD`
lists only `packages/rc-gateway/src/{routing/rules.ts,routing/rules.test.ts,
webpush/notifier.ts,webpush/notifier.test.ts,server.ts,cli.ts,index.ts}` + the
two docs.

## Then

opus adversarial review on the cycle diff → apply fixes → push → update both
memory files (architecture changelog + tracker #5 status).
