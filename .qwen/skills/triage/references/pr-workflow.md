# PR Workflow

Shared rules (untrusted input, skip, bilingual format) are in `SKILL.md`.

**Comment style:** write like a human maintainer — conversational, concise, bilingual. No bullet-point checklists that feel auto-generated.

### Comment Management

Three comments, one per stage. Post each through the issues comments API and
capture its ID:

```bash
COMMENT_ID=$(gh api "repos/$REPO/issues/$PR_NUMBER/comments" -F body=@/tmp/stage-N.md --jq '.id')
```

| Stage   | Comment                                       |
| ------- | --------------------------------------------- |
| Stage 1 | Gate findings                                 |
| Stage 2 | Code review + test results (with screenshots) |
| Stage 3 | Reflection + verdict                          |

**Terminal gate exception:** if Stage 1a template check fails, submit exactly
one `CHANGES_REQUESTED` review and stop. Do not also post or update a Stage 1
issue comment, and do not continue to Stage 2, Stage 3, or approval.

**Re-runs:** if the triage runs again on the same PR, update each comment in place:

```bash
gh api -X PATCH "/repos/$REPO/issues/comments/$COMMENT_ID" -F body=@/tmp/stage-N-updated.md
```

Never create duplicates.

**Signature:** every comment ends with:

```
— *Qwen Code · qwen3.7-max*
```

**Approval:** the `gh pr review --approve` command is a separate step that runs **after** Stage 3 comment is posted. Comment first, then approve only when genuinely confident.

### Stage 1: Gate (Template + Direction + Solution Review)

**⛔ Before anything else: create a worktree.** This is the #1 forgotten step.

```
enter_worktree(name: "triage")
```

Save the `worktreePath`. All `read_file`, `grep_search`, `glob` calls below must use it as root. `gh` commands do not need it.

This is the most important stage — catch problems before anyone spends time reviewing code.

**1a. Template check:**

PR body missing required headings from `.github/pull_request_template.md` (read from worktree) → request changes, @mention author, link the template, stop. This is the only public output for this terminal gate.

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

**1c. Solution review** (never skip — judge from the PR description and a skim of the diff structure, before reading code in detail):

- If we cut 80% of the scope, would the remaining 20% already solve the problem?
- Could we achieve the same goal by modifying something that already exists, instead of adding something new?
- Can the complexity live outside the codebase (user config, external tool) instead of inside it?
- **Minimal change:** is every edit in the diff needed for the stated goal, or does it carry unrelated changes, drive-by refactors, formatting churn, or scope creep that should be split into a separate PR? A focused PR that does one thing is easier to review, revert, and reason about.

If you spot a materially simpler path, or changes that go beyond the minimal set needed for the stated goal, raise it — not as a blocker, but as a genuine question the contributor should think about before the code review.

Implementation-level concerns (over-abstraction, code duplication, "10 lines vs 10 files") belong in Stage 2a code review — you need to see the code for those.

Post a single Stage 1 comment. Be direct — say what you actually think, not what's polite:

```markdown
<!-- qwen-triage stage=1 -->

Thanks for the PR!

Template looks good ✓

On direction: <state your honest assessment — aligned and why, or concerns and why>. CHANGELOG <reference if found, or "no direct reference but the area is relevant">.

On approach: <state your honest assessment — the scope feels right / feels like it could be much simpler / here's what I'd consider cutting>. <If you see a simpler path, name it: "Have you considered just X? It might cover most of the use case with a fraction of the complexity."> <If the diff carries unrelated changes or drive-by refactors, name them and suggest splitting them out.>

<If passing:> Moving on to code review. 🔍
<If concerns:> Flagging these for discussion before diving deeper.

<details>
<summary>中文说明</summary>

感谢贡献！

模板完整 ✓

方向：<直接说判断——对齐的原因/担心的原因>。

方案：<范围合理 / 感觉可以大幅简化 / 建议砍掉的部分>。<如果看到更简路径，点名：有没有考虑过直接 X？可能用很小的复杂度覆盖大部分场景。><如果 diff 夹带了无关改动或顺手重构，点名并建议拆成单独 PR。>

<如果通过：> 进入代码审查 🔍
<如果有顾虑：> 先提出来讨论，再深入看代码。

</details>

— _Qwen Code · qwen3.7-max_
```

Save this comment's ID. If direction is escalated → stop here. Template
failures already stopped in Stage 1a.

### Stage 2: Review + Test

#### 2a. Code Review

All local file reads (`read_file`, `grep_search`, `glob`) operate inside the worktree. The diff itself comes from `gh pr diff` (GitHub API, no worktree needed).

**Step 1 — Independent proposal (before reading the diff):**

Read only the PR title + "Why it's needed" section. Without looking at the diff, write down what _you_ would do to solve this problem. Be concrete — name the files, the approach, the tradeoffs. This is your independent baseline.

> Why: seeing the diff first anchors your judgment. You'll confirm the PR's approach instead of evaluating whether it's the right approach. Forcing yourself to propose first is the only way to have a real alternative in mind.

**Step 2 — Compare with the diff:**

Now read the diff. Compare the PR's approach against your independent proposal:

- Does the PR's solution match or exceed yours? Or did you find a simpler path it missed?
- Are there correctness bugs, security holes, or regressions your approach would have avoided?
- Does the implementation follow the project's conventions, or does it over-abstract / duplicate code / put logic in the wrong package?

Keep it tight — only flag two kinds of issues:

- **Critical blockers** — correctness bugs, security holes, regressions.
- **Clear AGENTS.md violations** — over-abstraction, unnecessary duplication, code in the wrong package, structural patterns that directly contradict the project's conventions.

Don't nitpick style, naming preferences, or "could be done differently." If it's not a blocker, leave it.

```bash
gh pr diff "$PR_NUMBER" --repo "$REPO"
```

When posting findings, summarize in a few sentences like a human would — "the auth logic is duplicated in two places, worth extracting" not a line-by-line breakdown. Save inline comments for things that genuinely block the merge.

#### 2b. Real-Scenario Testing

**Runs in the main working tree, not the worktree** — tmux needs the local build environment.

**Mandatory.** Unit tests don't substitute. Unrelated build failure ≠ excuse to skip.

**⛔ The tmux output IS the review.** The maintainer reads your Stage 2 comment and decides approve/reject from it. You **must** paste the actual `capture-pane` terminal output inline in the comment — inside a fenced code block. Not a file path, not "see attached log", not a text summary. If you didn't inline the output, the review is worthless.

Drive the real product in tmux, using the `tmux-real-user-testing` skill. Capture the terminal at key moments with `capture-pane` — these are the evidence that makes the review actionable.

**Before/after** (for bug fixes / behavior changes):

```bash
S=triage-test-$(date +%H%M%S); mkdir -p "tmp/$S"
tmux new-session -d -s "$S" -x 200 -y 50 -c "$(pwd)"
# sanitize scenario — derived from PR text, must not reach shell unsanitized
SAFE_SCENARIO=$(printf '%s' "$SCENARIO" | tr -cd '[:alnum:] _-.,' | cut -c1-200)
# before — installed qwen (bug reproduces)
tmux send-keys -t "$S" "qwen -p '$SAFE_SCENARIO' 2>&1 | tee tmp/$S/before.log" Enter
for i in $(seq 1 120); do tmux capture-pane -t "$S" -p | tail -1 | grep -qE '\$|#' && break; sleep 1; done
tmux capture-pane -t "$S" -p -S -5000 > "tmp/$S/before-session.txt"
# after — this PR via dev build (bug fixed)
tmux send-keys -t "$S" "npm run dev -- -p '$SAFE_SCENARIO' 2>&1 | tee tmp/$S/after.log" Enter
for i in $(seq 1 120); do tmux capture-pane -t "$S" -p | tail -1 | grep -qE '\$|#' && break; sleep 1; done
tmux capture-pane -t "$S" -p -S -5000 > "tmp/$S/after-session.txt"
tmux kill-session -t "$S"
```

`qwen ...` = installed build, `npm run dev -- ...` = PR code. Same invocation, only the build differs.

- Cannot run after exhausting workarounds → FAIL, not skip.
- Fork code: sandbox (strip write tokens/secrets).

Post a single Stage 2 comment (must include `<!-- qwen-triage stage=2 -->` at the top): code review findings + testing result.

**⛔ BEFORE POSTING: verify your comment contains the tmux output.** Read back through your draft — does it have a fenced code block with the actual terminal capture? If not, add it now. The maintainer cannot approve without seeing what actually happened.

````markdown
## Before (installed build)

<!-- paste capture-pane output here inside ``` -->

## After (this PR)

<!-- paste capture-pane output here inside ``` -->
````

Sign with `— *Qwen Code · qwen3.7-max*` and save this comment's ID.

### Stage 3: Reflect

Don't rush to approve. This is the moment to actually think.

Step back and look at the whole picture — the motivation, the implementation, the test results, the direction signal. Go back to the independent proposal you wrote in Stage 2a Step 1, and ask yourself:

- Does the PR's approach match or exceed my independent proposal? Or did I find a simpler path it missed?
- Does this solve something users actually care about?
- Is the code straightforward, or does it feel like it's trying too hard?
- Is every change in the diff necessary, or did unrelated edits / drive-by refactors bloat it beyond the minimal change the goal needs?
- After seeing it run, do the results match what the PR promised?
- If I had to maintain this in six months, would I curse the author or thank them?
- Am I approving this because it's genuinely good, or because I ran out of reasons to say no?

If your independent proposal was materially simpler — say so. Not as a blocker, but as an honest question the contributor should think about.

**Step 1: Post the reflection comment** (must include `<!-- qwen-triage stage=3 -->` at the top). Write what you're actually thinking. "Looks good, ships the feature cleanly, the before/after shows it works" — not a five-bullet summary of the stages. If you have reservations, say them plainly. If you're approving with mild concerns, name them. Sign with `— *Qwen Code · qwen3.7-max*` and save this comment's ID.

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
