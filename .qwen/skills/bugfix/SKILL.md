---
name: bugfix
description: Fix a bug from a GitHub issue, following the reproduce-first
  workflow. Use when the user asks to fix a bug, investigate a GitHub issue, or
  debug a user-reported problem. Takes a GitHub issue URL or number as input.
---

# Bugfix Workflow

Follow this workflow for GitHub issue bugfixes. Do not skip reproduction; fixing
without first reproducing the bug tends to produce incomplete fixes and
regressions.

## Input

A GitHub issue URL or number. Slash-command arguments are appended to this skill
body by Qwen Code.

## Artifact Path

Use `.qwen/issues/` in this repo. In the steps below, `<issue-file>` means the
selected issue markdown file.

## Step 1: Read The Issue

Create the artifact directory if needed, then pipe the issue directly into a
markdown file using `gh`:

```bash
mkdir -p .qwen/issues
gh issue view <number> \
  --json number,title,body \
  -t '# Issue #{{.number}}: {{.title}}

{{.body}}

---

## Reproduction report

_Pending - to be filled by the test engineer._

## Verification report

_Pending - to be filled by the test engineer._
' > .qwen/issues/issue-<number>.md
```

## Step 2: Reproduce

Spawn the `test-engineer` agent and point it at `<issue-file>`. State only the
goal: reproduce the bug. Keep the prompt minimal; the test engineer owns the
reproduction strategy.

Wait for the test engineer to finish. Then read `<issue-file>` to get the
reproduction report. If the status is `NOT_REPRODUCED`, report that and stop.

## Step 3: Fix

Read the relevant code and make the fix. Use the reproduction report for
context; it should contain observed behavior, expected behavior, and useful code
paths.

If the bug is complex enough that the first attempt does not work, use the
`structured-debugging` skill and work through hypotheses systematically.

## Step 4: Verify

Build and bundle your changes:

```bash
npm run build && npm run bundle
```

Spawn the `test-engineer` agent again, pointing it at the same issue file. State
the goal: verify the fix using `node dist/cli.js`.

If the verification status is `STILL_BROKEN`, read the updated issue file, go
back to Step 3, and iterate. Do not proceed until verification returns
`VERIFIED_FIXED`.

## Step 5: Tests

Run unit tests for any packages you modified. If the test engineer wrote a
failing test during reproduction, make sure it passes after the fix. Otherwise,
add focused regression coverage for the failure scenario.

## Step 6: Code Review

Skip this only for a plain one-line or trivial config fix. For anything else,
run `/review` with a review task listing all changed files. Triage each comment
with a verdict:

- **Valid**: real bug or meaningful improvement. Fix it.
- **False positive**: reviewer missed context. Skip it.
- **Overthinking**: technically plausible but not worth the complexity. Skip
  it.

After fixing valid issues, re-run unit tests and a quick verification sanity
check.

## Iteration Rules

- If Step 4 fails, go back to Step 3, then re-run Step 4.
- If Step 6 finds valid issues, fix them, then re-run Step 4 as a sanity check.
- Do not loop more than 3 times between Steps 3-6 without asking the user.
