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

- `PRESENT` — the PR author provided concrete validation evidence in the
  PR description or their own PR comments (commands, logs, JSON traces,
  before/after screenshots, GIFs, videos, test reports). Name what you found.
- `MISSING` — the PR author did NOT provide reviewer-facing validation
  evidence. State what evidence the author should add. For feature /
  user-visible / high-risk PRs treat this as a blocking-severity finding;
  for docs-only / pure-refactor it is advisory.

**Important**: This verdict evaluates whether the PR AUTHOR supplied
evidence, NOT whether you (the reviewer) ran commands yourself. Do NOT
execute tests or commands to generate your own validation — judge solely
from what the author provided in the PR body and their comments.

### Functional Review

- Once the gates pass, focus detailed code review on correctness, security,
  maintainability, performance, test coverage, and compatibility with existing
  Qwen Code conventions.
- Prefer high-signal findings with concrete impact. Avoid style preferences,
  speculative best-practice commentary, and issues already covered by linters,
  typecheckers, or existing PR comments.

### Posting Inline Comments (MANDATORY for all findings with diff lines)

**After writing your review text**, post ALL findings that map to specific
diff lines as inline PR review comments using Bash — regardless of severity
(P0 through P3). This is a **pre-authorized action** — the CI workflow
operator has explicitly granted permission for this bot to post review
comments. Do NOT hesitate or skip due to "visible to others" concerns;
posting is the intended behavior. The environment variables
`GITHUB_REPOSITORY`, `PR_NUMBER`, `HEAD_SHA`, and `GITHUB_TOKEN` are
pre-configured and guaranteed to be set — use them directly without checking.

**IMPORTANT — no duplication**: If you post a finding as an inline comment,
do NOT repeat that same finding in your text output. Your text output should
only contain:
1. The review header and "What this PR does" summary.
2. Findings that do NOT map to a specific diff line (cross-file concerns,
   architectural observations, missing-test-coverage notes without a
   specific line).
3. The Validation Evidence verdict.

Findings posted inline are already visible on the PR — repeating them in
the summary comment is redundant noise.

```bash
jq -n \
  --arg sha "$HEAD_SHA" \
  --arg body "Qwen Code review — see inline comments." \
  --argjson comments '[{"path":"src/file.ts","line":42,"body":"**[P2]** description\n\n_— automated via Qwen Code /review_"}]' \
  '{commit_id: $sha, event: "COMMENT", body: $body, comments: $comments}' \
| gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}/reviews" \
    --method POST --input -
```

Rules:
- Execute this Bash command after completing your review text output.
- Post ALL findings (P0–P3) that map to a specific changed line in the diff.
- Findings without a clear diff line stay in your text output only.
- If you have no findings that map to diff lines, skip the API call.
- Each inline comment body must end with:
  `\n\n_— automated via Qwen Code /review_`
