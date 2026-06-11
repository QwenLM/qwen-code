# Plan — `qwen-rc policy lint <file>` (cycle 40)

See design: `../specs/2026-06-11-rc-gateway-policy-lint-cli-design.md`.

TDD, fail-safe commit order. All commands from repo root, absolute paths.

## Commit 1 — docs

## Commit 2 — pure `lintPolicyFile` + `formatPolicyLint` (INERT) + tests + barrel

`policy/loader.ts`, add + export:

```ts
export interface PolicyLintResult {
  ok: boolean;
  ruleCount?: number;
  deferred?: string[]; // rule id or [index] using maxPerWindow
  error?: string;
}
export async function lintPolicyFile(path: string): Promise<PolicyLintResult>;
export function formatPolicyLint(path: string, r: PolicyLintResult): string;
```

`lintPolicyFile`: read file (ENOENT → `{ok:false, error:'file not found: <path>'}`,
other read error → `{ok:false, error}`); `loadPolicy(text)` in try/catch
(`PolicyError`/parse → `{ok:false, error: msg}`); valid → scan
`rules.filter(r => r.maxPerWindow !== undefined).map(r => r.id ?? '[i]')` →
`{ok:true, ruleCount, deferred}`. Never throws.

`formatPolicyLint`: ok → `✓ ${path}: valid (${ruleCount} rule(s))` (+ deferred
note when non-empty); !ok → `✖ ${path}: ${error}`.

`index.ts`: export both + `type PolicyLintResult`.

Tests → `policy/lint.test.ts` (temp files): valid, malformed, missing, deferred;
`formatPolicyLint` valid/deferred/invalid strings.

Verify: `npx vitest run --root packages/rc-gateway src/policy/lint.test.ts`.

## Commit 3 — cli.ts argv dispatch LAST

In the entrypoint block (currently `if (process.argv[2] === 'serve')`), add an
`else if (argv[2] === 'policy' && argv[3] === 'lint')` branch: missing
`argv[4]` → `console.error('usage: qwen-rc policy lint <file>')` + exit 2; else
`lintPolicyFile(argv[4]).then(r => { console.log(formatPolicyLint(argv[4], r));
process.exit(r.ok ? 0 : 1); })`. Import the two functions.

## Verify (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

(Manual smoke, optional: `node packages/rc-gateway/dist/cli.js policy lint <tmpfile>`.)

## Review → fix → push → memory

opus review on `git diff 649b462a3..HEAD -- packages/rc-gateway/`; fix; push to
`origin/add-remote-control-spec`; update both memory files. Use explicit
`packages/rc-gateway/` + `docs/` paths in every `git add` (foreign upstream
working-tree changes are present this session and must NOT be committed).
