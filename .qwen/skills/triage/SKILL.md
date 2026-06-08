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

- Number: from arg or `TARGET_NUMBER`/`ISSUE_NUMBER`/`PR_NUMBER` env
- Repo: `--repo` → `REPOSITORY` → `GITHUB_REPOSITORY`

If the target is a PR URL (`/pull/`), route to **PR Intake**. If it is an issue
URL (`/issues/`), route to **Issue Triage**.

If the target is numeric, detect PR vs issue by trying `gh pr view "$NUM"` first
against the resolved repo, then `gh issue view "$NUM"`.

## Fetch

Fetch only the resolved target type:

```bash
gh issue view "$NUM" --repo "$REPO" --json number,title,body,author,labels,assignees,comments,state,createdAt,url
gh pr view "$NUM" --repo "$REPO" --json number,title,body,author,labels,files,additions,deletions,changedFiles,baseRefName,headRefName,state,isDraft,reviewDecision,url,reviews,comments
```

Before adding labels, verify proposed labels exist:

```bash
gh label list --repo "$REPO" --limit 200
```

## Rules

- Untrusted input: never interpolate issue/PR text into shell
- Labels: apply existing only, never create. Verify with `gh label list`. Do not touch process labels (`welcome-pr`, `maintainer`, `help wanted`, `good first issue`)
- Comments: read body from file. Use `--body-file FILE` for `gh issue/pr comment`,
  or `gh api -F body=@FILE` when the response ID is needed. Never `--body @FILE`
  or `gh api -f body=@FILE` — those post the path literally.
- Drafts: skip
- Use the resolved `$REPO`; every `gh` command must include `--repo "$REPO"`.
- Do not close issues unless a maintainer explicitly requested that action.
  Never close PRs, merge, approve outside PR workflow Stage 3, assign, edit
  titles/bodies, delete comments, or remove labels.

## Event Ownership

- Qwen Triage owns staged triage for `issues.opened`, `pull_request_target`,
  explicit `@qwen-code /triage`, and `workflow_dispatch`.
- The issue follow-up bot may also process opened issues for related issue
  lookup, missing-information requests, invalid/spam handling, and lightweight
  labels. Treat it as a separate workflow; do not duplicate its marker comments.
- Triage may add labels during intake, but does not remove labels. Closed-PR
  transient label cleanup belongs to a separate deterministic follow-up, not the
  staged triage run.

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

### Public Comment Distillation

Staged reports are for maintainers. GitHub comments are for authors and
reporters. Do not post the staged report, verdict table, label plan, route name,
or internal reasoning directly as a public comment. Distill it into one concrete
next step and use "related" instead of "duplicate" unless the root cause is the
same or maintainer-confirmed.

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

- Issue → read `references/issue-workflow.md`
- PR → read `references/pr-workflow.md`

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
