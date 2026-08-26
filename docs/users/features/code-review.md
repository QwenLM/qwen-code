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

# Review local changes and apply the findings to your working tree
/review --fix

# Continue a review of the same PR that was interrupted, instead of starting over
/review 123 --resume

# Review a specific file
/review src/utils/auth.ts

# Quick unverified pass (no subagents)
/review --effort low
/review 123 --effort medium
```

If there are no uncommitted changes, `/review` will let you know and stop — no agents are launched.

## Effort Levels

`--effort low|medium|high` trades depth for speed:

| Level    | What runs                                                                                                                                                   | Findings cap        | Verdict                             | Posts to PR      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------- | ---------------- |
| `low`    | 3-6 directed inline angles over the diff (scaled by diff size) plus a gap sweep — no subagents, no build/test, no project rules                             | 10 (unverified)     | None                                | Never            |
| `medium` | The high pipeline minus its most expensive passes: the parallel finder fan-out over a reduced dimension set, plus build/test and a single verification pass | Uncapped (verified) | Approve capped at Comment           | Never            |
| `high`   | Full pipeline: up to 16 parallel agents → sharded verification → iterative reverse audit                                                                    | Uncapped (verified) | Approve / Request changes / Comment | With `--comment` |

Defaults: **high** for PR reviews, **medium** for local and file reviews. An effective `--comment` forces high (posted comments must survive verification) — on a non-PR target `--comment` is ignored with a warning and does **not** change the effort. Medium keeps the security and test-coverage agents and build/test, and drops the adversarial personas, the language-pitfall and wrapper/proxy specialists (Agents 1d/1e), the diff-specialist finders and the reverse audit — so a subtle Critical only the second look would surface can slip; use `--effort high` for security-sensitive or pre-release reviews. Only `low` is unverified. Worktree isolation applies to same-repo PR reviews; cross-repo PRs run in lightweight mode (diff-only, no worktree or build/test). The low pass is labeled unverified, emits no verdict, and never writes the incremental review cache, so a later `--effort high` run is never skipped as "already reviewed"; medium is verified but its Approve is capped at Comment, because nothing looked twice for what the first pass missed. The diff-obtaining mechanics are identical at every level — PR reviews always use the isolated worktree and the same base resolution, so the review is never against the wrong base. One scope difference remains: the incremental cache is high-only, so a high re-review may cover just the new commits (`lastCommitSha..HEAD`) while low/medium always review the full PR diff.

## How It Works

The `/review` command runs a multi-stage pipeline:

```
Step 1:  Determine scope + effort level (local diff / PR worktree / file)
         Capture the diff to a file + partition it into chunks
Step 2:  Load project review rules (medium/high)
Step 3C: low effort: 3-6 inline angles + gap sweep     [0 subagent calls]
Step 3A: high, <=500 src AND <=3200 total: up to 16 agents  [16+ LLM calls]
           |-- Agent 0: Issue Fidelity & Root-Cause Ownership
           |-- Agent 1a: Correctness — line-by-line scan
           |-- Agent 1b: Correctness — removed-behavior audit
           |-- Agent 1c: Correctness — cross-file tracer
           |-- Agent 1d: Correctness — language-pitfall scan
           |-- Agent 1e: Correctness — wrapper/proxy routing
           |     (only when the diff signals a wrapping type)
           |-- Agent 2: Security
           |-- Agent 3a: Reuse & duplication
           |-- Agent 3b: Altitude & abstraction fit
           |-- Agent 3c: Consistency & clarity
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
           stop after 2 consecutive dry rounds (cap 10/5/3 by topology)
Step 6:  Present findings + verdict (high; low pass: findings only)
         Canonicalize findings -> .qwen/tmp/...-findings.json
Step 6B: Apply findings + record per-finding outcomes  (--fix only)
Step 7:  Submit PR review (inline comments, if requested; high only)
Step 8:  Save report + incremental cache (cache: high only)
Step 9:  Clean up (remove worktree + temp files)
```

Steps 3A/3B/4/5 are the high-effort pipeline; at `--effort low|medium` a single inline pass (Step 3C) replaces them.

### Review Agents

| Agent                             | Focus                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent 0: Issue Fidelity           | Linked issue evidence, root-cause ownership, and whether the PR solves the reported problem                                                                                                                                                                                                     |
| Agent 1a: Line-by-line scan       | Walks every hunk plus its enclosing function: wrong conditions, off-by-one, missing `await`, edge cases, race conditions                                                                                                                                                                        |
| Agent 1b: Removed-behavior audit  | Walks every deleted/replaced line: names the invariant it enforced and hunts for where the new code re-establishes it — including removed **exports**, whose replacement often lives in another file and quietly changed a default. In 3B it runs whole-diff (chunk agents keep the local half) |
| Agent 1c: Cross-file tracer       | Walks every changed symbol's callers (consumer direction) and every added field's read sites (producer direction), plus same-PR callee changes                                                                                                                                                  |
| Agent 1d: Language-pitfall scan   | Carries the classic-footgun checklist for the diff's language (`==` coercion, falsy-value traps, loop-variable capture, mutable defaults, nil-map writes, SQL concatenation, DST arithmetic) and pattern-matches every hunk against it                                                          |
| Agent 1e: Wrapper/proxy routing   | For every type the diff adds or modifies that wraps another (cache, proxy, decorator, adapter): every method routes through the wrapped instance, and the wrapper forwards every method callers use. Rostered only when the diff signals a wrapping type                                        |
| Agent 2: Security                 | Injection, XSS, SSRF, auth bypass, sensitive data exposure                                                                                                                                                                                                                                      |
| Agent 3a: Reuse & duplication     | Does the codebase already have this? Greps for the behavior, names the existing helper to call instead, and flags dead code the diff leaves behind                                                                                                                                              |
| Agent 3b: Altitude & abstraction  | Is the fix at the right depth — or a bandaid on shared infrastructure, a downstream compensation for an upstream bug, or an abstraction serving one call site?                                                                                                                                  |
| Agent 3c: Consistency & clarity   | Sibling consistency (a guard one member of a parallel family has but its twin lacks), convention drift against a cited local example, misleading names/comments, needless complexity                                                                                                            |
| Agent 4: Performance & Efficiency | N+1 queries, memory leaks, unnecessary re-renders, bundle size                                                                                                                                                                                                                                  |
| Agent 5: Test Coverage            | Untested code paths in the diff, missing branch coverage, weak assertions                                                                                                                                                                                                                       |
| Agent 6: Undirected Audit         | 3 parallel personas (attacker / 3am-oncall / maintainer) — catches cross-dimensional issues                                                                                                                                                                                                     |
| Agent 7: Build & Test             | Runs build and test commands, reports failures                                                                                                                                                                                                                                                  |
| Agent 8: Diff-specialized finders | 0-2 extra finders written per-review when the diff concentrates in a domain with known failure modes (reconnect logic, module loaders, schedulers, codecs)                                                                                                                                      |

The three Correctness agents are **procedural**: each is defined by how it walks the diff (line-by-line / deleted lines / cross-file edges), not by a bug taxonomy — so their coverage is complementary instead of overlapping. Two further dedicated angles (1d/1e) split the language-pitfall checklist and wrapper/proxy routing out of the line-by-line walk: a checklist pattern-match and a structural routing expectation are different attention modes, and folded into the walk they were diluted by its rhythm. The same reasoning splits **code quality into three** (3a/3b/3c): one agent holding a six-item checklist finishes one item — measured on a heavily-rewritten file, one agent holding an eight-item checklist found 1 of 5 defects and the same model split three ways found all 5 — so the quality checklist is cut where the questions genuinely differ. All agents run in parallel (Agent 1 launches 3 procedural variants and 2 dedicated angles, Agent 3 launches 3 checklist slices, and Agent 6 launches 3 persona variants concurrently, totaling up to 16 parallel tasks for same-repo PR reviews — Agent 1e runs only when the diff signals a wrapping type — plus 0-2 Agent 8 finders when the diff's domain calls for them, so 15-18 in practice; Agent 0 is skipped for local-diff and file-path reviews, which run 14-17; cross-repo lightweight mode also skips Agents 1c and 7, running 13-16).

Every finding must state a **failure scenario** — the concrete input, state, or timing that triggers it and the wrong outcome that results (for quality findings, the concrete cost instead). A finding that cannot name its scenario is dropped at the source, and verification re-traces the claimed scenario through the real code rather than judging the finding's prose.

Once a PR carries more than 500 lines of **source** change — or more than 3 200 diff lines in total, past which the fifteen whole-diff readers are each too diluted to read carefully (an attention bound, not a promise of fewer calls — heavy files and specialized finders can make 3B cost more) — this dimension fan-out is replaced by a **territory × dimension** fan-out: the diff is split into ~400-line chunks — boundaries fall on hunk boundaries, and a hunk too large to fit is split only at a top-level declaration, never inside a function — and each chunk gets its own agent that applies every review dimension to that chunk alone.

The gate deliberately counts source lines rather than diff lines. Test code, prose and lockfiles dominate diff size — across this repo's last 40 merged PRs the median diff is 41% tests — so a gate on raw size would carve a 173-line production change into territories just because it shipped 489 lines of new tests, leaving that production code with one reviewer instead of fourteen lenses (the diff-reading dimension agents — sixteen minus Issue Fidelity and Build & Test). Chunking still covers every line either way, tests included; what the gate decides is how many reviewers there are and what each is asked to do. Fourteen diff-reading lenses all walking one large diff read the same early hunks fourteen times over; one agent per chunk means every line of the diff has exactly one accountable reviewer. Each chunk agent returns a `Covered:` receipt, and a chunk with no receipt is re-reviewed before the run proceeds — so "no blockers" can never be reported over code that nobody read.

A **source** file that is largely rewritten (an existing file of 300+ lines that is now 40%+ new, or has 800+ changed lines) also gets **three whole-file invariant agents**. Test and generated files never qualify — the checklist asks about fields, timers, and error taxonomies, which a rewritten test file does not have. Its bugs are usually not inside any one hunk but _between_ the new lines — a timer armed near the top of the file and a teardown path two thousand lines below. Each agent reads the whole post-change file and walks two or three items of a fixed checklist: mutable fields cleared on every exit path, timers cancelled on every close (and cancellation not discarding captured data), map inserts matched by deletes, retry counters incremented at every entry, status return values actually checked, error codes exhaustively classified permanent vs transient, config fields honoured on every path, and early returns that skip a required side effect.

The checklist is split three ways on purpose. Handing one agent all eight checks over a 2 400-line file gets one of them done properly; three agents with two or three checks each get all of them done. Chunk agents do not substitute for this — on PR #6457 they held every one of these defects inside their assigned territory and reported none. What they lacked was not the lines but the question.

Findings are verified in **sharded batches** (at most 8 findings per verification agent, all launched together). A verifier may reject a Critical only by quoting the code that contradicts it (or when the diff's own comments document the flagged behavior as deliberate); anything less certain is downgraded to low confidence rather than deleted — a silently rejected Critical is invisible to every later stage, while a downgraded one still reaches a human. The bar applies to the shape of every rejection: it must be constructible from the code — quote the line the finding misreads, prove the claimed state impossible from a type, constant, or invariant, cite the in-diff guard that covers the trigger, or match a pure-style change with no observable effect — or otherwise match an exclusion criterion — and "too speculative" is never one of them. A finding whose failure scenario names a state the code does not exclude is plausible by default: a concurrency race, nil/undefined on a rare-but-reachable path, a falsy zero or empty collection treated as missing, an off-by-one on an unexcluded boundary, a retry storm or partial failure, a regex or allowlist that lost an anchor. A rejection that constructs none of the four grounds downgrades instead of dropping. After verification, **iterative reverse audit** hunts for gaps, fanned out one auditor per chunk per round, each with the cumulative finding list. The loop stops after **two consecutive dry rounds** (or at the plan's round cap — reported as such rather than as convergence). That cap follows the diff's topology: **10** on a small diff, where a round is a single auditor; **5** on a chunked one, where it is one auditor per chunk; and **3** on a huge diff (≥ 3000 effective lines) _when the run has a deadline_, because five ~90-minute rounds do not fit a six-hour CI ceiling and a review killed mid-flight posts nothing — with no deadline a huge diff keeps the chunked cap of 5. An operator can lower whichever cap applies for every review with the `review.reverseAuditRounds` setting; it can never raise one. One dry round is not evidence of convergence, and reverse-audit findings are verified like any other.

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
- If a review is interrupted (Ctrl+C, crash), the next `/review` of the same PR automatically cleans up the stale worktree before starting fresh. If the interrupted session still leaves its lease behind — a hard kill that skips this, or a multi-prompt review interrupted during a later prompt — `/review` refuses and names the lease file to delete. Clean stops release it: a finished review and the early stops (empty diff, no new changes since the last review) all run `cleanup`, which releases the lease
- The worktree is leased to its session: a second `/review` of a PR that is already under review refuses to start (naming the holder) rather than tear down the running review's worktree
- Review reports and cache are saved to the main project directory (not the worktree)
- Steps that **modify** code to measure something — the test-efficacy probe's mutants, and a verifier's probe of a specific finding — each run in their own throwaway worktree beside it (`…-probe`, `…-scratch-<agent>`), so one agent's experiment is not visible to the others reading the shared tree. As a backstop, every agent in each wave is also told which paths (if any) differ from the commit under review at the moment it was launched, and that a failure confined to those paths is not a finding. All of these trees are swept along with the worktree at the end of the review.

## Cross-repo PR Review

You can review PRs from other repositories by passing the full URL:

```bash
/review https://github.com/other-org/other-repo/pull/456
```

This runs in **lightweight mode** — no worktree, no build/test. The review is based on the diff text only (fetched via GitHub API). PR comments can still be posted if you have write access.

| Capability                                                                    | Same-repo | Cross-repo                     |
| ----------------------------------------------------------------------------- | --------- | ------------------------------ |
| LLM review (Agents 0, 1a, 1b, 1d, 1e, 2-6 + verify + iterative reverse audit) | ✅        | ✅                             |
| Agent 1c: Cross-file tracer                                                   | ✅        | ❌ (no local codebase to grep) |
| Agent 7: Build & test                                                         | ✅        | ❌ (no local codebase)         |
| Agent 8: Diff-specialized finders (0-2, when the domain calls for it)         | ✅        | ✅ (needs only the diff)       |
| PR inline comments                                                            | ✅        | ✅ (if you have write access)  |
| Incremental review cache                                                      | ✅        | ❌                             |

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
- Model and CLI version attribution footer on each comment (e.g., _— qwen3-coder via Qwen Code /review (v0.21.2)_); set `review.attribution` to `false` in your user or system `settings.json` (the workspace `.qwen/settings.json` is ignored for `review.*` settings) to post without it — comments and body lists then also lose the `**[Critical]**`/`**[Suggestion]**` severity markers, and the model is withheld from the review's machine-ledger marker, so in fresh environments (no review cache) the recovered incremental anchor fails the same-model check and the re-review falls back to full-range

**What stays terminal-only:**

- Nice to have findings
- Low-confidence findings

**Self-authored PRs:** GitHub does not allow you to submit `APPROVE` or `REQUEST_CHANGES` reviews on your own pull request — both fail with HTTP 422. When `/review` detects that the PR author matches the current authenticated user, it automatically downgrades the API event to `COMMENT` regardless of verdict, so the submission still succeeds. The terminal still shows the honest verdict ("Approve" / "Request changes" / "Comment") — only the GitHub-side review event is neutralized. The actual findings still appear as inline comments on specific lines, so substantive feedback is unchanged.

**Re-reviewing a PR with prior Qwen Code comments:** when `/review` runs on a PR that already has previous Qwen Code review comments, it classifies them before posting new ones. Only **same-line overlap** (an existing comment on the same `(path, line)` as a new finding) prompts you to confirm — that's the case where you'd see a visual duplicate on the same code line. Comments from older commits, replied-to comments (treated as resolved), and comments that simply don't overlap with any new finding are silently skipped, with a terminal log line so you know what was filtered.

**CI / build status check before APPROVE:** if the verdict is "Approve", `/review` queries the PR's check-runs and commit statuses before submitting. If any check has failed (or all checks are still pending), the API event is automatically downgraded from `APPROVE` to `COMMENT`, with the review body explaining why. Rationale: the LLM review reads code statically and cannot see runtime test failures; approving while CI is red would be misleading. The inline findings are still posted unchanged. If you want to approve anyway (e.g., a known-flaky CI failure), submit the GitHub approval manually after verifying.

## Applying the Findings (`--fix`)

`--fix` is `--comment` reflected. `--comment` writes to a **pull request**, so it needs one; `--fix` writes to a **working tree**, so it needs one that outlives the review:

```bash
/review --fix                 # local uncommitted changes
/review src/auth.ts --fix     # a single file
```

On a **PR target it is ignored with a warning** — a PR review runs in an ephemeral worktree that is deleted when the review ends, so "fixed" edits there are discarded minutes later. Use `--comment` to publish the findings instead.

An effective `--fix` **floors the effort at medium**, because it edits your files and `low` runs no verification: applying an unverified finding is the same mistake as posting one, aimed at your working tree rather than someone's PR. It does not force `high` — medium's findings are verified, and the reverse audit `high` adds hunts for findings that are _missing_, which is not what deciding whether to apply one turns on.

After the review, each finding is applied with the `edit` tool and then **accounted for**, one of three ways:

| Outcome            | Meaning                                               | Stays on your plate? |
| ------------------ | ----------------------------------------------------- | -------------------- |
| `fixed`            | The edit is in your tree                              | No                   |
| `skipped`          | Real, not applied — the reason is reported alongside  | Yes                  |
| `no_change_needed` | The finding was wrong, or the code already handled it | No                   |

A finding is skipped when its fix would change intended behavior, would need changes well outside the reviewed diff, or turns out on a second look to be a false positive.

**Every finding gets an outcome, and this is enforced rather than requested.** The ledger goes through `qwen review findings --outcomes`, which refuses a set that does not cover all of them — a fixer that applies six of nine findings and reports six has not lied about any one of them, it has silently shortened the list, and you would have no way to see the three that fell off.

## Resuming an interrupted review (`--resume`)

A long review that dies part-way — a dropped connection, a timeout, a killed terminal — leaves everything it had done on disk: the worktree, the captured diff, and the harness's own record of every agent that ran. `--resume` continues from there instead of starting over:

```bash
/review 123 --resume
```

It applies to **PR targets only** (a local review's diff comes from a live working tree, which has no stable interrupted state to continue), and it is safe to pass whenever you are unsure: the review rules on the on-disk state itself — the worktree still at the fetched commit and clean, the captured diff unchanged byte for byte, the PR head unmoved, the resume limit unspent — and silently starts fresh whenever anything no longer matches, telling you which check refused. A continuation reuses the earlier attempt's certified agent results, so the report says how many were recovered; it is disclosed, never a coverage gap.

Two things to know. A continuation keeps the interrupted run's **effort**: passing a different `--effort` refuses the resume and runs fresh at the level you asked for, because different effort is different work. And if the PR head moved while the review was down, the resume refuses (`head-moved`) and the fresh run reviews the new commits — which is what you want, and it counts as this review's one restart.

## Findings as Data

Confirmed findings are canonicalized into `.qwen/tmp/qwen-review-<target>-findings.json` before anything else consumes them — the terminal report, the saved Markdown report, and the PR review JSON all read that one artifact instead of re-typing the list. Each finding carries a unique `id` (what outcomes and resolved anchors join on), `severity`, `confidence`, `source`, `summary`, a `shortSummary` capped at 60 characters for list rendering, `failureScenario`, and one or more `locations` — a pattern-aggregated finding keeps **one location per occurrence**, so each still gets its own inline comment.

**Before anything else, the review checks that it is running your code.** Every `qwen review …` step runs the built bundle, not the working tree, so a review command edited since the last build takes no effect and the run measures the old behaviour. The build records a digest of the review sources it bundled; `parse-args` re-derives it and compares, and `drive` checks again, because the verifier brief sends agents straight there without a step 1. On a mismatch it says on stderr that the bundle was not built from these sources, and what to rebuild. The check runs when the CLI resolves to the bundled `dist/cli.js` (the `qwen` binary, or `node dist/cli.js`); launchers that run unbundled output, such as `npm start` and `npm run dev`, skip it. Two cases it cannot compare are treated differently: a checkout whose build predates the recording is told the check could not run and why, and an installed package — which has no sources to differ from — is left silent. The digest covers the review commands, the file that registers them, the review-only lease they import from outside their directory, and the bundled review skill; it does not follow those into the shared helpers they import, so a quiet run means the review code matches the bundle rather than that the whole tree does.

**A Critical the base tree already failed is held back, not filed.** When a test command failed and the merge base could be built, `test-delta` records which failing files also fail without the pull request. Canonicalization reads that measurement back (`qwen review findings --test-delta`, beside `--outcomes`): a Critical whose own text names one of those files is lowered to a Suggestion, keeps its evidence, gains the measurement that demoted it and a `heldByMeasurement` field, and the demotion is announced. A test that was already red is not a test this pull request turns red — and if it now fails for a _new_ reason, say which test, quote both sides, and file it at Critical again: a finding that already carries the measurement and is raised anyway is left where you put it.

The command validates on write: a duplicate id, a finding with no failure scenario, an empty locations array, or an unknown severity is an error rather than a silently mangled entry.

## Evidence Images in PR Comments

GitHub's API cannot attach images to review comments, so `/review` can host evidence images (TUI screenshots, rendered-output comparisons) in a repository you designate and embed them by URL:

```bash
export QWEN_REVIEW_ASSETS_REPO=your-org/your-repo   # a repo you can push to
/review 123 --comment
```

Maintainers typically point it at the repo under review; anyone else can use a fork or a scratch repo. Images land on the `pr-assets/<pr>-review` branch with content-hashed names, and comments reference them by **commit-pinned** URL — immutable even if the branch later moves, and working unchanged on GitHub Enterprise.

For GitHub-triggered reviews (the PR-review workflow), the same variable is wired from a **repository variable** of the same name: with the variable unset the workflow passes an empty value and publishing refuses — nothing changes. A maintainer who sets `QWEN_REVIEW_ASSETS_REPO` in the repository's Actions variables (typically to the repository itself) enables review comments to embed capture PNGs; the branches it writes are cleaned up by the visuals cleanup workflow when the variable points at the same repository, while a fork or scratch destination manages its own retention.

The publishing is gated exactly like posting: no designated repo means no publish, and an unauthorized run (no effective `--comment`) is refused the same way `submit` refuses. Only image types are accepted (SVG is excluded deliberately), with size caps, and each file's bytes must match the format its extension claims — mislabeled or unrecognized content is refused. A manifest records every file pushed. Without a designation, findings keep their evidence as local file paths in the terminal and saved report — nothing breaks, comments just stay text-only.

## Follow-up Actions

After the review, context-aware tips appear as ghost text. Press Tab to accept:

| State after review               | Tip                | What happens                            |
| -------------------------------- | ------------------ | --------------------------------------- |
| Local review, `--fix` not passed | `fix these issues` | LLM interactively fixes each finding    |
| PR review with findings          | `post comments`    | Posts PR inline comments (no re-review) |
| PR review, zero findings         | `post comments`    | Approves the PR on GitHub (LGTM)        |
| Local review, all clear          | `commit`           | Commits your changes                    |

Note: `fix these issues` is only available for local reviews, for the same reason `--fix` is — for PR reviews the worktree is cleaned up after the review, so post-review interactive fixing is not possible; use `--comment` or `post comments` to publish findings instead. When `--fix` was passed, the findings already carry outcomes and no fix tip is offered.

## Project Review Rules

You can customize review criteria per project. `/review` reads rules from these files (in order):

1. `.qwen/review-rules.md` (Qwen Code native)
2. `.github/copilot-instructions.md` (preferred) or `copilot-instructions.md` (fallback — only one is loaded, not both)
3. `AGENTS.md` — `## Code Review` section
4. `QWEN.md` — `## Code Review` section

Rules are injected into the LLM review agents (0-6) as additional criteria. For PR reviews, rules are read from the **base branch** to prevent a malicious PR from injecting bypass rules.

## Repository Context

Repositories can hand the reviewers bounded, repository-specific guidance by committing a strict JSON manifest to `.qwen/review-context.json`. At medium or high effort, `/review` reads the manifest after capturing the plan and attaches the matching guidance before any agent launches:

```json
{
  "version": 1,
  "label": "Example repository",
  "rules": [
    {
      "paths": ["packages/*/src/**"],
      "domains": ["runtime"],
      "relatedPaths": ["packages/runtime/src/**"],
      "recommendedTests": ["npm run test:runtime"],
      "requiredConfigurations": ["debug"],
      "requiredAgents": ["test-matrix"],
      "unverifiedDimensions": ["Alternate runtime was not exercised"],
      "verificationNotes": ["Use the repository native test runner"]
    }
  ]
}
```

A rule applies when any changed file matches one of its `paths` globs (`*`, `?`, and `**` segments; case-sensitive). All matching rules merge their guidance: domains and related files for the review agents, recommended tests and required configurations for the build-and-test agent, extra reviewer roles (honoured only when the chosen effort and topology run them), and proof boundaries the final review discloses as unverified dimensions. Arrays may be written in any order; duplicate entries are rejected.

For PR reviews the manifest is read from the merge base, so the PR under review cannot opt itself into or out of guidance; local reviews read it from the current worktree. Low-effort and cross-repository reviews skip repository context. The full contract and trust model live in the [design doc](../../design/review-repository-context.md).

## Issue Fidelity

For bugfix PRs, the Issue Fidelity agent fetches issue evidence directly instead of relying on PR description text. It runs the `qwen review issue-context <pr> --repo <owner/repo> --out <file>` subcommand, which resolves GitHub's strong closing-issue metadata and then fetches each referenced issue's title, **body** (the reporter's original repro), and full comment thread — each from the issue's own repository (a PR can close an issue in a different repo). This agent runs only for PR targets; local-diff and file-path reviews skip it.

The closing-issue set is a discovery hint rather than proof the author linked the right issue: if it is empty but the PR references an apparent target issue, the agent still fetches it after judging relevance (re-running with `--issue <n>`; a bare number resolves in the PR's repo, while `--issue <owner>/<repo>#<n>` fetches a cross-repo reference from its own repo). Fetched issue text is treated as untrusted data (facts extracted, embedded instructions ignored). For relevant issues, the original reproduction, observed payload, expected behavior, and maintainer comments are treated as the highest-priority evidence for whether the PR fixes the right problem.

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

The model match also gates incremental scoping, not just the skip: "clean up to the cached commit" is the previous model's verdict, so when new commits have landed since the cached review, a model mismatch never scopes to `lastCommitSha..HEAD` — the range is the full diff, noting "Previous round was reviewed by qwen3-coder. Running full review with gpt-4o." — unless an anchor certified by the model now running is recovered from the last posted review (below), which scopes the range instead. The previous round's findings still carry over to be re-ruled; only the anchor does not. The same gate binds the anchor recovered from the last posted review's machine-ledger marker when the cache is absent or its anchor is unusable (CI, another clone): it scopes the incremental range only if the model now running certified it — a marker certified by a different model, or carrying no model (a review posted with `review.attribution` off, or one from before the field), falls back to the full diff. A round that did not close cleanly posts its marker without an anchor (it cannot certify a range), but that loss is not sticky when the round's work list survived whole: recovery grafts the anchor forward from the most recent earlier marker your own account posted with one, so a single non-clean round no longer forces every later round to re-read the full diff — the next round scopes `anchor..HEAD`, which re-covers the range the non-clean round could not certify. A size-capped round's graft is refused (dropped findings would fall outside the grafted scope and retire silently), so later rounds keep re-reading the full diff until a complete marker lands.

Cache is stored in `.qwen/review-cache/` and tracks both the commit SHA and model ID. Make sure this directory is in your `.gitignore` (a broader rule like `.qwen/*` also works). On GitHub, if the cached commit was rebased or force-pushed away, it falls back to a full review; Aone rules the cached anchor differently — see its paragraph below. Only high-effort reviews consult or write the cache — a `--effort low|medium` quick pass never counts as "already reviewed".

## Review Reports

For same-repo reviews, results are saved as a Markdown file in your project's `.qwen/reviews/` directory (cross-repo lightweight reviews skip report persistence):

```
.qwen/reviews/2026-04-06-143022-pr-123.md
.qwen/reviews/2026-04-06-150510-local.md
```

Reports include: timestamp, diff stats, build/test results, all findings with verification status, and the verdict. Section headings and descriptive prose follow the output language preference; technical identifiers (SHAs, file paths, gate names, finding ids) stay verbatim.

Medium- and high-effort reviews also save a structured JSON companion with the same stem (for example, `2026-04-06-143022-pr-123.json`) holding the canonical findings and the composed verdict as data. Qwen Code's Web Shell renders that document as an interactive review view with filterable findings; the Markdown report stays the human-readable archive.

The deterministic halves of the pipeline — argument parsing (`qwen review parse-args`) and the event/body decision (`qwen review compose-review`) — are tested subcommands rather than prompt text, so `--effort` grammar, `--comment` forcing, verdict caps, and downgrade behavior are pinned by unit tests and cannot drift with the model.

**GitHub Enterprise:** reviewing a PR URL on a non-`github.com` host routes every GitHub call at that host — the review subcommands (`match-remote`, `meta`, `fetch-pr`, `pr-context`, `comment-status`, `issue-context`, `fetch-diff`, `comment-body`, `plan-diff`, `test-plan`, `presubmit`, `compose-review`, `submit`, `publish-assets`) accept `--host` and set it in code, so a forgotten host cannot silently retarget the review at `github.com`.

**Aone Code:** for a clone whose origin is on `gitlab.alibaba-inc.com`, run `/review` from inside that clone — the platform is detected from the remote and the subcommands work, backed by the `a1` CLI (at least 0.1.90 — an older install is refused at authentication time with an upgrade message) — the target number is the global MR id. `fetch-pr` fetches `refs/merge-requests/<id>/head` and builds the worktree + diff, so the agent review of the worktree is unchanged, and `test-plan` works too — it reads the MR description through the same reader. `pr-context` is backed too: it reads the MR's metadata, discussion threads, and previously posted qwen summaries (the machine ledger recovers from them), so an Aone run sees the MR's existing discussion exactly as a GitHub run sees a PR's. `comment-status` and `presubmit` are a1-backed too (presubmit fully: self-PR detection, head drift, merge-gate CI, and existing-comment dedup), so repeat `--comment` rounds dedup against the MR's existing comments instead of re-posting them (a thread the platform marks outdated — its line no longer maps after an amend — stays re-postable), and self-PR detection works too. The `publish-assets` write is skipped. `--comment` **posts** the review through the `a1` CLI: one comment per inline finding, then the summary comment. Aone has no native request-changes state — on that verdict the summary comment carries a blocking header, and any inline Criticals that were actually posted block the merge through the discussion gate while their discussions stay unresolved (when no inline Critical posted, the header is advisory and nothing mechanically blocks the merge). The posted comments carry no AI-comment flag — `a1` cannot set one — so a repo's dedicated `ai_comment` merge gate does not track them. The native `a1 repo mr approve` fires for an Approve verdict when the run read the MR's context (the same gate as GitHub; a context-unavailable run stays capped at Comment). Incremental re-review follows the AGit-Flow update model: an update AMENDS the single CR commit in place, orphaning the head the previous round reviewed — so the cached anchor is ruled WITHOUT ancestry (the anchor-behind-head test would fail for every update), and the re-review scopes the PR's own diff to the files the update touched instead of falling back to a full review; an update that also rebased onto newer master keeps that scope only while the rebase's drift stays within the CR's files — drift touching any other file falls back to the full review, and no drift byte enters the published scope either way. See `docs/design/2026-08-15-review-aone-provider.md`.

Every run ends with one machine-readable line (`Review complete: <target> — <disposition>`), so scripts and CI wrappers can detect completion and outcome with a single `^Review complete: ` match.

## Headless runs (`qwen review run`)

`/review` is interactive. When a script or CI job needs to run a review and act on its outcome, use the headless wrapper:

```bash
qwen review run [target] [--json] [--fail-on request-changes] [--comment] [--resume] [--quiet]
```

`target` is a PR number, a PR URL, or a file path; omit it to review the local working tree. The command runs this build's own CLI non-interactively (with stdin closed, so slash-command detection survives), streams the child's progress to **stderr**, and prints the verdict to **stdout** — or, with `--json`, the full result object. The verdict is read from the artifact `compose-review` writes (the same JSON the skill treats as the verdict authority), never parsed from the model's prose.

The exit code is the contract a gate should read:

| Exit | Meaning                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------- |
| `0`  | The review completed (whatever it decided)                                                        |
| `1`  | It never reached a verdict — the child failed, timed out, or left no composed artifact            |
| `3`  | It completed with `REQUEST_CHANGES` **and** `--fail-on request-changes` was set (opt-in blocking) |

`3` (not `2`) lets a gate distinguish "the review is blocking" from "the tool broke" — yargs already uses `1` for usage errors — without parsing any output. `--timeout-minutes` (default 120, floored at 1) terminates a hung review and exits `1`, and cancelling the command (Ctrl+C / SIGTERM) terminates the review's process group rather than orphaning it.

`--resume` continues an interrupted review of the same PR instead of starting over — when a long local run dies part-way (a dropped connection, a timeout, a killed terminal), the retry would otherwise re-fetch, re-chunk and re-launch agents whose work is already on disk. It is safe to pass unconditionally on a retry: `fetch-pr` rules on the on-disk state itself (worktree still at the fetched SHA and clean, diff bytes unchanged, PR head unmoved, resume cap unspent) and silently falls back to a fresh review whenever anything no longer matches, so the flag never fails a run that could start over. A continuation is pinned to the interrupted run's recorded effort — an explicitly different `--effort` refuses the resume and runs fresh at the requested level. PR targets only (a local review's diff is captured from a live working tree, which has no stable interrupted state to continue). Resume is a **local convenience**: the repository's own CI review workflow does **not** resume — each retry re-runs fresh, because a CI attempt runs no-sandbox and its worktree is deleted on exit, leaving no interrupted state to continue.

A time-budgeted run can also export a **soft** deadline so the review stops its open-ended reverse-audit loop while there is still time to verify, compose and post: `QWEN_REVIEW_DEADLINE_EPOCH` is the Unix-seconds moment the run will be killed, and `QWEN_REVIEW_DEADLINE_RESERVE_SECONDS` (default 3600; `0` keeps only the round estimate) is the tail that must remain for the last round's verification, `compose-review` and submission. When the remaining budget no longer fits another round plus that tail, the round builder refuses to build it, and the composed verdict discloses the truncated audit (an otherwise-Approve verdict is capped at Comment). A missing or malformed deadline leaves the review ungated — the outer timeout still bounds the run.

Nested inside that reserve is a smaller **compose floor**, `QWEN_REVIEW_DEADLINE_COMPOSE_FLOOR_SECONDS` (default 1200; `0` disables this gate entirely, at every point including past the deadline). The reserve is one number covering "verify the last round **plus** compose **plus** submit", which fits a normal per-finding re-trace but not a security review whose verification re-runs real filesystem/git workloads without bound. So the verifier — not the round builder — is gated on this floor: once the floor or less remains, `agent-prompt --role verify` refuses to build (a `VERIFY BUDGET:` line, exit **4**), the findings in hand keep their unverified tag (which caps the verdict), and `compose-review` and submission run. The floor is strictly below the reserve, so a healthy run hits the reverse-audit gate first and never reaches it; it is the cover for the one span the reserve cannot bound.

## Cross-file Impact Analysis

A dedicated cross-file tracer (Agent 1c) owns this walk end-to-end. When code changes modify exported functions, classes, or interfaces, it searches for all callers and checks compatibility:

- Parameter count/type changes
- Return type changes
- Removed or renamed public methods
- Breaking API changes

It also walks the **producer direction**: every field, option, or optional parameter the diff adds is traced to its read sites — including files the diff never touches. A live code path reading a field that nothing populates means the feature it gates silently does nothing, and that is flagged as Critical at the read site.

For large diffs (>10 modified symbols), the caller-direction analysis prioritizes functions with signature changes; the producer direction is never budget-limited, because an unchanged signature is exactly its point.

## Review Budget

The parts of the pipeline that are elastic in diff size are scaled from it, and the scaling is written into the diff plan so every stage reads one number rather than each deciding for itself:

| Budget field    | What it scopes                      | How it scales                                                      |
| --------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `inlineAngles`  | How many `low` angles run (Step 3C) | 3, plus one per 60 source lines, capped at the 6 angles that exist |
| `sweep`         | Whether `low`'s gap sweep runs      | Off below 25 source lines                                          |
| `specialistCap` | The Agent 8 ceiling                 | 0 below 80 source lines, otherwise 2                               |
| `verifyShard`   | Findings per verification agent     | Flat at 8 — a property of the verifier, not of the diff            |

Two things it deliberately does not do. It **never scales a dimension away**: which agents a review owes is decided by the roster, which reads the effort level, so a small diff still gets its security pass and its test-coverage pass. And it reads **source** lines, not diff lines — a 40-line production change shipping 900 lines of new tests is a small change, and the same reasoning already governs the territory-fan-out gate.

Why the floors are where they are: on a nine-line typo fix, six inline walks are five walks over nothing, and the sweep — a fresh reader hunting what the first pass did not get to — has nothing to hunt when the first pass got to all of it. Agent 8's floor is the substantive one: "one domain dominates the diff" is a judgement, and a judgement made about forty lines finds a dominant domain every time, because forty lines are usually all one thing.

## Token Efficiency

The high-effort pipeline bounds each stage (shard size, audit rounds), but total calls scale with findings — `ceil(F/8)` verification shards — and, under 3B, with chunk count (reverse audit runs per chunk per round). Typical 3A profile:

| Stage                            | LLM calls                       | Notes                                                                                                                                                                                               |
| -------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review agents (Step 3)           | 16 (+0-2)                       | Run in parallel; Agent 1e only when the diff signals a wrapping type (15 without it); cross-repo skips Agents 1c and 7 (14), local/file skips Agent 0 (15)                                          |
| Sharded verification (Step 4)    | ceil(F/8)                       | F = findings; at most 8 per verification agent, launched together                                                                                                                                   |
| Iterative reverse audit (Step 5) | 2-10 (3A); rounds × chunks (3B) | Two consecutive dry rounds to stop; the cap follows the topology — 10 on a small diff, 5 on a chunked one, 3 on a huge one when the run has a deadline. 3B fans out one auditor per chunk per round |
| **Total**                        | **~19-30 (~17-29)**             | 3A same-repo: ~19-30 (typical ~19-21); cross-repo or local/file: ~17-29; one fewer when Agent 1e is not rostered; 3B scales with chunks (see DESIGN.md)                                             |

Most PRs converge to the lower end of the range; the caps prevent runaway cost on pathological cases. At `--effort low` the review runs entirely inline — **0 subagent calls** — walking the diff once per angle instead of once in total.

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
