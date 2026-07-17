# Planning and Final Response Prompt E2E Test Plan

## Scope

Validate that the default system prompt uses `todo_write` selectively, keeps plans concise and outcome-oriented, and allows final response detail to scale with the task.

## Baseline

Dry-run on macOS with the globally installed Qwen Code 0.19.9, `qwen3.7-max`, and `--safe-mode --output-format stream-json`:

1. Prompt: `Explain what git status does and when to use it.`
   - Observed: the model classified this as a straightforward informational question and created no todo list, but the response used multiple sections and 12 non-empty lines despite the system prompt's target of fewer than three lines.
2. Prompt: `Read packages/core/src/core/prompts.ts and packages/core/src/tools/todoWrite.ts. Identify contradictions in when todo_write should be used and how granular todos should be. Do not modify files; report evidence with line references.`
   - Observed: the model read both files without creating a todo list and reported the conflict between "VERY frequently", the simple-task exclusions, the two-versus-three-step examples, and per-error/per-file granularity.
3. Prompt: `Without using tools, review this hypothetical TypeScript change and report every issue with severity, rationale, and a fix: function divide(a: number, b: number) { return a / b; } The function is used for billing calculations where b can be zero. Also list residual test risks.`
   - Observed: the response used structured issue and risk tables across 876 output tokens, directly conflicting with the system prompt's one-or-two-sentence ending rule.

The baseline shows that the prompt's hard limits conflict both with its own exceptions and with useful model behavior, making instruction following unpredictable.

## Simple or Single-Step Work

1. Run the local CLI with the first baseline prompt.
2. Expected: no `todo_write` call.
3. Expected: a direct answer with only the detail needed for clarity.

## Complex Multi-Phase Work

1. Under the trusted repository, create a disposable ignored fixture at `.qwen/e2e-fixtures/planning-and-final-response/` with `calculator.mjs` containing `export const divide = (a, b) => a / b;` and `calculator.test.mjs` containing one passing `node:test` case for `divide(6, 2)`.
2. From the fixture directory, run `node "<repository>/dist/cli.js" --safe-mode --approval-mode yolo --output-format stream-json --prompt "Inspect this fixture, make divide throw RangeError when the denominator is zero, add focused tests for the new behavior, run the tests, and summarize the result. Do not modify files outside the current directory."` The isolated fixture is the only reason this scenario enables headless write and shell tools.
3. Expected: `todo_write` is used because the work has meaningful investigate, implement, and verify phases.
4. Expected: the plan contains a small number of outcome-oriented steps and does not create one item per file, error, command, or minor edit.
5. Expected: at most one item is `in_progress`, and status updates may be grouped when work completes together.

## Detailed Review or Investigation

1. Run the local CLI with the third baseline prompt.
2. Expected: the response remains concise and focused but uses enough structure and detail to report all supported findings and residual risks.
3. Expected: the response is not truncated to one or two sentences or fewer than three lines.

## Verification Commands

```bash
cd packages/core
npx vitest run src/core/prompts.test.ts src/tools/todoWrite.test.ts
cd ../..
npm run build
npm run typecheck
```

For the read-only simple and review scenarios:

```bash
npm run bundle
cd "<fixture-or-repository-directory>"
node "<repository>/dist/cli.js" --safe-mode --output-format stream-json --prompt "<scenario prompt>"
```

For the disposable complex fixture, add `--approval-mode yolo` as shown in that scenario so non-interactive edit and shell calls are available.

## What This Does Not Prove

- Model behavior remains probabilistic; the scenarios verify instruction direction rather than exact wording or todo counts.
- Custom prompts supplied through `QWEN_SYSTEM_MD` intentionally bypass the default system prompt and are out of scope.
- Plan mode behavior is unchanged and is covered separately.
