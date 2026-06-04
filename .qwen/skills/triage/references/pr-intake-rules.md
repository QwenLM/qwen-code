# PR Intake Rules

Reference material for `pr-workflow.md`. Criteria and thresholds that
supplement the workflow's Stage 1 gate. Intake is not deep code review.

## Historical Design Context

Closed PRs are design history, not automatic negative precedent. Extract
reusable rationale, constraints, and validation ideas. Treat as reject signal
only when maintainers explicitly said the direction should not be pursued.
Prefer "there is useful prior design context in #NNNN" over "this was rejected
before."

## Author Validation

Judge only evidence supplied by the PR author. Do not run tests to manufacture
evidence.

| PR type            | Expected evidence                                      |
| ------------------ | ------------------------------------------------------ |
| TUI or interactive | Screenshot, recording, tmux log, or before/after       |
| CLI behavior       | Command transcript with observed output                |
| Bug fix            | Reproduction plus fixed behavior                       |
| API/SDK            | Test output or usage example                           |
| Performance        | Before/after numbers                                   |
| CI/workflow        | Workflow run link or local actionlint/smoke output     |
| Pure refactor      | Relevant tests/typecheck and why behavior is unchanged |
| Docs only          | N/A is acceptable if the doc surface is reviewed       |

## Scope And Size

Exclude lockfiles, generated files, snapshots, and schema artifacts from
line counts.

| Lines    | Action                                           |
| -------- | ------------------------------------------------ |
| < 800    | Normal                                           |
| 800-1500 | Warn and suggest split if concerns are separable |
| > 1500   | Strongly suggest splitting unless PR is cohesive |

Split signals: refactor + feature, dependency churn + behavior changes,
multiple unrelated packages, "while I was here" cleanup.

## Deep Review Handoff

Only hand off to code review when:

- Product fit is `aligned` (or `discuss` has explicit maintainer route).
- Body completeness is `complete`.
- Author validation is `present` (or credibly N/A).
- Scope is `focused` (or oversized with maintainer acknowledgement).

## Label Taxonomy

Verdict mapping:

| Verdict                          | Label plan                                  |
| -------------------------------- | ------------------------------------------- |
| Product Fit = `discuss`          | `need-discussion`, `status/ready-for-human` |
| Product Fit = `reject`           | `status/ready-for-human`                    |
| Body Completeness = `incomplete` | `status/need-information`                   |
| Scope = `oversized-acknowledged` | `oversized-ok` only if maintainer confirmed |
| Author Validation = `missing`    | `status/waiting-for-feedback`               |
| All pass                         | `status/in-review`                          |
