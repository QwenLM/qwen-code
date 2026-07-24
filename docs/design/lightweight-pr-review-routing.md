# Lightweight PR Review Routing

## Decision

Reuse the existing PR triage and review workflows. Stage 1 may apply `status/on-hold` to a non-maintainer PR only when the entire diff is clearly behavior-neutral. The automatic review workflow uses its existing delay to give triage time to classify the PR, then reads the live label and skips the full `/review` path when it is present.

Maintainer-triggered `@qwen-code /review`, reviewer requests, and workflow dispatch remain available. The label does not close the PR, block merging, or impose a required check.

## Safety boundary

Classification is conservative: uncertain changes and anything affecting observable behavior, user-facing text, prompts, configuration, dependencies, schemas, public APIs, security, correctness, data loss, or compatibility continue through full review. Size alone is not a signal.

## Lifecycle

All automatic review lifecycle events use the existing ten-minute delay so triage can apply the label first. The workflow never removes `status/on-hold` automatically because a maintainer may have applied it for another reason.
