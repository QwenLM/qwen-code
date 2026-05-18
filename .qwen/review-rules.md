# Qwen Code Review Rules

These rules guide the current bundled `/review` behavior and the future
preflight readiness checks. Apply them conservatively: the bot should reduce
review noise and route unclear PRs to maintainers, not make final product
decisions on weak evidence.

## Gate Behavior

- **Current workflow behavior**: Until the Design Gate preflight is enabled,
  these rules are loaded by bundled `/review` as project review guidance.
  A blocking gate should be treated as an actionable process finding, but the
  workflow may still continue into detailed code review.
- **Design Gate behavior**: Once the preflight gate is enabled, a blocking gate
  failure stops before detailed code analysis. The bot posts a process comment
  explaining which gate failed, why, and what the author should address (e.g.,
  split the PR, provide design rationale, add validation evidence). The PR stays
  open — the author can address the concern and re-trigger review with
  `@qwen /review`.
- **Advisory gates**: When an advisory gate has concerns, the bot flags them
  in the review body but proceeds with code review.

### Gate Defaults

| Gate | Default | Override |
|------|---------|----------|
| Scope / PR Purity | blocking | `scope-gate: advisory` in this file |
| Product Direction | blocking | `product-direction-gate: advisory` in this file |
| Validation / Dogfooding | advisory | `validation-gate: blocking` in this file |

## Review Gates

### Scope And PR Purity

- Prefer small, focused PRs that can be reviewed and validated independently.
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

### Functional Review

- Once the gates pass, focus detailed code review on correctness, security,
  maintainability, performance, test coverage, and compatibility with existing
  Qwen Code conventions.
- Prefer high-signal findings with concrete impact. Avoid style preferences,
  speculative best-practice commentary, and issues already covered by linters,
  typecheckers, or existing PR comments.
