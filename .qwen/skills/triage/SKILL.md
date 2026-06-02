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
- Comments: always `--body-file`
- Drafts: skip

## Duplicate Guard

- Unattended (CI env set) + prior `## Stage N` or `APPROVED`: exit
- Explicit `/triage`: run all stages, update prior comments in place

## Format

Bilingual: English first, Chinese in `<details>`. @mention author when blocking.

- **Issue**: one comment, Stage 2 updates it in place. Key-point bullet format.
- **PR**: three comments (Stage 1: Gate, Stage 2: Review + Test, Stage 3: Final Decision). Key-point bullet format.

## Workflow

- Issue → read `references/issue-workflow.md`
- PR → read `references/pr-workflow.md`
