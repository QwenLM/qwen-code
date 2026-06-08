# Issue Workflow

Triage a GitHub issue. Shared rules in `SKILL.md` — read those first.

For detailed classification criteria (type, priority P0-P3), completeness
checks, version staleness, auto-fix eligibility, and welcome-PR eligibility,
consult `issue-triage-rules.md`.

**Single comment, updated in place.** Stage 1 posts a concise bilingual
comment; Stage 2 appends results to the same comment via `gh api PATCH`.
Key points only — no verbose prose.

```markdown
<!-- qwen-triage stage=1 -->
<!-- qwen-issue-bot:needs-info -->

## Triage

- **Type**: unclear
- **Labels**: `type/support`, `status/need-information`
- **Next**: Could you share `/about` output and the exact command that failed?

<details>
<summary>中文说明</summary>

- **类型**: 信息不足
- **标签**: `type/support`, `status/need-information`
- **下一步**: 请补充 `/about` 输出和失败的完整命令。
</details>

--- Qwen Code
```

## Stage 1: Intake Gate

Before classifying, evaluate the comment gate and label gate from `SKILL.md`.
Record the gate decisions in the staged report. Analysis always proceeds
regardless of gate outcomes — only `gh` write calls are affected.

Include the appropriate bot-coordination marker in the comment draft alongside
the stage marker. For example: `<!-- qwen-triage stage=1 -->` plus
`<!-- qwen-issue-bot:needs-info -->` for unclear issues.

Default stance: issues are admissible. Close only the narrow inadmissible cases
below.

Classify the issue from title, body, comments, labels, docs, and source context.
Use the priority definitions from `issue-triage-rules.md` (P0-P3) and the
completeness check (version, OS, auth method) to decide next steps:

- **Inadmissible**: religious or political flame wars, harassment, abusive
  language, spam, or content unrelated to Qwen Code.
- **Unclear**: missing reproduction, expected behavior, environment, or enough
  detail to answer.
- **Docs / usage**: how-to questions, configuration confusion, documentation
  gaps, or behavior that is already documented.
- **Bug**: user-visible broken behavior.
- **Feature**: new capability, behavior change, or product request.

Apply labels using existing labels only. Prefer one `type/*`, one `category/*`,
relevant `scope/*`, one priority label, and status labels as needed. Apply
labels with `gh issue edit --add-label`.

Post a single triage comment (bilingual, concise key points — see format
below). This comment is updated in place by Stage 2; never post a second one.

If inadmissible, close the issue and stop:

```bash
gh issue close "$ISSUE_NUMBER" --repo "$REPO" --reason "not planned"
```

Save the comment ID for Stage 2 to update.

## Stage 2: Handle By Type

Work the issue by type below, then **update** the Stage 1 comment in place with
the result appended:

```bash
gh api -X PATCH repos/$REPO/issues/comments/$COMMENT_ID -F body=@/tmp/triage-comment.md
```

### For unclear issues:

1. Add `status/need-information`.
2. Ask for specific missing data: `/about` output, exact commands, expected vs
   actual behavior, logs, screenshots.
3. Stop — no further analysis is useful until the reporter responds.

### For docs / usage issues:

1. Search docs and source with `rg` (inside worktree — use `worktreePath` as the search root).
2. Search similar issues (reduce title to safe keywords first):

   ```bash
   SAFE_KEYWORDS=$(printf '%s' "$TITLE" | tr -cd '[:alnum:] _-' | cut -c1-60)
   if [ -n "$SAFE_KEYWORDS" ]; then
     gh issue list --repo "$REPO" --state all --search "$SAFE_KEYWORDS"
   else
     echo "No Latin keywords (CJK-only title); falling back to label search"
     gh issue list --repo "$REPO" --label "type/bug"
   fi
   ```

3. Append the answer with links.

### For bugs with clear reproduction:

1. Check safety — no untrusted code with write tokens or secrets.
2. Use `tmux-real-user-testing` skill if available; otherwise tmux manually (runs in main working tree, not worktree):

   ```bash
   S=triage-test-$(date +%H%M%S); mkdir -p "tmp/$S"
   tmux new-session -d -s "$S" -x 200 -y 50 -c "$(pwd)"
   SAFE_SCENARIO=$(printf '%s' "$SCENARIO" | tr -cd '[:alnum:] _-.,' | cut -c1-200)
   tmux send-keys -t "$S" "qwen -p '$SAFE_SCENARIO' 2>&1 | tee tmp/$S/before.log" Enter
   for i in $(seq 1 120); do tmux capture-pane -t "$S" -p | tail -1 | grep -qE '\$|#' && break; sleep 1; done
   tmux capture-pane -t "$S" -p -S -5000 > "tmp/$S/before-session.txt"
   tmux send-keys -t "$S" "npm run dev -- -p '$SAFE_SCENARIO' 2>&1 | tee tmp/$S/after.log" Enter
   for i in $(seq 1 120); do tmux capture-pane -t "$S" -p | tail -1 | grep -qE '\$|#' && break; sleep 1; done
   tmux capture-pane -t "$S" -p -S -5000 > "tmp/$S/after-session.txt"
   tmux kill-session -t "$S"
   ```

3. Inspect source for root cause and likely fix (read files inside worktree).
4. Append: reproduced (yes/no), affected area, fix direction.

### For bugs without clear reproduction:

1. Check version staleness using `issue-triage-rules.md` rules: if the reported
   version is ≥6 stable releases behind current, add `status/need-retesting`
   and ask the reporter to upgrade and retest.
2. Check welcome-PR eligibility using `issue-triage-rules.md`: root cause
   identified, fix is describable, change is modest, test path is known.
3. Check auto-fix eligibility: root cause is high-confidence, fix is ≤3 files,
   change is mechanical, existing tests cover the area. If eligible, ask whether
   to run `/qc bugfix <issue-number>`.
4. Inspect source and docs inside worktree; state confidence: confirmed /
   plausible / no clear direction.
5. Append likely root cause or link similar historical issues.

For welcome-PR comments, use dual markers:

```markdown
<!-- qwen-issue-bot:welcome-pr -->
<!-- qwen-maintain:welcome-pr -->
```

### For feature requests:

1. Produce a product direction assessment using `issue-triage-rules.md`:
   `aligned` / `discuss` / `reject`.
2. For `aligned` or `discuss`, state the recommended implementation boundary:
   skill/prompt, docs, existing command extension, core architecture, or
   roadmap discussion.
3. Check welcome-PR readiness: product direction is `aligned`, implementation
   boundary is self-contained, acceptance criteria can be stated without a
   private maintainer decision.
4. For `discuss` or when AI confidence is insufficient, add
   `need-discussion` + `status/ready-for-human` and ask maintainers to weigh in.
5. Append verdict: accept for exploration, suggest a smaller alternative, or
   decline as out of direction.
