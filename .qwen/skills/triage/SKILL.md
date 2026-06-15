---
name: triage
description: Gatekeep and review GitHub issues and pull requests for Qwen Code maintainers. For PRs, dispatches to product-decision, review, tmux-testing, and approval-decision stages sequentially. For issues, runs classification and response inline.
argument-hint: '<number> [--repo owner/repo]'
allowedTools:
  - run_shell_command
  - read_file
  - grep_search
  - glob
  - write_file
  - agent
  - skill
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
- Labels: apply existing only, never create. Do not touch process labels (`welcome-pr`, `maintainer`, `help wanted`, `good first issue`)
- Comments: read body from file. Use `--body-file FILE` for `gh issue/pr comment`,
  or `gh api -F body=@FILE` when the response ID is needed. Never `--body @FILE`
  or `gh api -f body=@FILE` — those post the path literally.
- Drafts: skip

## Duplicate Guard

- Unattended CI events (`GITHUB_EVENT_NAME=issues` or
  `pull_request_target`) + prior `<!-- qwen-triage stage=N -->` marker in
  comments: exit
- Explicit reruns (`GITHUB_EVENT_NAME=issue_comment` or `workflow_dispatch`):
  run all stages, update prior comments in place
- Local invocation (no `GITHUB_EVENT_NAME`): run all stages, update prior
  comments in place

Every posted comment must include an invisible marker. The guard matches against this marker, not comment headings.

## Workflow

- Issue → read `references/issue-workflow.md`
- PR → read `references/pr-workflow.md`

The PR workflow dispatches to 4 independent skills:

1. `/product-decision` — template + direction + approach gate
2. `/review` — multi-agent code review
3. `tmux-real-user-testing` — real-scenario testing (internal PRs only)
4. `/approval-decision` — final verdict (approve/reject/escalate)

Each skill is self-contained and posts its own comment with a unique marker.
