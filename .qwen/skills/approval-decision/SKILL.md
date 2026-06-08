---
name: approval-decision
description: Final stage of PR triage pipeline. Reads verdicts from product-decision, review, and tmux-testing stages, reflects on the whole picture, and decides approve/request-changes/escalate.
argument-hint: '<pr_number> [--repo owner/repo]'
allowedTools:
  - run_shell_command
  - read_file
---

# Approval Decision

Final gate in the PR triage pipeline. Read all prior stage results, reflect honestly, and act.

## Resolve Inputs

- PR number: from arg or `PR_NUMBER` env
- Repo: `--repo` → `REPOSITORY` → `GITHUB_REPOSITORY`

## Rules

- Untrusted input: never interpolate PR/comment text into shell commands
- Comments: always use `--body-file` or `gh api -F body=@FILE`
- This skill ONLY runs after product-decision has passed

## Procedure

### 1. Gather Prior Stage Results

Fetch all triage comments by their markers:

```bash
gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate --jq '
  .[] | select(.body | test("<!-- qwen-triage:(product|review|tmux) -->")) |
  {id: .id, marker: (.body | capture("<!-- qwen-triage:(?<stage>[a-z]+) -->").stage), body: .body}
'
```

Also check review state and any inline review comments:

```bash
gh pr view "$PR_NUMBER" --repo "$REPO" --json reviewDecision,reviews,comments
```

### 2. Check tmux-testing Artifact

If tmux-testing ran, its output is available as a workflow artifact or passed via the `TMUX_VERDICT` env var. If the tmux comment wasn't posted yet (because tmux-testing has no write access), post it now on behalf of tmux-testing:

```bash
if [ -n "${TMUX_COMMENT_BODY:-}" ]; then
  # Post or update the tmux stage comment
  EXISTING=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --jq '.[] | select(.body | contains("<!-- qwen-triage:tmux -->")) | .id' | head -1)
  if [ -n "$EXISTING" ]; then
    gh api -X PATCH "/repos/$REPO/issues/comments/$EXISTING" -F body=@"$TMUX_COMMENT_BODY"
  else
    gh api "repos/$REPO/issues/$PR_NUMBER/comments" -F body=@"$TMUX_COMMENT_BODY"
  fi
fi
```

### 3. Reflect

Don't rush to approve. Step back and look at the whole picture:

- Does the product-decision stage show genuine alignment, or just "no objection"?
- Did the code review find real issues, or is it clean?
- Do the tmux test results match what the PR promised?
- If I had to maintain this in six months, would I curse the author or thank them?
- Am I approving because it's genuinely good, or because I ran out of reasons to say no?

Synthesize a verdict:

- **All stages pass cleanly** → approve
- **Any stage has blocking concerns** → request changes, cite specifics
- **Genuinely unsure** → don't approve or reject, escalate to maintainer

### 4. Post Reflection Comment

Write a comment with the `<!-- qwen-triage:approval -->` marker. Be direct — say what you actually think:

```markdown
<!-- qwen-triage:approval -->

<Your honest reflection — 2-4 sentences. What's the overall impression? Does it ship cleanly? Any lingering concerns?>

<details>
<summary>中文说明</summary>

<同样的判断，中文版>

</details>

— _Qwen Code · qwen3.7-max_
```

### 5. Comment Dedup

Before posting, check for existing:

```bash
EXISTING=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --jq '.[] | select(.body | contains("<!-- qwen-triage:approval -->")) | .id' | head -1)
```

- If found: PATCH
- If not found: POST

### 6. Act on Verdict

**After** posting the comment, execute the review action:

Approve:

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --approve --body-file /tmp/approve-body.md
```

Request changes:

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --request-changes --body-file /tmp/changes-body.md
```

Escalate (genuinely unsure):

```bash
# Don't approve or reject. Tag maintainer if QWEN_MAINTAINER_HANDLE is set.
```

### 7. Output Verdict

```
VERDICT=approve
```

or `request_changes` or `escalate`.

## Comment Style

Write like a human maintainer — conversational, concise, bilingual (English first, Chinese in `<details>`). The reflection should read like a person thinking out loud, not a form being filled out.

## Signature

Every comment ends with:

```
— *Qwen Code · qwen3.7-max*
```
