# Plan — workspace `policy.yaml` override (cycle 38)

See design: `../specs/2026-06-10-rc-gateway-policy-workspace-override-design.md`.

TDD, fail-safe commit order. All commands from repo root, absolute paths.

## Commit 1 — docs

`docs/superpowers/specs|plans/2026-06-10-rc-gateway-policy-workspace-override*`.

## Commit 2 — pure `mergePolicies` + `loadLayeredPolicy` (INERT) + tests + barrel

`policy/loader.ts`, add + export:

```ts
const DEFAULT_PROMPT_POLICY: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [],
};

/** Prepend workspace rules to user rules (D1: workspace wins equal-specificity
 * ties under the evaluator's earlier-index tiebreak). Keeps USER defaults;
 * workspace `defaults` ignored (D3). workspace null → user unchanged. Pure. */
export function mergePolicies(workspace: Policy | null, user: Policy): Policy;

/** Load the user policy (absent → default-prompt; malformed → THROWS, preserving
 * cycle-14 boot-fail) and, when a workspace cwd is given, the workspace override
 * (malformed → logged via `warn` + ignored, never throws). Merge (workspace
 * prepended). */
export async function loadLayeredPolicy(
  userPath: string,
  workspaceCwd: string | undefined,
  warn?: (msg: string) => void,
): Promise<Policy>;
```

`index.ts`: export `mergePolicies`, `loadLayeredPolicy`.

Tests → `policy/workspaceOverride.test.ts` (temp files + the REAL `evaluate`):

- `mergePolicies`: null → user identity; both → workspace rules first; user
  defaults kept, workspace defaults ignored.
- `loadLayeredPolicy`: neither workspace → user policy; **spec scenario**
  (workspace `allow` + user `prompt`, same match → `evaluate` = allow + workspace
  ruleId); **more-specific user `deny` beats broad workspace `allow`**;
  **supremacy: workspace `allow` over user `deny`, equal specificity+priority →
  allow**; malformed workspace → ignored + warn + user policy intact; malformed
  user → rejects; absent user → default-prompt.

Verify: `npx vitest run --root packages/rc-gateway src/policy/workspaceOverride.test.ts`.

## Commit 3 — wire cli.ts (boot-only) LAST

Reuse the cycle-36 `workspaceCwd` (cli.ts:50, resolved before the policy load).
Replace the inline policy load (cli.ts:76-78) with:

```ts
const policy = await loadLayeredPolicy(
  join(homedir(), '.qwen', 'rc', 'policy.yaml'),
  workspaceCwd,
  // eslint-disable-next-line no-console
  (msg) => console.warn(msg),
);
```

Do NOT wrap in a swallowing catch — the malformed-user throw is current behavior.

## Verify (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

(e2e mounts `createGatewayApp` directly, not `runServe`, so the cli policy-merge
glue is typecheck-verified + loader-unit-tested but not e2e-executed — honesty.)

## Review → fix → push → memory

opus adversarial review on `git diff 2692a67d7..HEAD -- packages/rc-gateway/`;
apply fixes; push; update both memory files.
