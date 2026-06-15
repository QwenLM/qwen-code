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
- Emit-only mode: if `QWEN_APPROVAL_EMIT_ONLY=1`, do not post comments and do
  not run `gh pr review`. Write the files described below to
  `${TRIAGE_RESULTS_DIR:-/tmp/triage-results}`; the CI workflow publishes them
  with the write-capable token.
- This skill ONLY runs when product-decision passed (or was explicitly
  skipped by a review-only trigger) AND code review completed without
  requesting changes. Upstream failures post their own request-changes and
  stop the pipeline — so never re-litigate an upstream rejection here; this
  stage weighs review nits + tmux results and issues the final verdict

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

If tmux-testing ran, its output is downloaded to `${TMUX_RESULTS_DIR:-/tmp/tmux-results}/`. The `TMUX_VERDICT` env var indicates the result (`pass`, `fail`, or `timeout`).

If the tmux results file exists but no tmux comment has been posted yet (because tmux-testing has no write access), post it now on behalf of tmux-testing:

```bash
RESULTS_DIR="${TRIAGE_RESULTS_DIR:-/tmp/triage-results}"
TMUX_RESULTS_DIR="${TMUX_RESULTS_DIR:-/tmp/tmux-results}"
TMUX_RESULTS="$TMUX_RESULTS_DIR/output.jsonl"
if [ -f "$TMUX_RESULTS" ]; then
  # Summarize tmux results into a comment body
  mkdir -p "$RESULTS_DIR"
  cat > "$RESULTS_DIR/tmux-comment.md" << 'EOF'
<!-- qwen-triage:tmux -->

<tmux testing summary based on output.jsonl>

— _Qwen Code · qwen3.7-max_
EOF

  if [ "${QWEN_APPROVAL_EMIT_ONLY:-}" != "1" ]; then
    EXISTING=$(
      gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate -F per_page=100 \
        | jq -sr '[.[][] | select(.body | contains("<!-- qwen-triage:tmux -->"))] | last | .id // empty'
    )
    if [ -n "$EXISTING" ]; then
      gh api -X PATCH "/repos/$REPO/issues/comments/$EXISTING" -F body=@"$RESULTS_DIR/tmux-comment.md"
    else
      gh api "repos/$REPO/issues/$PR_NUMBER/comments" -F body=@"$RESULTS_DIR/tmux-comment.md"
    fi
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

Write a comment file with the `<!-- qwen-triage:approval -->` marker. Be direct — say what you actually think:

```bash
RESULTS_DIR="${TRIAGE_RESULTS_DIR:-/tmp/triage-results}"
mkdir -p "$RESULTS_DIR"
cat > "$RESULTS_DIR/approval-comment.md" << 'EOF'
<!-- qwen-triage:approval -->

<Your honest reflection — 2-4 sentences. What's the overall impression? Does it ship cleanly? Any lingering concerns?>

<details>
<summary>中文说明</summary>

<同样的判断，中文版>

</details>

— _Qwen Code · qwen3.7-max_
EOF
```

The generated comment should follow this shape:

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

If `QWEN_APPROVAL_EMIT_ONLY=1`, skip this step. Otherwise, before posting,
check for existing:

```bash
EXISTING=$(
  gh api "repos/$REPO/issues/$PR_NUMBER/comments" --paginate -F per_page=100 \
    | jq -sr '[.[][] | select(.body | contains("<!-- qwen-triage:approval -->"))] | last | .id // empty'
)
```

- If found: PATCH
- If not found: POST

### 6. Act on Verdict

Write the formal review body to `$RESULTS_DIR/approval-review.md`, then execute
the review action only when not in emit-only mode:

Approve:

```bash
cat > "$RESULTS_DIR/approval-review.md" << 'EOF'
<short approval body>
EOF
if [ "${QWEN_APPROVAL_EMIT_ONLY:-}" != "1" ]; then
  gh pr review "$PR_NUMBER" --repo "$REPO" --approve --body-file "$RESULTS_DIR/approval-review.md"
fi
```

Request changes:

```bash
cat > "$RESULTS_DIR/approval-review.md" << 'EOF'
<short request-changes body>
EOF
if [ "${QWEN_APPROVAL_EMIT_ONLY:-}" != "1" ]; then
  gh pr review "$PR_NUMBER" --repo "$REPO" --request-changes --body-file "$RESULTS_DIR/approval-review.md"
fi
```

Escalate (genuinely unsure):

```bash
# Don't approve or reject. Tag maintainer if QWEN_MAINTAINER_HANDLE is set.
```

### 7. Output Verdict

Write the verdict to a file so the CI workflow can read it:

```bash
RESULTS_DIR="${TRIAGE_RESULTS_DIR:-/tmp/triage-results}"
mkdir -p "$RESULTS_DIR"
cat > "$RESULTS_DIR/approval-decision.json" << 'VERDICT_EOF'
{
  "verdict": "approve",
  "review_action": "approve",
  "summary": "<one-line summary of decision>"
}
VERDICT_EOF
```

Possible `verdict` values: `approve`, `request_changes`, `escalate`.
Possible `review_action` values: `approve`, `request_changes`, `none`.
Use `none` for `escalate`.

## Comment Style

Write like a human maintainer — conversational, concise, bilingual (English first, Chinese in `<details>`). The reflection should read like a person thinking out loud, not a form being filled out.

## Signature

Every comment ends with:

```
— *Qwen Code · qwen3.7-max*
```
