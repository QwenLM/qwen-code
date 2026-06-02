# PR Workflow

Shared rules (untrusted input, skip, bilingual format) are in `SKILL.md`.

**Comment style:** concise key-point bullets, bilingual. No verbose prose.

### Stage 1: Gate (Template + Direction)

Check PR body for required headings from `.github/pull_request_template.md`:

- `## What this PR does`
- `## Why it's needed`
- `## Reviewer Test Plan`
- `### Evidence (Before & After)`

Missing any → request changes, @mention author, link the template, stop.

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --request-changes --body-file /tmp/pr-gate-template.md
```

If template passes, check product direction:

```bash
curl -s https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | grep -iC1 "<keywords>"
```

- **Found** → aligned (cite version/line).
- **Not found** → not a rejection. Fall through to checks below.

**Direction rules:**

- Cite or don't claim — no citation = open question.
- Touches auth/sandbox/model selection/telemetry/release/public contract → maintainer's call.
- Uncertain → add `status/ready-for-human`, post non-committal note.
- Never auto-reject on direction.

**Best-solution reflection** (most important — never skip):
Even when aligned, ask: is this the _best_ approach, or is there a simpler design? A materially better path = maintainer discussion, never autonomous rejection.

Post a single Stage 1 comment (bilingual, concise):

```markdown
## Stage 1: Gate

- **Template**: ✓ passed
- **Direction**: aligned (Claude Code CHANGELOG v1.0.42)
- **Best solution**: current approach is reasonable / suggest <simpler path>
- **Verdict**: continue to code review

<details>
<summary>中文说明</summary>

- **模板**: ✓ 通过
- **方向**: 对齐
- **最优解**: 当前方案合理 / 建议 <更简路径>
- **结论**: 进入代码审查
</details>

--- Qwen Code
```

If template fails or direction is escalated → stop here.

### Stage 2: Review + Test

#### 2a. Code Review

Lighter than `/review`. Focus on:

- Structure and ownership boundaries
- Unnecessary abstraction, configurability, or duplication
- Implementation matches motivation
- Correctness, security, regression risks

```bash
gh pr diff "$PR_NUMBER" --repo "$REPO"
```

Inline comments only for critical/high-confidence blockers.

#### 2b. Real-Scenario Testing

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

- Cannot run after exhausting workarounds → FAIL, not skip.
- Fork code: sandbox (strip write tokens/secrets).

Post a single Stage 2 comment: code review findings + testing result. Inline tmux logs as evidence.

### Stage 3: Final Decision

Weigh all stages holistically:

1. **Need real?** Solves an actual user problem.
2. **Code simple?** Minimal, no over-engineering.
3. **Best approach?** After seeing the code and test results, is this implementation actually the best way to solve the problem, or is there a simpler / more native / lower-cost alternative? If a clearly better path exists, surface it.
4. **Confident to merge?** Weigh blast radius and reversibility. Real doubt → maintainer decides.

Approve only if all pass: template ✓, direction ✓, no critical issues ✓, real-scenario ✓, three questions clean ✓, blast radius acceptable ✓.

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --approve --body-file /tmp/pr-gate-approve.md
```

Anything uncertain → ask maintainer. Use `$QWEN_MAINTAINER_HANDLE` if set.

Post a single Stage 3 comment: overall verdict and reasoning.
