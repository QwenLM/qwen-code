# PR Workflow

Shared rules (untrusted input, skip, bilingual format) are in `SKILL.md`.

## Dispatcher

PR triage is split into 4 gated stages — product-decision → review → tmux-testing → approval-decision — each blocking the next. In CI they are orchestrated by `qwen-pr-triage.yml` as a serial job chain; locally, `/triage` runs them sequentially with the same gates.

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

### Stage 2: Code Review

Invoke the `/review` skill:

```
/review <PR_URL> --comment
```

This runs the full multi-agent code review and posts inline comments.

### Stage 3: Real-Scenario Testing (internal PRs only)

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

## Execution Flow (Local)

When running locally via `/triage <N>`, follow this dependency chain:

```
/product-decision
    │
    ├─ verdict=fail → STOP (post comment, do not continue)
    ├─ verdict=needs_human → STOP (escalate to maintainer)
    │
    ▼ verdict=pass
/review --comment
    │
    ├─ requested changes → STOP (the review's CHANGES_REQUESTED is the verdict)
    │
    ▼ passed
tmux-real-user-testing (internal PRs only)
    │
    ├─ skipped → STOP (fork, closed, draft, or no runnable environment)
    │
    ▼
/approval-decision (reads all prior comments, decides final verdict)
```

This is a **serial pipeline** — each stage gates the next, and exactly one
stage owns the formal review verdict on every path:

- **product-decision fails** → it posts request-changes; nothing else runs
- **review requests changes** → that review IS the verdict; tmux and approval skipped
- **tmux fails** → approval still runs and weighs the failure (review passed, so there is no competing verdict)
- **tmux is skipped** → stop; do not approve without real-scenario evidence
- **approval-decision runs only when product, review, and tmux gates completed** — it issues the single final approve/request-changes

Each stage posts its own comment with a unique marker. Re-runs update in place.

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
