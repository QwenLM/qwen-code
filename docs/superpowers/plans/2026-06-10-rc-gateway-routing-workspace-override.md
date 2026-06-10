# Plan — workspace `routing.yaml` override (cycle 36)

See design: `../specs/2026-06-10-rc-gateway-routing-workspace-override-design.md`.

TDD, fail-safe commit order. All commands from repo root, absolute paths.

## Commit 1 — docs

`docs/superpowers/specs|plans/2026-06-10-rc-gateway-routing-workspace-override*`.

## Commit 2 — pure merge + layered loader (INERT) + tests + barrel

`routing/rules.ts`, add and export:

```ts
/** Prepend workspace rules to user rules (D1: workspace evaluates first; both
 * active). Returns null only when BOTH are null. Pure. */
export function mergeRoutingConfigs(
  workspace: RoutingConfig | null,
  user: RoutingConfig | null,
): RoutingConfig | null { ... }

/** Load the user file and (if a workspace cwd is given) the workspace override,
 * merge (workspace prepended), and compile. Per-file FAIL-OPEN + never-throw
 * (D4): a malformed file is caught, logged via `warn`, and ignored; the other
 * layer still applies. Returns { matcher: undefined, ruleCount: 0 } when neither
 * file exists. `warn` defaults to a no-op (cli passes a console.warn wrapper). */
export async function loadLayeredRoutingMatcher(
  userPath: string,
  workspaceCwd: string | undefined,
  warn?: (msg: string) => void,
): Promise<{ matcher: RoutingMatcher | undefined; ruleCount: number }> { ... }
```

Internals: a private `loadOneFailOpen(path, label, warn)` wraps
`loadRoutingConfigFile` in try/catch → null on RoutingError (warn the message);
ENOENT already returns null. Workspace path = `join(workspaceCwd, '.qwen',
'routing.yaml')` only when `workspaceCwd` truthy. `mergeRoutingConfigs(workspace,
user)`; null → `{undefined, 0}`; else `{ compileRouting(merged), merged.rules.length }`.

`index.ts`: export `mergeRoutingConfigs`, `loadLayeredRoutingMatcher`.

Tests → new `routing/workspaceOverride.test.ts` (temp dirs, real files):

- `mergeRoutingConfigs` null/null, passthrough, concat-workspace-first, and the
  ORDER PROOF (both match → `compileRouting(merged).firstDrop` returns workspace id).
- `loadLayeredRoutingMatcher`: neither; user-only; workspace-only; both
  (ruleCount sum + workspace-first id); malformed workspace ignored + user
  applies + warn fired; malformed user ignored + workspace applies; both
  malformed → `{undefined,0}`; never-throws. Do NOT assert the deferred-field
  warning (D5 — module-global `warnedDeferred`).

Verify: `npx vitest run --root packages/rc-gateway src/routing/workspaceOverride.test.ts`.

## Commit 3 — wire cli.ts (boot-only) LAST

Replace the inline user-only routing block (`cli.ts:47-64`) with:

- resolve `workspaceCwd` once: `let workspaceCwd; try { workspaceCwd = (await
handle.daemon.capabilities()).workspaceCwd; } catch { /* skip workspace layer */ }`
- `const { matcher: routing, ruleCount: routingRuleCount } =
await loadLayeredRoutingMatcher(userPath, workspaceCwd, (m) => console.warn(m));`
  (with the existing `// eslint-disable-next-line no-console`).

Keep passing `routing` into `createGatewayApp` and the banner `routingRuleCount`.

## Verify (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

## Review → fix → push → memory

opus adversarial review on `git diff 315ef470b..HEAD -- packages/rc-gateway/`;
apply fixes; push to `origin/add-remote-control-spec`; update both memory files.
