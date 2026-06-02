# PR Workflow

Shared rules (untrusted input, skip, bilingual format) are in `SKILL.md`.

### Stage 1: Template Gate

Required headings from `.github/pull_request_template.md`:

- `## What this PR does`
- `## Why it's needed`
- `## Reviewer Test Plan`
- `### Evidence (Before & After)`

Missing any → request changes, @mention author, link the template, stop.

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --request-changes --body-file /tmp/pr-gate-template.md
```

### Stage 2: Product Direction Gate

You usually lack context to rule on direction. Think hard, show evidence, route to human.

**Primary signal: Claude Code parity.**

```bash
curl -s https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | grep -iC1 "<keywords>"
```

- **Found** → aligned (cite version/line). Still run best-solution reflection below.
- **Not found** → not a rejection. Qwen Code has its own scope. Fall through to checks below.

**Rules:**

- Cite or don't claim — no citation = open question, not verdict.
- Before "aligned," look for the strongest counter-argument. Touches auth/sandbox/model selection/telemetry/release/public contract → maintainer's call.
- Uncertain → add `status/ready-for-human`, post non-committal note naming the open question.
- Never auto-reject on direction. `--request-changes` is for template gate and maintainer-confirmed rejections only.

**Best-solution reflection** (most important judgment — never skip):
Even when direction is aligned, ask: is this the _best_ approach, or is there a simpler, more composable design that solves the same need with less code? If a materially better path exists, surface it to the maintainer and author. A clearly better design = maintainer discussion, never autonomous rejection.

Aligned (parity or plainly in-scope: bug fix, docs, tests) → continue to Stage 3. Otherwise escalated → stop.

### Stage 3: KISS-Focused Code Review

Lighter than `/review`. Focus on:

- Structure and ownership boundaries
- Unnecessary abstraction, configurability, or duplication
- Implementation matches motivation
- Correctness, security, regression risks

```bash
gh pr diff "$PR_NUMBER" --repo "$REPO"
```

Summary comment for all concerns. Inline comments only for critical/high-confidence blockers.

### Stage 4: Real-Scenario Testing

**Mandatory.** Unit tests don't substitute. Unrelated build failure ≠ excuse to skip.

Drive the real product in tmux, using the `tmux-real-user-testing` skill.

**Before/after** (for bug fixes / behavior changes):

```bash
S=triage-test-$(date +%H%M%S); mkdir -p "tmp/$S"
tmux new-session -d -s "$S" -x 200 -y 50 -c "$(pwd)"
# before — installed qwen (bug reproduces)
tmux send-keys -t "$S" "qwen -p '<scenario>' 2>&1 | tee tmp/$S/before.log" Enter
# after — this PR via dev build (bug fixed)
tmux send-keys -t "$S" "npm run dev -- -p '<scenario>' 2>&1 | tee tmp/$S/after.log" Enter
tmux capture-pane -t "$S" -p -S -5000 > "tmp/$S/session.txt"; tmux kill-session -t "$S"
```

`qwen ...` = installed build, `npm run dev -- ...` = PR code. Same invocation, only the build differs.

- Cannot run after exhausting workarounds → FAIL, not skip. Report what was tried.
- Fork code: sandbox (strip write tokens/secrets). Token is for posting results only.
- Post tmux logs inline as evidence.

### Stage 5: Final Decision

Before deciding, honestly answer:

1. **Need real?** Solves an actual user problem, not change for its own sake.
2. **Code simple?** Minimal, no over-engineering, no speculative flexibility.
3. **Confident to merge?** Weigh blast radius and reversibility. Real doubt → maintainer decides.

Approve only if all pass: template ✓, direction aligned ✓, no critical issues ✓, real-scenario passed ✓, three questions clean ✓, blast radius acceptable ✓.

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --approve --body-file /tmp/pr-gate-approve.md
```

Anything uncertain → final comment summarizing findings, ask maintainer. Use `$QWEN_MAINTAINER_HANDLE` if set.
