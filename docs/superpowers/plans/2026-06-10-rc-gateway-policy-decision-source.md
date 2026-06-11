# Plan — audit `decisionSource` (cycle 39)

See design: `../specs/2026-06-10-rc-gateway-policy-decision-source-design.md`.

TDD, fail-safe commit order. All commands from repo root, absolute paths.

## Commit 1 — docs

## Commit 2 — evaluator `source` field + tests

`policy/evaluator.ts`: `PolicyDecision` += `source: 'policy' | 'default'`.

- Unevaluable→downgrade return (~208): `source: 'policy'`.
- Matched-rule return (~216): `source: 'policy'`.
- Default fall-through return (~225): `source: 'default'`.

Tests (`evaluator.test.ts`): matched → `'policy'`; no-match → `'default'`;
unevaluable-downgrade → `'policy'`.

Verify: `npx vitest run --root packages/rc-gateway src/policy/evaluator.test.ts`.

## Commit 3 — enforcer + permission route audit stamping + tests

`policy/enforcer.ts`: add `decisionSource: d.source` to all three
`policy_decision` audit details.
`routes/permission.ts`: add `decisionSource: 'client'` to the `permission_voted`
audit detail.

Tests: enforcer allow/deny → `decisionSource:'policy'`; no-match prompt →
`'default'`; route vote → `'client'`.

## Verify (repo root)

```
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
npm run test --workspace @qwen-code/rc-gateway
node scripts/rc-gateway-e2e.mjs
```

## Review → fix → push → memory

opus review on `git diff b2252499d..HEAD -- packages/rc-gateway/`; fix; push;
update both memory files.
