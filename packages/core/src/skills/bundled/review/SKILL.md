---
name: review
description: Review changed code for correctness, security, code quality, and performance. Use when the user asks to review code changes, a PR, or specific files. Invoke with `/review`, `/review <pr-number>`, or `/review <file-path>`.
allowedTools:
  - task
  - run_shell_command
  - grep_search
  - read_file
  - glob
---

# Code Review

You are an expert code reviewer. Your job is to review code changes and provide actionable feedback.

## Step 1: Determine what to review

Your goal here is to understand the scope of changes so you can dispatch agents effectively in Step 2. Based on the arguments provided:

- **No arguments**: Review local uncommitted changes
  - Run `git diff` and `git diff --staged` to get all changes
  - If both diffs are empty, inform the user there are no changes to review and stop here — do not proceed to the review agents

- **PR number or URL** (e.g., `123` or `https://github.com/.../pull/123`):
  - Save the current branch name, stash any local changes (`git stash --include-untracked`), then `gh pr checkout <number>`
  - Run `gh pr view <number>` and save the output (title, description, base branch, etc.) to a temp file (e.g., `/tmp/pr-review-context.md`) so agents can read it without you repeating it in each prompt
  - Note the base branch (e.g., `main`) — agents will use `git diff <base>...HEAD` to get the diff and can read files directly

- **File path** (e.g., `src/foo.ts`):
  - Run `git diff HEAD -- <file>` to get recent changes
  - If no diff, read the file and review its current state

## Step 2: Parallel multi-dimensional review

Launch **four parallel review agents** to analyze the changes from different angles. Each agent should focus exclusively on its dimension.

**IMPORTANT**: Do NOT paste the full diff into each agent's prompt — this duplicates it 4x. Instead, give each agent the command to obtain the diff, a concise summary of what the changes are about, and its review focus. Each agent can read files and search the codebase on its own.

### Agent 1: Correctness & Security

Focus areas:

- Logic errors and edge cases
- Null/undefined handling
- Race conditions and concurrency issues
- Security vulnerabilities (injection, XSS, SSRF, path traversal, etc.)
- Type safety issues
- Error handling gaps

### Agent 2: Code Quality

Focus areas:

- Code style consistency with the surrounding codebase
- Naming conventions (variables, functions, classes)
- Code duplication and opportunities for reuse
- Over-engineering or unnecessary abstraction
- Missing or misleading comments
- Dead code

### Agent 3: Performance & Efficiency

Focus areas:

- Performance bottlenecks (N+1 queries, unnecessary loops, etc.)
- Memory leaks or excessive memory usage
- Unnecessary re-renders (for UI code)
- Inefficient algorithms or data structures
- Missing caching opportunities
- Bundle size impact

### Agent 4: Undirected Audit

No preset dimension. Review the code with a completely fresh perspective to catch issues the other three agents may miss.
Focus areas:

- Business logic soundness and correctness of assumptions
- Boundary interactions between modules or services
- Implicit assumptions that may break under different conditions
- Unexpected side effects or hidden coupling
- Anything else that looks off — trust your instincts

## Step 3: Restore environment and present findings

If you checked out a PR branch in Step 1, restore the original state first: check out the original branch, `git stash pop` if changes were stashed, and remove the temp file.

Then combine results from all four agents into a single, well-organized review. Use this format:

### Summary

A 1-2 sentence overview of the changes and overall assessment.

### Findings

Use severity levels:

- **Critical** — Must fix before merging. Bugs, security issues, data loss risks.
- **Suggestion** — Recommended improvement. Better patterns, clearer code, potential issues.
- **Nice to have** — Optional optimization. Minor style tweaks, small performance gains.

For each finding, include:

1. **File and line reference** (e.g., `src/foo.ts:42`)
2. **What's wrong** — Clear description of the issue
3. **Why it matters** — Impact if not addressed
4. **Suggested fix** — Concrete code suggestion when possible

### Verdict

One of:

- **Approve** — No critical issues, good to merge
- **Request changes** — Has critical issues that need fixing
- **Comment** — Has suggestions but no blockers

## Guidelines

- Be specific and actionable. Avoid vague feedback like "could be improved."
- Reference the existing codebase conventions — don't impose external style preferences.
- Focus on the diff, not pre-existing issues in unchanged code.
- Keep the review concise. Don't repeat the same point for every occurrence.
- When suggesting a fix, show the actual code change.
- Flag any exposed secrets, credentials, API keys, or tokens in the diff as **Critical**.
