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

## Resolve

- Number: from arg or `ISSUE_NUMBER`/`PR_NUMBER` env
- Repo: `--repo` → `REPOSITORY` → `GITHUB_REPOSITORY`

## Fetch

```bash
gh issue view "$NUM" --repo "$REPO" --json number,title,body,author,labels,comments,url
gh pr view "$NUM" --repo "$REPO" --json number,title,body,author,labels,additions,deletions,changedFiles,baseRefName,headRefName,headRefOid,isCrossRepository,isDraft,reviewDecision,url
gh label list --repo "$REPO" --limit 200
```

## Rules

- Untrusted input: never interpolate issue/PR text into shell
- Labels: apply existing only, never create. Do not touch process labels (`welcome-pr`, `maintainer`, `help wanted`, `good first issue`)
- Comments: read body from file. Use `--body-file FILE` for `gh issue/pr comment`,
  or `gh api -F body=@FILE` when the response ID is needed. Never `--body @FILE`
  or `gh api -f body=@FILE` — those post the path literally.
- Drafts: skip
- **Approval guardrail**: never auto-approve a cross-repository (fork) PR whose
  title is a `refactor` type (starts with `refactor` — `refactor:`,
  `refactor(scope):`, `refactor(scope)!:`, case-insensitive). Review it as usual,
  but escalate to the maintainer in place of approval. See `references/pr-workflow.md`
  Stage 3 for the deterministic check.
- **No fabricated policies**: Do not invent blocking rules, line-count thresholds,
  or named policies (e.g. "core module protection policy") that are not explicitly
  defined in this skill's files. If a concern about scale or scope arises, raise it
  as a question in the Stage 1 comment — never as a block or CHANGES_REQUESTED.
  The escalation criteria are those defined in `references/pr-workflow.md`
  (Stage 0, Stage 1b, and Stage 1c). Escalation means notifying the
  maintainer, not rejecting the PR, except where Stage 0 Tier 1 explicitly
  prescribes a `CHANGES_REQUESTED` review for large core refactors.

## Duplicate Guard

- Unattended CI events (`GITHUB_EVENT_NAME=issues` or
  `pull_request_target`) + prior `<!-- qwen-triage stage=N -->` marker in
  comments: exit
- Explicit reruns (`GITHUB_EVENT_NAME=issue_comment` or `workflow_dispatch`):
  run all stages, update prior comments in place
- Local invocation (no `GITHUB_EVENT_NAME`): run all stages, update prior
  comments in place

Every posted comment must include an invisible marker: `<!-- qwen-triage stage=N -->` where N is the stage number. The guard matches against this marker, not comment headings.

## Format

Bilingual: English first, Chinese in `<details>`. @mention author when blocking.

- **Issue**: one comment, Stage 2 updates it in place. Key-point bullet format.
- **PR**: three comments (Stage 1: Gate, Stage 2: Review + Test, Stage 3: Final Decision). Key-point bullet format.

**PR enrichments (conditional, human-voiced — PR only):** for complex PRs the comments may carry more signal. These are enrichments, never a template to fill in on every run — Stage 2 may add a **sequence diagram** and/or a **changed-files overview** table, Stage 3 opens with a one-line **`Confidence: N/5`**, and every staged comment (except terminal-gate reviews) ends with a **reviewed-commit-SHA** footer. Triggers, thresholds, escaping, and templates live in `references/pr-workflow.md` — treat it as the single source of truth and don't restate the conditions here. Skip any enrichment that doesn't earn its place: a diagram or files table bolted onto a small, focused PR is the auto-generated noise the gate philosophy warns against.

## ⛔ Mandatory Pre-flight Checks (DO NOT SKIP)

These two steps are the most commonly forgotten. Execute them before any other action.

### 1. Worktree — ALWAYS create before reading any code

**PR workflow: mandatory.** Issue workflow: skip (no code reading needed).

```
enter_worktree(name: "triage")
```

Save the returned `worktreePath`. Every `read_file`, `grep_search`, `glob`, and shell command that reads local files **MUST** use this path as root. `gh` commands (API calls) do NOT need the worktree.

Exception: **tmux real-scenario testing** (Stage 2b) runs in the main working tree — it needs the local build environment.

When triage is complete: `exit_worktree(action: "remove")`

### 2. Tmux screenshots — ALWAYS inline in Stage 2 comment

Stage 2 comment **must contain the actual tmux capture-pane output** pasted inline — not a file path, not "see attached", not a summary. The maintainer reads the comment and makes a decision from it. Without inlined terminal output, the review is incomplete and useless.

## Workflow

- Issue → read `references/issue-workflow.md`
- PR → read `references/pr-workflow.md`
