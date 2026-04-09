---
description: Fix a bug from a GitHub issue, following the reproduce-first workflow
---

# Bugfix

## Input

A GitHub issue URL or number: $ARGUMENTS

## Workflow

### 1. Read the issue and create the issue file

Create `.qwen/issues/` if it doesn't exist, then pipe the issue directly
into a markdown file using `gh`:

```bash
mkdir -p .qwen/issues
gh issue view <number> \
  --json number,title,body \
  -t '# Issue #{{.number}}: {{.title}}

{{.body}}

---

## Reproduction report

_Pending — to be filled by the test engineer._

## Verification report

_Pending — to be filled by the test engineer._
' > .qwen/issues/issue-<number>.md
```

This file is the single source of truth for the issue. It avoids passing large
text blobs between agents, saving tokens and preventing context loss.

### 2. Reproduce

Spawn the `test-engineer` agent and tell it to read `.qwen/issues/issue-<number>.md`
for the issue details, then assess and reproduce the bug. Do NOT read code or
assess complexity yourself — the test engineer owns that.

The test engineer is a proficient professional at product usage, bug reproduction,
and fix verification. Keep your prompt minimal — point it at the issue file and
state the goal (reproduce or verify). Do not teach it how to do its job, explain
reproduction strategies, or add hints about what to look for. It will figure that
out on its own.

Wait for the test engineer to finish. Then **read `.qwen/issues/issue-<number>.md`**
to get the reproduction report. If the status is `NOT_REPRODUCED`, say so and
stop.

### 3. Locate and fix

Read the relevant code and make the fix. Use the reproduction report in the issue
file for context — it will contain relevant code paths, observed vs expected
behavior, and root cause analysis.

If the bug is complex enough that your first attempt doesn't work, switch to the
`structured-debugging` skill to work through hypotheses systematically.

### 4. Verify the fix

Build your changes (`npm run build && npm run bundle`), then spawn the
`test-engineer` agent again and tell it to read `.qwen/issues/issue-<number>.md`
and _verify_ the fix. It will re-run its reproduction steps using
`node dist/cli.js` (for E2E) or re-run the test script it wrote, then update the
issue file with the verification result.

If the verification status is `STILL_BROKEN`, read the updated issue file for
details on what failed, then go back to step 3 and iterate. Use the
`structured-debugging` skill if you haven't already. Do not proceed to step 5
until verification returns `VERIFIED_FIXED`.

### 5. Tests

Run the unit tests for any packages you modified. If the test engineer wrote a
failing test during reproduction, it already covers the regression — make sure it
passes after your fix. Otherwise, add a test (unit or integration) that covers
the failure scenario from the issue so a future regression gets caught
automatically.
