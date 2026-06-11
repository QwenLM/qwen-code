# Plan — `qwen rc policy explain` (cycle 44)

Spec: `docs/superpowers/specs/2026-06-11-rc-gateway-policy-explain-design.md`

## Commit order (fail-safe: pure logic first, CLI glue last)

### Commit 1 — evaluator internals refactor + `explainPolicy` (PURE, inert)

- `policy/evaluator.ts`:
  - Extract `orderedRuleIndices(policy): number[]` from `evaluate()`; have
    `evaluate()` call it. (behavior-preserving)
  - Add `matchReason(rule, ctx, argString, paths): string | null`; rewrite
    `ruleMatches` as `matchReason(...) === null`.
  - Add `classifyConditionsDetailed(rule, now, quota?): { kind, reason }`;
    rewrite `classifyConditions` as `classifyConditionsDetailed(...).kind`.
  - Add types `RuleTrace`, `PolicyExplanation`, and `explainPolicy(policy,
ctx, now=new Date(), quota?)`.
- Barrel `policy/index.ts`: export `explainPolicy`, `RuleTrace`,
  `PolicyExplanation`.
- Tests `policy/explain.test.ts` (the explainPolicy half):
  - trace lists rules in evaluation order; winner is `matched`, later rules
    `not-reached`.
  - `decision` equals `evaluate()` and matches the winning trace entry
    (id + action).
  - skipped reasons: tool-mismatch, args-mismatch, path-mismatch,
    no-path-candidates, origin-scope-mismatch, session-tag-mismatch.
  - condition no-match: expired, outside-time-window, quota-exhausted
    (with an injected oracle).
  - unevaluable: maxPerWindow with no oracle → matched/prompt/downgraded,
    reason `quota-not-evaluated`; malformed expiresAt → downgraded.
  - no rule matches → empty-of-winner trace, decision source `default`.
- VERIFY existing `evaluator*.test.ts` still pass unchanged.

### Commit 2 — CLI input/render helpers (PURE)

- `policy/explain.ts`: `parseExplainArgs(argv): { tool?: string; ctx:
ToolCallContext }` and `formatExplanation(exp): string`.
- Barrel exports.
- Tests `policy/explainArgs.test.ts`:
  - positional tool; `--args="npm test"` → string; `--args={...}` JSON →
    object; `--path=` populates a path candidate; `--scope`/`--tag` map;
    missing tool → `tool` undefined; unknown flags ignored.
  - `formatExplanation`: MATCHED/SKIPPED/not-reached lines in order; final
    `decision:` line with source+rule; quota caveat appears iff a
    maxPerWindow rule is present; default-source rendering.

### Commit 3 — wire the CLI branch (glue, smoke-tested)

- `cli.ts`: `else if (argv[2]==='policy' && argv[3]==='explain')`:
  parse argv.slice(4); if no tool → usage, exit 2; else
  `loadLayeredPolicy(userPath, process.cwd(), warn)` in a try/catch
  (catch → print error, exit 1); `explainPolicy(policy, ctx)`;
  print `formatExplanation`; exit 0.
- Reuse the existing `homedir()/.qwen/rc/policy.yaml` user path.

## Verify

- typecheck + lint + build + test (`@qwen-code/rc-gateway`).
- e2e (`scripts/rc-gateway-e2e.mjs`) — unchanged, must stay 39/39.
- Build + smoke the real CLI:
  - `node dist/cli.js policy explain` → usage, exit 2.
  - `node dist/cli.js policy explain bash --args="npm test"` against a temp
    policy → MATCHED path + decision, exit 0.
  - malformed temp policy → error, exit 1.

## Review + close

- opus adversarial review on the cycle diff (ignore foreign out-of-boundary
  edits; point it at the evaluator refactor — the one place behavior could
  silently drift).
- Update both memory files.
