---
name: review
description: Review changed code for correctness, security, code quality, and performance. Use when the user asks to review code changes, a PR, or specific files. Invoke with `/review`, `/review <pr-number>`, `/review <file-path>`, or `/review <pr-number> --comment` to post inline comments on the PR.
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

Your goal here is to understand the scope of changes so you can dispatch agents effectively in Step 2.

First, check if `--comment` flag is present in the arguments. If so, note that findings should be posted as PR inline comments in Step 4. Remove `--comment` from the arguments before proceeding. If `--comment` is used but the review target is not a PR, warn the user: "Warning: `--comment` flag is ignored because the review target is not a PR." and continue without it.

Based on the remaining arguments:

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

**Do NOT flag:**
- Pre-existing issues in unchanged code (focus on the diff only)
- Style, formatting, or naming that matches surrounding codebase conventions
- Pedantic nitpicks that a senior engineer would not flag
- Issues that a linter or type checker would catch automatically
- Subjective "consider doing X" suggestions that aren't real problems
- If you're unsure whether something is a problem, do NOT report it

Each agent must return findings in this structured format (one per issue):

```
- **File:** <file path>:<line number or range>
- **Issue:** <clear description of the problem>
- **Impact:** <why it matters>
- **Suggested fix:** <concrete code suggestion when possible, or "N/A">
- **Severity:** Critical | Suggestion | Nice to have
```

If an agent finds no issues in its dimension, it should explicitly return "No issues found."

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

## Step 2.5: Deduplicate and verify

### Deduplication

Before verification, merge findings that refer to the same issue (same file, same line range, same root cause) even if reported by different agents. Keep the most detailed description and note which agents flagged it.

### Independent verification

For each **unique** finding, launch an **independent verification agent** (run all verification agents in parallel).

Each verification agent receives:
- The finding description (what's wrong, file, line)
- The command to obtain the diff (as determined in Step 1)
- Access to read files and search the codebase

Each verification agent must **independently** (without seeing other agents' findings):
1. Read the actual code at the referenced file and line
2. Check surrounding context — callers, type definitions, tests, related modules
3. Verify the issue is not a false positive — reject if it falls under any of these:
   - Pre-existing issue in unchanged code
   - Style/naming that matches surrounding conventions
   - Pedantic nitpick a senior engineer would not flag
   - Issue a linter or type checker would catch automatically
   - Subjective suggestion that isn't a real problem
4. Return a verdict:
   - **confirmed** — with severity: Critical, Suggestion, or Nice to have
   - **rejected** — with a one-line reason why it's not a real issue

**When uncertain, lean toward rejecting.** The goal is high signal, low noise — it's better to miss a minor suggestion than to report a false positive.

**After all verification agents complete:** remove all rejected findings. Only confirmed findings proceed to Step 3.

## Step 3: Present findings

Present the confirmed findings from Step 2.5 as a single, well-organized review. Use this format:

### Summary

A 1-2 sentence overview of the changes and overall assessment. Include verification stats: "X findings reported, Y confirmed after independent verification."

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

## Step 4: Post PR inline comments (only if `--comment` flag was set)

Skip this step if `--comment` was not specified or the review target is not a PR.

First, get the repository owner/repo and the latest commit SHA on the PR branch:

```bash
gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"'
git rev-parse HEAD
```

Then, for each confirmed finding, post an **inline comment** on the specific file and line using `gh api`:

```bash
# Single-line finding:
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
  -f body="**[{severity}]** {issue description}

{suggested fix}" \
  -f commit_id="{commit_sha}" \
  -f path="{file_path}" \
  -F line={line_number} \
  -f side="RIGHT"

# Multi-line finding (e.g., line range 42-50):
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
  -f body="**[{severity}]** {issue description}

{suggested fix}" \
  -f commit_id="{commit_sha}" \
  -f path="{file_path}" \
  -F start_line={start_line} \
  -F line={end_line} \
  -f side="RIGHT"
```

If posting an inline comment fails (e.g., line not part of the diff, auth error), include the finding in the overall review summary comment instead.

**Important rules:**
- Only post **ONE comment per unique issue** — do not duplicate across lines
- Keep each comment concise and actionable
- Include the severity tag (Critical/Suggestion/Nice to have) at the start of each comment
- Include the suggested fix in the comment body when available

After posting all inline comments, submit an overall review summary using:

```bash
gh pr review {pr_number} --comment --body "{summary + verdict}"
```

If there are **no confirmed findings**, post a single comment:

```bash
gh pr review {pr_number} --comment --body "No issues found. LGTM! ✅"
```

## Step 5: Restore environment

If you checked out a PR branch in Step 1, restore the original state now: check out the original branch, `git stash pop` if changes were stashed, and remove the temp file.

This step runs **after** Step 4 to ensure the PR branch is still checked out when posting inline comments (Step 4 needs the correct commit SHA from the PR branch).

## Guidelines

- Be specific and actionable. Avoid vague feedback like "could be improved."
- Reference the existing codebase conventions — don't impose external style preferences.
- Focus on the diff, not pre-existing issues in unchanged code.
- Keep the review concise. Don't repeat the same point for every occurrence.
- When suggesting a fix, show the actual code change.
- Flag any exposed secrets, credentials, API keys, or tokens in the diff as **Critical**.
