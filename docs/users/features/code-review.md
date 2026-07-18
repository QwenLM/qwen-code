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

# Quick unverified pass (no subagents)
/review --effort low
/review 123 --effort medium
```

If there are no uncommitted changes, `/review` will let you know and stop — no agents are launched.

## Effort Levels

`--effort low|medium|high` trades depth for speed:

| Level    | What runs                                                                                                                                                                 | Findings cap        | Verdict                             | Posts to PR      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------- | ---------------- |
| `low`    | One inline pass over the diff — no subagents, no build/test, no project rules                                                                                             | 8 (unverified)      | None                                | Never            |
| `medium` | Finder angles run sequentially in one context: line-by-line, removed-behavior, cross-file trace (same-repo only), quality/altitude, performance, project-rule conventions | 12 (unverified)     | None                                | Never            |
| `high`   | Full pipeline: 12 parallel agents → sharded verification → iterative reverse audit                                                                                        | Uncapped (verified) | Approve / Request changes / Comment | With `--comment` |

Defaults: **high** for PR reviews, **medium** for local and file reviews. An effective `--comment` forces high (posted comments must survive verification) — on a non-PR target `--comment` is ignored with a warning and does **not** change the effort. Medium runs no dedicated security or test-coverage pass — use `--effort high` for security-sensitive changes. Worktree isolation applies to same-repo PR reviews; cross-repo PRs run in lightweight mode (diff-only, no worktree or build/test). Quick passes are labeled unverified, never emit a verdict, and never write the incremental review cache, so a later `--effort high` run is never skipped as "already reviewed". The diff-obtaining mechanics are identical at every level — PR reviews always use the isolated worktree and the same base resolution, so the review is never against the wrong base. One scope difference remains: the incremental cache is high-only, so a high re-review may cover just the new commits (`lastCommitSha..HEAD`) while low/medium always review the full PR diff.

## How It Works

The `/review` command runs a multi-stage pipeline:

```
Step 1:  Determine scope + effort level (local diff / PR worktree / file)
         Capture the diff to a file + partition it into chunks
Step 2:  Load project review rules (medium/high)
Step 3C: low/medium effort: inline pass, no subagents  [0 subagent calls]
Step 3A: high, <=500 src AND <=3200 total: 12 agents       [12+ LLM calls]
           |-- Agent 0: Issue Fidelity & Root-Cause Ownership
           |-- Agent 1a: Correctness — line-by-line scan
           |     (incl. language-pitfall + wrapper-routing checks)
           |-- Agent 1b: Correctness — removed-behavior audit
           |-- Agent 1c: Correctness — cross-file tracer
           |-- Agent 2: Security
           |-- Agent 3: Code Quality (incl. altitude)
           |-- Agent 4: Performance & Efficiency
           |-- Agent 5: Test Coverage
           |-- Agent 6: Undirected Audit (3 personas: 6a/6b/6c)
           |-- Agent 8: Diff-specialized finders (0-2, only when
           |     the diff's domain calls for them)
           '-- Agent 7: Build & Test (runs shell commands)
Step 3B: high, >500 src OR >3200 total: territory x dim.   [N+5..7+3H calls]
           (N chunks, 5-7 whole-diff agents, 3 invariant
            agents per heavy file H)
           |-- 1 chunk agent per ~400 diff lines (all dimensions,
           |     its territory only, returns a coverage receipt)
           |-- 3 invariant agents per heavily-rewritten source
           |     file (whole file; state/timers, counters/
           |      returns/errors, config/early-returns)
           |-- Agent 0: Issue Fidelity      (whole diff)
           |-- Agent 7: Build & Test        (whole repo)
           |-- Agent 1b: Removed-behavior   (whole diff — the
           |     cross-chunk half; chunks keep the local half)
           |-- Agent 1c: Cross-file tracer  (whole diff)
           |-- Agent 8: Specialized finders (whole diff, 0-2)
           '-- Test coverage matrix         (whole diff)
Step 4:  Deduplicate --> Sharded verify (<=8 findings each)
           --> Aggregate                    [ceil(F/8) calls, F=findings]
Step 5:  Iterative reverse audit, fanned out per chunk;
           stop after 2 consecutive dry rounds (cap 5)
Step 6:  Present findings + verdict (high; quick passes: findings only)
Step 7:  Submit PR review (inline comments, if requested; high only)
Step 8:  Save report + incremental cache (cache: high only)
Step 9:  Clean up (remove worktree + temp files)
```

Steps 3A/3B/4/5 are the high-effort pipeline; at `--effort low|medium` a single inline pass (Step 3C) replaces them.

### Review Agents

| Agent                             | Focus                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 0: Issue Fidelity           | Linked issue evidence, root-cause ownership, and whether the PR solves the reported problem                                                                                                                                                                                                     |
| Agent 1a: Line-by-line scan       | Walks every hunk plus its enclosing function: wrong conditions, off-by-one, missing `await`, language-specific pitfalls, wrapper/proxy routing                                                                                                                                                  |
| Agent 1b: Removed-behavior audit  | Walks every deleted/replaced line: names the invariant it enforced and hunts for where the new code re-establishes it — including removed **exports**, whose replacement often lives in another file and quietly changed a default. In 3B it runs whole-diff (chunk agents keep the local half) |
| Agent 1c: Cross-file tracer       | Walks every changed symbol's callers (consumer direction) and every added field's read sites (producer direction), plus same-PR callee changes                                                                                                                                                  |
| Agent 2: Security                 | Injection, XSS, SSRF, auth bypass, sensitive data exposure                                                                                                                                                                                                                                      |
| Agent 3: Code Quality             | Style consistency, naming, duplication/reuse, altitude (fix at the right depth, not a bandaid on shared infrastructure), dead code                                                                                                                                                              |
| Agent 4: Performance & Efficiency | N+1 queries, memory leaks, unnecessary re-renders, bundle size                                                                                                                                                                                                                                  |
| Agent 5: Test Coverage            | Untested code paths in the diff, missing branch coverage, weak assertions                                                                                                                                                                                                                       |
| Agent 6: Undirected Audit         | 3 parallel personas (attacker / 3am-oncall / maintainer) — catches cross-dimensional issues                                                                                                                                                                                                     |
| Agent 7: Build & Test             | Runs build and test commands, reports failures                                                                                                                                                                                                                                                  |
| Agent 8: Diff-specialized finders | 0-2 extra finders written per-review when the diff concentrates in a domain with known failure modes (reconnect logic, module loaders, schedulers, codecs)                                                                                                                                      |

The three Correctness agents are **procedural**: each is defined by how it walks the diff (line-by-line / deleted lines / cross-file edges), not by a bug taxonomy — so their coverage is complementary instead of overlapping. All agents run in parallel (Agent 1 launches 3 procedural variants and Agent 6 launches 3 persona variants concurrently, totaling 12 parallel tasks for same-repo PR reviews, plus 0-2 Agent 8 finders when the diff's domain calls for them — so 12-14 in practice; Agent 0 is skipped for local-diff and file-path reviews, which run 11-13; cross-repo lightweight mode also skips Agents 1c and 7, running 10-12).

Every finding must state a **failure scenario** — the concrete input, state, or timing that triggers it and the wrong outcome that results (for quality findings, the concrete cost instead). A finding that cannot name its scenario is dropped at the source, and verification re-traces the claimed scenario through the real code rather than judging the finding's prose.

Once a PR carries more than 500 lines of **source** change — or more than 3 200 diff lines in total, past which the eleven whole-diff readers are each too diluted to read carefully (an attention bound, not a promise of fewer calls — heavy files and specialized finders can make 3B cost more) — this dimension fan-out is replaced by a **territory × dimension** fan-out: the diff is split into ~400-line chunks — boundaries fall on hunk boundaries, and a hunk too large to fit is split only at a top-level declaration, never inside a function — and each chunk gets its own agent that applies every review dimension to that chunk alone.

The gate deliberately counts source lines rather than diff lines. Test code, prose and lockfiles dominate diff size — across this repo's last 40 merged PRs the median diff is 41% tests — so a gate on raw size would carve a 173-line production change into territories just because it shipped 489 lines of new tests, leaving that production code with one reviewer instead of ten lenses (the diff-reading dimension agents — twelve minus Issue Fidelity and Build & Test). Chunking still covers every line either way, tests included; what the gate decides is how many reviewers there are and what each is asked to do. Ten diff-reading lenses all walking one large diff read the same early hunks ten times over; one agent per chunk means every line of the diff has exactly one accountable reviewer. Each chunk agent returns a `Covered:` receipt, and a chunk with no receipt is re-reviewed before the run proceeds — so "no blockers" can never be reported over code that nobody read.

A **source** file that is largely rewritten (an existing file of 300+ lines that is now 40%+ new, or has 800+ changed lines) also gets **three whole-file invariant agents**. Test and generated files never qualify — the checklist asks about fields, timers, and error taxonomies, which a rewritten test file does not have. Its bugs are usually not inside any one hunk but _between_ the new lines — a timer armed near the top of the file and a teardown path two thousand lines below. Each agent reads the whole post-change file and walks two or three items of a fixed checklist: mutable fields cleared on every exit path, timers cancelled on every close (and cancellation not discarding captured data), map inserts matched by deletes, retry counters incremented at every entry, status return values actually checked, error codes exhaustively classified permanent vs transient, config fields honoured on every path, and early returns that skip a required side effect.

The checklist is split three ways on purpose. Handing one agent all eight checks over a 2 400-line file gets one of them done properly; three agents with two or three checks each get all of them done. Chunk agents do not substitute for this — on PR #6457 they held every one of these defects inside their assigned territory and reported none. What they lacked was not the lines but the question.

Findings are verified in **sharded batches** (at most 8 findings per verification agent, all launched together). A verifier may reject a Critical only by quoting the code that contradicts it (or when the diff's own comments document the flagged behavior as deliberate); anything less certain is downgraded to low confidence rather than deleted — a silently rejected Critical is invisible to every later stage, while a downgraded one still reaches a human. After verification, **iterative reverse audit** hunts for gaps, fanned out one auditor per chunk per round, each with the cumulative finding list. The loop stops after **two consecutive dry rounds** (or 5 rounds, hard cap — reported as such rather than as convergence). One dry round is not evidence of convergence, and reverse-audit findings are verified like any other.

## Severity Levels

| Severity         | Meaning                                                             | Posted as PR comment?      |
| ---------------- | ------------------------------------------------------------------- | -------------------------- |
| **Critical**     | Must fix before merging (bugs, security, data loss, build failures) | Yes (high-confidence only) |
| **Suggestion**   | Recommended improvement                                             | Yes (high-confidence only) |
| **Nice to have** | Optional optimization                                               | No (terminal only)         |

Low-confidence findings appear in a separate "Needs Human Review" section in the terminal and are never posted as PR comments.

## Worktree Isolation

When reviewing a PR, `/review` creates a temporary git worktree (`.qwen/tmp/review-pr-<number>`) instead of switching your current branch. This means:

- Your working tree, staged changes, and current branch are **never touched**
- Dependencies are installed in the worktree (`npm ci`, etc.) so build/test work
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

This runs in **lightweight mode** — no worktree, no build/test. The review is based on the diff text only (fetched via GitHub API). PR comments can still be posted if you have write access.

| Capability                                                            | Same-repo | Cross-repo                     |
| --------------------------------------------------------------------- | --------- | ------------------------------ |
| LLM review (Agents 0, 1a, 1b, 2-6 + verify + iterative reverse audit) | ✅        | ✅                             |
| Agent 1c: Cross-file tracer                                           | ✅        | ❌ (no local codebase to grep) |
| Agent 7: Build & test                                                 | ✅        | ❌ (no local codebase)         |
| Agent 8: Diff-specialized finders (0-2, when the domain calls for it) | ✅        | ✅ (needs only the diff)       |
| PR inline comments                                                    | ✅        | ✅ (if you have write access)  |
| Incremental review cache                                              | ✅        | ❌                             |

## PR Inline Comments

Use `--comment` to post findings directly on the PR:

```bash
/review 123 --comment
```

Or, after running `/review 123`, type `post comments` to publish findings without re-running the review.

**What gets posted:**

- High-confidence Critical and Suggestion findings as inline comments on specific lines, each prefixed with `**[Critical]**` or `**[Suggestion]**` so blockers are distinguishable from recommendations
- Where the fix is a single localized edit, a ` ```suggestion ` block you can apply in one click
- For Approve/Request changes verdicts: a review summary with the verdict
- For Comment verdict with all inline comments posted: no separate summary (inline comments are sufficient)
- Model attribution footer on each comment (e.g., _— qwen3-coder via Qwen Code /review_)

**What stays terminal-only:**

- Nice to have findings
- Low-confidence findings

**Self-authored PRs:** GitHub does not allow you to submit `APPROVE` or `REQUEST_CHANGES` reviews on your own pull request — both fail with HTTP 422. When `/review` detects that the PR author matches the current authenticated user, it automatically downgrades the API event to `COMMENT` regardless of verdict, so the submission still succeeds. The terminal still shows the honest verdict ("Approve" / "Request changes" / "Comment") — only the GitHub-side review event is neutralized. The actual findings still appear as inline comments on specific lines, so substantive feedback is unchanged.

**Re-reviewing a PR with prior Qwen Code comments:** when `/review` runs on a PR that already has previous Qwen Code review comments, it classifies them before posting new ones. Only **same-line overlap** (an existing comment on the same `(path, line)` as a new finding) prompts you to confirm — that's the case where you'd see a visual duplicate on the same code line. Comments from older commits, replied-to comments (treated as resolved), and comments that simply don't overlap with any new finding are silently skipped, with a terminal log line so you know what was filtered.

**CI / build status check before APPROVE:** if the verdict is "Approve", `/review` queries the PR's check-runs and commit statuses before submitting. If any check has failed (or all checks are still pending), the API event is automatically downgraded from `APPROVE` to `COMMENT`, with the review body explaining why. Rationale: the LLM review reads code statically and cannot see runtime test failures; approving while CI is red would be misleading. The inline findings are still posted unchanged. If you want to approve anyway (e.g., a known-flaky CI failure), submit the GitHub approval manually after verifying.

## Follow-up Actions

After the review, context-aware tips appear as ghost text. Press Tab to accept:

| State after review                 | Tip                | What happens                            |
| ---------------------------------- | ------------------ | --------------------------------------- |
| Local review with unfixed findings | `fix these issues` | LLM interactively fixes each finding    |
| PR review with findings            | `post comments`    | Posts PR inline comments (no re-review) |
| PR review, zero findings           | `post comments`    | Approves the PR on GitHub (LGTM)        |
| Local review, all clear            | `commit`           | Commits your changes                    |

Note: `fix these issues` is only available for local reviews. For PR reviews the worktree is cleaned up after the review, so post-review interactive fixing is not possible — use `--comment` or `post comments` to publish findings instead.

## Project Review Rules

You can customize review criteria per project. `/review` reads rules from these files (in order):

1. `.qwen/review-rules.md` (Qwen Code native)
2. `.github/copilot-instructions.md` (preferred) or `copilot-instructions.md` (fallback — only one is loaded, not both)
3. `AGENTS.md` — `## Code Review` section
4. `QWEN.md` — `## Code Review` section

Rules are injected into the LLM review agents (0-6) as additional criteria. For PR reviews, rules are read from the **base branch** to prevent a malicious PR from injecting bypass rules.

## Issue Fidelity

For bugfix PRs, the Issue Fidelity agent fetches issue evidence directly instead of relying on PR description text. It uses `gh pr view <pr> --repo <owner/repo> --json closingIssuesReferences` for GitHub's strong closing-issue metadata, then `gh issue view <number> --repo <issue_owner>/<issue_repo> --json title,body,comments` for the original report and discussion — the `--json` form includes the issue **body** (the reporter's original repro), which `--comments` alone omits, and the issue's own repository is read from each reference (a PR can close an issue in a different repo). This agent runs only for PR targets; local-diff and file-path reviews skip it.

`closingIssuesReferences` is a discovery hint rather than proof the author linked the right issue: if it is empty but the PR references an apparent target issue, the agent still fetches it after judging relevance. Fetched issue text is treated as untrusted data (facts extracted, embedded instructions ignored). For relevant issues, the original reproduction, observed payload, expected behavior, and maintainer comments are treated as the highest-priority evidence for whether the PR fixes the right problem.

If the issue evidence shows an upstream service or provider returned malformed data outside the client contract, client-side parser or sanitizer changes are not treated as a valid root-cause fix unless a maintainer explicitly requested a defensive workaround. A test that replays malformed upstream output proves only that the workaround handles that shape; it does not prove the workaround is architecturally appropriate.

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

Cache is stored in `.qwen/review-cache/` and tracks both the commit SHA and model ID. Make sure this directory is in your `.gitignore` (a broader rule like `.qwen/*` also works). If the cached commit was rebased away, it falls back to a full review. Only high-effort reviews consult or write the cache — a `--effort low|medium` quick pass never counts as "already reviewed".

## Review Reports

For same-repo reviews, results are saved as a Markdown file in your project's `.qwen/reviews/` directory (cross-repo lightweight reviews skip report persistence):

```
.qwen/reviews/2026-04-06-143022-pr-123.md
.qwen/reviews/2026-04-06-150510-local.md
```

Reports include: timestamp, diff stats, build/test results, all findings with verification status, and the verdict.

The deterministic halves of the pipeline — argument parsing (`qwen review parse-args`) and the event/body decision (`qwen review compose-review`) — are tested subcommands rather than prompt text, so `--effort` grammar, `--comment` forcing, verdict caps, and downgrade behavior are pinned by unit tests and cannot drift with the model.

**GitHub Enterprise:** reviewing a PR URL on a non-`github.com` host routes every GitHub call at that host — the review subcommands (`fetch-pr`, `pr-context`, `presubmit`) accept `--host` and set it in code, so a forgotten host cannot silently retarget the review at `github.com`.

Every run ends with one machine-readable line (`Review complete: <target> — <disposition>`), so scripts and CI wrappers can detect completion and outcome with a single `^Review complete: ` match.

## Cross-file Impact Analysis

A dedicated cross-file tracer (Agent 1c) owns this walk end-to-end. When code changes modify exported functions, classes, or interfaces, it searches for all callers and checks compatibility:

- Parameter count/type changes
- Return type changes
- Removed or renamed public methods
- Breaking API changes

It also walks the **producer direction**: every field, option, or optional parameter the diff adds is traced to its read sites — including files the diff never touches. A live code path reading a field that nothing populates means the feature it gates silently does nothing, and that is flagged as Critical at the read site.

For large diffs (>10 modified symbols), the caller-direction analysis prioritizes functions with signature changes; the producer direction is never budget-limited, because an unchanged signature is exactly its point.

## Token Efficiency

The high-effort pipeline bounds each stage (shard size, audit rounds), but total calls scale with findings — `ceil(F/8)` verification shards — and, under 3B, with chunk count (reverse audit runs per chunk per round). Typical 3A profile:

| Stage                            | LLM calls                      | Notes                                                                                                          |
| -------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Review agents (Step 3)           | 12 (+0-2)                      | Run in parallel; cross-repo skips Agents 1c and 7 (10), local/file skips Agent 0 (11)                          |
| Sharded verification (Step 4)    | ceil(F/8)                      | F = findings; at most 8 per verification agent, launched together                                              |
| Iterative reverse audit (Step 5) | 2-5 (3A); rounds × chunks (3B) | Two consecutive dry rounds to stop (cap 5); 3B fans out one auditor per chunk per round                        |
| **Total**                        | **~15-21 (~13-20)**            | 3A same-repo: ~15-21 (typical ~15-17); cross-repo or local/file: ~13-20; 3B scales with chunks (see DESIGN.md) |

Most PRs converge to the lower end of the range; the caps prevent runaway cost on pathological cases. At `--effort low|medium` the review runs entirely inline — **0 subagent calls**.

## What's NOT Flagged

The review intentionally excludes:

- Pre-existing issues in unchanged code (focus on the diff only)
- Style or formatting a formatter would auto-normalize, or naming matching your codebase conventions — but NOT substantive issues a linter or type checker would flag (unused variables, unreachable code, type errors), which are in scope
- Subjective "consider doing X" suggestions without a real problem
- Minor refactoring that doesn't fix a bug or risk
- Missing documentation unless the logic is genuinely confusing
- Issues already discussed in existing PR comments (avoids duplicating human feedback)

## Design Philosophy

> **Silence is better than noise.** Every comment should be worth the reader's time.

- If unsure whether something is a problem → don't report it
- Every finding names a concrete failure scenario (trigger → wrong outcome) or a concrete cost — a finding that can't is dropped before it reaches you
- Same pattern across N files → aggregated into one finding
- PR comments are high-confidence only (and only from high-effort, verified reviews)
- Cosmetic style/formatting matching codebase conventions is excluded
