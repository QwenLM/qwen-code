# Issue Workflow

Triage a GitHub issue. Shared rules in `SKILL.md` — read those first.

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

Default stance: issues are admissible. Treat only the narrow cases below as
inadmissible.

Classify the issue from title, body, comments, labels, docs, and source context:

- **Inadmissible**: religious or political flame wars, harassment, abusive
  language, spam, or content unrelated to Qwen Code.
- **Unclear**: missing reproduction, expected behavior, environment, or enough
  detail to answer.
- **Docs / usage**: how-to questions, configuration confusion, documentation
  gaps, or behavior that is already documented.
- **Bug**: user-visible broken behavior.
- **Feature**: new capability, behavior change, or product request.

Priority:

- **P0**: catastrophic failure for most users, data loss, severe security, or
  release blocker.
- **P1**: serious regression or core feature failure without an easy workaround.
  Feature requests are almost never P1.
- **P2**: moderate issue, smaller subset affected, or easy workaround.
- **P3**: cosmetic, typo, rare edge case, or nice-to-have.

Completeness for bug reports: prefer full `/about` output. Ask only for missing
version, OS, auth method, exact command, expected/actual behavior, logs, or
screenshots. If `status/need-information` or a prior missing-info bot comment
already exists, do not post another.

Apply labels using existing labels only. Prefer one `type/*`, one `category/*`,
relevant `scope/*`, one priority label, and status labels as needed. Apply
labels with `gh issue edit --add-label`.

Post a single triage comment (bilingual, concise key points — see format
below). This comment is updated in place by Stage 2; never post a second one.

If inadmissible, recommend closure in the comment and stop. Do not close the
issue unless a maintainer explicitly requested that action.

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

1. If local docs/source search is needed, create a worktree first, then search
   with `rg` using `worktreePath` as the root.
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

1. If the issue explicitly reports an old version, add `status/need-retesting`
   and ask the reporter to upgrade and retest. Otherwise ask for current
   `/about` output instead of running a release lookup.
2. Search related issues using exact error text, command/feature name, stack
   trace file, or symptom keywords. Say "duplicate" only for same root cause or
   maintainer-confirmed duplicates; otherwise say "related".
3. Check welcome-PR eligibility: root cause identified, fix is describable,
   change is modest, test path is known, and no deep architecture knowledge is
   needed.
4. Check auto-fix eligibility: root cause is high-confidence, fix is ≤3 files,
   change is mechanical, existing tests cover the area, and no product decision
   is needed. If eligible, ask whether to run `/qc bugfix <issue-number>`.
5. Inspect source and docs inside worktree; state confidence: confirmed /
   plausible / no clear direction.
6. Append likely root cause or link similar historical issues.

For welcome-PR comments, use dual markers:

```markdown
<!-- qwen-issue-bot:welcome-pr -->
<!-- qwen-maintain:welcome-pr -->
```

### For feature requests:

1. Produce a product direction assessment: `aligned` / `discuss` / `reject`.
   Consider product fit, smallest useful implementation boundary, overlap with
   existing commands/skills/roadmap, and whether a contributor can proceed
   without private maintainer decisions.
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
