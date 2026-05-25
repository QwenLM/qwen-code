# Qwen Code Review Rules

These are the project-specific review criteria for Qwen Code. Bundled
`/review` loads this file and applies the rules below to its review
agents. Apply them conservatively: the goal is to reduce review noise
and route unclear PRs to maintainers, not to make final product
decisions on weak evidence.

> Scope note: this file describes _what_ to evaluate and _how strong_ a
> finding is — review content only. It does NOT describe CI workflow
> mechanics (when a gate stops the pipeline, when a process comment is
> posted, how to re-trigger). When `/review` runs locally on
> uncommitted changes there is no CI gate; treat the rules below as
> review guidance, not as a process to enforce.

## Finding Severity

How strongly to weight each gate's findings. "blocking" means a failure
here is a high-priority, actionable finding the author should resolve
before the change is mergeable; "advisory" means flag it but it does not
by itself block.

| Gate                    | Default severity | Override token (in this file)      |
| ----------------------- | ---------------- | ---------------------------------- |
| Scope / PR Purity       | blocking         | `scope-gate: advisory`             |
| Product Direction       | blocking         | `product-direction-gate: advisory` |
| Validation / Dogfooding | advisory         | `validation-gate: blocking`        |

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
- Evidence may appear in the PR body or in top-level PR comments from the PR
  author. Maintainer comments, bot comments, or review suggestions do not count
  as the author's own validation evidence.
- Good evidence includes exact commands, prompts, inputs, observed output,
  logs, JSON traces, before/after examples, screenshots, GIFs, or short videos.
- CLI-only changes can be validated with command transcripts and observed
  output when they demonstrate the changed behavior.
- TUI, interactive, visual, or workflow changes should include a screenshot,
  GIF, video, or equivalent before/after evidence whenever practical.
- Dogfooding notes should explain the quickest reviewer path to exercise the
  feature and what result to expect.

**Required review output — Validation Evidence verdict.** Every review of a
PR MUST include a section titled exactly `## Validation Evidence` with one
of:

- `PRESENT` — name the concrete evidence found (commands / logs / JSON
  trace / before-after / screenshot / GIF / recording / test report).
- `MISSING` — state what reviewer-facing evidence is absent and what the
  author should add. For feature / user-visible / high-risk PRs treat this
  as a blocking-severity finding; for docs-only / pure-refactor it is
  advisory.

End that section with this line verbatim:
`> This is an automated, advisory, comment-only review — it never approves or requests changes.`

### Functional Review

- Once the gates pass, focus detailed code review on correctness, security,
  maintainability, performance, test coverage, and compatibility with existing
  Qwen Code conventions.
- Prefer high-signal findings with concrete impact. Avoid style preferences,
  speculative best-practice commentary, and issues already covered by linters,
  typecheckers, or existing PR comments.

### Posting Inline Comments

When you have Bash access and the environment provides `GITHUB_REPOSITORY`,
`PR_NUMBER`, and a valid `GITHUB_TOKEN`, post high-confidence findings
(P0/P1) as inline PR comments using the GitHub Create Review API:

```bash
gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" \
  --method POST \
  -f commit_id="$HEAD_SHA" \
  -f event=COMMENT \
  -f body="Summary of review findings." \
  --jsonc comments='[{"path":"src/file.ts","line":42,"body":"**[Critical]** description"}]'
```

Rules:
- Only post findings you can map to a specific diff line in the `comments` array.
- Findings that cannot map to a diff line go in the `body` field.
- Do NOT post P2/P3 (low-severity) findings as inline comments — keep them in
  your text output only. Inline comments should be high-signal.
- If you have no P0/P1 findings, skip the API call entirely.
- Always include a trailing signature in each inline comment body:
  `_— ${OPENAI_MODEL} via Qwen Code /review_`
