# Code Review

> Review code changes for correctness, security, performance, and code quality using `/review`.

## Quick Start

```bash
# Review local uncommitted changes
/review

# Review a pull request (by number or URL)
/review 123
/review https://github.com/org/repo/pull/123

# Review and post inline comments on the PR
/review 123 --comment

# Review a specific file
/review src/utils/auth.ts
```

If there are no uncommitted changes, `/review` will let you know and stop — no agents are launched.

## How It Works

The `/review` command runs a multi-stage pipeline:

```
Step 1:   Determine scope (local diff / PR / file)
Step 1.1: Load project review rules
Step 1.5: Run deterministic analysis (linters, type checkers)
Step 2:   5 parallel review agents (correctness, quality, performance, undirected, build/test)
Step 2.5: Deduplicate → verify → aggregate findings
Step 2.6: Reverse audit — find issues all agents missed
Step 3:   Present findings with verdict
Step 3.5: Offer autofix for fixable issues
Step 4:   Post PR inline comments (if requested)
Step 4.5: Save report and incremental cache
Step 5:   Clean up (remove worktree and temp files)
```

### Review Agents

| Agent                             | Focus                                                              |
| --------------------------------- | ------------------------------------------------------------------ |
| Agent 1: Correctness & Security   | Logic errors, null handling, race conditions, injection, XSS, SSRF |
| Agent 2: Code Quality             | Style consistency, naming, duplication, dead code                  |
| Agent 3: Performance & Efficiency | N+1 queries, memory leaks, unnecessary re-renders, bundle size     |
| Agent 4: Undirected Audit         | Business logic, boundary interactions, hidden coupling             |
| Agent 5: Build & Test             | Runs build and test commands, reports failures                     |

All agents run in parallel. Each finding is independently verified by a separate verification agent to reduce false positives. After verification, a **reverse audit agent** reviews the diff with knowledge of all confirmed findings to catch issues that every other agent missed.

## Deterministic Analysis

Before the LLM agents run, `/review` automatically runs your project's existing linters and type checkers:

| Language              | Tools detected                           |
| --------------------- | ---------------------------------------- |
| TypeScript/JavaScript | `tsc --noEmit`, `npm run lint`, `eslint` |
| Python                | `ruff`, `mypy`, `flake8`                 |
| Rust                  | `cargo clippy`                           |
| Go                    | `go vet`, `golangci-lint`                |

Deterministic findings are tagged with `[linter]` or `[typecheck]` and skip LLM verification — they are ground truth.

- **Errors** → Critical severity
- **Warnings** → Nice to have (terminal only, not posted as PR comments)

If a tool is not installed or times out, it is skipped with an informational note.

## Severity Levels

| Severity         | Meaning                                                             | Posted as PR comment?      |
| ---------------- | ------------------------------------------------------------------- | -------------------------- |
| **Critical**     | Must fix before merging (bugs, security, data loss, build failures) | Yes (high-confidence only) |
| **Suggestion**   | Recommended improvement                                             | Yes (high-confidence only) |
| **Nice to have** | Optional optimization                                               | No (terminal only)         |

Low-confidence findings appear in a separate "Needs Human Review" section in the terminal and are never posted as PR comments.

## Autofix

After presenting findings, `/review` offers to auto-apply fixes for Critical and Suggestion findings that have clear solutions:

```
Found 3 issues with auto-fixable suggestions. Apply auto-fixes? (y/n)
```

- Fixes are applied using the `edit` tool (targeted replacements, not full-file rewrites)
- Per-file linter checks run after fixes to verify they don't introduce new issues
- For PR reviews, fixes are committed and pushed from the worktree automatically
- Nice to have and low-confidence findings are never auto-fixed
- For PR reviews, autofix operates in an isolated worktree — your working tree stays clean. Fixes are committed and pushed directly from the worktree.

## Worktree Isolation

When reviewing a PR, `/review` creates a temporary git worktree (`.qwen/tmp/review-pr-<number>`) instead of switching your current branch. This means:

- Your working tree, staged changes, and current branch are **never touched**
- Dependencies are installed in the worktree (`npm ci`, etc.) so linting and build/test work
- Build and test commands run in isolation without polluting your local build cache
- If anything goes wrong, your environment is unaffected — just delete the worktree
- The worktree is automatically cleaned up after the review completes
- Review reports and cache are saved to the main project directory (not the worktree)

## PR Inline Comments

Use `--comment` to post findings directly on the PR:

```bash
/review 123 --comment
```

Or, after running `/review 123`, type `post comments` to publish findings without re-running the review.

**What gets posted:**

- High-confidence Critical and Suggestion findings as inline comments on specific lines
- A review summary with verdict (Approve / Request changes / Comment)
- Model attribution footer (e.g., _Reviewed by qwen3-coder via Qwen Code /review_)

**What stays terminal-only:**

- Nice to have findings (including linter warnings)
- Low-confidence findings

## Follow-up Actions

After the review, context-aware tips appear as ghost text. Press Tab to accept:

| State after review      | Tip                | What happens                            |
| ----------------------- | ------------------ | --------------------------------------- |
| Unfixed findings remain | `fix these issues` | LLM interactively fixes each finding    |
| PR review with findings | `post comments`    | Posts PR inline comments (no re-review) |
| Local review, all clear | `commit`           | Commits your changes                    |

## Project Review Rules

You can customize review criteria per project. `/review` reads rules from these files (in order):

1. `.qwen/review-rules.md` (Qwen Code native)
2. `.github/copilot-instructions.md` (preferred) or `copilot-instructions.md` (fallback — only one is loaded, not both)
3. `AGENTS.md` — `## Code Review` section
4. `QWEN.md` — `## Code Review` section

Rules are injected into the LLM review agents (1-4) as additional criteria. For PR reviews, rules are read from the **base branch** to prevent a malicious PR from injecting bypass rules.

Example `.qwen/review-rules.md`:

```markdown
# Review Rules

- All API endpoints must validate authentication
- Database queries must use parameterized statements
- React components must not use inline styles
- Error messages must not expose internal paths
```

## Incremental Review

When reviewing a PR that was previously reviewed, `/review` only examines changes since the last review:

```bash
# First review — full review, cache created
/review 123

# PR updated with new commits — only new changes reviewed
/review 123
```

### Cross-model review

If you switch models (via `/model`) and re-review the same PR, `/review` detects the model change and runs a full review instead of skipping:

```bash
# Review with model A
/review 123

# Switch model
/model

# Review again — full review with model B (not skipped)
/review 123
# → "Previous review used qwen3-coder. Running full review with gpt-4o for a second opinion."
```

Cache is stored in `.qwen/review-cache/` and tracks both the commit SHA and model ID. Make sure this directory is in your `.gitignore` (a broader rule like `.qwen/*` also works). If the cached commit was rebased away, it falls back to a full review.

## Review Reports

Every review is saved as a Markdown file in your project's `.qwen/reviews/` directory:

```
.qwen/reviews/2026-04-06-143022-pr-123.md
.qwen/reviews/2026-04-06-150510-local.md
```

Reports include: timestamp, diff stats, deterministic analysis results, all findings with verification status, and the verdict.

## Cross-file Impact Analysis

When code changes modify exported functions, classes, or interfaces, the review agents automatically search for all callers and check compatibility:

- Parameter count/type changes
- Return type changes
- Removed or renamed public methods
- Breaking API changes

For large diffs (>10 modified symbols), analysis prioritizes functions with signature changes.

## What's NOT Flagged

The review intentionally excludes:

- Pre-existing issues in unchanged code (focus on the diff only)
- Style/formatting/naming that matches your codebase conventions
- Issues a linter or type checker would catch (handled by deterministic analysis)
- Subjective "consider doing X" suggestions without a real problem
- Minor refactoring that doesn't fix a bug or risk
- Missing documentation unless the logic is genuinely confusing
- Issues already discussed in existing PR comments (avoids duplicating human feedback)

## Design Philosophy

> **Silence is better than noise.** Every comment should be worth the reader's time.

- If unsure whether something is a problem → don't report it
- Linter/typecheck issues are handled by tools, not LLM guesses
- Same pattern across N files → aggregated into one finding
- PR comments are high-confidence only
- Style/formatting issues matching codebase conventions are excluded
