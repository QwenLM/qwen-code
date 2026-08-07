# /review Design Document

> Architecture decisions, trade-offs, and rejected alternatives for the `/review` skill.

## Why 14 agents + 1 verify + iterative reverse, not 1 agent?

**Considered:**

- **1 agent (Copilot approach):** Single agent with tool-calling, reads and reviews in one pass. Cheapest (1 LLM call). But dimensional coverage depends entirely on one prompt's attention — easy to miss performance issues while focused on security.
- **5 parallel agents (original design):** Each agent focuses on one dimension. Higher coverage through forced diversity of perspective. Limited by combined Correctness+Security and a single undirected pass — recall ceiling left findings on the table that the user only discovered in subsequent /review rounds.
- **9 parallel agents:** 6 review dimensions (Correctness, Security, Code Quality, Performance, Test Coverage, Undirected) + Build & Test. Undirected runs as 3 personas in parallel.
- **10 parallel agents:** The 9-agent design plus Issue Fidelity & Root-Cause Ownership, which compares linked issue evidence against the PR's claimed fix before accepting a client-side change.
- **12 parallel agents:** The 10-agent design with Correctness split into three procedural walks — 1a line-by-line scan, 1b removed-behavior audit, 1c cross-file tracer — plus up to 2 optional diff-specialized finders (Agent 8) when one domain dominates the diff.
- **14 parallel agents (current):** The 12-agent design with Code Quality split into three checklist slices on the same evidence that split Correctness and the invariant checklist — 3a reuse & duplication, 3b altitude & abstraction fit, 3c consistency & clarity. One agent holding a six-item quality checklist finishes one item (measured on PR #6457: one agent with an eight-item checklist found 1 of 5 defects; the same model split three ways found all 5).

**Decision:** 14 agents. The marginal cost (14x vs 1x) is acceptable because:

1. All 14 agents are submitted in one response and run concurrently up to the runtime's tool-call cap (default 10, `QWEN_CODE_MAX_TOOL_CONCURRENCY`) — wall time is bounded by roughly two waves at worst, still far below fourteen sequential agents
2. Dimensional focus produces higher recall (fewer missed issues)
3. Three undirected personas (attacker / 3am-oncall / maintainer) catch cross-dimensional issues that a single undirected agent's prompt-induced bias would miss
4. Issue Fidelity prevents a common false approval mode: a PR can be internally well-tested while solving only the author's mistaken diagnosis, not the linked issue's original failure
5. The "Silence is better than noise" principle + verification controls precision

### Why split Correctness from Security

A single Correctness+Security agent has split attention — empirically one dimension dominates the output and the other is shallow. Different mindsets too: correctness asks "does this do what it intends," security asks "what unintended thing can a hostile actor make this do." Splitting forces both to get full attention.

### Why a dedicated Test Coverage agent

Test gaps are a systematic blind spot. Review agents focused on bugs in the new code itself rarely look at whether the change came with adequate tests. A dedicated agent that asks "what scenarios in this diff are untested?" catches misses no other dimension hits.

### Why a dedicated Issue Fidelity agent

Bugfix PRs often carry their own diagnosis in the PR body, but that diagnosis can be wrong. The linked issue's original reproduction, observed payload, expected behavior, and maintainer comments must be checked before judging whether the implementation is a real fix. The implementation deliberately keeps issue discovery out of `pr-context`: the Issue Fidelity agent fetches GitHub's closing-issue metadata with `gh pr view --json closingIssuesReferences`, then fetches relevant issue discussions with `gh issue view --json title,body,comments` (the `--json` form is required — it returns the issue **body**, which `--comments` alone omits). This keeps relevance judgment in the agent instead of baking fragile PR-body parsing into TypeScript. The agent runs only for PR targets — a local-diff or file-path review has no PR or linked issue, so it is skipped there (13 agents instead of 14).

The agent also enforces the root-cause ownership gate: a client-side parser/sanitizer workaround for malformed upstream output is not acceptable as a root-cause fix unless a maintainer explicitly asked for that defensive mitigation.

### Why three undirected personas instead of one or many

A single undirected agent has prompt-induced bias and tends to find the same kinds of issues across runs. Three personas — attacker / 3am-oncall / maintainer — force completely different mental traversals, and the union of findings is meaningfully larger than 1.5× a single agent.

Empirically, ensemble diversity drops sharply past 3-5 sampled paths. Three is the sweet spot: enough to break single-prompt bias, few enough that the marginal cost stays bounded.

### Why Correctness is three procedural agents, not one topical agent

A topic brief ("find correctness bugs") lets the agent choose where to look, and independently-prompted agents converge on the same visibly-suspicious hunks — redundancy, not coverage. A procedural brief fixes the walk: every hunk line-by-line with its enclosing function (1a); every deleted line, asking where the deleted invariant is re-established (1b); every changed symbol's callers and read sites (1c). Complementary coverage comes from the walk itself, not from luck. The evidence is in this skill's own history: the whole-file invariant checklist — a procedural walk — found the five PR #6457 Criticals that both the topical dimension agents and 14 chunk agents missed ("what the chunk agents lack is not the lines; it is the question").

Two structural holes this closes:

- **Removed behavior was nobody's job.** A deleted guard, error path, or test leaves no trace in the post-change tree; only the diff's `-` lines witness it. Heavy files got this covered via the invariant agents' `diffRange`; an ordinary diff's deletions had no dedicated reader. Agent 1b is that reader.
- **Cross-file was everybody's job, which is the same thing.** The consumer/producer analysis was a shared duty of Agents 1–6: six agents re-running the same greps (~6× the tool calls), none accountable for finishing the walk. Step 3B had already consolidated it into one whole-diff agent; 3A now matches. Single ownership is also the shape the producer-direction lesson (PR #6621) demands — the read site of a never-populated field lives in a file no topical reviewer would open on its own initiative.

The language-pitfall and wrapper/proxy checklists fold into 1a rather than standing alone: they are line-level questions asked during the same walk, not separate walks.

### Why removed-behavior is a whole-diff agent in 3B, not only a chunk duty

3B folds Agent 1b into each chunk agent, scoped to "the deleted lines in your territory". That is necessary and — as PR #6638 proved — not sufficient. Territory-scoped 1b can only ask "was this deletion re-established _here_", and for the deletions that matter most the answer is somewhere else entirely.

The measurement: three reviewers ran over #6638 (extension management v2 — 43 files, 8 255 additions, 28 chunks). The 3B run with per-chunk 1b reported **one** Critical. An independent reviewer (Codex `$qreview`) reported 32, and a parallel hand-run wave of 1b + 1c agents over the same commit independently reproduced six of them. Every one of that overlapping six is a **cross-chunk deletion**: `enableByPath(includeSubdirs: true)` deleted in one file and replaced by an exact-path `setWorkspaceActivation` in another, silently narrowing what a workspace-scoped disable means for every untouched CLI/TUI caller; `refreshTools()` dropped from the activation paths, its replacement swallowing the errors it used to propagate; a global mutation timeout removed and replaced by one that covers only the prepare phase. Each has a deletion in chunk A, a replacement in chunk B, and a consumer in a file the diff never touches. **No chunk agent can see that triple, and 1c does not look for it.** The split is by task, not by symbol: 1c owns caller compatibility — it greps the removed export's old name (right there in the deleted lines) and checks each call site — while 1b owns the pairing, finding the _replacement_ and comparing its semantics to what was deleted. A replacement that leaves every call site compiling is all 1c can see; that it now means something different at every one of them is what only 1b goes looking for.

So 1b joins 1c as a whole-diff agent, with an explicit split: **1c walks the callers; 1b walks the replacement and compares its semantics.** The chunk agents keep the local half (a guard deleted and not re-established within the same hunk is theirs, and it is the common case). The cost is one agent per 3B review. The class it closes is the one where a replacement type-checks, compiles, passes every test, and means something different to callers nobody edited.

### Why diff-specialized finders (Agent 8) are optional and capped at 2

Domains have failure grammars — a reconnect state machine, a module loader, a cron scheduler each fail in ways no generic dimension list names. The whole-file invariant checklist is the fixed-form ancestor: a domain-specific walk out-finds a generic brief over the same lines. Agent 8 generalizes that idea to the diff's dominant domain, with the brief written per-review by the orchestrator. Capped at 2 so the fan-out stays bounded and specialization happens only when a domain actually dominates; zero is the common case. Findings flow through Step 4 verification like any other `[review]` finding.

## Why batch verification instead of N independent agents?

**Considered:**

- **N independent agents (original design):** One verification agent per finding. Each reads code independently. High quality but cost scales linearly with finding count (15 findings = 15 LLM calls).
- **1 batch agent (original):** Single agent receives all findings, verifies each one. Fixed cost.
- **Sharded batches, ≤8 findings each (chosen):** `ceil(F/8)` agents (F = finding count), launched together.

**Decision:** Shard. One batch agent was right when a review produced 15 findings — it saw cross-finding relationships and cost O(1). But a Step 3B review of a large PR produces 30-60 findings, and one agent re-reading code for each of them inside a single context window degrades on the tail of the list. Sharding costs `ceil(F/8)` calls instead of 1, still far below one-agent-per-finding, and keeps each verifier's job small enough to do properly.

**Rejecting a Critical requires quoted contradiction.** A verifier may reject a Critical only when it can quote the specific code that contradicts the claim (the finding describes behavior the code demonstrably does not have) or when the finding merely re-describes a change the diff's own text documents as deliberate; anything less certain is downgraded to low confidence, never deleted. A rejected Critical is deleted from both the PR and the terminal and no later stage revisits it; a downgraded one still reaches a human under "Needs Human Review". The asymmetry between a false positive (noise) and a wrongly deleted true positive (a shipped bug plus another `/review` round) is why the bar for rejection is quoted evidence, not judgment.

## Why reverse audit is a separate step, and why iterative

### Why separate from verification

- **Merge with verification:** Verification agent also looks for gaps. Saves 1 LLM call.
- **Separate step (chosen):** Reverse audit is a full diff re-read, not a finding check. Different cognitive task.

Verification is targeted (check specific claims at specific locations). Reverse audit is open-ended (scan entire diff for missed issues). Combining overloads one agent with two fundamentally different tasks, degrading both.

### Why iterative (multi-round)

A single reverse audit pass leaves whatever the reverse audit agent itself missed. Each new round receives the cumulative finding list from prior rounds, so it focuses on what's left undiscovered.

### Why the stop rule is two consecutive dry rounds, not one

One dry round was the original rule, and PR #6457 shows why it is unsound. The per-round Critical yield across its eight review rounds was `2, 2, 7, 0, 0, 5, 3, 1`. The review returned "no blockers" **twice**, and the next round surfaced five Criticals — three of them in code that had been in the diff since the first commit. A yield of zero is evidence about one round's agents, not about the code.

Requiring two consecutive dry rounds makes a single lazy or context-starved agent unable to end the loop. The hard cap moves from 3 rounds to 5, and when the cap is what stopped the loop the output must say so rather than implying convergence.

### Why the reverse audit fans out per chunk

The original design gave one agent the whole diff plus a growing cumulative finding list. On a 5 800-line diff that is the most context-starved agent in the pipeline — exactly on the PRs where reverse audit matters most. Under Step 3B each round runs one auditor per chunk, each with the full cumulative finding list but only its own territory to re-read.

### Why the topology gate counts source lines, not diff lines

Diff size is a bad proxy for review risk, because tests dominate it. Across this repo's last 40 merged PRs the median diff is **41% test code**, and 14 of the 40 are more than half tests. A gate on raw diff lines sends a change of 173 production lines that ships 489 lines of new tests into the territory fan-out, where the production code ends up owned by a single chunk agent — while under the dimension fan-out it would have been read by twelve lenses (the diff-reading dimension agents: fourteen minus Issue Fidelity and Build & Test).

Territory fan-out is worth it when there is a lot of _risky_ code to divide, not a lot of _lines_. So the gate is `srcDiffLines > 500`, with a second clause `diffLines > 3200` as an attention bound: past that point asking the thirteen diff-reading lenses each to swallow the whole diff dilutes all of them, and the chunk topology's base cost (`ceil(diffLines / 400) + 4`, counting the whole-diff agents that read the diff — Build & Test reads none) crosses that count nearer 3 600. The gate stays at 3 200 rather than moving with the roster — fanning out slightly before the crossover errs toward one accountable reader per line, and a gate that drifts every time a dimension is split or merged is a gate nobody can reason about. It is not a promise of fewer calls — a heavy file adds three invariant agents and a dominant domain up to two specialized finders — but of one accountable reader per line instead of thirteen diluted ones. On the 40-PR sample the second clause never fires; it exists for a changeset dominated by tests or generated files.

Re-gating moved 6 of those 40 PRs from 3B back to 3A and cost 22 extra agents in total across all 40 — about 5% — measured under the earlier 10-agent 3A roster; under the current 14-agent roster the same six PRs cost 4 more each, ~46 extra (~10%). It buys those six PRs twelve review lenses on their production code instead of one.

Chunking itself is unchanged: the plan still tiles every line, tests and generated files included. Only the count of reviewers and their brief change. `heavy` is likewise restricted to `source` files — the invariant checklist asks about fields, timers, collections, and error taxonomies, and a rewritten test file has none of those.

### Why `plan-diff` exists

Step 3B's chunk agents are defined as "one per entry in `chunks[]`", and only `fetch-pr` produced a chunk plan. A local-diff review, or a cross-repo review in lightweight mode, therefore routed into a topology it had no chunk list for: no receipts, no tiling guarantee, and the orchestrator left to improvise line ranges. Two of the four review paths were promised a mechanism the skill could not deliver.

`qwen review plan-diff <diff-file>` reads a captured diff and emits the same `chunks[]`, `files[]` and topology counts. Redirecting `git diff` or `gh pr diff` to a file bypasses Shell model-output truncation, so all four paths now share one code path. It cannot decide `heavy` — that needs a tree to read the post-change file from — so a bare diff gets chunk agents but no invariant agents.

### Why the topology gate ignores prose

`docs/**` and root-level markdown classify as `docs` and stay out of `srcDiffLines`. A translation PR carries no runtime risk, and gating on raw size would fan chunk agents across it. Markdown _inside a source tree_ stays `source`: this repo's bundled skill prompts are `packages/core/src/skills/**/SKILL.md`, and they are executable behaviour. Coverage is unaffected either way — every line is still chunked and receipted.

### Why the invariant checklist is split across three agents

Measured on PR #6457's `QQChannel.ts` (1551 → 2643 lines, 65% rewritten), at its first commit, against the nine defects maintainers later confirmed in that commit:

| Reviewer                                  | Invariant-class defects found |
| ----------------------------------------- | ----------------------------- |
| One agent, all eight checks               | 1 of 5                        |
| Three agents, 2-3 checks each, same model | 5 of 5                        |
| 14 chunk agents (Step 3B), same diff      | 0 of 5                        |
| 8 dimension agents on the truncated diff  | 2 of 5                        |

The chunk agents _saw_ every one of those five defects — the code was inside their territory — and reported none of them. Visibility is necessary and not sufficient. What the chunk agents lack is not the lines; it is the question. "Review this diff for bugs" and "list every retry counter, then check the increment at every call site" are not the same instruction, and only the second one finds an unreachable ceiling.

Eight simultaneous checks over a 2 400-line file is a task an agent performs once, shallowly. Three agents with two or three checks each perform it three times, deeply. The cost is two extra calls per heavy file.

### Why reverse audit findings no longer skip verification

They used to, on the theory that the auditor "already has full context, so its output is inherently high-confidence." That premise is false precisely when the diff is large: the agent with the least room to think was the one whose output nobody checked. Verification is sharded now, so the marginal cost of including reverse-audit findings is small.

## Why findings carry a failure scenario instead of an impact statement

`Impact` asked why the finding matters. `Failure scenario` asks the finder to prove the finding can happen: name the input/state/timing that triggers it and the wrong outcome that results — or, for quality findings, the concrete cost (what is duplicated, wasted, or harder to maintain, or the quoted project rule).

Two effects:

1. **Finders self-filter.** A "risk" for which no trigger can be constructed dies at the source instead of reaching the PR. Dogfood motivation: a /review run on PR #6612 auto-published two hallucinated Criticals onto an already-approved PR — both were findings for which no concrete trigger could have been written down. An `Impact` field accepts "this could cause issues in production"; a `Failure scenario` field does not.
2. **Verifiers get a testable claim.** Step 4's verdict becomes the result of tracing the claimed trigger through the real code — confirmed (high) = the trace works and the lines are quoted; confirmed (low) = mechanism real, trigger uncertain; rejected = the code contradicts the claim — rather than a plausibility vote on the finding's prose.

The reporting gate is severity-asymmetric, matching the recall rules elsewhere in the skill: a Suggestion with no scenario and no cost is dropped at the source; a suspected Critical with an uncertain trigger is kept at `Confidence: low` for the verifier to rule on. A dropped Suggestion costs a nicety; a dropped Critical costs a shipped bug.

## Why low-confidence over rejection on uncertain findings

**Original behavior:** When verification was uncertain, it would reject. Bias toward precision.

**Problem:** Uncertain findings often turn out to be real after human inspection. Rejection silently swallows valid concerns. Users discover them in the next iteration of /review or after merging — exactly the "iterate many rounds" pain this redesign targets.

**Current behavior:** Uncertain → "confirmed (low confidence)". Low-confidence findings:

- Appear in terminal output under "Needs Human Review"
- Are filtered out of PR inline comments (preserves "Silence is better than noise" for PR interactions)
- Do not affect the verdict (Approve/Request changes/Comment is computed from high-confidence findings only)

**Trade-off:** Terminal output gets noisier. PR comments stay clean. The user sees concerns without the cost of false-positive PR noise.

**Reserved for outright rejection:**

- Finding describes behavior the code does not actually have (factually wrong about the code)
- Finding matches an Exclusion Criterion (pre-existing issue, formatting nitpick, etc.)
- Vague suspicion with no concrete code reference

This boundary keeps the low-confidence bucket meaningful — it's "likely real but needs human judgment," not "I have no idea."

## Why worktree instead of stash + checkout

**Considered:**

- **Stash + checkout (original design):** `git stash` → `gh pr checkout` → review → `git checkout` original → `git stash pop`. Fragile: stash orphans on interruption, wrong-branch on restore failure, multiple early-exit paths need cleanup.
- **Worktree (chosen):** `git worktree add` → review in worktree → `git worktree remove`. User's working tree never touched.

**Decision:** Worktree. Eliminates an entire class of bugs (stash orphans, wrong-branch, dirty-tree blocking checkout). Trade-off: needs `npm ci` in worktree (extra time), but this is offset by isolation benefits.

**Interruption handling:** Step 1 cleans up stale worktrees from previous interrupted runs before creating new ones.

## Why "Silence is better than noise"

Copilot's production data (60M+ reviews): 29% return zero comments. This is by design — low-quality feedback causes "cry wolf" fatigue where developers stop reading ALL AI comments.

Applied throughout:

- Low-confidence findings → terminal only ("Needs Human Review")
- Nice to have → never posted as PR comments
- Uncertain issues → rejected, not reported
- Pattern aggregation → same issue across N files reported once

## Why classify existing Qwen Code comments instead of always prompting

**Original behavior:** any existing Qwen Code review comment on the PR → inform the user and require confirmation before posting new comments.

**Problem:** in real /review usage, most existing Qwen Code comments fall into one of three "no-real-conflict" cases:

1. **Stale by commit**: the comment was posted against an older PR HEAD; the underlying code has changed.
2. **Resolved by reply**: someone has replied in the thread (the original author "fixed in abc123" or a reviewer "ok, approved"). The conversation is closed.
3. **No anchor overlap**: the old comment is on a different `(path, line)` from any new finding. They simply coexist.

Forcing the user to confirm-or-decline every time the PR has any Qwen Code history creates prompt fatigue without protecting against the real risk — which is **commenting twice on the same line**, producing visual duplicates that look like a bug to PR readers.

**New behavior:** classify each existing Qwen Code comment by checking in priority order — **Stale by commit** > **Resolved by reply** > **Overlap** (same `path + line` as a new finding) > **No conflict**. The first match wins. Only the Overlap class blocks; the other three log to the terminal and continue.

**Priority matters because** a stale or resolved comment that happens to share a `(path, line)` with a new finding is not a real conflict — the underlying code may have changed in the stale case, and the conversation is already closed in the resolved case. Without priority, the line-based check would fire false-positive prompts on those.

**Trade-off:**

- ✅ Common case (re-running /review on a PR after a few new commits) no longer prompts unnecessarily.
- ✅ The terminal log keeps the user informed about what was skipped, so transparency is preserved.
- ❌ Conceptual overlap that doesn't share a line is missed — e.g. a prior comment on line 559 about cache lifecycle and a new comment on line 1352 about cache lifecycle would be classified `No conflict`. Line-based heuristics cannot detect "same root cause, different anchor." If the user wants semantic-overlap detection, they must read the terminal log and the PR comments themselves.

Line-based classification was chosen because it's deterministic, cheap, and catches the precise UX failure (visual duplicate at the same line). Semantic overlap detection would require an extra LLM call for what is, in practice, a rare edge case.

## Why downgrade APPROVE when CI is non-green

**Original behavior:** if Step 6 resolved verdict to `APPROVE`, the API event was submitted as `APPROVE` without any check on CI status.

**Problem:** the LLM review pipeline reads the diff and surrounding code statically. It does not run tests, does not exercise integration boundaries, and does not see runtime failures. CI does. A PR with red CI but no static red flags is **the worst case** for an LLM `APPROVE` — the human reader sees an Approve badge from a tool that didn't actually verify the change runs.

**Current behavior:** before submitting `APPROVE`, query `check-runs` and legacy commit `statuses` for the PR HEAD. Classify:

- All success → `APPROVE` continues.
- Any failure → downgrade `APPROVE` to `COMMENT`, body explains.
- All pending → downgrade to `COMMENT` (don't approve before CI decides), body explains.

**The hole under all of this: a check that never ran looked like a check that passed.** GitHub reports a skipped job as `status: completed, conclusion: skipped`. The classifier tested for failure conclusions and for pending statuses, and `skipped` matched neither — so it fell through into `all_pass`. Every word above delegates runtime truth to CI _because_ the LLM pipeline reads code statically. If the delegation returns nothing, and returns it wearing a green badge, the delegation is worse than not having it.

PR #6486: the one job that would have exercised the new `Ctrl+F` hotkey — `Integration Tests (CLI, No Sandbox)` — was skipped, as were the macOS and Windows `Test` legs. `all_pass`. And even had it run, it would have passed: the test drove a CSI-u sequence into a PTY that never negotiated the kitty protocol, so the keypress was discarded before reaching the handler. A test that cannot fail, in a job that did not run, scored as verification.

`skipped`/`neutral` are now recognised, with two deliberately different consequences:

- **Some checks skipped → a disclosure, not a downgrade.** Empirically this repo emits skipped runs constantly — routing jobs (`authorize`, `review-pr`, `precheck-pr`) that also emit a successful run of the same name, which is why "did it run" is a question about the _name_, not about any single run. And a docs-only PR legitimately skips the test matrix. Auto-downgrading on any skip would downgrade every review in the repo, which is how a gate gets ignored. So presubmit _names_ them and Step 7 rules on them — because whether a skipped check would have exercised **this** diff is a question about the diff, which presubmit cannot see and the reviewer can.
- **Every check skipped → a downgrade.** Checks exist, not one ran: there is no green here to approve on, and no judgment is required to say so. (A repo with no CI at all is a different claim — `totalChecks === 0`, not downgraded.)

**Why downgrade rather than block:** the reviewer LLM has done substantive work; throwing the review away because CI is red wastes that. Downgrading to `COMMENT` keeps all inline findings, preserves the static review value, and lets GitHub's check status carry the "do not merge" signal naturally.

**Why this stacks with self-PR downgrade:** a self-authored PR with red CI hits **both** downgrade rules. The event is `COMMENT` either way, so stacking is operationally a no-op — but the body should mention both reasons so a future maintainer reading the review knows why an LLM that found no Critical issues did not approve.

**Trade-off:**

- ✅ No more "LLM approved while CI is red" embarrassments.
- ✅ Reviewer's substantive work (inline comments) is preserved.
- ❌ Adds two extra API calls (`check-runs` + `statuses`) per APPROVE-bound submit; only relevant for the `APPROVE` path so the cost is negligible.
- ❌ A genuinely flaky CI failure can downgrade what should have been an Approve. Mitigation: the body text directs the user to verify; they can always submit `APPROVE` manually after triaging.

## Why presubmit and cleanup live as `qwen review` subcommands

**Original behavior:** Step 7's three pre-submission checks (self-PR detection, CI status, existing-comment classification) and Step 9's cleanup were inlined in SKILL.md as `gh api` / `git` shell commands. The LLM ran each command itself, parsed the output, and applied the classification logic.

**Problems with inlining:**

1. **Token cost**: each command, jq filter, classification rule, and output schema is part of the prompt — every `/review` invocation pays this cost.
2. **Drift risk**: the classification logic exists twice (in the prompt's English description, and in whatever the LLM internally synthesizes). When rules change (new check_run conclusion type, new comment bucket), both have to update or they drift.
3. **Cross-platform fragility**: `/tmp/qwen-review-*` worked on macOS shell but Node's `os.tmpdir()` returned `/var/folders/...`. The mismatch only surfaced when the cleanup logic was tested.
4. **Testability**: prompt text isn't unit-testable. Logic that classifies CI states or comment buckets is the kind of thing that benefits from real assertions.

**Current behavior:** the deterministic logic lives in `packages/cli/src/commands/review/` as TypeScript subcommands of the `qwen` CLI:

- `qwen review presubmit <pr> <sha> <owner/repo> <out>` — emits a single JSON report with `isSelfPr`, `ciStatus`, `existingComments` (4 buckets), `downgradeApprove`, `downgradeRequestChanges`, `downgradeReasons`, `blockOnExistingComments`. SKILL.md only describes the schema and how to apply the report.
- `qwen review cleanup <target>` — removes the worktree, branch ref, and per-target temp files. Idempotent.

**Why subcommands rather than `.mjs` scripts in the skill bundle:**

- `.mjs` files were tried first but `copy_files.js` only bundles `.md`/`.json`/`.sb`. Adding `.mjs` to the bundler is one option, but it leaves the script standing alone with no integration into `qwen`'s CLI surface.
- yargs subcommands compile via the same `tsc` step as the rest of `packages/cli`, so the build pipeline doesn't change.
- LLM doesn't need any path resolution — it calls `qwen review presubmit ...` exactly like it would any other shell command. No `{SKILL_DIR}` template, no `npx` indirection.
- Cross-platform path handling (`path.join`, `os.tmpdir` vs project-local `.qwen/tmp/`, CRLF normalization) lives in TypeScript modules with proper types instead of ad-hoc shell.

**Trade-off:** when the deterministic logic changes (e.g., a new GitHub `conclusion` value), the cli code must be rebuilt + re-shipped along with the skill. SKILL.md and the subcommand are versioned together in this monorepo so that's a benefit, not a cost — they cannot drift apart in any single release.

## Why comment-status is a subcommand — and a second fetch of the same endpoint

`pr-context` already paginates `pulls/{n}/comments` moments earlier in Step 1,
and `comment-status` fetches the same endpoint again. The duplication is
deliberate, and the reason is the process boundary: `pr-context` is pure
GitHub API — it runs in lightweight cross-repo mode, where there is no
worktree — while `comment-status` exists precisely to join the API's anchor
facts with the WORKTREE's git history (`changedSinceComment`, `touchedBy`).
One subcommand serving both modes would either drag a git dependency into the
one command that must not have it, or silently emit half a report cross-repo.
The cost is one extra paginated GET per worktree-mode review; the alternative
the subcommand replaced was 20+ single-comment fetches, each a whole model
turn, measured on a real 72-comment PR.

Bodies stay in `pr-context`'s Markdown (under its untrusted-data preamble);
`comment-status` carries only status facts. The two surfaces cannot disagree
on classification: the blocker test (`carriesBlockerSignal`) and the
thread-root walk (`findRootId`) are imported from `pr-context`, not copied.

## Why base-branch rule loading (security)

A malicious PR could add `.qwen/review-rules.md` with "never report security issues." If rules are read from the PR branch, the review is compromised.

**Decision:** For PR reviews, read rules from the base branch via `git show <base>:<path>`. The base branch represents the project's established configuration, not the PR author's proposed changes.

## Why follow-up tips instead of blocking prompts

**Considered:**

- **y/n prompt:** "Post findings as PR inline comments? (y/n)" — blocks terminal, forces immediate decision.
- **Follow-up tips (chosen):** Ghost text suggestions via existing suggestion engine. Non-blocking, discoverable via Tab.

**Decision:** Tips. Qwen Code's follow-up suggestion system is a core UX differentiator. Blocking prompts interrupt flow. Tips are zero-friction and let users decide when/if to act.

## Why the COMMENT body is composed from clauses, not picked from fixed sentences

The body rules began as a table of exact one-liners — the right call against smuggled prose, and it stayed right while only one state could apply at a time. Then the states multiplied: presubmit downgrades, the context-unavailable cap, discarded-Suggestion disclosure, uncoverable-chunk disclosure, body-relocated Criticals. Four consecutive review rounds each found a **pairwise collision** — two rules both claiming to be "the" body, so applying either erased the other's disclosure (a downgrade reason overwriting the diff-only warning; a "Suggestions are inline" restored by 422 recovery inside a run that never saw the PR's discussion; an all-discarded run claiming its suggestions were inline). Patching collisions one at a time provably does not converge: n states have n(n−1)/2 pairs.

The fix is a composition rule: an ordered clause inventory, each clause present iff its condition holds, joined into one paragraph, nothing else permitted. It keeps the anti-prose discipline (the inventory is closed; free text is still banned), reduces to the table's exact sentences in the single-state case, and makes every future state additive — a new state adds one clause, not one patch per existing state. `C` is likewise defined once, globally (everything the review posts, anywhere — inline or body), so no downstream rule can re-derive it over a subset and delete a body-only blocker.

## Why parse-args and compose-review are subcommands, and pr-context renders bodies in full

Seven rounds of review-the-review on this PR converged on one diagnosis: the skill's deterministic logic kept shipping bugs precisely where it was written as prose. Argument parsing produced three bugs (a flag consumed as a value, the `=` form undefined, an invalid value leaking into target disambiguation). The event/body machine produced five (four Critical), all one shape — a downstream branch not updated when an upstream rule gained a new state, because the machine was restated in four places that had to be synchronized by hand: n states, n(n−1)/2 pairwise collisions, patched one at a time without converging. And the "fetch review bodies for the re-check" instruction was rewritten **five times in four rounds** (missing pagination → shell truncation → unpageable single-line JSON → a marker filter that discarded markerless blockers → offline selection), which is what writing a download program in English looks like.

The resolution is the same one this document already records for presubmit and cleanup: judgment stays in the prompt, bookkeeping moves to tested subcommands that version together with the skill.

- **`parse-args`** owns the grammar. Every previously-shipped parsing bug is a named row in its table-driven tests. The raw string travels **on stdin** (`--stdin` with a quoted heredoc), never as a positional: a flag-first raw string (`/review --effort low`) is consumed by the CLI's own strict parser before the handler runs, and a positional also breaks on quotes and shell metacharacters. Pure-function tests could not see that class — the documented invocation failed only when run against the built binary — so the suite includes yargs-level wiring tests alongside the table.
- **`compose-review`** owns event selection and body composition — the C/S table (counting body Criticals and discarded Suggestions), the event caps (cannot-tell existing Criticals, uncoverable chunks, unreviewed dimensions, context-unavailable), the downgrade carve-outs, and the clause composition. Its truth-table tests pin each shipped bug; writing them immediately caught one more instance of the class (all Suggestions discarded → S=0 → APPROVE). The input is validated at the boundary: the producer is a model writing JSON that omits inapplicable fields, so absent counts default to zero and malformed values throw typed errors — before that, an omitted count meant `undefined + 1 = NaN`, which fails every event comparison and would have returned APPROVE over a body-only blocker. 422 recovery stops being a hand-derived recomposition: it is the same call with the updated `--comments` file (the inline counts are counted from the drafted comments, never typed — see "The Approve over a relocated Critical" under Measured incidents), so the "recompute may never upgrade the verdict" guarantee holds by construction.
- **`pr-context`** ends the fetch-prose chain at its root: review bodies **and every blocker-bearing body** render **in full** (a body-only blocker lives only there; a capped body names its review or comment id so the tail stays fetchable one object at a time, and reply snippets name their comment id when cut), and blocker-bearing threads are quarantined into a "Blockers to re-check" section instead of settling into "Already discussed" — a reply alone never retires a blocker. The `gh` wrapper's `maxBuffer` rises to 64 MiB, closing the ENOBUFS that killed two subcommands mid-review on a comment-heavy PR.

What deliberately stays prose: everything judgment-shaped — what counts as a Critical, verification, the posting gate's authorization semantics, the angles. A truth table cannot decide whether a finding is real; it can guarantee that a real finding is never mislabeled, dropped by a downgrade, or approved past.

## Why blocker recognition is semantic, not the `[Critical]` marker

The mandatory re-check section used to be gated on the literal string `[Critical]`. That marker is emitted by exactly one author — `/review` itself. Every human blocker was therefore invisible to the gate, and the fallback was a prose instruction in Step 6 telling the model to also scan "Already discussed" semantically.

Prose does not beat structure. PR #6486 is the proof, and it cost a shipped blocker.

A maintainer built the PR, drove the real CLI through a PTY, and found that `Ctrl+F` **dual-fires** — it toggles the model _and_ moves the input cursor, because `text-buffer.ts:2663` still binds `Ctrl+F → move('right')` and both handlers are independent subscribers of a `KeypressContext.broadcast()` that has no stop-propagation. They filed it as an **issue comment**, headed `🔴 Finding 1 — … (blocker)`. No `[Critical]` marker, because a human wrote it.

Three things then compounded:

1. Issue comments all settle into **"Already discussed — do NOT re-report"**.
2. They render as **240-character one-line snippets**.
3. The first 240 characters of a verification report are its **preamble**: _"I built this PR from source and drove the real CLI … to validate the model-toggle hotkey before merge. Sharing the results as a merge reference."_

So the one artifact that proved the PR was broken was presented to the review agents as a **maintainer endorsement**, in the section that says not to re-report it. The blocker itself began 1 143 characters past the cut. Three hours later `/review` reviewed the same commit — the fix did not land until that evening — and submitted **"Reviewed — no blockers"**. This is precisely the "dropped blocker" failure the Step 6 re-check exists to prevent, and the re-check could not prevent it, because the input it was handed said the opposite of the truth.

The fix moves the decision out of prose and into `carriesBlockerSignal`: any body asserting a blocking defect — inline thread or issue comment, `[Critical]` or `(blocker)` or "is a blocker" or "must fix" or "still reproducible" or 阻塞项 — is promoted into **"Blockers to re-check"** and rendered **in full**. A bare `🔴` is deliberately **not** a signal, for the reason the next paragraph measures.

Two properties are deliberate:

- **Fail-safe direction.** A false positive costs one extra ruling by the re-check; a false negative ships the bug. When in doubt, promote.
- **Precision still matters, in the other direction.** Promotion means full-body rendering, and a context file that outgrows one `read_file` is its own way of losing a blocker (PR #5738, recorded above). The prose scan of "Already discussed" is retained as a floor — `carriesBlockerSignal` recognises the phrasings we have seen, not every phrasing that exists.

**Both of those were nearly undone by the first implementation, and only a live run showed it.** That version scanned the whole body for the words `blocker`, `🔴`, `阻塞`, `[Critical]`. Run against the real #6486 thread it promoted **8 of 15** issue comments; exactly one was a live blocker. The others were the triage bot's own template line **"No critical blockers."** (the word inside its own negation), the author's **"### 🔴 Critical fixes"** (a severity emoji on a list of repairs), and a later comment _quoting_ `[Critical]` while arguing a finding away. Eight full bodies took the context file from 30 KB to 59 KB and pushed the real blocker to character **43 094** — past the 25 000 one `read_file` returns. The section existed, held the right blocker, and no agent could see it: PR #5738's failure, reintroduced one section further down by the fix for it.

Three changes, and the ordering one is load-bearing:

- **The section is written FIRST**, ahead of the description and the review history. Nothing in the file outranks the claims a `C=0` verdict may not be reached without ruling on. On the live thread this moved the heading from char 25 961 to **569**, and the blocker body from 43 094 to **4 421**.
- **Recognition matches assertion patterns, not word presence** — `[Critical]`, `(blocker)`, `is a blocker`, a bare `blocking` (with a `non-blocking` / `非阻塞` lookbehind), `must fix`, `still reproducible/repro/broken/fails`, `阻塞项/问题/点` — with a **bilingual** negation guard, so neither "no blockers" nor "没有阻塞项" ever promotes. Live promotions dropped 8 → 3 (the one real blocker plus two harmless mentions), and the file 59 KB → 40 KB.
- **The section carries a character budget.** Tight patterns keep promotion rare; the budget keeps a pathological thread from blowing the read window anyway. Bodies past it degrade to snippets **naming their exact fetch**, which the re-check already must run before ruling — not to silence.

The lesson generalizes past this file: **"a false positive is cheap" is a claim about a budget, and it has to be measured against the real distribution, not assumed.** Here it was false until the ordering was fixed.

## Why a test-efficacy probe, when there is already a Test Coverage agent

Agent 5 asks whether a test **exists** and whether its assertions **look like** they check something. Agent 7 runs the suite and reports that it is **green**. Neither can see a test that protects nothing, and there are two ways to ship one:

- **Unreachable** — the project's test command never collects the file.
- **Inert** — it runs, it passes, and it would still pass with the change reverted.

PR #6486 shipped both, in one file. The new test lived in `integration-tests/`, which is not an npm workspace, so `npm test --workspaces` never collected it; its CI job (`Integration Tests (CLI, No Sandbox)`) was skipped, so CI never ran it either. **The test executed nowhere — not in CI, not in the review — and nothing in the pipeline noticed.** And had it run, it would have passed regardless: it drove a kitty CSI-u sequence into a PTY that never negotiated the kitty protocol, so the keypress was discarded before reaching the handler under test. It could only ever have caught a startup crash. Agent 5 saw a test file with plausible assertions and said coverage was fine.

Both questions are decidable without judgment, which is why they are a subcommand and not a prompt. Unreachability needs no execution at all — it is a path against the root `package.json` workspace globs. Inertness needs one run: revert the diff's **source** files to base, keep its **tests**, re-run them. A test that is still green is green whether or not the feature exists.

**The trap, and the reason the classifier is asymmetric.** Reverting source frequently breaks the test's own compile — it imports a symbol the diff introduced — and the runner exits non-zero having collected nothing. It is tempting to score that as "the test caught the revert". It is not: a compile error says nothing about whether the test would catch a _behavioural_ regression, and scoring it as `gated` would hand back precisely the false assurance this command exists to remove. So `gated` requires a real **assertion** failure; a bare non-zero exit with nothing collected is `inconclusive`, and `inconclusive` is never reported as a finding.

Two other deliberate limits:

- **A test-only diff is never probed.** A new test for old code is _supposed_ to pass with nothing reverted. Probing it would flag every such PR as inert — a false blocker on exactly the PRs we want people to write.
- **Findings are Suggestions, not Criticals.** A test that does not gate is not itself wrong code; nothing is broken today. What the finding must say concretely is which behaviour is now shipping unprotected.

## Why a review that only ever had one tree needed the other one

Every step in this pipeline looks at a single tree. The agents read the PR's code. The verifier traces a failure scenario through the PR's code. Even the probe capability — the one thing here that _runs_ rather than reads — runs against the PR's code alone. The merge base has been known since the first `fetch-pr` (`mergeBaseSha`, resolved and recorded), and it was used for exactly one thing: choosing the diff range. Nothing ever built it.

That is fine for most findings, because most findings are claims about the code in front of you: this branch is unreachable, this variable is undefined here, this lock is never released. But it leaves a class the review can only ever guess at, and it is a large one, because it is the class the diff itself is _about_:

- "This changes the output format."
- "This only adds a field; existing consumers are unaffected."
- "This silently drops the error message."
- "Before this, a cancelled call and a failed call were indistinguishable."

Every one is a statement about the **difference between two programs**, and the review has had one of them. So the difference gets recovered by reading the diff — and that is precisely the reading that fails, for the reason this document keeps rediscovering in other contexts: a diff's new lines are always present and always look correct, and whether they change what anyone observes routinely turns on code the diff never touches. It is the same shape as the `fixed by this diff` trap ("the diff adds a fix" is not "the defect can no longer fire") and the same shape as the documented-intent trap. Both were closed by making the verifier go read something outside the diff. This one cannot be closed that way, because what is outside the diff here is not a _file_ — it is a _build_.

**With a built base tree the question stops being an argument and becomes an observation.** Feed the same input to both, compare the two outputs. That is a different kind of evidence from anything else in this pipeline: not a better-traced claim, but a measurement, and the only kind that settles a disagreement about what a program used to do.

Three deliberate limits:

- **The command builds; it does not run.** Standing up the tree is the expensive, failure-prone half — a detached worktree at the right SHA, a stale sibling from a crashed run, the minimal build set, the widening loop, deadlines a real build can meet — and all of it is decidable, so it is code. _What_ to run is not: it depends entirely on the claim under test, and a fixed scenario would fit almost none of them. The report hands back a path and stops.
- **It is per-finding, not per-review.** A cold checkout means an install and a build — the honest price, and why the command's idempotent fast path reuses an already-built tree instead of letting concurrent verifiers each pay it (or worse, sweep it out from under each other mid-A/B). Paid on a review with a comparative claim it is cheap for what it settles; paid on every review it is a tax most of them get nothing for. So it lives in the verifier's brief as an option, next to the probe, on the same terms.
- **Unavailable is never a finding.** No merge base, a merge base that may be stale (`baseFetchFailed` — an A/B against the wrong base attributes the base branch's own commits to this PR, the two-dot-diff error in another shape), or a base tree that will not compile: each is a fact about the harness. The base failing to build says nothing whatsoever about the PR, and a review that filed it as one would be reporting on its own infrastructure.

## Why rendering claims get a real renderer — and only with a user-designated scratch repo

A sanitizer PR's guarantees are claims about GitHub: what its comment pipeline decodes, what its allowlist strips, when its notification path fires. A live verification measured the gap between the model and the authority exactly where it hurts: an `@` → `&#64;` defusal that every local reading called sound, because GitHub decodes character references _before_ the mention filter runs — a fact no local markdown library reproduces and the real renderer demonstrated in one posted comment (the mention registered, the subscription fired). Judging a sanitizer against a local model of GitHub is the same parser-divergence failure the sanitizer itself is being reviewed for.

So the verifier gets the authority itself — under three constraints that keep it from eroding the write ban:

- **User-designated, or nothing.** The capability exists only when `QWEN_REVIEW_SCRATCH_REPO` names a repo the user chose for disposable posts. There is no default, no fallback, no "any repo I can write to": the review does not pick its own outward write destination, ever.
- **Payload-minimal.** What gets posted is the markdown shape under test, never the report, the diff, or anything naming the PR or its authors — a scratch post that leaked review content would be a disclosure, not a measurement.
- **Honest without it.** Absent the setting, a rendering claim caps at low confidence / `cannot tell`. The alternative — "confirmed" off a local approximation — is precisely the false assurance the live case measured.

Step 7's write ban names the carve-out explicitly rather than relying on "the scratch repo is not the PR": the ban's strength is that a compressor cannot narrow it, so an exception it does not name is an exception a compressed run cannot trust.

## Why extract-step exists, and why it stubs nothing

The strongest workflow verification in this repo's review history ran the real composer step from both arms with a stubbed `gh` and byte-compared outputs against a real posted comment. Everything judgment-shaped in that harness — what to stub, what input to feed, what to diff — stays with the verifier. What moves into code is the half that is mechanical and quietly error-prone by hand: finding the right job, the right step among same-named siblings, and carrying the settings whose values change the script's behaviour. The command emits the script **verbatim** plus metadata: the `${{ … }}` sites (listed, never evaluated — any value this command inserted would be an invention), the env (as comments, never half-substituted exports — an unbound variable should fail loudly), and a heuristic list of invoked commands as the stubbing starting point. Combined with `base-tree`, the two arms of the by-hand harness are now two invocations.

Three details of that mechanical half are worth naming, because each was a way the command could have been quietly wrong about the script it claims to reproduce verbatim:

- **`env:`, `shell:` and `working-directory:` are three-level settings** — workflow, job, step, nearest wins — and only the step level appears in the step's own text. Reading step level alone would reproduce by machine the transcription error the command exists to remove; measured on this repo's own workflows, **195 of 434 `run:` steps inherit env from an outer level**, so it would have been wrong about 45% of them. The metadata carries the merged result plus the level each key came from, ordered nearest-first so a step's own vars are not buried under an inherited block.
- **A `shell:` declared as `bash` is not the runner's default `bash`.** The default is `bash -e {0}`; declaring `shell: bash` (at any level) makes it `bash --noprofile --norc -eo pipefail {0}`. A pipeline whose middle stage fails aborts under one and not the other, so the emitted header carries `set -eo pipefail` or `set -e` accordingly — a distinction that decides whether the extraction measures the same script the runner ran.
- **The header must be inert, line by line.** A `env:` value can be a YAML block scalar; commenting only the entry's first line left its continuation lines in command position, and under the header's own `set -e` the step died in its preamble before its body ran. Four steps in this repo produced exactly that. The test oracle asserts the property directly — the file is the header plus the body verbatim, and every line before the body is a comment or a named directive — rather than filtering the output for lines that look executable, a filter that could not tell the header's `set -e` from one the body legitimately contains.

## Why the round-3 lenses are prose, not detectors

Seven lenses joined the briefs from one verification round, and each is a judgment with a crisp trigger rather than a decidable predicate — which is what separates a brief lens from a subcommand here:

- **A borrowed idiom, missing what made it work at home.** The `&#64;` rewrite was lifted from a workflow where the _code ancestor_ did the protecting; the entity was belt-and-braces, and only the braces were copied. The check — read the source context of a lifted defensive construct, name what it provided — requires understanding which surrounding condition was load-bearing.
- **A second parser is a divergence hunt.** A sanitizer's model of markdown against GitHub's parse: every input the two read differently is a bypass. Finding the divergent input is the work; a tool can only confirm one once named.
- **A `fixed` ruling on a divergence-class defect is a ruling about the family.** Round 6 of the same verification closed the fence-shaped entrance into a raw-HTML block and left the code-span entrance beside it open — same divergence, adjacent syntax. The re-check bar in Step 6 now says it outright: enumerate the sibling entrances before ruling `fixed`, report a still-open sibling as a new finding, and keep the two rulings separate (the original's `fixed` stands when its own input is closed). Judgment again: knowing which inputs are "the same mechanism" is the understanding a detector cannot supply.
- **A threshold fix's coverage is a number, and the number wants measuring.** A ratio-guard fix verified live was covering exactly half of its linked issue's reported shapes — provable only by holding the issue's own preamble fixed and binary-searching the payload size where recovery flips (~473 chars). The recipe (fix the variables, scan the guarded one, put the boundary next to the issue's report) is in the verifier's brief; choosing which variable to scan is the judgment half.
- **The sharpest parser-differential corner is the format's own delimiters as payload.** A no-escaping extractor fed a value containing its close tag truncates silently — measured live as a file written truncated with no warning. Named explicitly in the lens so the first probe is the strongest one.
- **A deliberate-design defence covers the states it argues, not the gate it shares.** An input-hold correct and argued for the _active_ state silently froze three idle states nothing had argued for — the sibling-entrance rule applied to a state machine. The documented-intent step now says it: enumerate the states a shared gate serves, and treat every unargued one on its own merits.
- **Mechanism-pinning tests, and oracles that mirror the implementation.** A test asserting `&#64;` appears pins the mechanism while the guarantee fails; a fold-balance test whose helper re-implements the sanitizer's own scanner shares its blind spot by construction. Both shapes need the reviewer to ask what the _effect_ assertion would be and where an independent oracle would come from.

## Why test failures are attributed by measurement, and why the delta is over file sets

Agent 7's brief has always carried a path rule: a failure in a file the diff changed is a Critical, one in a file it did not touch is pre-existing. It was the best rule available when the review had one tree, and it misclassifies in both directions — an environment-sensitive test failing in a touched file gets filed as a Critical the PR did not cause, and a PR that breaks a test in an untouched file (the exact shape the base-tree section above is about) gets waved through. The first live run of this pipeline hit the benign half: three env-sensitive core failures the model had to _reason_ into "pre-existing, not in diff", correctly but on judgment.

With `base-tree` standing, attribution is decidable: `test-delta` reruns the same failed command in the built merge base and diffs the outcomes. The two design points that matter:

- **File sets, not counts.** Measured on a live re-verification: the same branch's flaky suite failed _different test names_ on two consecutive runs, so counts (and names) are noise. The failing-file set is the stable unit, and an empty net-new set is the strongest "all pre-existing" statement obtainable.
- **Failures only, and base attributes nothing it did not finish.** A green PR-side suite has nothing to attribute, and base's suite was green before the PR existed — so the base run costs exactly one rerun per PR-side failure. A base rerun that times out attributes _nothing_: promoting PR-side failures to net-new off an unfinished run would manufacture the command's strongest evidence out of an infrastructure timeout (this shipped briefly in review of the command itself, caught because the test that "covered" it asserted only the note text). The same holds for every other way the base side can end up unmeasured — a rerun that failed without naming a file, a command the budget could not fit, a base tree that would not build — and the report names each with its own reason, because "we could not measure" and "we measured nothing" are different facts to the author.

## Why the cache carries a findings ledger

A human reviewer's round-2 comment opens with "M1 is fixed"; the pipeline's round-2 opened with a fresh list, because the incremental cache stored a _count_ and a _verdict_ — enough to scope the diff to `lastCommitSha..HEAD`, nothing with which to say what became of round 1's findings. The author was left to diff two reports by hand, which inverts who is doing the review.

So the cache now carries the findings themselves, with round-scoped ids (`R1-2`), and an incremental re-review owes each entry a ruling under the same bar the open-Criticals re-check already enforces — _fixed_ requires tracing that the mechanism can no longer fire, not observing that the diff contains a fix. Two boundaries keep the ledger honest: only **confirmed high-confidence** findings enter (next round re-asserts each entry by id, so the ledger holds claims the review stands behind), and a finding ruled fixed _leaves_ (the cache is what the next round must check, not history — the report already told the story). The fail-closed rules are unchanged: a run that must not advance the cache does not advance the ledger either.

## Why the ledger's authoritative copy rides the posted review, not the cache

The round ledger shipped as a local cache file and its first multi-round live use exposed the flaw immediately: four model-comparison rounds reviewed the same two PRs from the same machine at medium effort, and every round opened from scratch — medium never reads the cache, and had the rounds run from CI or another clone there would have been no cache to read. Meanwhile the one artifact every environment can see — the posted review — carried nothing machine-readable, even though the human it imitates opens round 2 with "M1 is fixed" precisely because the previous report is right there on the PR.

So the authoritative ledger now travels in the posted body as an HTML-comment marker: invisible on the PR page, durable as the comment, recovered by the next round's `pr-context` wherever it runs, with the local cache demoted to fallback for rounds that never posted. Three boundaries keep it honest:

- **Own-account, latest round only.** The ledger claims "these are the findings the previous /review stood behind", and only this account's reviews can make that claim — another user's marker is data about _their_ tooling. Each posted round embeds a fresh full copy, so the newest marker is the whole state.
- **Data, not authority.** Every recovered entry is owed a Step 6 ruling against the code — the ledger routes work, it never rules. A tampered or stale marker therefore costs a few wasted rulings, not a wrong verdict, which is why parsing is fail-quiet and the round number feeds `compose-review` from a CLI-written side file rather than a model's memory.
- **Medium reads, high writes.** Recovering the ledger is free (the reviews were already fetched), so the default-effort re-review finally opens like a round-2 comment; the cache write and the posting that carries the marker keep their existing effort gates untouched.

Two consequences of those boundaries are worth naming rather than discovering. Ids are **carried, not renumbered**: a still-standing finding is re-reported under the id it already has, that id is written into the comment right after the severity marker, and `buildLedger` reads it back — because a ledger that renumbered by position would key the next round's work list to ids the report riding beside it never used, and `R1-2 names the same claim in every round` is the entire payoff. And own-account recovery means a PR reviewed from **two** accounts — a maintainer locally, a bot in CI — keeps two independent ledgers, each with its own round counter and its own `R2-1`; that is the honest reading of "only this account's reviews can claim what this account stood behind", but it does mean the ids are scoped to the account that wrote them, not to the PR.

## Why three more mutation operators, and why each is shaped the way it is

Statement deletion with a safety-verb filter was the first operator because it has the cleanest survivor semantics. But a live maintainer re-verification produced a survivor list the deletion operator cannot express — and every entry mapped to one of three shapes, each with equally crisp semantics:

- **`?? fallback` dropped.** The surviving case was the one line preventing a previously-fixed regression from returning through a different path — a coalesce to `getModel()` that nothing tested. A coalesce survivor means the miss path is unexercised, and the miss path is frequently the entire safety property.
- **Guard condition → `true`.** The surviving case was the round-2 fix _itself_ — a skip-condition shipped in response to review, tested by nothing. Restricted to comparison-bearing `if`s on purpose: forcing `if (ready)` to `true` survives trivially everywhere and means nothing; forcing `a !== b` to `true` surviving means no test pins when the guard must _not_ fire, which is precisely the untested half of any guard.
- **`+ UPPER_CONST` dropped.** The surviving case was a reserve term in a budget estimate. A term-drop survivor means the constant never decides any test's outcome — the boundary is unpinned.

Mechanically they are **replacements**, not deletions, which bought one bug worth recording: the selector's per-line code view is trimmed and literal-blanked, and an edit index computed there and applied to the raw line spliced `iftrue 0)` into a guard. The fix is the conservative equivalence the selector now enforces — a line whose raw text and code view disagree (it carries a string or comment) yields no candidate at all, because a mangled mutant is worse than a skipped one: its compile error reads as `inconclusive` and quietly spends a cap slot. Deletion mutants keep cap priority (they have the track record); the operators queue behind them and every skip is counted.

## Why the quality brief checks documentation parity, not documentation

"This flag needs docs" is a reviewer's preference; "three of this flag's four siblings have a docs entry and it does not" is the codebase's own convention, broken. The lens is deliberately the second shape: no documented sibling, no finding, and the finding must name the precedent file — so the Suggestion arrives as the house standard rather than taste. The trigger that earns it a place at all is the compounding case from a live review: a surface whose behaviour can _silently change_ (an automatic model swap with a warning) shipping undocumented leaves the user staring at a message with nowhere to look it up.

## Why the Test Plan is checked — and why a count mismatch is never a contradiction

Every other input this pipeline reads is something the review has to derive: the diff, the linked issue, the existing threads, the build's exit code. A Test Plan is different. It is a list of falsifiable assertions the author **already wrote down** and handed over, and until `test-plan` existed the review read none of them.

Not for want of the text — `pr-context` renders the PR body in full. But its consumer is Agent 0, and Agent 0's question is root-cause fidelity: is this the right fix for the linked issue? "The author says 471 tests pass; do they?" is a different question, nobody owned it, and the answer is frequently no in a way that costs the next reader real time — a path from a commit that got amended away, an `npm run test:unit` that was renamed, a count copied from the first push.

The split follows this document's recurring line — determinism owns the evidence, judgment owns the ruling — but the interesting part is where it says determinism owns **nothing**. Two claim kinds are decidable here with no model and no false positives:

- **A path that is not there.** Checkable against the reviewed tree. Absent from the diff _and_ absent from the worktree means the sentence describes some other commit. (Present-but-untouched is not a defect: "ran the existing suite at X" is a normal thing to write, and the ruling says so.)
- **An npm script that does not exist.** Checkable against the workspace manifests. If no package defines it, a reviewer who follows the Test Plan cannot run it.

**A test count is the third kind, it is the one that motivated the command, and it is deliberately not ruled a contradiction.** The temptation is obvious — the count is right there, `build-test` observed a count, compare them. It is wrong, because a count is only falsifiable against the suite the author meant, and a Test Plan almost never names one. `build-test` runs the workspaces the diff touches plus the workspaces that depend on them; the author ran whatever they ran. `471 ≠ 472` is then a fact about two different measurements, and filing it as a defect is filing arithmetic the command cannot do. So the verdict is `differs`: both numbers, side by side, framed as claimed-versus-observed, and the reader decides. That is what the observation was worth in the first place — a note to the author, never a blocker. The real 471-vs-472 case that prompted this was the mildest item in a four-item review, and the fix was "bump the number".

**Nothing here blocks and nothing caps**, which makes `testPlanGate` the first gate in this file that is pure disclosure. Both halves are deliberate. A Test Plan defect is not a code defect — the diff is unaffected, and the verdict is about the code; spending the review's one irreversible public action on a documentation nit is exactly the "cry wolf" cost the design philosophy exists to avoid. And capping on a **missing** report would cap essentially every PR, because most produce no notes at all. That is the deferred-checker precedent from `script-lint`, for the identical reason: a limitation the author cannot fix must not make their PR un-Approvable forever. A stale report is dropped in silence rather than failed closed, since there is no cap to fall back to and a note about a previous commit's Test Plan is worse than no note.

## Why the probe is also per-hunk, when there are already mutants

The efficacy command asks "does anything gate this change?" three ways, and the third exists because the first two leave a gap that is easy to miss:

| probe  | neutralises                                              | answers                  |
| ------ | -------------------------------------------------------- | ------------------------ |
| revert | **all** the diff's source, at once                       | is ANY of this gated?    |
| mutant | **one statement**, from a high-precision safety-verb set | is THIS statement gated? |
| hunk   | **one hunk**                                             | is THIS change gated?    |

The revert probe is all-or-nothing, and the live dogfood that motivated the mutants showed exactly what that costs: a file with six well-tested behaviours and one untested safety statement reverts red on the six, reports `gated`, and the seventh — the PR's headline invariant — is invisible. The mutants close that, but only for statements the safety-verb set recognises: calls that discard, detach or reset state, and reassignment to an empty collection. That set is deliberately narrow, because a wide one produces mutants nobody should act on.

So a diff made of **condition changes, return-value changes, format changes, off-by-one fixes** — which is most diffs — generates **zero mutants**, and its only signal is the all-or-nothing revert. A hunk is the natural unit for the missing question: it is the granularity the author wrote and the granularity a reviewer reads, and reverting one at a time is the only way to attribute a still-green suite to a **particular** change rather than to the diff at large.

Four things this gets right by construction, three of them borrowed from the mutants:

- **The patch, not a checkout.** `git checkout base -- <file>` reverts the whole file and the verdict belongs to no particular change — the revert probe's limitation, one level down. Reverse-applying the hunk's own patch keeps the attribution, and `git` does the line-offset arithmetic so a later hunk lands in the right place without this code tracking offsets.
- **The third outcome is still asymmetric.** A patch that will not apply, or a tree that will not compile without the hunk, is `inconclusive` and **never** `killed`. A compile error says nothing about whether a test would have caught a behavioural regression, and scoring it as "a test caught it" is the precise false assurance this whole command exists to remove.
- **Restore by content, never by re-applying forward.** A forward re-apply can fail on its own and would leave the tree neutralised for every probe after it, turning one bad restore into a run of false survivors.
- **Hunks a mutant already covers are skipped**, and the probes run **last**, out of the mutants' leftover budget. The ordering is the priority statement: the safety-verb mutant is the higher-precision experiment, so it is bought first; a hunk probe is what the remainder buys. Both skip counts — cap and budget — are reported, because a hunk probe that never ran must never be readable as a hunk that came back clean.

The gating mistake worth recording, because it inverted the feature while every test stayed green: the hunk loop first lived **inside** the mutant branch, so it ran only when the diff already had a safety-verb candidate. The one class of diff per-hunk probing exists for — no mutants at all — got nothing. Selection now happens beside the mutants' and the phase runs whenever **either** kind has candidates.

## Why "fixed by this diff" is the verdict that needed a bar

The re-check has three verdicts, and until PR #6486 only two of them cost anything:

| verdict              | consequence                                           |
| -------------------- | ----------------------------------------------------- |
| `still stands`       | `REQUEST_CHANGES` — blocks the merge                  |
| `cannot tell`        | serialized into the body, caps the event at `COMMENT` |
| `fixed by this diff` | **nothing. Silent, free, unrecorded.**                |

An agent under context pressure, choosing among three answers where one is free and two are not, drifts toward the free one — and the free one is the only one that can ship a bug.

Worse, the bar for it read "you read the lines and the fix is there", which invites reading **the diff's lines**. That is precisely the reading that fails. A fix's new lines are always in the diff; whether they _work_ routinely depends on code outside it.

PR #6486 is the case. A `Ctrl+F` dual-fire blocker was filed — the hotkey toggled the model _and_ moved the input cursor. The author added a guard to the toggle handler: visible in the diff, and it reads like a fix. It changed nothing. The second handler is `text-buffer.ts:2663`, in a file the PR never touches, subscribed independently to a `KeypressContext.broadcast()` that has no stop-propagation — `return`ing from one subscriber does not stop the other. Read the diff and you see a guard and rule "fixed". Read `text-buffer.ts:2663` and you cannot.

Two changes, split the way this document keeps arriving at — **determinism owns the evidence, judgment owns the ruling**:

- **`pr-context` extracts the evidence** (`extractCodeRefs`). A blocker's body names the code it is about — #6486's named `text-buffer.ts:2663` outright — so a promoted blocker that names a file now renders a **Referenced code** list (a blocker citing no path gets none — the reader traces the mechanism themselves). "Go read the untouched code" stops being a hope the agent might have and becomes a list it is handed.
- **SKILL.md raises the bar** on the ruling: name the mechanism, name what now stops it, and when the stopping condition lives outside the diff, read it there — or the verdict is `cannot tell`.

No new `compose-review` input was needed: `cannot tell` already caps the event. The change is to make wrong "fixed" rulings land there instead of passing silently.

## What the first dogfood batch changed

Six concurrent real-PR runs (batch 3) produced three targeted changes, each fixing something the batch measured rather than predicted:

- **Overlap disposal is deterministic.** presubmit's overlap report used to end in "ask the user whether to proceed" — 2 of 6 runs stalled on an improvised interactive question (fatal for a headless run) while the other 4 proceeded, the signature of an under-specified decision point. An overlap is a duplicate by the Exclusion Criteria; the rule is now drop, note in the terminal, continue — and the comments file `compose-review` counts from shrinks accordingly, so a dropped finding can never flip the verdict.
- **Host routing is a flag, not prose.** The GH_HOST-by-prefix instruction survived exactly one review round before a reviewer noted the model must remember it per call. `--host` on `fetch-pr` / `pr-context` / `presubmit` routes every wrapped `gh` call in code (`lib/gh.ts` `setGhHost`/`ghEnv`), leaving the prose rule only for the handful of `gh` commands the orchestrating model runs directly.
- **A fixed completion line.** Three different completion phrasings across one batch each needed their own detection regex in the batch driver. Step 9 now ends every run with `Review complete: <target> — <disposition>`, greppable by `^Review complete: `.

## Why Step 7 opens with a hard posting gate

Posting is the only irreversible, public, outward-facing action the skill takes, and it must never happen as a side effect of a confident verdict. The skip condition existed from the start, but it was phrased as one clause among several ("skip if … or if BOTH `--comment` absent AND no post request"), which a model evaluates as a judgment call at the end of a long run — exactly when it is reasoning about what it wants to say rather than about what it was authorized to do.

Dogfooding proved the phrasing insufficient: across four concurrent no-`--comment` reviews, three correctly withheld (offering the follow-up tip) and one self-submitted a `COMMENT` review with an inline suggestion to a real PR. One violation in four is a model-adherence failure, not a logic error — the rule was right, its force was not.

The fix promotes the gate to the first thing in Step 7 and reframes it as arithmetic, not judgment: post **only if** `--comment` was parsed in Step 1 **or** the user explicitly asked to post this session; otherwise no `reviews`-API write happens at all, regardless of verdict or the "Tip: post comments" text being printed. This mirrors the `event`/`body` invariant elsewhere in Step 7 ("stop reasoning and count") — the same failure mode (a model rationalizing past a stated rule at submit time) gets the same countermeasure (convert the rule to a check with no discretion).

## Why verification checks the diff's own documented intent

Verification traces a finding's failure scenario through the code, but "the code does what the finding says" is not sufficient for a finding framed as a **regression** — the code doing X is exactly what a deliberate, documented change to do X looks like. The missing question is whether X is a defect or a design decision, and the diff itself usually answers it: a rationale comment, a JSDoc note, or a test that asserts the new behavior on purpose.

Dogfooding auto-posted the failure. A review of a secret-sanitization PR filed a Critical — "third-party credentials (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `NPM_TOKEN`) now pass through to subprocesses = security regression." The factual claim was true; the framing was wrong. The same file carried a rationale comment three lines from the change — user-managed credentials `must remain available` for shell/MCP/tool subprocesses, and the old broad denylist that scrubbed them was the bug this PR fixed — plus tests that assert the pass-through on purpose. The verifier traced the behavior and confirmed it without reading the rationale, and the Critical published to a real PR.

So verification now has an explicit step: for any finding that reads as "regression / removed protection / now allows X", read the diff-local comments and tests for the changed lines, and engage the documented intent. A documented-and-deliberate change is a design decision — reject the finding if it merely re-describes that change without naming any harm the rationale fails to answer. Documentation changes what the verifier must do, not what confidence it may reach: a traced, concrete harm that survives the rationale keeps high confidence (documenting a hole does not make it safe); low confidence is for cases where the rationale makes the harm genuinely uncertain, e.g. it names a compensating control the verifier cannot rule out. It is the diff-local analogue of Agent 0's root-cause-ownership gate (which checks intent against the linked _issue_); this checks intent against the _diff's own text_, which every review path has even when there is no issue. The counterpart finding in that same review — two new `scrubChildEnv(process.env, …)` call sites missing the `normalizePathEnvForWindows` wrapper that every sibling call site uses — had no such rationale and was a real oversight bug; the gate is about documented intent, not about suppressing findings on sanitization PRs.

## Why whole-diff agents get a substantive-return check

Step 3B's coverage receipts guarantee every chunk was read, but they cover only chunk agents — the whole-diff agents (Issue Fidelity, removed-behavior, cross-file tracer, invariant agents, test-coverage matrix, diff-specialized finders) have no receipt, because they own a concern, not a territory. That left a blind spot symmetric to the one receipts close: an agent that whiffs — returns almost instantly with near-empty output — is indistinguishable from one that examined its concern and found nothing.

Dogfooding surfaced it concretely. On a heavy-file review, one of the three invariant agents returned in 11 seconds having emitted ~370 tokens while its siblings ran for minutes and thousands; the fast one owned the checklist half (counters / return-values / error-taxonomy) that, in a parallel exhaustive pass, produced the run's most serious finding. Nothing flagged the whiff, and the orchestrator folded its silence into "no issues in that dimension".

The countermeasure is cheap and needs no new machinery: before Step 4, sanity-check that each receipt-less agent's return actually describes its walk (the fields/callers/lines it enumerated) rather than a bare "No issues found." The primary test is evidential, not statistical — a return that names nothing it examined is a non-return regardless of length, and a legitimately empty scope passes as long as it says what it checked. The comparative signal ("far shorter and faster than its peers") is only a prompt to look at that agent's output, never a threshold to relaunch on: no fixed cutoff would survive a review where every agent is legitimately terse. Deliberately no number, because a false relaunch costs one agent call and a missed whiff costs a shipped bug — when in doubt, relaunch. It is the receipt-less analogue of "a chunk with no receipt was never reviewed," and it applies to 3A's dimension agents just as it does to 3B's whole-diff agents, since neither emits a receipt.

## Why effort levels (low / medium / high)

**Considered:**

- **Always-full (original):** every `/review` runs the full pipeline. Right for a PR verdict; wrong for a 5-line pre-commit sanity check — 14 agents, sharded verification, and ≥2 reverse-audit rounds to re-derive what one reader could see in a single pass.
- **A `--quick` boolean:** two modes, but "quick" hides what is and isn't checked (rules? cross-file? build?).
- **Three levels (chosen):** **low** = 3-6 directed angles (per `plan.budget.inlineAngles`) plus a gap sweep, all in the orchestrator's own context over the chunk plan — hunk-visible bugs only, ≤10 unverified findings. **medium** = the high pipeline minus its most expensive passes: the parallel finder fan-out over a reduced dimension set (no adversarial personas, no Agent 8), build & test, and a single verification pass — verified findings, Approve capped at Comment, no reverse audit. **high** = the full pipeline, unchanged.

**Guardrails, because an unverified pass is recall-limited by construction.** These guardrails defend against findings that no verifier ever checked, which since medium became a verified fan-out means **low alone**; medium shares only the cache and posting rules (its Approve cap is Step 6's own rule, not one of these).

- Labeled **unverified**; no Approve/Request-changes verdict is emitted. A verdict is a claim the pipeline earns in Steps 4–5; a quick pass claims findings, not absence of findings.
- Never posts to the PR: `--comment` forces high, and a "post comments" follow-up after a quick pass is declined.
- Never consults or writes the incremental cache — otherwise a medium run's SHA would make a later high run report "No new changes since last review", silently converting a quick pass into a full-review verdict.
- Scope handling (worktree, diff capture, chunk plan) is identical at all levels. The levels change who reads the diff and what runs afterwards, never how the diff is obtained — the base-resolution and truncation traps do not care how fast the user wants the answer.

**Defaults:** PR targets → high (the product is a public verdict); local-diff / file-path targets → medium (the product is fast feedback; the closing tip advertises `--effort high`). Findings caps exist only at the unverified levels — at high effort, verification is the noise filter, so no cap is needed.

## LLM call budget

**Small diffs (≤ 500 source lines AND ≤ 3200 total diff lines, Step 3A, high effort) — 17-23 calls (typically 17-19):**

| Stage                   | Calls               | Why                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review agents           | 14 (+0-2)           | issue fidelity + 3 procedural correctness walks (1a/1b/1c) + security + 3 quality slices (3a/3b/3c) + perf/tests + 3 undirected personas + build&test, plus 0-2 diff-specialized finders; cross-repo skips Agents 7 and 1c (12), non-PR skips Agent 0 (13)                |
| Sharded verification    | `ceil(F/8)`         | F = findings; typically 1-2; keeps each verifier's job small on high-finding reviews                                                                                                                                                                                      |
| Iterative reverse audit | 2-5                 | loop ends after two consecutive dry rounds; 5-round hard cap                                                                                                                                                                                                              |
| **Total**               | **~17-23 (~15-22)** | Row maxima do not co-occur on typical runs (~17-19 is common), but the honest sum of ranges is 17-23 same-repo, 15-22 cross-repo/local. **Low effort: 0 subagent calls** — the angle rotation runs in the orchestrator's own context; medium launches its reduced fan-out |

**Large diffs (> 500 source lines OR > 3200 total diff lines, Step 3B, high effort) — `ceil(diffLines / 400)` chunk agents + `5..7` whole-diff agents + `3H` invariant agents (H = heavy files) + `ceil(F/8)` verify (F = findings) + `rounds × chunks` reverse audit.** The reverse audit dominates: it fans out one auditor per chunk per round, and the stop rule needs two consecutive dry rounds (hard cap 5). PR #6457 (5801 diff lines, 19 chunks, 1 heavy file) costs ~27-29 first-wave calls, then `19 × (2..5) = 38-95` reverse auditors — ~66-126 calls total depending on how long the audit keeps finding; ~70 is the clean-run floor, and the count scales with chunks and findings, not a fixed ceiling.

That is roughly 4x the small-diff budget, and it buys the thing the small-diff topology cannot deliver at that size: coverage. Ten dimension agents (the roster of the day; fourteen now) on a 5801-line diff each read the same truncated 14% window (see "Why the diff is a file, not a command"), so nine of the ten calls were redundant reads of the same hunks. Nineteen chunk agents each read a distinct ~390-line territory, and every line of the diff has exactly one accountable owner. The comparison to make is not ~70 calls vs ~17: PR #6457 took **eight** review rounds at 12-14 calls each — over 100 calls — and was still surfacing Criticals in code that had been in the diff since the first commit.

Competitors: Copilot uses 1 call, Gemini uses 2, Claude /ultrareview uses 5-20 (cloud). Ours biases toward higher recall — the assumption is that "find more issues per round" is more valuable than minimizing per-run cost, because every missed issue forces the user into another `/review` iteration.

## Why the diff is a file, not a command

Agents used to be handed `git diff main...HEAD` and told to run it. At the time of the measurements below, Shell tool output passed through `truncateToolOutput` with `ShellTool.maxOutputChars = 30_000` and `keep: 'both'`, and the 30K trigger was also the preview budget: `threshold / 5` characters went to the head and the remainder to the tail. Shell now keeps the 30K persistence trigger but uses an approximately 4K head-and-tail model preview. That makes direct `git diff` output even less suitable for complete review coverage; the file-and-chunk design below remains authoritative.

On PR #6457's 211 000-character diff that yields a 6 000-char head (`QQChannel.ts` lines 41-250) and a 24 000-char tail (`stream.test.ts` and `types.ts`, which sort last by path and together changed 9 lines). 85.8% of the diff — including 19 of the 20 Criticals eventually reported on that PR — was replaced by a `[CONTENT TRUNCATED]` marker. Every agent saw the same window, so the ten-way dimension fan-out multiplied redundancy rather than coverage, and each round of `/review` sampled a different subset of the bugs depending on which files an agent happened to `read_file` on its own initiative.

`fetch-pr` now writes the diff to `.qwen/tmp/qwen-review-pr-<n>-diff.txt` and emits a chunk plan. `read_file` overrides `maxOutputChars` to `Infinity`, so it escapes the scheduler's head/tail mangling — but `processSingleFileContent` still caps one read at `truncateToolOutputThreshold` (25 000 chars), sets `isTruncated`, and expects the caller to page. Writing the diff to a file is therefore necessary but **not sufficient**: a single `read_file` over PR #6457's diff returns lines 1-611 and stops.

The chunk plan is what closes the gap. Chunks are bounded by **both** a line budget (attention) and a character budget (`MAX_CHUNK_CHARS`, 20 000 — under the 25 000 read cap, so a chunk never comes back short), and they tile the diff exactly (`chunksCoverDiff` asserts no gap, no overlap). Exact tiling is what makes the Step 3B coverage receipts checkable: a chunk with no receipt is a territory nobody reviewed.

Measured on PR #6457's real 211 000-char diff, driving the production `truncateAndSaveToFile` and `processSingleFileContent`:

| What the agent is given                    | Chars delivered | Diff covered | Of the 20 Criticals eventually found, in view |
| ------------------------------------------ | --------------- | ------------ | --------------------------------------------- |
| `git diff` via shell (the old way)         | 30 468          | 14.4%        | 1                                             |
| Diff in a file, read whole (no chunk plan) | 25 015          | 10.5%        | —                                             |
| Diff in a file + 19-chunk plan             | 210 900         | **100%**     | **20**                                        |

Chunk boundaries fall on hunk boundaries wherever they can, because a boundary inside a hunk risks cutting a function in half. A hunk larger than the target is the exception: it is split, but only at a column-0 source line preceded by a blank line — a top-level declaration. A brand-new file arrives as one enormous hunk (`events.test.ts` was a single 1535-line hunk), so treating hunks as strictly atomic would hand one agent a 50 000-char territory and defeat the whole point. When no such boundary exists the hunk stays whole and the chunk is flagged `oversized`.

## Why cross-repo uses lightweight mode

CLI tools are inherently repo-local. Worktree, build/test, cross-file analysis all require the codebase on disk. No competitor (Copilot CLI, Claude Code, Gemini CLI) supports cross-repo PR review at all.

Our lightweight mode is the best a CLI can do: GitHub API calls work cross-repo (`gh pr diff <url>`, `gh pr view <url>`, `gh api .../comments`), so LLM review and PR comment posting work. Everything that needs local files is skipped. This is strictly better than "not supported."

Key implementation detail: Step 7 must use the owner/repo extracted from the URL, not `gh repo view` (which returns the current repo).

## Why auto-discover build/test commands from CI config instead of user configuration

**Considered:**

- **`.qwen/review-tools.md`**: Let projects define custom build/test commands. Precise, but requires users to learn a new config format and maintain it.
- **Auto-discovery from CI config (chosen)**: Read `.github/workflows/*.yml`, `Makefile`, etc. to find what commands the project already runs in CI. Zero user effort.

**Decision:** Auto-discovery. Every project already defines its tool chain in CI config. Reading those files leverages existing knowledge without asking users to duplicate it. The LLM is capable of parsing YAML workflow files and extracting the relevant commands. Falls back gracefully: if no CI config exists, the build/test discovery is simply skipped and LLM agents still review the diff.

## Why Suggestion-level findings are posted as inline comments, like Critical

**Considered:**

- **Critical inline, Suggestion in the review `body`:** splits by severity, but the review body is a frozen artifact of one review submission — every new /review run appends a new review with its own body, so Suggestion lists accumulate across runs and never converge.
- **Critical inline, Suggestion in one updatable issue comment:** Suggestion findings go to a single PR issue comment located by author + embedded marker and PATCHed in place on every run, so the list refreshes rather than grows. Shipped for a while; reverted for the reasons below.
- **Both severities inline, distinguished by a `**[Critical]**`/`**[Suggestion]**` body prefix (chosen):** every high-confidence finding is pinned to its code line and carries a one-click ` ```suggestion ` block. Severity is communicated in the comment text, not by the channel it arrives on.

**Decision:** Both inline. The updatable-summary design optimized for a convergence problem, but it paid for that with two costs that turned out to dominate:

1. **A summary comment can never collapse.** GitHub marks an inline review thread **Outdated** and folds it away as soon as the author edits the line it is anchored to. So an addressed inline finding removes itself from the page. An issue comment has no such lifecycle — it sits in the PR conversation permanently, one extra comment whether or not its rows still apply. PATCHing it to "all suggestions addressed" replaces the content but not the comment. The very mechanism intended to prevent clutter _was_ the clutter.
2. **A Markdown table cannot carry a one-click fix.** GitHub renders a ` ```suggestion ` fence as an applicable change only inside a review comment on a diff line; in an issue comment it degrades to a plain code block. Suggestion-level findings — mechanical, localized cleanups — are precisely the class that benefits most from one-click apply, so the split withheld the feature from the findings that most needed it. The table's cramped "Suggested fix" column also degraded badly as the suggestion count grew.

The convergence concern that motivated the summary is real but narrower than it looked: GitHub's Outdated-collapse handles every suggestion the author actually acts on, which is the common case. What remains is a suggestion the author declines and leaves untouched — its line does not change, so the thread stays open and a later run can post a near-duplicate. That residue is bounded by the presubmit Overlap check (`blockOnExistingComments`), which blocks submission when a new finding lands on the same `(path, line)` as a live Qwen comment on the same commit.

**Trade-off:**

- ✅ Suggestion findings regain one-click ` ```suggestion ` apply and sit next to the code in "Files changed."
- ✅ Addressed findings self-collapse via GitHub's Outdated mechanism; no permanent extra comment on the PR page.
- ✅ One posting path for both severities — the `comments` array — instead of a review submission plus a second issue-comment API call.
- ❌ Suggestions now share the atomic `POST /pulls/{n}/reviews` call with Criticals. That call is all-or-nothing: one entry anchored to a line outside the diff 422s the whole review, so a mis-anchored Suggestion can suppress a Critical blocker. Previously Suggestions travelled on a separate, line-agnostic issue-comment call where a bad anchor was impossible. Step 7 mitigates with a 422 fallback rather than pre-validating every anchor up front: GitHub's 422 does not identify the offending entry, so the fallback has the model recheck each anchor against the diff, relocate failing Criticals into `body` (failing Suggestions are discarded — Suggestion text must stay off the `body` channel, which `qwen-autofix.yml` does not filter), and resubmit — degrading to an all-prose review of the blockers rather than posting nothing.
- ❌ A declined suggestion on an unchanged line can be re-posted by a later run on a new commit: the presubmit Overlap check only compares against comments whose `commit_id` matches the commit under review, so prior comments are bucketed `stale` after any push. Closing this fully needs a resolve/minimize step (GraphQL `resolveReviewThread` / `minimizeComment`) that folds our own superseded threads before submitting a new review.
- ❌ Pattern-aggregated Suggestion findings (the multi-occurrence `Pattern:` form) must pick a representative line to anchor to; the full structured aggregation remains visible in the terminal output.

## Rejected alternatives

| Idea                                                         | Why rejected                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `.qwen/review-tools.md` for custom tool config               | Requires users to learn a new format. Auto-discovery from CI config achieves the same result with zero user effort.  |
| Use fast model for verification/reverse audit                | User requirement: quality first. Fast models may miss subtle issues.                                                 |
| Reduce to 2 agents (like Gemini)                             | Loses dimensional focus. We retain build/test (Agent 7) and want higher LLM coverage.                                |
| `mktemp` for temp files                                      | Over-engineering for a prompt. `{target}` suffix is sufficient for CLI concurrent sessions.                          |
| Mermaid diagrams in docs                                     | Only renders on GitHub. ASCII diagrams are universally compatible.                                                   |
| `gh pr checkout --detach` for worktree                       | It modifies the current working tree, defeating the purpose of worktree isolation.                                   |
| Shell-like tokenizer for argument parsing                    | LLM handles quoted arguments naturally from conversation context.                                                    |
| Model attribution via LLM self-identification                | Unreliable (hallucination risk). `{{model}}` template variable from `config.getModel()` is accurate.                 |
| Verbose agent prompts (no length limit)                      | 9 long prompts exceed output token budget → model falls back to serial. Each prompt must be ≤200 words for parallel. |
| Relaxed parallel instruction ("if you can't fit 5, try 3+2") | Model always takes the fallback. Strict "MUST include all in one response" is required.                              |

## Token cost analysis

For a PR with 15 findings:

| Approach                                            | LLM calls          | Notes                                                                                                                   |
| --------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Copilot (1 agent)                                   | 1                  | Lowest cost, lowest coverage                                                                                            |
| Gemini (2 LLM tasks)                                | 2                  | Good cost, medium coverage                                                                                              |
| Our design (5 agents, N verify)                     | 21                 | 5+15+1 — too expensive                                                                                                  |
| Our design (5 agents, batch verify, single reverse) | 7                  | 5+1+1 — original design                                                                                                 |
| Our design (9 agents, iterative reverse)            | 11-13              | 9+1+(1-3) — +50% cost for meaningfully higher recall                                                                    |
| Our design (10 agents)                              | 12-14              | 10+1+(1-3) — adds issue-fidelity/root-cause gate                                                                        |
| Our design (14 agents + effort levels, current)     | 17-23 high / 0 low | 14(+0-2)+ceil(F/8)+(2-5) under 3A; low runs inline with no subagents, 3-6 angles by diff size — cost scales with intent |
| Claude /ultrareview                                 | 5-20               | Cloud-hosted, cost on Anthropic                                                                                         |

## Future optimization: Fork Subagent

> Dependency: [Fork Subagent proposal](https://github.com/wenshao/codeagents/blob/main/docs/comparison/qwen-code-improvement-report-p0-p1-core.md#2-fork-subagentp0)

**Current problem:** Each of the ~17-23 LLM calls (14-16 review + sharded verify + 2-5 reverse audit rounds) creates a new subagent from scratch. At ~52K per agent (50K system + 2K task), that is ~880K-1.2M input tokens with massive redundancy. The cost grew along with the agent count — Fork Subagent matters even more under the current 14-agent design than under the original 5-agent design. (Effort levels bound the cost from the other side: low runs spawn no subagents at all, and medium spawns the reduced fan-out.)

**Fork Subagent solution:** Instead of creating independent subagents, fork the current conversation. All forks inherit the parent's full context (system prompt, conversation history, Step 1/1.1/1.5 results) and share a prompt cache prefix. The API caches the common prefix once; each fork only pays for its unique delta (~2K per agent).

```
Current (independent subagents):
  Agent 1: [50K system] + [2K task]  = 52K
  Agent 2: [50K system] + [2K task]  = 52K
  ...× 17-23 agents                 = ~880K-1.2M total input tokens

With Fork + prompt cache sharing:
  Cached prefix: [50K system + conversation history]  (cached once)
  Fork 1: [cache hit] + [2K delta]   = ~2K effective
  Fork 2: [cache hit] + [2K delta]   = ~2K effective
  ...× 17-23 forks                  = ~50K cached + ~34-46K delta = ~84-96K total
```

**Additional benefits for /review:**

- Forked agents inherit PR context and review rules — no need to repeat in each agent prompt
- SKILL.md workaround "Do NOT paste the full diff into each agent's prompt" becomes unnecessary — fork already has the context
- Verification and reverse audit agents inherit all prior findings naturally
- Agent 6 personas can fork from a shared diff-loaded base, paying only the persona-framing delta

**Estimated savings:** ~88-92% token reduction (~780K-1.1M → ~80-92K) with zero quality impact. The savings ratio is now even more compelling than under the 5-agent design.

**Why not implemented now:** Fork Subagent requires changes to the Qwen Code core (`AgentTool`, `forkSubagent.ts`, `CacheSafeParams`). This is a platform-level feature (~400 lines, ~5 days), not a /review-specific change. When available, /review should be updated to use fork instead of independent subagents.

## Measured incidents behind the SKILL.md rules

The blocks below are incident narratives moved out of SKILL.md (which is loaded into the orchestrator's context on every run). Each one is the story behind a rule that still lives there; the rule references it as `(measured; DESIGN.md — <title>)`.

### The todo-call latency

Measured on real small-PR runs from the harness's own records, the todo calls in one review cost **377 seconds**, in another **179** — minutes spent restating steps that were already written down.

### The transcribed argument file

Dogfooding `/review 6771`, a run wrote `--effort high` into the argument file — not the user's argument, but an **example** lifted out of the SKILL.md paragraph that introduces the argument file. The parser then did its job perfectly on the wrong input: it resolved a _local_ review, found the working tree clean, and reported "no changes to review". A request to review a pull request became a no-op, and nothing raised an error.

### The stale PATH qwen

Measured: a `npm run dev:daemon` session issued `qwen review agent-prompt --role 0`, `PATH` found a v0.19.10 whose `agent-prompt` predates `--role` entirely, and the review died on `Missing required argument: chunk` — the skill and the CLI it was talking to were different versions.

### The unseen untracked file

The reviews that skipped a brand-new file did not decide it was low-risk; they never saw it. When the new file was the _only_ change, `/review` reported "no changes to review" and stopped.

### The guessed fork repo

Dogfooding this skill against its own PR, the model inferred the fork from the branch's push target, `fetch-pr` answered "Could not resolve to a PullRequest", and the review stopped before reading a line of code.

### The endorsement-shaped blocker (PR #6486)

On PR #6486 a maintainer built the PR, drove the real CLI, and filed `🔴 Finding 1 — Ctrl+F dual-fires … (blocker)` as an **issue comment**. Every issue comment used to settle into "Already discussed" as a 240-character snippet, and the first 240 characters of that one were its preamble — _"I built this PR from source and drove the real CLI … to validate the model-toggle hotkey before merge"_ — which reads as an **endorsement**, filed under a heading that says not to re-report it. The blocker began 1 143 characters past the cut. `/review` reviewed that same commit three hours later and submitted "no blockers"; the defect was real and was fixed that evening.

### The 71-thread comment-status report

On a 71-thread PR the comment-status report measured over twice the 25 000-character threshold, and because `threads` is path-sorted a truncated read drops the alphabetically-later files wholesale (24 blocker-flagged threads, in that measurement) while the cut JSON does not even parse.

### The 20-turn status re-derivation

Measured on a real 72-comment PR, a run burned 20+ model turns re-deriving exactly those per-comment status fields (`line`/`outdated`/`commit_id`) one id at a time.

### The two-dot phantom regressions (PR #6626)

On PR #6626 a review approved four files and then warned the author, publicly, that their branch carried "typo regressions in `ide-client.ts`" and should be rebased. The branch had done nothing: main had corrected `compatability` → `compatibility` after the fork point, and a two-dot diff showed the branch putting the typo back. The PR's real change set, `merge-base..head`, is four files and does not touch that file at all.

### The paraphrased roster prompt

Asked to paste a 4 652-character prompt to each of twelve agents, a real run delivered **2 893** characters of one: it kept the head, added a preamble of its own, and cut nineteen hundred characters out of the middle. Then it read the coverage check's refusal, concluded that "the agents clearly did their job", never called `compose-review` at all, and printed **`Review complete — Approve`** — a verdict it had composed itself, from prose, on a review whose gate had just refused.

### The roles nobody launched

Measured against the harness's own record of real runs — the launch prompt of every agent, written at launch and not retconnable — `1c` and the test-coverage matrix were handed prompts that named **no diff file at all** and went off to read the post-change source instead (which, on a deletion, shows them nothing); and **Agent 0 was never launched**, on a PR review, and no check in the run could see it, because every other check inspects an agent that ran.

Dogfooded, a real PR review **never launched Agent 0** — the agent whose whole job is asking whether the PR fixes the thing it claims to — and every other check passed.

### The eighty-seven kilobyte roster

A chunk agent's brief runs to about five kilobytes with the project rules in it, and a Step 3B review of a real pull request has **seventeen** of them: eighty-seven kilobytes, in one response, pasted without an edit. That is not a thing that happens; at a twelfth of that load, it already measurably did not — see The paraphrased roster prompt.

### The 23 blind chunk agents

Measured against the harness's own record of what the agents were actually started with — the first record of each subagent transcript, written at launch — **23 of 23 chunk agents got a prompt that named no diff file at all**: no path, no `read_file`, no offset. All 23 made **zero tool calls**, and all 23 said the sentence their prompt handed them. The receipts that looked like proof of work were in the prompt that launched them. Downstream, the first coverage check asked the orchestrator to copy the agents' returns into a file and read the receipts back — and on the next run it **fabricated** them. The second checked the agents' prose for evidence of work; measured against 129 real transcripts it caught **none** of the 80 agents that made no tool call, because every one of them wrote more than forty characters of confident, specific text.

### The whole-diff agents launched without the diff

Measured against the harness's record of one real 3B run, all three whole-diff agents — cross-file tracer, test-coverage matrix, build & test — were launched with a prompt that named **no diff file at all**. The test-coverage matrix was told, in prose, to "Read the diff chunks and the test files", and given no path to read them from. It went and read the post-change source instead, and on a diff with deletions that shows an agent precisely nothing: the removed line is not in that file, and nothing marks where it was. These are the agents that own the classes a chunk agent is structurally blind to — the cross-file trace, the cross-chunk removed-behaviour pairing, the test matrix. The review's only coverage of all three was done by agents that never opened the diff, and the coverage check could not see it, because it only ever asked that question of agents whose prompt said `chunk N of M`.

### The 3A review told nobody read it

The coverage check used to live inside Step 3B and be reachable only from there, and it modelled coverage as "an agent whose prompt says `chunk N of M` made a tool call" — which no Step 3A agent's prompt ever says. Run against a real 3A review whose twelve agents each opened the diff, walked both chunks and filed findings, it reported `0/2 chunk(s) reviewed … Nobody read those lines` in the same breath as `16 agent(s) ran; 16 did work`. `compose-review` runs the same computation on the way to the verdict, so that review was capped away from Approve and the body it would have posted to the pull request said nobody had read it. Both sentences cannot be true.

### The paraphrased chunk prompts

Dogfooded, one run called the command for all five chunks and then delivered a paraphrase: it dropped the rule against reciting a stock sentence, dropped the half-read warning, and replaced the project's review rules with three sentences of its own.

### The one-word drift repair

Measured: a model asked to copy twelve blocks normalized one word in every block's tail, and the repair relaunched the entire fan-out to redeliver text the agents had already acted on.

### The Approve over an unread diff

Dogfooded against its own PR, the orchestrator launched 25 agents over an 18-chunk, 4 925-line diff. Twenty-two came back in under two seconds having made **zero tool calls**, returning about nineteen tokens each — the length of the words "No issues found." The three that worked were the three whose jobs do not require opening the diff. The prompt had three defences against this and every one of them was prose: the receipts every chunk agent "MUST" emit, the "exactly one receipt per chunk" verification, and the substantive-return check. The run performed none of them, reported zero findings, wrote "Not reviewed: none", and filed an **Approve**.

### The six-second Agent 0

Dogfooded against this skill's own PR, Agent 0 returned in **6 seconds** having made **one tool call**, and the review went on to print "All chunks were successfully reviewed and covered" and **Approve**.

### The eleven-second invariant agent

In dogfooding an invariant agent on a heavy file returned in 11 seconds having emitted a few hundred tokens, while its sibling agents ran for minutes; the whiffing agent happened to own the checklist half that held the run's most serious defect, and nothing flagged the miss.

### The hand-copied focus areas

The rule the `agent-prompt` flow replaced asked you to keep each prompt under 200 words and to copy the focus areas across by hand. Both were prose, and prose is what this skill keeps discovering it cannot rely on: the copy was made, and it dropped things.

### The unrelayed Exclusion Criteria

The Exclusion Criteria in particular had **never reached an agent**: the skill states them at the end of SKILL.md and told you to "apply" them, and the agents do not read that document. They read the prompt they are launched with.

### The severity-inflated coverage finding

Measured on one run: the same "zero test coverage" finding was filed as Critical four times and Suggestion twice, in the same review, and the PR was blocked partly on the strength of the four.

### The one-agent invariant checklist (PR #6457)

PR #6457's `QQChannel.ts`: one agent holding the whole eight-item checklist found **one** of that file's five invariant-class defects; the same model split three ways found **all five**.

### The hand-assembled verifier prompt

Dogfooded twice: the step that used to have you prepend the list by hand is where the prompt got paraphrased — a summary inserted, the "nothing replaces the brief" line truncated — and Step 6's check caught it and capped the verdict.

### The double-execute the probe caught

Measured on this repo, the strongest model traced a real double-execute (`!git push` firing twice) and called it correct; a probe that runs the path reports `sendShellCommand called twice` and the guessing stops.

### The head-sampled roster

A real run that sampled each build with `| head -5` never possessed the prompts, hand-reconstructed all ten launches, and had every one flagged rewritten — a full repair round spent recovering from a shortcut that saved nothing.

### The hand-written reverse-audit launches

Dogfooded, two same-findings rounds shared one record, the orchestrator appended `(round N)` to the identity line to tell its own launches apart, and both rounds were flagged rewritten — a repair round paid for a label the CLI now prints. A real run skipped `--findings`, hand-wrote the auditor's launch keeping only the brief pointer, and Step 6's check capped the verdict — the auditors had run and read their brief, but not one of them got the prompt the CLI built.

### The code-span door beside the fixed fence

A live six-round dogfood is the caution: the fix closed the fence-shaped door into a raw-HTML block, and the code-span door beside it — same divergence, adjacent syntax — stayed open; a re-check that tested only the reported input ruled `fixed` over a hole one backtick away.

### The guard that fixed nothing (PR #6486)

On PR #6486 the author responded to a `Ctrl+F` dual-fire blocker by adding a guard to the toggle handler. The guard is right there in the diff and reads like a fix. It changed nothing — `Ctrl+F` still toggled the model **and** moved the cursor, because the second handler is `text-buffer.ts:2663` in an untouched file, subscribed independently to a `KeypressContext.broadcast()` with no stop-propagation. The blocker's own body named that line. A re-check that read only the diff would rule "fixed" and be wrong; a re-check that read the named line could not.

### The scripts nobody ran

Measured, twice: a model told in prose to run the step scripts read them and did not run them (0/4), and even the strongest model's attacker persona walked into a double-execute bug and declared it correct.

### What transcription cost

A Critical that changed severity between two sections of one review; an aggregate that arrived at `resolve-anchors` with its per-location anchors dropped and took the whole batch down.

### The four-round misattributed Critical (#8368)

Measured on #8368, a Critical asserting the PR broke an already-red test was carried across four rounds and into the composed review while the run's own `test-delta` had classified that file `shared` twice.

Measured on #8368, that is the exact path the misattribution took into a composed review: the hold landed after `compose-review` had run, so it reached only the Step 8 report — the verdict line, the drafted marker and the payload Step 7 recounts were all fixed before the measurement was consulted.

### The Approve over a relocated Critical

Dogfooded, a report-only run — where no later step recounts — moved its one Critical from `bodyCriticals` to an inline comment, dropped the typed inline count on the way, and the verdict line read Approve over a blocker the same report listed. That is why `compose-review` counts the inline findings from the drafted comments, never from a typed number.

### The narrated-away cap

The failure came back in a subtler shape, on a later dogfood: the run _did_ call `compose-review`, _did_ read `Verdict: Comment — an Approve was NOT available: a dimension nobody reviewed`, and then wrote — in its next thought — _"the compose-review flagged reverse audit as unreviewed (transcript visibility issue — the reverse audit did run substantively)"_, and reported **Approve** to the user and into the saved report. It was wrong: the auditors had run, but the orchestrator had hand-written their launch prompts, so they never got the prompt the CLI built — which is precisely what the gap said, and precisely the run's own doing.

### The four assertions that survived their mutation

Measured on this pipeline's own PRs, four assertions written to pin a real defect all survived the mutation they were written for. `expect(body).toContain('"index":0')` passed with the tool-call index deleted, because `"index":0` also appears on every `choices` entry. `expect(body).toContain('input_json_delta')` passed with the arguments handed over as a finished object, because the mutation kept the type and changed the field. `expect(wrapScript(s)).toMatch(/set \+e/)` asserted the mechanism rather than the behaviour, and `set +e` has no bearing on the `exit` that broke it. A pure function tested alone passed while the request path called a different one entirely.

### The gh pr comment bypass

Dogfooded the hard way: a run that had lost these instructions to four context compressions decided its findings were "all duplicates", never called submit, and hand-posted a consolidated summary with `gh pr comment` — a write with no authorisation gate, no downgrade semantics, no `posted` fact, and no completion line; nothing downstream could tell it had happened.

### The self-filed COMMENT review (PR #6771)

The posting check failed twice under dogfooding. The second time was this skill reviewing _its own pull request_: `/review 6771`, no `--comment`, no publish request — and it filed a public COMMENT review anyway, whose body announced inline suggestions it had not posted. Neither run decided to defy the rule. Each reasoned its way to a verdict it wanted to file and never re-read the sentence forbidding the filing.

The gate itself has been violated the same way: a review self-submitted a COMMENT with no `--comment` flag set.

### The five test reviews

A run against a real PR left five reviews carrying the bodies `Test`, `Test`, `t`, `t`, `t` before submitting the real one.

### The interactive overlap question

Dogfooding measured the overlap-disposal decision point improvised as an interactive question in 2 of 6 runs — which stalls a headless run forever — while the other 4 runs proceeded.

### The 283-file drift cap

Measured on a real 283-file base-merge drift, the truncated `filesTouched` cap silently dropped every path the findings actually anchored to.

### The skipped integration job (PR #6486)

The one job that would have exercised the new hotkey, `Integration Tests (CLI, No Sandbox)`, was skipped; so were the macOS and Windows `Test` legs. The classifier called it `all_pass`, and the whole design leans on CI precisely because the LLM pipeline reads code statically (DESIGN.md, "Why downgrade APPROVE when CI is non-green"). The delegation returned nothing, and returned it looking like a pass.

### Two live verdict failures (#6584, #6631)

A review that filed three Suggestions and then publicly `APPROVE`d the PR (#6584), and a Suggestion that would not anchor becoming a second paragraph of the public body (#6631).

### The phantom APPROVE posted line

Dogfooding this skill against its own PR emitted `Review complete: pr-6771 — APPROVE posted` on a run with no `--comment` and no publish request, where the gate had correctly blocked every write and nothing whatsoever was sent to GitHub.

### The five already-implemented Suggestions

Dogfooded against this skill's own PR, a run reported five "Suggestions" — "Enhanced Binary File Handling", "Security Improvement for Terminal Output" — each summarising a thing the PR already did, each with `Suggested fix: N/A (already implemented)`. That is not silence being better than noise; it is noise wearing silence's clothes, and the reader has to read all five to discover there was nothing to do.

### The 22-minute serial first verification

Two CI reviews of similar-size PRs ran the same skill on the same day (2026-08-06). The #8619 run launched its Step 4 verifier and its round-1 reverse auditor together in one response. The #8628 run launched the verifier alone at 08:12, read its verdicts at 08:34, and only then launched round 1 at 08:37 — 22 minutes of wall clock spent waiting for verdicts the auditor's launch never consumed (the findings file carries `— [unverified]` tags for exactly this state). The pipelining rule said "round _k_'s verifiers ride with round _k+1_'s auditors" and started counting at k=1, so the initial verification's coupling was orchestrator discretion, and discretion split 50/50 across the measured runs.

### The serial convergence pair

Measured on the CI reviews of #8619 and #8607: both audits converged at the minimum — round 1 dry, round 2 dry — and the rounds ran serially at 13–25 minutes each, although a dry round leaves the cumulative findings list unchanged, so round 2's launch input was substantively identical to round 1's — the same entries, at most with verification tags the unconditional merge had cleared in between: an independent rerun, paid for at the price of a dependent one. The #8501 round-5 review made the cost concrete: round 1 came back dry, the deadline gate then refused round 2 (`BUDGET:`, exit 4), and the verdict shipped capped by a budget stop — for want of a second dry audit the run had time to launch in parallel but not in series.

### The rounds a rejected finding bought (PR #8353)

The 15th review round of #8353 (its audit rounds numbered 1–5 within that run; `R15-1` is the incremental-review ledger's naming, not an audit round): audit round 2 dry; round 3's sole finding rejected by its verifier with direct counter-evidence — the claimed compound behavior lived entirely in unchanged code. The rejection removed the entry from the cumulative list, but not the reset it had already applied to the dry counter. Under the forward pairing the rule licenses, round 4's dry return completed the two-dry evidence the moment it landed — the retired round 3 plus dry round 4 — and round 5 (~15–20 minutes) was the waste: it audited nothing the loop had not already answered.

### The artifact root that pointed at qwen-home

Every one of six measured CI reviews (2026-08-05/06) spent 1.5–3 minutes at Step 8 rediscovering the same fact: `save-artifact` resolved its containment root from `QWEN_CODE_PROJECT_DIR`, and that variable does not name the main checkout in any environment — the harness exports it as `Storage.getProjectDir()`, the session-storage directory under the runtime base where the harness's own transcripts live. The helper refused its own inputs ("must be inside the workspace"), and each orchestrator improvised a different workaround: one overrode the env var to the repo, one copied the inputs into the qwen-home mirror and copied the artifact back, others retried path shapes until one landed. The env preference was wrong 100% of the time it was consulted; the command's cwd — the main checkout, where the skill runs every subcommand — was right in every measured run.

### The one-command-per-turn tail

Measured across the same six CI reviews: the post-verdict bookkeeping — Markdown report, cost-ledger, save-artifact, `record_artifact`, the incremental-cache write, cleanup — ran one command per model turn, 4–6 minutes of wall clock after the review's outcome was already decided (and, on posting runs, already on the PR), stretching past 7 minutes when the qwen-home fumbling above joined it. Every command in the tail is cheap; the turns are not — the same arithmetic that batches the Step 1 setup calls, unapplied to the other end of the run.
