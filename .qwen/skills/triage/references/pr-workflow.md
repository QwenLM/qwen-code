# PR Workflow

Intake and review a GitHub PR. Runs under the shared rules in `SKILL.md` (target
resolution, untrusted-input handling, skip-if-handled, and the bilingual comment
format) — read those first.

### Stage 1: Template Gate

The PR template — `.github/pull_request_template.md`
(https://github.com/QwenLM/qwen-code/blob/main/.github/pull_request_template.md)
— is the source of truth. Before reviewing direction or code, check the PR body
against it. These are the essential headings to require:

- `## What this PR does`
- `## Why it's needed`
- `## Reviewer Test Plan`
- `### Evidence (Before & After)`

If any is missing, request changes, mention the author, and stop all later
stages:

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --request-changes --body-file /tmp/pr-gate-template.md
```

The blocking review must name which headings are missing, **link the template
above so the author knows exactly what to copy**, and ask them to update the PR
body to match it. Linking the source makes the request verifiable, not just the
skill's opinion.

If the template passes, post a Stage 1 comment and continue.

### Stage 2: Product Direction Gate

You usually lack the context to judge product direction — it lives in maintainer
decisions and discussions not in this repo. So do not rule on it. Think hard,
show what you found, and route the call to a human.

**The decisive signal is Claude Code parity.** Qwen Code tracks Claude Code's
capabilities, so the most efficient direction check is whether Claude Code
already ships this. Search its changelog (try a few term variants — its wording
may differ from the PR's):

```bash
curl -s https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | grep -iC1 "<feature keywords>"
```

If Claude Code clearly ships the capability, direction is **aligned** — cite the
changelog version and line. Still run the best-solution reflection below before
continuing. Absence is **not** a rejection: Qwen Code has its own scope (e.g. Qwen-specific auth and
integrations), so a feature Claude Code lacks falls through to the checks below,
never an auto-reject.

For what the changelog does not settle:

- **Cite or don't claim.** Any direction claim must point to the Claude Code
  changelog above, a prior PR/issue, or a maintainer statement you actually
  read. No citation → it is an open question, not a verdict.
- **Stress-test yourself.** Before concluding "aligned," look for the strongest
  reason it is off-direction. If you have to talk yourself into it — or it
  touches auth, sandbox, model selection, telemetry, release, or a public
  contract — it is a maintainer's call.
- **Escalate by default.** When anything is uncertain, add `status/ready-for-human`,
  hand the maintainer what you found, and post a warm, non-committal note that
  names the one open question. Wrongly discouraging a contributor is the costly
  error.
- **Never auto-reject on direction.** Reserve `gh pr review --request-changes`
  for the template gate and for rejections a maintainer has confirmed.

**This is the single most important judgment in the gate — never skip it, never
rush it, and weight it above every mechanical check.** Before any "aligned,"
parity or otherwise, stop and reflect deeply: even when the need is real and the
feature belongs, is this PR's approach actually the _best_ one — or is there a
simpler, more composable, more native product design that solves the same need
better, with less code and less surface? Direction alignment and a green
checklist do not make a workable-but-mediocre solution the right answer. Push
hard here; this is where most value is won or lost. If a materially better path
exists, you must surface it — to the maintainer, and as a suggestion to the
author. A clearly better design is a maintainer discussion, never an autonomous
rejection.

Aligned — Claude Code parity, or plainly in-scope work (a bug fix, docs, tests,
an obvious reliability win) touching no core contract — continues to Stage 3, as
your reading, not a ruling. Otherwise you have escalated: stop here. Do not run
code review, testing, or approval; those happen only after a maintainer confirms
the direction.

### Stage 3: KISS-Focused Code Review

This is not the full `/review` skill. Keep it lighter and focus on:

- code structure and ownership boundaries;
- unnecessary abstraction or configurability;
- duplicate logic and avoidable complexity;
- taste and maintainability;
- whether implementation matches the PR motivation;
- critical correctness, security, or regression risks.

Use `gh pr diff "$PR_NUMBER" --repo "$REPO"` and inspect changed files locally.
If you need isolated PR code, use the existing review worktree flow rather than
changing the current checkout.

Post a Stage 3 summary comment. Only post inline comments for critical or
high-confidence blocking issues. For inline comments, use GitHub's create review
API with a `comments` array so all line comments are grouped in one review.
Uncertain concerns belong in the summary comment, not inline.

### Stage 4: Real-Scenario Testing

If Stages 1-3 pass, prove the change works the way a user hits it by driving the
real product in a tmux TUI session. This is mandatory: it cannot be skipped, unit
tests do not substitute for it (other CI covers units), and an unrelated build
failure is never an excuse to skip — exhaust every workaround first. Build the
scenario from the PR's core behavior: what does a user actually do to exercise
what this PR adds or fixes?

- Use the project `tmux-real-user-testing` skill: launch Qwen Code in a real
  tmux session and walk the user's path end to end (the slash command, dialog,
  flag, or workflow the PR touches), taking a `tmux capture-pane -p` snapshot
  after each meaningful state change.
- For a bug fix or behavior change, capture a **before/after** comparison so the
  maintainer can confirm the fix is real, not just claimed. Run the same scenario
  on two builds, changing only the build:
  - **Before** — a build without this PR: the installed `qwen` (or `main`). The
    log should show the bug reproducing.
  - **After** — this PR's code via `npm run dev`. The log should show it fixed.

  `npm run dev -- <args>` runs the working tree exactly as `qwen <args>` runs the
  installed build — same command, only the build differs. So before/after is one
  invocation run two ways: `qwen …` (no PR) vs `npm run dev -- …` (this PR). A
  quick headless check uses `-p` (one prompt, then exits):

  ```bash
  S=triage-test-$(date +%H%M%S); mkdir -p "tmp/$S"
  tmux new-session -d -s "$S" -x 200 -y 50 -c "$(pwd)"
  # before — installed qwen, no PR: the bug should reproduce
  tmux send-keys -t "$S" "qwen -p '<scenario>' 2>&1 | tee tmp/$S/before.log" Enter
  # wait until the shell prompt returns, then after — this PR via dev build:
  tmux send-keys -t "$S" "npm run dev -- -p '<scenario>' 2>&1 | tee tmp/$S/after.log" Enter
  # wait again, capture the session, clean up
  tmux capture-pane -t "$S" -p -S -5000 > "tmp/$S/session.txt"; tmux kill-session -t "$S"
  ```

  Poll the pane for completion between commands (see `tmux-real-user-testing`).
  `-p` is just one invocation. For interactive TUI changes, launch `qwen` and
  `npm run dev` without `-p` and drive the live TUI the same way in both.

- Get it running by any means. Prefer `npm run dev`, which runs the source
  directly — an unrelated `npm run bundle` / packaging failure does not block it.
  If a package or channel unrelated to this PR fails to build, install the missing
  dependency, disable that module, or work around it; the installed `qwen`
  baseline needs no build at all. A failure outside this PR's code is never a
  reason to skip the test.
- The readable tmux logs are the evidence. Post them to the PR as proof — the
  before and after frames inline, plus the full `tmux-readable-full.log` artifact
  path — so the result is verifiable, not just asserted.
- Run untrusted fork code with write tokens and secrets stripped from the
  environment — sandbox it, do not skip it. The token is only for posting results
  and is never exposed to the PR's code during the run.

If, after genuinely exhausting these, the real scenario truly cannot run, that is
a blocker, not a pass: report it as FAIL with exactly what you tried and why each
attempt failed, and do not approve. A skipped tmux test never counts as PASS.

Post a Stage 4 testing report: the scenario, the exact steps a user took, the
before/after result, and the tmux logs that back it.

### Stage 5: Final Decision

The earlier stages are mechanical checks. Before deciding, step back and
re-examine three things honestly — your judgment, not a checklist:

1. **Is the need real?** Does this solve an actual user problem, or is it change
   for its own sake — a feature nobody asked for, a fix for a non-problem? If you
   cannot name who is hurting without it, it is not merge-ready.
2. **Is the code simple?** Minimal and direct, with no over-engineering, no
   speculative flexibility, no defenses for impossible cases. If a smaller
   version would do the job, it is not merge-ready.
3. **Are you actually confident to merge this yourself, or does it need a
   maintainer?** Weigh blast radius, reversibility, and how sure you really are.
   Real doubt here means a maintainer decides — that is the correct call, not a
   failure.

Approve as merge-ready only if all are true:

- template passed;
- direction is aligned;
- no critical KISS, correctness, security, or regression issue remains;
- real-scenario testing passed — not skipped (only a change with no runnable
  behavior, e.g. docs-only, is exempt);
- the three questions above answer cleanly;
- the blast radius is small enough that you are confident.

```bash
gh pr review "$PR_NUMBER" --repo "$REPO" --approve --body-file /tmp/pr-gate-approve.md
```

If anything is uncertain — especially question 3 — do not approve. Post a final
comment summarizing what you found and ask a maintainer to decide. Use
`$QWEN_MAINTAINER_HANDLE` (a GitHub login without the leading `@`) when set;
otherwise write "maintainer review requested" without inventing a handle.
