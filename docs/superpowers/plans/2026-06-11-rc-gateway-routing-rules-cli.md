# Plan — `qwen-rc routing rules [--resolved]` (cycle 41)

See design: `../specs/2026-06-11-rc-gateway-routing-rules-cli-design.md`.

TDD, fail-safe commit order. All from repo root, absolute paths. Use explicit
`packages/rc-gateway/` + `docs/` paths in every `git add` (foreign upstream
working-tree edits are present this session — never commit them).

## Commit 1 — docs

## Commit 2 — extract shared loader + resolved/format fns (INERT) + tests + barrel

`routing/rules.ts`:

- Extract a private `loadBothRoutingLayers(userPath, workspaceCwd, warn) →
Promise<{ workspace: RoutingConfig | null; user: RoutingConfig | null;
workspacePath?: string }>` from the two `loadOneFailOpen` calls inside
  `loadLayeredRoutingMatcher`; rewrite `loadLayeredRoutingMatcher` to use it.
  **The cycle-36 `workspaceOverride.test.ts` is the ORACLE — it must pass
  byte-identically with ZERO edits. If a cycle-36 test needs changing, the
  extraction changed behavior → stop and fix the extraction.**
- Add + export:
  ```ts
  export interface ResolvedRoutingRule {
    source: string;
    rule: RoutingRule;
  }
  export async function loadResolvedRoutingRules(
    userPath: string,
    workspaceCwd: string | undefined,
    warn?: (m: string) => void,
  ): Promise<ResolvedRoutingRule[]>;
  export function formatResolvedRouting(rules: ResolvedRoutingRule[]): string;
  ```
  `loadResolvedRoutingRules`: `loadBothRoutingLayers` → `[...workspace.rules.map(
r => ({source: workspacePath, rule:r})), ...user.rules.map(r => ({source:
userPath, rule:r}))]`. `formatResolvedRouting`: empty → `(no routing rules)`;
  per rule `source  id  match: <summary>  drop:<bool>`; empty match → `any`;
  id-less → `<unnamed>`.

`index.ts`: export `loadResolvedRoutingRules`, `formatResolvedRouting`,
`type ResolvedRoutingRule`.

Tests → `routing/routingRules.test.ts` (temp files): user-only, both-layers
(workspace first + source paths), malformed-workspace (user still lists + warn),
neither → []; format empty/rule/id-less/empty-match=any.

Verify: `npx vitest run --root packages/rc-gateway src/routing/routingRules.test.ts
src/routing/workspaceOverride.test.ts` (the latter MUST stay green untouched).

## Commit 3 — cli.ts argv dispatch LAST

`else if (process.argv[2] === 'routing' && process.argv[3] === 'rules')`:
`const resolved = process.argv.includes('--resolved');`
`loadResolvedRoutingRules(join(homedir(),'.qwen','rc','routing.yaml'), resolved ?
process.cwd() : undefined, (m)=>console.warn(m)).then(rules => {
console.log(formatResolvedRouting(rules)); process.exit(0); });`
Import the two fns. Smoke-test the built CLI on temp files.

## Verify (repo root)

```
npm run typecheck/lint/build/test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

## Review → fix → push → memory

opus review on `git diff 5d8dbc881..HEAD -- packages/rc-gateway/`; fix; push;
update both memory files. Wrap-up: name the trajectory choice (heavy cycle on
fresh context vs checkpoint) — the light inspector lane is nearly tapped.
