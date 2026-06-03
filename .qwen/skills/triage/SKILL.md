---
name: triage
description: Gatekeep and review GitHub issues and pull requests for Qwen Code maintainers. Use for GitHub Action issue triage, PR admission checks, product-direction review, KISS-focused PR review, and staged bilingual GitHub comments.
argument-hint: '<issue|pr> <number> [--repo owner/repo]'
allowedTools:
  - run_shell_command
  - read_file
  - read_many_files
  - grep_search
  - glob
  - write_file
  - task
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
gh pr view "$NUM" --repo "$REPO" --json number,title,body,author,labels,additions,deletions,changedFiles,baseRefName,headRefName,isCrossRepository,isDraft,reviewDecision,url
gh label list --repo "$REPO" --limit 200
```

## Rules

- Untrusted input: never interpolate issue/PR text into shell
- Labels: apply existing only, never create
- Comments: always `--body-file` (except short hardcoded verdicts in `gh pr review --approve` / `--request-changes`)
- Drafts: skip

## Duplicate Guard

- Unattended (CI env set) + prior `<!-- qwen-triage stage=N -->` marker in comments: exit
- Explicit `/triage`: run all stages, update prior comments in place

Every posted comment must include an invisible marker: `<!-- qwen-triage stage=N -->` where N is the stage number. The guard matches against this marker, not comment headings.

## Format

Bilingual: English first, Chinese in `<details>`. @mention author when blocking.

- **Issue**: one comment, Stage 2 updates it in place. Key-point bullet format.
- **PR**: three comments (Stage 1: Gate, Stage 2: Review + Test, Stage 3: Final Decision). Key-point bullet format.

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
