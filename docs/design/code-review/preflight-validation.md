# Preflight Triage Validation Evidence

This document records the real GitHub Actions runs and PR comments used to
validate the PR gate and preflight-triage review workflow on the
`codex/preflight-triage` branch. It is intentionally evidence-oriented; the
design rationale lives in [`preflight-triage.md`](./preflight-triage.md) and
[`../pr-gate-plan.md`](../pr-gate-plan.md).

## Hosted PR Gate And CI Evidence

PR: [#4359](https://github.com/QwenLM/qwen-code/pull/4359)

| Evidence                                | Link                                                                                            | Result                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Qwen Code CI on commit `45b276922`      | [run 26241003840](https://github.com/QwenLM/qwen-code/actions/runs/26241003840)                 | Passed: Lint, CodeQL, macOS/Ubuntu/Windows tests, coverage comment |
| PR Template gate on commit `45b276922`  | [job 77227090790](https://github.com/QwenLM/qwen-code/actions/runs/26241024844/job/77227090790) | Passed on the rewritten PR body                                    |
| PR Size gate on commit `45b276922`      | [job 77227090928](https://github.com/QwenLM/qwen-code/actions/runs/26241024844/job/77227090928) | Failed by design: `oversized-ok` was self-applied by the PR author |
| Final local verification before publish | See [Local Verification](#local-verification)                                                   | Passed on the final staged diff                                    |

The `PR Size` failure is the expected self-waiver guard. The event timeline
shows `oversized-ok` was applied by `@yiliang114` on 2026-05-21T03:35:20Z.
A different maintainer must remove and re-apply the label, or the PR must be
split, before the required size gate can pass.

The local size calculation for #4359 produced:

| Metric                      | Value |
| --------------------------- | ----: |
| Changed files               |    20 |
| Raw changed lines           |  4557 |
| Meaningful changed lines    |  2621 |
| Meaningful files            |    11 |
| Ignored docs/markdown files |     9 |
| Ignored docs/markdown lines |  1936 |

This confirms the size gate is blocking because the PR is genuinely above the
1500 meaningful-line threshold, not because docs-only churn was counted.

## Tier Comment Evidence

These comments prove each tier can produce a PR-visible review comment.

| Tier        | PR    | Evidence comment                                                                                 | First line                                                       |
| ----------- | ----- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| ULTRA_LIGHT | #4356 | [issuecomment-4506096640](https://github.com/QwenLM/qwen-code/pull/4356#issuecomment-4506096640) | `## Qwen Code Review - ULTRA_LIGHT`                              |
| LIGHT       | #4371 | [issuecomment-4505842660](https://github.com/QwenLM/qwen-code/pull/4371#issuecomment-4505842660) | `<!-- tier=LIGHT; status=complete; segments=1; emitted=1 -->`    |
| STANDARD    | #4383 | [issuecomment-4505964471](https://github.com/QwenLM/qwen-code/pull/4383#issuecomment-4505964471) | `<!-- tier=STANDARD; status=complete; segments=1; emitted=1 -->` |
| DEEP        | #4373 | [issuecomment-4506321384](https://github.com/QwenLM/qwen-code/pull/4373#issuecomment-4506321384) | `<!-- tier=DEEP; status=complete; segments=17; emitted=1 -->`    |

## Workflow Dispatch Runs

Before this workflow can be triggered automatically from `pull_request_target`
on the default branch, dispatch runs are the realistic pre-merge end-to-end
test path. The following runs exercised tier overrides, natural preflight
routing, fallback behavior, and always-emit behavior.

| Run                                                                         | Purpose                                                | Result                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- |
| [26169929547](https://github.com/QwenLM/qwen-code/actions/runs/26169929547) | LIGHT override path                                    | Passed                                 |
| [26170668291](https://github.com/QwenLM/qwen-code/actions/runs/26170668291) | ULTRA_LIGHT override path                              | Passed                                 |
| [26169481330](https://github.com/QwenLM/qwen-code/actions/runs/26169481330) | DEEP override path, time-capped run                    | Passed with always-emit partial output |
| [26171803232](https://github.com/QwenLM/qwen-code/actions/runs/26171803232) | Natural ULTRA_LIGHT routing for docs-only PR           | Passed                                 |
| [26171807736](https://github.com/QwenLM/qwen-code/actions/runs/26171807736) | Natural fallback-to-DEEP path when preflight timed out | Passed                                 |
| [26171812332](https://github.com/QwenLM/qwen-code/actions/runs/26171812332) | Natural high-risk DEEP path with time-capped output    | Passed with always-emit partial output |

The old failure shape remains visible on
[#4110](https://github.com/QwenLM/qwen-code/pull/4110#issuecomment-4495220567):
the previous review path could spend the full timeout and leave only a generic
"review did not complete" comment. The current workflow's stream accumulator and
fallback comment path are designed to remove that failure mode.

## Local Verification

The final local verification pack for this PR used the repository's focused
workflow/script tests rather than a full root-level suite:

```text
git diff --check origin/main...HEAD
node --check scripts/compute-pr-size.cjs
node --check scripts/parse-review-stream.cjs
node --check scripts/render-review-prompt.cjs
actionlint -color -ignore 'SC2002:' -ignore 'SC2016:' -ignore 'SC2129:' -ignore 'label ".+" is unknown' .github/workflows/pr-gate.yml .github/workflows/qwen-code-pr-review.yml
npx prettier --check .github/workflows/pr-gate.yml .github/workflows/qwen-code-pr-review.yml docs/design/code-review/code-review-design.md docs/design/code-review/preflight-triage.md docs/design/code-review/preflight-validation.md docs/design/pr-gate-plan.md .qwen/preflight-light-review-prompt.md .qwen/preflight-prompt.md .qwen/preflight-standard-review-prompt.md .qwen/preflight-deep-review-prompt.md scripts/compute-pr-size.cjs scripts/parse-review-stream.cjs scripts/render-review-prompt.cjs scripts/tests/compute-pr-size.test.js scripts/tests/parse-review-stream.test.js scripts/tests/render-review-prompt.test.js scripts/tests/pr-gate-template.test.js scripts/tests/qwen-pr-review-workflow.test.js
npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/compute-pr-size.test.js scripts/tests/parse-review-stream.test.js scripts/tests/render-review-prompt.test.js scripts/tests/pr-gate-template.test.js scripts/tests/qwen-pr-review-workflow.test.js
```

Expected result: all commands pass; the focused Vitest set contains 5 files and
43 tests.

## Follow-Up Notes

- `Post Coverage Comment` currently uses `thollander/actions-comment-pull-request@v3`,
  whose latest release (`v3.0.1`) still declares `runs.using: node20`. GitHub
  warns that Node 20 JavaScript actions will be forced to Node 24 on
  2026-06-02 and removed on 2026-09-16. This is a repository-wide CI
  maintenance follow-up, not part of the PR gate / preflight review scope.
- The PR intentionally remains over the size threshold. The required gate should
  be satisfied by a non-author maintainer waiver only if maintainers agree the
  workflow and design changes are cohesive enough to review together.
