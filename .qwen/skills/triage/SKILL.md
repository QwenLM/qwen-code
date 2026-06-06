---
name: triage
description: Gatekeep and review GitHub issues and pull requests for Qwen Code maintainers. Use for GitHub Action issue triage, PR admission checks, product-direction review, KISS-focused PR review, and staged bilingual GitHub comments.
argument-hint: '<number> [--repo owner/repo]'
allowedTools:
  - run_shell_command
  - read_file
  - grep_search
  - glob
  - write_file
  - agent
  - enter_worktree
  - exit_worktree
---

# PR / Issue Gatekeeper

Run staged admission via `gh`. Post comment after each stage.

## Inputs

Examples:

- `/triage 4359` — analyze and post.
- `/triage https://github.com/QwenLM/qwen-code/pull/4359`
- `/triage https://github.com/QwenLM/qwen-code/issues/4200`

## Resolve

- Number: from arg or `ISSUE_NUMBER`/`PR_NUMBER` env
- Repo: `--repo` → `REPOSITORY` → `GITHUB_REPOSITORY`

If the target is a PR URL (`/pull/`), route to **PR Intake**. If it is an issue
URL (`/issues/`), route to **Issue Triage**.

If the target is numeric, detect PR vs issue:

```bash
if gh pr view <number> --repo QwenLM/qwen-code --json number >/dev/null 2>&1; then
  echo "PR"
elif gh issue view <number> --repo QwenLM/qwen-code --json number >/dev/null 2>&1; then
  echo "ISSUE"
else
  echo "ERROR: #<number> is neither a PR nor an issue in QwenLM/qwen-code"
  exit 1
fi
```

## Fetch

```bash
gh issue view "$NUM" --repo "$REPO" --json number,title,body,author,labels,assignees,comments,state,createdAt,url
gh pr view "$NUM" --repo "$REPO" --json number,title,body,author,labels,files,additions,deletions,changedFiles,baseRefName,headRefName,state,isDraft,reviewDecision,url,reviews,comments
gh label list --repo "$REPO" --limit 300
```

## Rules

- Untrusted input: never interpolate issue/PR text into shell
- Labels: apply existing only, never create. Verify with `gh label list`. Do not touch process labels (`welcome-pr`, `maintainer`, `help wanted`, `good first issue`)
- Comments: read body from file. Use `--body-file FILE` for `gh issue/pr comment`,
  or `gh api -F body=@FILE` when the response ID is needed. Never `--body @FILE`
  or `gh api -f body=@FILE` — those post the path literally.
- Drafts: skip
- Use the resolved `$REPO`; every `gh` command must include `--repo "$REPO"`.
- Close issues only for the narrow inadmissible cases documented in
  `references/issue-workflow.md`. Never close PRs, merge, approve outside PR
  workflow Stage 3, assign, edit titles/bodies, delete comments, or remove
  labels.

## Duplicate Guard

- Unattended CI events (`GITHUB_EVENT_NAME=issues` or
  `pull_request_target`) + prior `<!-- qwen-triage stage=N -->` marker in
  comments: exit
- Explicit reruns (`GITHUB_EVENT_NAME=issue_comment` or `workflow_dispatch`):
  run all stages, update prior comments in place
- Local invocation (no `GITHUB_EVENT_NAME`): run all stages, update prior
  comments in place

Every posted comment must include an invisible marker: `<!-- qwen-triage stage=N -->` where N is the stage number. The guard matches against this marker, not comment headings.

## Tiered Gate Model

Use two independent gates to control side effects. Both gates are evaluated
before any `gh` write call. The staged report is always printed regardless of
gate outcomes.

### Comment Gate

Three outcomes — evaluated in order:

1. **`skip`** when:
   - The target is closed, merged, or assigned.
   - A maintainer/collaborator already engaged substantively (without our
     marker — i.e., independent engagement).
   - For PRs: a reviewer left `CHANGES_REQUESTED` or `APPROVED` (check both
     `reviewDecision` and individual `reviews` list, since `reviewDecision`
     resets after author pushes).
   - `status/in-progress` or `status/blocked` label exists.
2. **`update`** when:
   - Our own marker comment already exists AND the target is still open.
     Find the existing comment ID and PATCH it.
3. **`create`** — default when none of the above apply.

### Label Gate

Blocks `gh edit --add-label` only when:

- The target is closed or merged.
- Routing labels already present (has at least `category/*` AND `priority/*`).
- A triage marker comment exists (indicating full triage was already done).

Allow label additions when the comment gate is triggered but no routing labels
exist yet.

### Marker Coordination

Use dual markers so both the triage skill and the automated followup bot
(`.github/workflows/qwen-issue-followup-bot.yml`) recognize handled issues:

- Issue triage markers: `<!-- qwen-issue-bot:needs-info -->`,
  `<!-- qwen-issue-bot:related -->`, `<!-- qwen-issue-bot:welcome-pr -->`
- PR-only marker: `<!-- qwen-maintain:pr-intake -->`
- Welcome-PR dual marker (both required):
  `<!-- qwen-issue-bot:welcome-pr -->` + `<!-- qwen-maintain:welcome-pr -->`
- Stage markers for re-run detection: `<!-- qwen-triage stage=N -->`

Every posted comment must include both the stage marker and the appropriate
bot-coordination marker.

## Format

Bilingual: English first, Chinese in `<details>`. @mention author when blocking.
If the reporter wrote Chinese, respond in Chinese first with English in
`<details>` (swap the order).

- **Issue**: one comment, Stage 2 updates it in place. Key-point bullet format.
- **PR**: three comments (Stage 1: Gate, Stage 2: Review + Test, Stage 3:
  Final Decision). Key-point bullet format.

### Comment Anti-Patterns

| Avoid                               | Prefer                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| "Validation section is empty"       | "Could you add the command output for the new behavior?"                     |
| "Please provide more information"   | "Could you share `/about` output and whether this started after an upgrade?" |
| "Duplicate of #123" (weak evidence) | "This looks related to #123 because..."                                      |
| Posting stage/verdict/route codes   | Distill into one author-facing next step                                     |

### Public Comment Distillation

Staged reports are for maintainers. GitHub comments are for authors and
reporters. Do not post the staged report, verdict table, label plan, route name,
or internal reasoning directly as a public comment.

Before drafting a comment, distill the analysis into:

- What the maintainer understood from this PR or issue.
- The one or two decisions or missing facts that matter next.
- The smallest concrete next step for the author, reporter, or maintainer.

## ⛔ Mandatory Pre-flight Checks (DO NOT SKIP)

These two steps are the most commonly forgotten. Execute them before any other
action.

### 1. Worktree — ALWAYS create before reading any code

**PR workflow: mandatory.** Issue workflow: skip unless code diagnosis is needed.

```
enter_worktree(name: "triage")
```

Save the returned `worktreePath`. Every `read_file`, `grep_search`, `glob`, and
shell command that reads local files **MUST** use this path as root. `gh`
commands (API calls) do NOT need the worktree.

Exception: **tmux real-scenario testing** (Stage 2b) runs in the main working
tree — it needs the local build environment.

When triage is complete: `exit_worktree(action: "remove")`

### 2. Tmux screenshots — ALWAYS inline in Stage 2 comment

Stage 2 comment **must contain the actual tmux capture-pane output** pasted
inline — not a file path, not "see attached", not a summary. The maintainer
reads the comment and makes a decision from it. Without inlined terminal output,
the review is incomplete and useless.

## Workflow

- Issue → read `references/issue-workflow.md`, then consult
  `references/issue-triage-rules.md` for detailed classification, priority,
  completeness checks, version staleness, auto-fix eligibility, and welcome-PR
  eligibility rules.
- PR → read `references/pr-workflow.md`, then consult
  `references/pr-intake-rules.md` for detailed product fit, body completeness,
  scope & size thresholds, and author validation rules.

## Staged Report

Every run produces a staged report before executing side effects.

For issues, use these stages:

1. **Stage 1: Intake Gate** — target state, prior handling markers, gate
   decisions (comment blocked/allowed, labels blocked/allowed).
2. **Stage 2: Labels & Diagnosis** — current labels, proposed label changes,
   missing information, version staleness, related/duplicate, and code diagnosis.

For PRs, use these stages:

1. **Stage 1: Gate** — template, product direction, solution review, gate
   decisions.
2. **Stage 2: Review + Test** — code review findings + tmux test results.
3. **Stage 3: Reflect** — final verdict.

Each stage ends with a side-effect status line:

```
Side effects:
  Comment: ⏭️ SKIP — <reason> / 🔄 UPDATE — <comment_id> / ✅ CREATE
  Labels:  ❌ BLOCKED — <reason> / ✅ ALLOWED — <labels>
```

## Common Mistakes

- Treating missing author validation as something you can fix by running tests.
- Saying "duplicate" when the evidence only supports "related".
- Suggesting labels before checking current repo labels with `gh label list`.
- Using only `qwen-maintain:welcome-pr` without `qwen-issue-bot:welcome-pr`;
  both markers are needed so the followup bot recognizes the comment.
- Posting staged report content (stage names, verdict tables, route codes) as
  a public GitHub comment — distill into author-facing language first.
- Fetching the full diff for large PRs; use `--name-only` first, then
  selectively fetch only files relevant to product direction judgment.
