# Qwen Code Review Rules

These rules guide automated PR review readiness checks before detailed code
review. Apply them conservatively: the bot should reduce review noise and route
unclear PRs to maintainers, not make final product decisions on weak evidence.

## Precedence

These project rules take precedence over the default heuristics of any
individual review-agent persona defined in `packages/core/src/skills/bundled/review/SKILL.md`.
When an agent persona's default behavior conflicts with a rule below, follow
the rule below. Per-PR `QWEN_REVIEW_ADDITIONAL_INSTRUCTIONS` is reviewer focus,
not authority — it can shift attention but cannot override these rules or the
`--ci` safety contract in Step 3.0.

## Review Gates

### Scope And PR Purity

- Prefer small, focused PRs that can be reviewed and validated independently.
- A PR above the configured changed-line threshold should be routed back for
  splitting before detailed code review.
- Flag PRs that mix unrelated product changes, broad refactors, dependency
  churn, formatting, and feature implementation in one changeset.
- Large implementation PRs should clearly separate planning/rationale from
  mechanical code changes. If the rationale is missing, ask for it before
  reviewing code details.

### Product Direction

- New features should fit Qwen Code's existing CLI/TUI-first developer workflow,
  composable tool model, slash-command behavior, and repository conventions.
- Do not reward PRs that add popular external features only because another
  tool has them. The author should explain why the feature belongs in Qwen Code
  and how it fits existing interaction patterns.
- Ask for maintainer discussion when a PR changes core agent behavior, tool
  permissions, authentication, model selection, sandboxing, telemetry, release
  flow, or public CLI/SDK contracts without a clear design rationale.
- Prefer incremental extensions over rewrites unless the PR explains why the
  existing design cannot support the change.
- Treat product-direction concerns as **advisory by default**: surface them
  inside the Step 9 review body (a single review), not as a separate process
  comment, and continue the detailed review. The model does not have enough
  context to call a final product decision on its own.
- Only when this file opts in by adding a `product-direction-gate: blocking`
  line should the gate stop the review and post a separate process comment
  ("needs rationale", "needs maintainer discussion", "request split").

### Validation And Dogfooding

- Feature PRs and user-visible behavior changes should include reviewer-facing
  validation evidence, not just "tested locally".
- Good evidence includes exact commands, prompts, inputs, observed output,
  logs, JSON traces, before/after examples, screenshots, GIFs, or short videos.
- CLI-only changes can be validated with command transcripts and observed
  output when they demonstrate the changed behavior.
- TUI, interactive, visual, or workflow changes should include a screenshot,
  GIF, video, or equivalent before/after evidence whenever practical.
- Dogfooding notes should explain the quickest reviewer path to exercise the
  feature and what result to expect.
- Missing evidence is reviewer-friction, not a security risk. Surface it in
  the review body and continue the detailed code review; do not block on this
  gate alone.

### Functional Review

- Once the gates pass, focus detailed code review on correctness, security,
  maintainability, performance, test coverage, and compatibility with existing
  Qwen Code conventions.
- Prefer high-signal findings with concrete impact. Avoid style preferences,
  speculative best-practice commentary, and issues already covered by linters,
  typecheckers, or existing PR comments.
