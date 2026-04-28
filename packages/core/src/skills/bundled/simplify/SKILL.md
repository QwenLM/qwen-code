---
name: simplify
description: Review recent code changes for reuse, code quality, and efficiency, then directly apply straightforward cleanup improvements. Use when the user wants a post-implementation cleanup pass, pre-PR polish, or asks to simplify/refine recent changes. Invoke with `/simplify` or `/simplify <focus>`.
allowedTools:
  - agent
  - run_shell_command
  - grep_search
  - read_file
  - write_file
  - edit
  - glob
---

# Simplify Recent Changes

You are running a structured cleanup workflow over recent code changes. Your goal is not just to comment on the code, but to safely improve it.

## Step 1: Identify the review scope

Determine which files and changes to review.

1. First inspect the current git state.
2. If there are staged changes, review against `HEAD` so both staged and unstaged tracked changes are included.
3. Otherwise review the current uncommitted diff.
4. If there is no git diff, fall back to recently modified files in the working tree.
5. If recently modified files are not obvious, fall back to files edited in this conversation.
6. If you still cannot identify a meaningful scope, stop and tell the user there are no recent changes to simplify.

Preferred commands:

- `git diff --name-only`
- `git diff --staged --name-only`
- `git diff HEAD --name-only`
- `git diff`
- `git diff HEAD`
- `git status --short`

Use `git diff HEAD` whenever staged changes exist. Otherwise use `git diff`.

## Step 2: Launch three review passes in parallel

Use the `agent` tool and launch all review passes in a single response so they run concurrently. Each pass must receive the same review scope and diff command.

Keep each review prompt short and focused. Do not paste the full diff into the prompt. Tell each pass to read the diff itself and inspect only files relevant to its findings.

### Pass 1: Code Reuse Review

Look for opportunities to reduce duplication and reuse existing code:

- existing utilities or helpers that should be reused
- duplicated logic introduced in new code
- inline logic that should delegate to an existing abstraction
- ad-hoc helpers for string, path, env, parsing, or type checks when a project utility already exists

### Pass 2: Code Quality Review

Look for maintainability issues:

- copy-paste variants that should be unified
- parameter sprawl or awkward APIs
- redundant state or indirection
- abstraction leaks
- stringly-typed code that should be modeled more clearly
- unnecessary nesting
- unnecessary comments that explain what instead of why
- naming or structure that does not match surrounding code

### Pass 3: Efficiency Review

Look for wasteful work and unnecessary overhead:

- repeated work that can be memoized, cached, or removed
- serial work that can be parallelized safely
- unnecessary scans, allocations, reads, or traversals
- hot-path blocking work
- redundant no-op updates
- overly broad operations when a narrower one would work
- existence-check patterns that introduce TOCTOU style waste or risk

## Step 3: Aggregate findings

Wait for all three passes to finish, then merge overlapping findings.

Prioritize fixes that are:

- low risk
- local in scope
- clearly aligned with existing project patterns
- easy to validate with tests or targeted commands

Do not force a cleanup if it would require speculative architectural changes.

## Step 4: Apply straightforward improvements

Directly implement safe cleanup improvements.

Examples of good automatic fixes:

- replace duplicated logic with an existing helper
- remove dead or redundant code
- simplify conditionals or control flow
- tighten loops or repeated work
- reduce unnecessary state or wrapper code
- remove low-value comments
- align code with nearby conventions

Skip items that are uncertain, risky, or too invasive. Do not spend time debating rejected findings; simply move on.

## Step 5: Verify the cleanup

After making changes:

1. Run focused tests for the changed area when they exist.
2. Run the relevant project quality checks you can identify for the touched code.
3. If there are no applicable tests, at least run a targeted build, typecheck, or lint command that covers the edited files.

Prefer targeted verification over whole-repo commands unless the project only exposes repo-wide checks.

## Additional focus

If the user supplied extra instructions after `/simplify`, treat them as additional review focus and prioritize them alongside the default dimensions.

The raw user invocation appears below when present. Use it to extract any extra focus such as performance, duplication, rendering, API clarity, testability, or naming consistency.
