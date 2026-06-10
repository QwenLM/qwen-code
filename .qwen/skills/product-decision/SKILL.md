---
name: product-decision
description: Evaluate PR template compliance, product direction alignment, and solution approach. First gate in the PR triage pipeline — blocks review and testing if concerns are raised.
argument-hint: '<pr_number> [--repo owner/repo]'
allowedTools:
  - run_shell_command
  - read_file
  - grep_search
  - glob
---

# Product Decision Gate

Evaluate whether a PR should proceed to code review and testing. This is the first stage in the triage pipeline — catch direction and scope problems before anyone spends time reviewing code.

## Resolve Inputs

- PR number: from arg or `PR_NUMBER` env
- Repo: `--repo` → `REPOSITORY` → `GITHUB_REPOSITORY`

## Rules

- Untrusted input: never interpolate PR text into shell commands
- Labels: apply existing only, never create
- Comments: always use `--body-file` or `gh api -F body=@FILE`
- Drafts: skip entirely

## Procedure

### 1. Fetch PR Metadata

```bash
gh pr view "$PR_NUMBER" --repo "$REPO" --json number,title,body,author,labels,additions,deletions,changedFiles,baseRefName,headRefName,isCrossRepository,isDraft,url
```

If draft → exit with verdict `skip`.

### 2. Template Check

Read the PR template from the repo:

```bash
gh api "repos/$REPO/contents/.github/pull_request_template.md" --jq '.content' | base64 -d
```

Compare required headings against the PR body. Missing required sections → post a `CHANGES_REQUESTED` review and stop:

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --request-changes --body-file /tmp/template-fail.md
```

Output verdict `fail` and exit. Do not continue to direction/approach evaluation.

### 3. Product Direction

Ask the hard questions before reading code:

- Does this solve a real user problem, or is it a solution looking for a problem?
- Is it within qwen-code's core mission, or does it pull focus?
- "Can do" ≠ "should do" — technically feasible doesn't mean we should ship it.

Check Claude Code as a reference signal. A local checkout lives on the runner
at `$CLAUDE_CODE_SRC` — prefer it, since it lets you grep both the CHANGELOG and
the actual source, not just release notes:

```bash
if [ -n "${CLAUDE_CODE_SRC:-}" ] && [ -d "$CLAUDE_CODE_SRC" ]; then
  # CHANGELOG signal
  grep -iC1 "<keywords>" "$CLAUDE_CODE_SRC/CHANGELOG.md"
  # Source signal — does the area already exist / how is it shaped there?
  grep -rinC1 "<keywords>" "$CLAUDE_CODE_SRC/src" 2>/dev/null | head -40
else
  # Fallback: remote CHANGELOG only (CLAUDE_CODE_SRC unset, e.g. GitHub-hosted)
  curl -s https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | grep -iC1 "<keywords>"
fi
```

- **Found** → cite version/line (or source path) as supporting signal.
- **Not found** → not a rejection. The area may still be relevant.

**Escalate to maintainer** (never auto-reject): touches auth/sandbox/model selection/telemetry/release/public contract, or direction is genuinely unclear.

### 4. Solution Approach

Judge from the PR description and diff structure (not full code review):

- If we cut 80% of the scope, would the remaining 20% already solve the problem?
- Could we achieve the same goal by modifying something that already exists?
- Can the complexity live outside the codebase instead of inside it?

If you spot a materially simpler path, raise it — as a genuine question, not a blocker.

Implementation-level concerns belong in the review stage, not here.

### 5. Post Comment

Write a comment file and post it. Must include the marker for dedup:

```markdown
<!-- qwen-triage:product -->

Thanks for the PR!

Template looks good ✓

On direction: <honest assessment — aligned and why, or concerns and why>. CHANGELOG <reference if found, or "no direct reference but the area is relevant">.

On approach: <honest assessment — scope feels right / could be simpler / suggest cutting>. <If simpler path exists: "Have you considered just X?">

<If passing:> Moving on to code review. 🔍
<If concerns:> Flagging these for discussion before diving deeper.

<details>
<summary>中文说明</summary>

感谢贡献！

模板完整 ✓

方向：<直接说判断>。

方案：<范围评估>。

<如果通过：> 进入代码审查 🔍
<如果有顾虑：> 先提出来讨论。

</details>

— _Qwen Code · qwen3.7-max_
```

### 6. Comment Dedup

Before posting, check for an existing comment with `<!-- qwen-triage:product -->`:

```bash
EXISTING=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" --jq '.[] | select(.body | contains("<!-- qwen-triage:product -->")) | .id' | head -1)
```

- If found: PATCH the existing comment
- If not found: POST a new comment

### 7. Output Verdict

Write the verdict to a file so the CI workflow can read it:

```bash
mkdir -p /tmp/triage-results
cat > /tmp/triage-results/product-decision.json << 'VERDICT_EOF'
{
  "verdict": "pass",
  "summary": "<one-line summary of decision>",
  "blocking_reasons": []
}
VERDICT_EOF
```

Possible `verdict` values:

- `pass` — direction and approach are acceptable, proceed to review
- `fail` — template check failed (missing required sections). This is the ONLY case for `fail` — direction and approach concerns never auto-reject
- `needs_human` — escalated to maintainer. Use for: direction concerns, scope questions, touches sensitive areas (auth/sandbox/model/telemetry/release)

For `fail` or `needs_human`, populate `blocking_reasons` with specific concerns.

## Comment Style

Write like a human maintainer — conversational, concise, bilingual (English first, Chinese in `<details>`). No bullet-point checklists that feel auto-generated.

## Signature

Every comment ends with:

```
— *Qwen Code · qwen3.7-max*
```
