# Preflight Triage Validation Evidence

This document records the real GitHub Actions runs and PR comments used to
validate the PR gate and preflight-triage review workflow on the
`codex/preflight-triage` branch. It is intentionally evidence-oriented; the
design rationale lives in [`preflight-triage.md`](./preflight-triage.md) and
[`../pr-gate-plan.md`](../pr-gate-plan.md).

## Hosted PR Gate And CI Evidence

PR: [#4359](https://github.com/QwenLM/qwen-code/pull/4359)

| Evidence                                    | Link                                                                            | Result                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Qwen Code CI on commit `b583706`            | [run 26364525202](https://github.com/QwenLM/qwen-code/actions/runs/26364525202) | Passed: Lint, CodeQL, macOS/Ubuntu/Windows tests, coverage comment |
| PR Gate on commit `b583706`                 | [run 26364525191](https://github.com/QwenLM/qwen-code/actions/runs/26364525191) | Passed: PR Template, Classify PR, PR Size                          |
| Focused local verification after follow-ups | See [Local Verification](#local-verification)                                   | Passed on the current local diff                                   |

`PR Size` is now a warning-only reviewability signal. It still computes and
reports the meaningful size, but it does not call `core.setFailed` solely
because a PR is large. The `oversized-ok` label is an acknowledgement/audit
signal, not an escape hatch required to make the check pass.

The local size calculation for #4359 produced:

| Metric                      | Value |
| --------------------------- | ----: |
| Changed files               |    24 |
| Raw changed lines           |  5408 |
| Meaningful changed lines    |  3312 |
| Ignored docs/markdown files |    13 |

This confirms the PR is genuinely above the 1500 meaningful-line threshold
even after docs/markdown/lockfile/snapshot/generated churn is excluded. The
workflow surfaces that fact as a warning and continues review.

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

The local verification pack for this PR uses the repository's focused
workflow/script tests rather than a full root-level suite:

```text
git diff --check
node --check scripts/compute-pr-size.cjs
node --check scripts/parse-review-stream.cjs
node --check scripts/render-review-prompt.cjs
actionlint -color -ignore 'SC2002:' -ignore 'SC2016:' -ignore 'SC2129:' -ignore 'label ".+" is unknown' .github/workflows/pr-gate.yml .github/workflows/qwen-code-pr-review.yml
npx prettier --check .github/workflows/pr-gate.yml .github/workflows/qwen-code-pr-review.yml docs/design/code-review/code-review-design.md docs/design/code-review/preflight-triage.md docs/design/code-review/preflight-validation.md docs/design/pr-gate-plan.md .qwen/preflight-light-review-prompt.md .qwen/preflight-prompt.md .qwen/preflight-standard-review-prompt.md .qwen/preflight-deep-review-prompt.md .qwen/deep-review-correctness-security-prompt.md .qwen/deep-review-test-coverage-prompt.md .qwen/deep-review-maintainability-performance-prompt.md .qwen/deep-review-undirected-audit-prompt.md scripts/compute-pr-size.cjs scripts/parse-review-stream.cjs scripts/render-review-prompt.cjs scripts/tests/compute-pr-size.test.js scripts/tests/parse-review-stream.test.js scripts/tests/render-review-prompt.test.js scripts/tests/pr-gate-template.test.js scripts/tests/qwen-pr-review-workflow.test.js
npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/compute-pr-size.test.js scripts/tests/parse-review-stream.test.js scripts/tests/render-review-prompt.test.js scripts/tests/pr-gate-template.test.js scripts/tests/qwen-pr-review-workflow.test.js
```

Expected result: all commands pass. The latest focused Vitest run covered 5
files / 66 tests.

## Follow-Up Notes

- `Post Coverage Comment` currently uses `thollander/actions-comment-pull-request@v3`,
  whose latest release (`v3.0.1`) still declares `runs.using: node20`. GitHub
  warns that Node 20 JavaScript actions will be forced to Node 24 on
  2026-06-02 and removed on 2026-09-16. This is a repository-wide CI
  maintenance follow-up, not part of the PR gate / preflight review scope.
- The PR intentionally remains over the size threshold. Size is warning-only,
  so maintainers can merge if they agree the workflow and design changes are
  cohesive enough to review together.
