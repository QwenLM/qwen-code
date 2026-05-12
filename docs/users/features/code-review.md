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
Step 1:  Determine scope (local diff / PR worktree / file)
Step 2:  Load project review rules
Step 3:  Run deterministic analysis (linter, typecheck)    [zero LLM cost]
Step 4:  9 parallel review agents                          [9 LLM calls]
           |-- Agent 1: Correctness
           |-- Agent 2: Security
           |-- Agent 3: Code Quality
           |-- Agent 4: Performance & Efficiency
           |-- Agent 5: Test Coverage
           |-- Agent 6: Undirected Audit (3 personas: 6a/6b/6c)
           '-- Agent 7: Build & Test (runs shell commands)
Step 5:  Deduplicate --> Batch verify --> Aggregate         [1 LLM call]
Step 6:  Iterative reverse audit (1-3 rounds, gap finding) [1-3 LLM calls]
Step 7:  Present findings + verdict
Step 8:  Autofix (user-confirmed, optional)
Step 9:  Post PR inline comments (if requested)
Step 10: Save report + incremental cache
Step 11: Clean up (remove worktree + temp files)
```

### Review Agents

| Agent                             | Focus                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Agent 1: Correctness              | Logic errors, edge cases, null handling, race conditions, type safety                       |
| Agent 2: Security                 | Injection, XSS, SSRF, auth bypass, sensitive data exposure                                  |
| Agent 3: Code Quality             | Style consistency, naming, duplication, dead code                                           |
| Agent 4: Performance & Efficiency | N+1 queries, memory leaks, unnecessary re-renders, bundle size                              |
| Agent 5: Test Coverage            | Untested code paths in the diff, missing branch coverage, weak assertions                   |
| Agent 6: Undirected Audit         | 3 parallel personas (attacker / 3am-oncall / maintainer) — catches cross-dimensional issues |
| Agent 7: Build & Test             | Runs build and test commands, reports failures                                              |

All agents run in parallel (Agent 6 launches 3 persona variants concurrently, totaling 9 parallel tasks for same-repo reviews). Findings from Agents 1-6 are verified in a **single batch verification pass** (one agent reviews all findings at once, keeping verification cost fixed regardless of finding count). After verification, **iterative reverse audit** runs 1-3 rounds of gap-finding — each round receives the cumulative finding list from prior rounds, so successive rounds focus on whatever's left undiscovered. The loop stops as soon as a round returns "No issues found", or after 3 rounds (hard cap). Reverse audit findings skip verification (the agent already has full context) and are included as high-confidence results.

## Deterministic Analysis

Before the LLM agents run, `/review` automatically runs your project's existing linters and type checkers:

| Language              | Tools detected                                                   |
| --------------------- | ---------------------------------------------------------------- |
| TypeScript/JavaScript | `tsc --noEmit`, `npm run lint`, `eslint`                         |
| Python                | `ruff`, `mypy`, `flake8`                                         |
| Rust                  | `cargo clippy`                                                   |
| Go                    | `go vet`, `golangci-lint`                                        |
| Java                  | `mvn compile`, `checkstyle`, `spotbugs`, `pmd`                   |
| C/C++                 | `clang-tidy` (if `compile_commands.json` available)              |
| Other                 | Auto-discovered from CI config (`.github/workflows/*.yml`, etc.) |

For projects that don't match standard patterns (e.g., OpenJDK), `/review` reads CI configuration files to discover what lint/check commands the project uses. No user configuration needed.

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
- For PR reviews, fixes are committed and pushed from the worktree automatically — your working tree stays clean
- Nice to have and low-confidence findings are never auto-fixed
- PR review submission always uses the **pre-fix verdict** (e.g., "Request changes") since the remote PR hasn't been updated until the autofix push completes

## Worktree Isolation

When reviewing a PR, `/review` creates a temporary git worktree (`.qwen/tmp/review-pr-<number>`) instead of switching your current branch. This means:

- Your working tree, staged changes, and current branch are **never touched**
- Dependencies are installed in the worktree (`npm ci`, etc.) so linting and build/test work
- Build and test commands run in isolation without polluting your local build cache
- If anything goes wrong, your environment is unaffected — just delete the worktree
- The worktree is automatically cleaned up after the review completes
- If a review is interrupted (Ctrl+C, crash), the next `/review` of the same PR automatically cleans up the stale worktree before starting fresh
- Review reports and cache are saved to the main project directory (not the worktree)

## Cross-repo PR Review

You can review PRs from other repositories by passing the full URL:

```bash
/review https://github.com/other-org/other-repo/pull/456
```

This runs in **lightweight mode** — no worktree, no linter, no build/test, no autofix. The review is based on the diff text only (fetched via GitHub API). PR comments can still be posted if you have write access.

| Capability                                                 | Same-repo | Cross-repo                    |
| ---------------------------------------------------------- | --------- | ----------------------------- |
| LLM review (Agents 1-6 + verify + iterative reverse audit) | ✅        | ✅                            |
| Agent 7: Build & test                                      | ✅        | ❌ (no local codebase)        |
| Deterministic analysis (linter/typecheck)                  | ✅        | ❌                            |
| Cross-file impact analysis                                 | ✅        | ❌                            |
| Autofix                                                    | ✅        | ❌                            |
| PR inline comments                                         | ✅        | ✅ (if you have write access) |
| Incremental review cache                                   | ✅        | ❌                            |

## PR Inline Comments

Use `--comment` to post findings directly on the PR:

```bash
/review 123 --comment
```

Or, after running `/review 123`, type `post comments` to publish findings without re-running the review.

**What gets posted:**

- High-confidence Critical and Suggestion findings as inline comments on specific lines
- For Approve/Request changes verdicts: a review summary with the verdict
- For Comment verdict with all inline comments posted: no separate summary (inline comments are sufficient)
- Model attribution footer on each comment (e.g., _— qwen3-coder via Qwen Code /review_)

**What stays terminal-only:**

- Nice to have findings (including linter warnings)
- Low-confidence findings

**Self-authored PRs:** GitHub does not allow you to submit `APPROVE` or `REQUEST_CHANGES` reviews on your own pull request — both fail with HTTP 422. When `/review` detects that the PR author matches the current authenticated user, it automatically downgrades the API event to `COMMENT` regardless of verdict, so the submission still succeeds. The terminal still shows the honest verdict ("Approve" / "Request changes" / "Comment") — only the GitHub-side review event is neutralized. The actual findings still appear as inline comments on specific lines, so substantive feedback is unchanged.

**Re-reviewing a PR with prior Qwen Code comments:** when `/review` runs on a PR that already has previous Qwen Code review comments, it classifies them before posting new ones. Only **same-line overlap** (an existing comment on the same `(path, line)` as a new finding) prompts you to confirm — that's the case where you'd see a visual duplicate on the same code line. Comments from older commits, replied-to comments (treated as resolved), and comments that simply don't overlap with any new finding are silently skipped, with a terminal log line so you know what was filtered.

**CI / build status check before APPROVE:** if the verdict is "Approve", `/review` queries the PR's check-runs and commit statuses before submitting. If any check has failed (or all checks are still pending), the API event is automatically downgraded from `APPROVE` to `COMMENT`, with the review body explaining why. Rationale: the LLM review reads code statically and cannot see runtime test failures; approving while CI is red would be misleading. The inline findings are still posted unchanged. If you want to approve anyway (e.g., a known-flaky CI failure), submit the GitHub approval manually after verifying.

## CI Mode (`--ci`)

For non-interactive automation (e.g. the bundled PR-review GitHub Action), invoke the skill with `--ci`:

```bash
/review 123 --comment --ci
```

`--ci` changes the skill's behavior to be safe for `pull_request_target`-style workflows where the runner has access to repository secrets:

- **Static-only.** Skips dependency install, linters, build, and tests against the PR worktree. The `--ci` safety contract in `SKILL.md` Step 3.0 is the source of truth for disallowed interpreters and build tools, forbidden git/gh write paths, blocked filesystem regions, banned secret echoing, and disallowed `gh api` repository-mutating endpoints.
- **Non-interactive.** Skips Step 8 (Autofix), skips follow-up prompts, and answers presubmit overlap questions automatically (drops same-line overlap with prior Qwen comments instead of asking).
- **Treats PR content as data.** Diffs, descriptions, trigger comments, and `QWEN_REVIEW_ADDITIONAL_INSTRUCTIONS` are never executed as instructions. Any prompt-injection attempt is surfaced under a dedicated heading in the final review body.
- **Comment-only.** Pair with `--comment` to publish findings via a single PR review. Without `--comment`, the review still runs but only logs to the workflow step summary (a "dry run").

See `.github/workflows/qwen-code-pr-review.yml` for the reference workflow that wires `--ci` to a `pull_request_target` trigger restricted to `OWNER`/`MEMBER`/`COLLABORATOR`. The workflow expects `QWEN_PR_REVIEW_MODEL` as a repository variable and `REVIEW_OPENAI_API_KEY` / `REVIEW_OPENAI_BASE_URL` as review-specific repository secrets; these secrets are mapped to Qwen Code's `OPENAI_*` environment only for the preflight and review processes. External-contributor PRs will not be auto-reviewed on `opened`; a maintainer must comment `@qwen /review` to start the review for those PRs (intentional safety boundary).

## Follow-up Actions

After the review, context-aware tips appear as ghost text. Press Tab to accept:

| State after review                 | Tip                | What happens                            |
| ---------------------------------- | ------------------ | --------------------------------------- |
| Local review with unfixed findings | `fix these issues` | LLM interactively fixes each finding    |
| PR review with findings            | `post comments`    | Posts PR inline comments (no re-review) |
| PR review, zero findings           | `post comments`    | Approves the PR on GitHub (LGTM)        |
| Local review, all clear            | `commit`           | Commits your changes                    |

Note: `fix these issues` is only available for local reviews. For PR reviews, use Autofix (Step 8) — the worktree is cleaned up after the review, so post-review interactive fixing is not possible.

## Project Review Rules

You can customize review criteria per project. `/review` reads rules from these files (in order):

1. `.qwen/review-rules.md` (Qwen Code native)
2. `.github/copilot-instructions.md` (preferred) or `copilot-instructions.md` (fallback — only one is loaded, not both)
3. `AGENTS.md` — `## Code Review` section
4. `QWEN.md` — `## Code Review` section

Rules are injected into the LLM review agents (1-6) as additional criteria. For PR reviews, rules are read from the **base branch** to prevent a malicious PR from injecting bypass rules.

Example `.qwen/review-rules.md`:

```markdown
# Review Rules

- All API endpoints must validate authentication
- Database queries must use parameterized statements
- React components must not use inline styles
- Error messages must not expose internal paths
```

### Review-readiness gates (`--ci` only)

When the skill is run with `--ci`, three readiness checks run before detailed code review:

| Gate                | Default behavior | How to opt into blocking                                                    |
| ------------------- | ---------------- | --------------------------------------------------------------------------- |
| Scope               | **blocking**     | Always on. Threshold = `QWEN_PR_REVIEW_MAX_CHANGED_LINES` (default 1500).   |
| Product direction   | advisory         | Add the line `product-direction-gate: blocking` to `.qwen/review-rules.md`. |
| Validation evidence | advisory         | No opt-in today; surface in review body only.                               |

Advisory gates surface their concern inside the Step 9 review body so a maintainer can react, but they do **not** stop the review. Blocking gates skip Steps 3–9 and post a single, contributor-friendly process comment with a model footer and a "reply if false-positive" line.

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

For same-repo reviews, results are saved as a Markdown file in your project's `.qwen/reviews/` directory (cross-repo lightweight reviews skip report persistence):

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

## Token Efficiency

The review pipeline uses a bounded number of LLM calls regardless of how many findings are produced:

| Stage                            | LLM calls         | Notes                                               |
| -------------------------------- | ----------------- | --------------------------------------------------- |
| Deterministic analysis (Step 3)  | 0                 | Shell commands only                                 |
| Review agents (Step 4)           | 9 (or 8)          | Run in parallel; Agent 7 skipped in cross-repo mode |
| Batch verification (Step 5)      | 1                 | Single agent verifies all findings at once          |
| Iterative reverse audit (Step 6) | 1-3               | Loops until "No issues found" or 3-round cap        |
| **Total**                        | **11-13 (10-12)** | Same-repo: 11-13; cross-repo: 10-12 (no Agent 7)    |

Most PRs converge to the lower end of the range (1 reverse audit round); the cap prevents runaway cost on pathological cases.

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
