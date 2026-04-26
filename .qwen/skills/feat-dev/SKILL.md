---
name: feat-dev
description: End-to-end workflow for implementing a non-trivial qwen-code
  feature. Covers requirements investigation, design, E2E test planning,
  baseline dry-run, implementation, verification, code review, and iteration.
---

# Feature Development Workflow

Use this workflow when implementing a feature in qwen-code that needs design,
behavioral validation, or coordinated changes across multiple files. Each phase
produces a concrete artifact. Do not combine phases; the output of each phase
feeds the next.

## Artifact Paths

Use `.qwen/` paths for planning artifacts:

- `.qwen/design/<feature>.md`
- `.qwen/e2e-tests/<feature>.md`

## Phase 1: Investigate

Understand the requested behavior and the current qwen-code implementation.

Use a code exploration agent when available. Ask it to inspect the relevant
qwen-code areas for:

- Existing feature definitions: tools, parameters, schemas, commands, UI, or
  config.
- Runtime wiring: spawning, lifecycle, state, permissions, hooks, and cleanup.
- Edge cases and error handling.
- Integration points and limitations.

In parallel, inspect docs, issues, tests, and nearby implementations that define
or constrain the expected behavior. If no exploration agent is available, do the
same investigation locally.

Output: mental model of current behavior, desired behavior, constraints, and key
file paths with line numbers.

## Phase 2: Design Doc

Write a design doc covering:

- Problem statement and current state, including the behavior gap.
- Proposed changes by layer or component.
- Key design decisions and rationale.
- Files affected.
- Scope boundaries.
- Open questions.

Use prose, tables, and bullets. Avoid code snippets unless essential for a key
data structure. JSON config examples are acceptable.

Output: design doc on disk.

## Phase 3: Test Plan

Use the `e2e-testing` skill to choose test modes. Then write an E2E test plan
covering:

- Test groups by capability: parameter acceptance, core behavior, error
  handling, cleanup, and regressions.
- Exact commands and expected behavior before and after implementation.
- Unique tmux session names and temp dirs for independent groups.
- Which groups can be run in parallel by separate `test-engineer` agents.

Output: test plan on disk.

## Phase 4: Dry-Run

Validate the test plan against the current baseline using the globally installed
`qwen` CLI, not the local build.

Spawn `test-engineer` agents for independent test groups when the runtime
supports it. The feature is not implemented yet, so tests should either fail or
show the gap. Iterate the test plan if the dry-run reveals broken commands,
wrong filters, or false positives.

Output: confirmed-working test plan with accurate pre-implementation baseline.

## Phase 5: Implement

Read the relevant source files before editing. Implement the changes described
in the design doc and follow project conventions:

- ESM and strict TypeScript.
- Prettier formatting.
- Collocated tests next to source.
- No speculative abstractions beyond the design.

After implementation:

```bash
npm run build
npm run typecheck
npm run bundle
```

Also run focused unit tests for changed files from the relevant package
directory.

Output: local implementation that builds and passes focused tests.

## Phase 6: Verify

Run the full E2E test plan against the local build with `node dist/cli.js`.
Spawn independent `test-engineer` agents when useful and available.

If tests fail, diagnose, fix, rebuild, re-bundle, and re-test until all groups
pass.

Output: E2E results appended to the test plan.

## Phase 7: Code Review

Run `/review` with a review task listing all changed files. Triage each comment
before acting:

- **Valid**: real bug or meaningful improvement. Fix it.
- **False positive**: reviewer missed context. Skip it.
- **Overthinking**: technically plausible but not worth the complexity. Skip
  it.

After fixes, re-run unit tests and a quick E2E sanity check.

Output: clean implementation with valid review findings addressed.

## Phase 8: Wrap Up

Skip unless the user asks. Create the branch, commit with Conventional Commits,
push, and create a draft PR using the project PR template. Post E2E results as a
separate PR comment when applicable.

## Iteration Rules

- If Phase 6 fails, return to Phase 5 and then re-run Phase 6.
- If Phase 7 finds valid issues, fix them and run a quick Phase 6 sanity check.
- Do not loop more than 3 times between Phases 5-7 without asking the user.
- If the test plan is inaccurate, update it and document why.
