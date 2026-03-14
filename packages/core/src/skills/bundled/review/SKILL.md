---
name: review
description: Review changed code for correctness, security, code quality, and performance. Use when the user asks to review code changes, a PR, or specific files. Invoke with `/review`, `/review <pr-number>`, or `/review <file-path>`.
allowedTools:
  - task
  - run_shell_command
  - grep_search
  - read_file
  - glob
  - multi_model_review
---

# Code Review

You are an expert code reviewer. Your job is to review code changes and provide actionable feedback.

## Step 1: Determine what to review

Based on the arguments provided:

- **No arguments**: Review local uncommitted changes
  - Run `git diff` and `git diff --staged` to get all changes
  - If both diffs are empty, inform the user there are no changes to review and stop here — do not proceed to the review agents

- **PR number or URL** (e.g., `123` or `https://github.com/.../pull/123`):
  - Run `gh pr view <number>` to get PR details
  - Run `gh pr diff <number>` to get the diff

- **File path** (e.g., `src/foo.ts`):
  - Run `git diff HEAD -- <file>` to get recent changes
  - If no diff, read the file and review its current state

## Step 2: Try multi-model review

Unless the user explicitly specified `--single`, check if the `multi_model_review` tool is available. If it is, call it with the diff obtained in Step 1.

- If the tool returns a **complete review report** (from independent arbitration): present it directly as the final output using the format in Step 4, then stop.
- If the tool returns **collected reviews from multiple models** (for session-model arbitration): you are the arbitrator. Merge, deduplicate, and validate findings from all models, then produce the final report using the format in Step 4. You have access to the full project context and tools to verify findings if needed.

If the `multi_model_review` tool is not available (not in your tool list), or the user specified `--single`, proceed directly to Step 3.

## Step 3: Single-model parallel multi-dimensional review

This step is used when multi-model review is not available, or when the user specified `--single`.

Launch **four parallel review agents** to analyze the changes from different angles. Each agent should focus exclusively on its dimension.

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

## Step 4: Aggregate and present findings

Combine results into a single, well-organized review. Use this format:

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
