# PR Workflow

Shared rules (untrusted input, skip, bilingual format) are in `SKILL.md`.

**Comment style:** write like a human maintainer — conversational, concise, bilingual. No bullet-point checklists that feel auto-generated.

### Comment Management

Three comments, one per stage. Save each comment's ID for re-runs:

| Stage   | Comment                                       |
| ------- | --------------------------------------------- |
| Stage 1 | Gate findings                                 |
| Stage 2 | Code review + test results (with screenshots) |
| Stage 3 | Reflection + verdict                          |

**Re-runs:** if the triage runs again on the same PR, update each comment in place (`gh api -X PATCH`) — never create duplicates.

**Signature:** every comment ends with:

```
— *Qwen Code · qwen3.7-max*
```

**Approval:** the `gh pr review --approve` command is a separate step that runs **after** Stage 3 comment is posted. Comment first, then approve only when genuinely confident.

### Stage 1: Gate (Template + Direction + Solution Review)

This is the most important stage — catch problems before anyone spends time reviewing code.

**1a. Template check:**

PR body missing required headings from `.github/pull_request_template.md` → request changes, @mention author, link the template, stop.

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --request-changes --body-file /tmp/pr-gate-template.md
```

**1b. Product direction:**

Ask the hard questions before reading a single line of code:

- Does this solve a real user problem, or is it a solution looking for a problem?
- Is it within qwen-code's core mission, or does it pull focus from what matters more?
- "Can do" ≠ "should do" — technically feasible doesn't mean we should ship it.

CHANGELOG is a reference signal, not the sole criterion:

```bash
curl -s https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | grep -iC1 "<keywords>"
```

- **Found** → cite version/line as supporting signal.
- **Not found** → not a rejection. The area may still be relevant.

**Escalate to maintainer** (never auto-reject): touches auth/sandbox/model selection/telemetry/release/public contract, or direction is genuinely unclear.

**1c. Solution review** (never skip — judge from the PR description alone, before reading code):

- If we cut 80% of the scope, would the remaining 20% already solve the problem?
- Could we achieve the same goal by modifying something that already exists, instead of adding something new?
- Can the complexity live outside the codebase (user config, external tool) instead of inside it?

If you spot a materially simpler path, raise it — not as a blocker, but as a genuine question the contributor should think about before the code review.

Implementation-level concerns (over-abstraction, code duplication, "10 lines vs 10 files") belong in Stage 2a code review — you need to see the code for those.

Post a single Stage 1 comment. Be direct — say what you actually think, not what's polite:

```markdown
Thanks for the PR!

Template looks good ✓

On direction: <state your honest assessment — aligned and why, or concerns and why>. CHANGELOG <reference if found, or "no direct reference but the area is relevant">.

On approach: <state your honest assessment — the scope feels right / feels like it could be much simpler / here's what I'd consider cutting>. <If you see a simpler path, name it: "Have you considered just X? It might cover most of the use case with a fraction of the complexity.">

<If passing:> Moving on to code review. 🔍
<If concerns:> Flagging these for discussion before diving deeper.

<details>
<summary>中文说明</summary>

感谢贡献！

模板完整 ✓

方向：<直接说判断——对齐的原因/担心的原因>。

方案：<范围合理 / 感觉可以大幅简化 / 建议砍掉的部分>。<如果看到更简路径，点名：有没有考虑过直接 X？可能用很小的复杂度覆盖大部分场景。>

<如果通过：> 进入代码审查 🔍
<如果有顾虑：> 先提出来讨论，再深入看代码。

</details>

— _Qwen Code · qwen3.7-max_
```

Save this comment's ID. If template fails or direction is escalated → stop here.

### Stage 2: Review + Test

#### 2a. Code Review

Keep it tight — only flag two kinds of issues:

- **Critical blockers** — correctness bugs, security holes, regressions.
- **Clear AGENTS.md violations** — over-abstraction, unnecessary duplication, code in the wrong package, structural patterns that directly contradict the project's conventions.

Don't nitpick style, naming preferences, or "could be done differently." If it's not a blocker, leave it.

```bash
gh pr diff "$PR_NUMBER" --repo "$REPO"
```

When posting findings, summarize in a few sentences like a human would — "the auth logic is duplicated in two places, worth extracting" not a line-by-line breakdown. Save inline comments for things that genuinely block the merge.

#### 2b. Real-Scenario Testing

**Mandatory.** Unit tests don't substitute. Unrelated build failure ≠ excuse to skip.

**The point:** tmux screenshots are the evidence. Reviewers should be able to **see** what actually happened — no guesswork, no "trust me it works." Inline screenshots in the review comment = the reviewer can make a decision without running anything locally.

Drive the real product in tmux, using the `tmux-real-user-testing` skill. Capture screenshots at key moments — these are what make the review actionable.

**Before/after** (for bug fixes / behavior changes):

```bash
S=triage-test-$(date +%H%M%S); mkdir -p "tmp/$S"
tmux new-session -d -s "$S" -x 200 -y 50 -c "$(pwd)"
# before — installed qwen (bug reproduces)
tmux send-keys -t "$S" "qwen -p '<scenario>' 2>&1 | tee tmp/$S/before.log" Enter
tmux capture-pane -t "$S" -p -S -5000 > "tmp/$S/before-session.txt"
# after — this PR via dev build (bug fixed)
tmux send-keys -t "$S" "npm run dev -- -p '<scenario>' 2>&1 | tee tmp/$S/after.log" Enter
tmux capture-pane -t "$S" -p -S -5000 > "tmp/$S/after-session.txt"
tmux kill-session -t "$S"
```

`qwen ...` = installed build, `npm run dev -- ...` = PR code. Same invocation, only the build differs.

- Cannot run after exhausting workarounds → FAIL, not skip.
- Fork code: sandbox (strip write tokens/secrets).

Post a single Stage 2 comment: code review findings + testing result. **Inline the tmux screenshots** (before/after) directly in the comment — that's what makes the review self-contained and decision-ready. Sign with `— *Qwen Code · qwen3.7-max*` and save this comment's ID.

### Stage 3: Reflect

Don't rush to approve. This is the moment to actually think.

Step back and look at the whole picture — the motivation, the implementation, the test results, the direction signal. Ask yourself:

- Does this solve something users actually care about?
- Is the code straightforward, or does it feel like it's trying too hard?
- After seeing it run, do the results match what the PR promised?
- If I had to maintain this in six months, would I curse the author or thank them?
- Am I approving this because it's genuinely good, or because I ran out of reasons to say no?

If there's a simpler way to solve the same problem — even if it wasn't the contributor's idea — mention it. Not as a blocker, but as an honest question.

**Step 1: Post the reflection comment.** Write what you're actually thinking. "Looks good, ships the feature cleanly, the before/after shows it works" — not a five-bullet summary of the stages. If you have reservations, say them plainly. If you're approving with mild concerns, name them. Sign with `— *Qwen Code · qwen3.7-max*` and save this comment's ID.

**Step 2: Act on the verdict.**

All stages genuinely clean — approve:

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --approve --body "LGTM, looks ready to ship. ✅"
```

Reflection shows it shouldn't merge — request changes immediately, citing the specific concerns from the comment:

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --request-changes --body "Needs some rethinking — see my notes above. 🙏"
```

Genuinely unsure — **don't approve or reject**. Ask the maintainer to weigh in. Use `$QWEN_MAINTAINER_HANDLE` if set.
