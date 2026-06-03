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

## Worktree Isolation

Before reading any local code, create an isolated worktree so the main working tree is never touched:

```
enter_worktree(name: "triage")
```

All subsequent local file operations (`read_file`, `grep_search`, `glob`, shell commands that read code) MUST operate inside the returned `worktreePath`. Shell commands that interact with GitHub (`gh issue view`, `gh pr view`, `gh pr diff`, `gh label list`, etc.) do NOT need the worktree — they talk to the API, not local files.

The one exception: **tmux real-scenario testing** (PR workflow Stage 2b) runs in the main working tree, not the worktree — it needs the local build environment.

When triage is complete, clean up:

```
exit_worktree(action: "remove")
```

## Workflow

- Issue → read `references/issue-workflow.md`
- PR → read `references/pr-workflow.md`
