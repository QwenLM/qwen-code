# PR Workflow

Shared rules (untrusted input, skip, bilingual format) are in `SKILL.md`.

## Dispatcher

PR triage is split into 4 independent stages. In CI, these are orchestrated by `qwen-pr-triage.yml` as parallel jobs. Locally, `/triage` runs them sequentially.

### Stage 1: Product Decision

Invoke the `/product-decision` skill:

```
/product-decision <PR_NUMBER> --repo <REPO>
```

This evaluates:

- Template compliance
- Product direction alignment
- Solution approach (scope, simplicity)

If verdict is `fail` or `needs_human` → stop here. Do not proceed to review.

### Stage 2: Code Review (parallel in CI)

Invoke the `/review` skill:

```
/review <PR_URL> --comment
```

This runs the full multi-agent code review and posts inline comments.

### Stage 3: Real-Scenario Testing (parallel in CI, internal PRs only)

Invoke the `tmux-real-user-testing` skill to drive the real product in tmux.

Skip if:

- Fork PR (security: cannot execute untrusted code)
- No way to build/run locally

The tmux output MUST be inlined in the comment — not a file path, not a summary.

### Stage 4: Approval Decision

Invoke the `/approval-decision` skill:

```
/approval-decision <PR_NUMBER> --repo <REPO>
```

This reads all prior stage comments (by `<!-- qwen-triage:* -->` markers), reflects on the whole picture, and decides:

- `approve` → `gh pr review --approve`
- `request_changes` → `gh pr review --request-changes`
- `escalate` → don't approve or reject, tag maintainer

## Sequential Execution (Local)

When running locally via `/triage <N>`:

1. Run Stage 1. If it fails → stop.
2. Run Stage 2 and Stage 3 (sequentially, since we're single-threaded locally).
3. Run Stage 4.

Each stage posts its own comment with a unique marker. Re-runs update comments in place.

## Comment Markers

| Stage             | Marker                                                   |
| ----------------- | -------------------------------------------------------- |
| Product Decision  | `<!-- qwen-triage:product -->`                           |
| Code Review       | `<!-- qwen-triage:review -->` (+ inline review comments) |
| Tmux Testing      | `<!-- qwen-triage:tmux -->`                              |
| Approval Decision | `<!-- qwen-triage:approval -->`                          |

## Comment Style

Write like a human maintainer — conversational, concise, bilingual (English first, Chinese in `<details>`). No bullet-point checklists that feel auto-generated.

Every comment ends with:

```
— *Qwen Code · qwen3.7-max*
```
