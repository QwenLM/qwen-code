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

Bugfix PRs often carry their own diagnosis in the PR body, but that diagnosis can be wrong. The linked issue's original reproduction, observed payload, expected behavior, and maintainer comments must be checked before judging whether the implementation is a real fix. The implementation deliberately keeps issue discovery out of `pr-context`: the Issue Fidelity agent fetches the evidence with the `qwen review issue-context` subcommand (welded into its generated prompt), which resolves GitHub's closing-issue metadata and fetches each issue's title, **body**, and full comment thread from the issue's own repository. The division of labor: discovery, fetch, and rendering live in the tested subcommand (this used to be prose `gh` commands in the brief — the prose-carried bug class); relevance judgment — which references are targets versus motivating incidents — stays in the agent, never in TypeScript. The agent runs only for PR targets — a local-diff or file-path review has no PR or linked issue, so it is skipped there (13 agents instead of 14).

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

Requiring two consecutive dry rounds makes a single lazy or context-starved agent unable to end the loop. The hard cap moves from 3 rounds to 5, and when the cap is what stopped the loop the output must say so rather than implying convergence. (The cap has since become one value per topology — see "Why the round cap is per topology" below.)

### Why the round cap is per topology

Five was one number standing in for three prices. What the cap bounds is a **round**, and a round costs one auditor on 3A, one auditor per non-retired chunk on 3B, and ~90 minutes on a huge diff. That is two orders of magnitude across the topologies a single cap had to serve, so it was necessarily wrong at one end: too loose to bound the huge case — which is why `HUGE_REVERSE_AUDIT_ROUNDS` had to be carved out of it — and, at the other end, tight enough on 3A to stop loops that were still confirming Criticals, for a saving of about five calls out of a review that cost 17-23 of them before this change.

The asymmetry that decides it is the one this whole design is built on: a missed issue costs another `/review` iteration, and per-run cost is the cheaper side of that trade (see the competitor comparison under "Token cost analysis" below). On 3A the marginal round is a single agent; on huge it is an hour and a half of a six-hour ceiling. The cap should say so.

So the cap is read from the plan's topology tier (`reverseAuditRoundTier`): **10** on 3A, **5** on 3B, **3** when huge. Three consequences worth naming:

- **The huge tier is checked first and wins, and it applies only where there is a wall.** It is a finishability ruling, and a huge diff is territory-fanned-out by construction anyway. A 3A diff can never be huge — `effective = max(src, floor(total/8))` is at most `max(500, 400)` under the 3A gate — so the two tiers cannot contend. See "Why the huge reduction needs a clock" below for why it is conditional.
- **One predicate, not two sets of numbers.** The tier reads `isTerritoryFanOut`, the same gate the roster turns on, which is why that function moved into `budget.ts`: a second copy of `500`/`3200` would eventually disagree with the roster about which fan-out a review owed.
- **The cap is a belt, not the terminator.** The loop still ends on two consecutive dry rounds, and in a time-budgeted run the deadline gate — which prices the round it is admitting plus the reserve — is the operative bound. The static cap is what a local run (no deadline) has instead, which is exactly why it should not be a number borrowed from another topology's arithmetic.

### Why the huge reduction needs a clock

Three is the one tier that is _lower_ than the topology below it, and read as a statement about auditing it is backwards: a huge diff has more defects and more territory than a chunked one, converges later, and on recall deserves more rounds, not fewer. PR #6457 is the standing counterexample — 5,801 lines, eight review rounds, still surfacing Criticals in code that had been in the diff since the first commit.

It is not a statement about auditing. It is a statement about a wall: a reverse-audit round on a 4,000-line PR is ~90 minutes, five of them are 450, and a six-hour CI ceiling does not hold that plus the fan-out and the tail. What the survey measured is not slow reviews but absent ones — 26 timed-out review jobs in one window, ~122 hours of compute, **zero posted** (DESIGN.md — The six-hour timeouts). Three rounds reported beat five rounds lost.

That argument is sound exactly where the wall is, and nowhere else. A local run exports no `QWEN_REVIEW_DEADLINE_EPOCH`, nothing kills it at six hours, and the reduction there trades recall away to fit a ceiling that does not exist — on the tier where recall matters most. So the reduction is now conditional on the run having a deadline at all: with a clock, 3; without one, a huge diff is a large 3B diff and gets 5.

Two things this does not pretend to fix, both worth naming rather than discovering:

- **The gate cannot price the early rounds.** `expectedRoundSeconds` falls back to a flat 30-minute constant until a round has been measured, and a huge round is ~90 — so on the runs that time out, the deadline gate under-prices rounds 1 and 2 by 3x and cannot refuse them. That, not the round count, is why a static reduction was needed on top of a working gate. A size-aware round-1 estimate is the change that would let the reduction retire entirely.
- **The cap is what stops retirement from paying for itself.** Chunk retirement (which predates this tier by five days) can only begin at round 3, and under a 3-round cap only round 3 can shrink before the loop ends. The expensive rounds are paid in full and the cheap ones are never reached, so the "5 × 90 = 450" arithmetic that justifies the cap is an arithmetic the cap guarantees stays true.

What this does **not** change: a cap stop is still a non-converged stop. It writes the marker, caps the verdict, and owes its `unreviewedDimensions` entry, at ten exactly as at five.

### Why the operator ceiling can only lower a tier

`review.reverseAuditRounds` lets an operator cut the round cap for every **high-effort** review they run — medium skips the reverse audit and low runs none, so there is no cap for it to cut there. It cannot raise one, and the asymmetry is not timidity about configuration — it is the same argument tiering is built on, applied to a knob.

A single operator-chosen count is exactly what tiering removed. A round is one agent on a 3A diff and ~90 minutes on a huge one, so one number is wrong for at least one topology, and the topology it is most wrong for is the one whose cap exists to stop six-hour reviews that post nothing. An operator who sets `8` has said something sensible about small diffs and something dangerous about large ones, and the setting cannot tell which they meant. Lowering carries no matching hazard: it can only end the loop sooner, and the floor at `HUGE_REVERSE_AUDIT_ROUNDS` keeps it above the point where a cap would pre-empt the two-consecutive-dry rule.

The two things an operator means by "let it run longer" are both about something other than a count. "Keep going while it is still finding real defects" is a property of the **findings**, not of a number chosen before the review starts. "My ceiling is not the six hours the huge tier assumes" has no expression today, and it is worth being precise about why rather than pointing at the deadline: `hasReviewDeadline` is a _presence_ check, so a huge diff reads 3 under any deadline however generous, and the round cap is evaluated before the deadline arithmetic — so setting a longer deadline **lowers** the cap rather than raising it. Saying "my ceiling is larger" would need the tier to read the deadline's size rather than its existence; see "Why the huge reduction needs a clock". Answering either with a bigger integer is answering a question about time or evidence with a question about counting.

The setting is also deliberately not a flag. It resolves in the capture command and lands in `plan.budget.reverseAuditRounds`, so every reader — the admission gate, the cold-check note, `compose-review` — sees one number and none of them learns a setting was involved. That is the module's standing rule (a budget the caller passes is a budget the caller can inflate) satisfied rather than excepted: the operator sets a standing policy, the CLI resolves it once, and no per-invocation caller gets to name a budget. The reader needs no new code at all — a lowered value is inside the tier's `[3, tier]` band, which `reverseAuditRoundCap` already honours.

One consequence belongs in the setting's own description, and is there: cutting the cap does not make reviews converge sooner, because the loop ends on two consecutive dry rounds. It makes them stop **before** converging more often — and every such stop is disclosed as unreviewed scope and caps the verdict at `COMMENT`. A cheaper review is also one that can no longer Approve.

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

## Why the verifier may file what its run tripped over

"Why separate from verification" (above) rejects merging the reverse audit into the verifier because it would load one agent with two search tasks. That rejection stands — and it is about SEARCH. What it never weighed is an agent that searches for nothing and still observes something, because when it was written the verifier only read. A verifier that runs — probes, drives, A/Bs, extracts steps — has the real stack in front of it, and the stack does not confine what it exhibits to the claim under test: the error path renders wrong while you are timing a retry; the bookkeeping doubles while you are counting refreshes. Under the old brief's flat "you do not look for new problems", that observation had nowhere to go, and the review threw away its own highest-grade evidence — the only observations in the whole pipeline that come from a live product rather than a reading.

So the incidental channel is a gag removal, not a mandate. Its three rules keep it from becoming the merged role the design rejected: **zero extra budget** (only what a required run already surfaced — no added runs, no widened reads, no chased leads; the hunt stays with the reverse audit), **never self-confirmed** (the entry enters unverified and a later round's fresh verifier rules on it — the run is the finding's evidence, exactly as a finder's grep is, and evidence is not a verdict), and **verdicts first** (the shard's actual job is not displaceable). The channel's entries ride machinery that already exists — the `— [unverified]` tag, the repeat verification rounds — so the pipeline gained a source, not a stage.

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

- `qwen review presubmit <pr> <sha> <owner/repo> <out>` — emits a single JSON report with `isSelfPr`, `ciStatus`, `existingComments` (5 buckets), `downgradeApprove`, `downgradeRequestChanges`, `downgradeReasons`, `blockOnExistingComments`. SKILL.md only describes the schema and how to apply the report.
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

## Why the verifier writes in a tree nobody reads

The review's agents are readers, with two exceptions that write in order to measure: Agent 7's test-efficacy probe, which has run in a disposable sibling worktree since #6832, and the Step 4 verifier — which did not. It writes a probe file, runs it, applies the one-line fix the finding implies to show the probe flips, and restores. Its brief has always ended that procedure with "leave the tree as you found it", and verifiers obey it — the tree is clean by the time they return.

That rule closes the wrong window. Every agent is pinned to the same worktree by `working_dir`, and the reverse-audit loop is **pipelined**: round _k_'s verifiers are launched in the same response as round _k+1_'s auditors, precisely so nobody waits on a verdict the next round does not need. So the interval in which a probe's mutant sits in the tree is the interval in which auditors are reading that tree. Restoring afterwards makes the residue transient; it does not make it invisible, and a reader cannot tell a transient mutation from the PR's own code — that is what "reading the working tree" means.

Live, it went exactly as that predicts (see _The probe residue an auditor almost filed_). The recovery is the part worth keeping: the auditor stopped trusting the working tree and took its evidence from `git show HEAD:` instead. Nothing had told it to. A pipeline whose correctness depends on an agent inventing the right fallback mid-round is a pipeline that is correct by luck.

Two halves, because either alone leaves a hole:

- **Remove the source.** `scratch-tree` gives each verifier shard a throwaway sibling worktree at the commit under review, with the review worktree's `node_modules` linked in so a unit harness starts without a per-tree install. This is the third instance of a pattern the pipeline already had — the efficacy probe's `-probe` tree (#6832) and the A/B's `-base` tree — and it closes the last step that wrote into the shared tree. Three properties are not decoration: **every call returns a pristine tree**, because a previous finding's mutant surviving into the next probe is a wrong verdict carrying a deterministic source tag; **the label is the shard's record key**, because the shards of one round run concurrently and a shared scratch tree would be the same race one level down; and **failure to isolate makes the probe inconclusive rather than falling back to the shared tree**, the same refusal `test-efficacy` makes, because "probe nothing" costs one low-confidence finding while "probe here" costs the round's readers their evidence.
- **Harden the reader.** Every code-reading brief — dimension agents, chunk agents, the Agent 8 whole-diff specialists, reverse auditors, and the verifier itself — now carries the rule the auditor had to invent: the worktree is shared, code that is not in the diff and not in the commit is not a finding, and anything surprising is judged against `git show HEAD:<path>` (a path that command cannot produce is not in the commit at all, which settles it rather than blocking on it). And `agent-prompt`, which builds every wave of agents immediately before it launches, reads the tree once per call: when it finds residue it names the paths inside each code-reading brief and warns on stderr. A reader told "distrust `compose-review.ts` and `__probe__.test.ts`" needs no improvisation at all. The roles that do not review code get the paths without the rule, and Agent 7 is why that distinction had to exist rather than being an exclusion: it does not judge code, so the evidence rule means nothing to it — but it builds and tests the shared tree, a `[build]`/`[test]` finding is pre-confirmed and skips verification, and residue that predates the round would therefore arrive as a merge-blocking Critical nothing looked at twice. So every brief names the paths and says a defect confined to them is not a finding; only the readers get the rest. The stderr line says the same, and says to restore before launching the wave rather than after it — the earlier wording deferred cleanup to the next round, which is precisely the round the dirty tree was about to be read by.

A tripwire has a second failure mode, opposite to the one it exists for, and reaching it took two tries. `git status` honors the tree's ignore rules, and those rules belong to the actor the tripwire is watching: a `.gitignore` written after the checkout, or a line appended to the common repo's `info/exclude`, hides a probe's leftovers — and itself. Listing the untracked side a second time under **no** ignore rule at all (`ls-files --others` without `--exclude-standard`) closes that, and reporting what it finds is the obvious next step. It is also wrong: measured on a healthy review worktree of this repo, after the `npm ci` and build the pipeline itself runs there, `git status` reported nothing and the raw listing reported 3 957 paths — coverage HTML, `.tsbuildinfo`, husky's installed hooks. A tripwire that fires on every healthy run stops being read, real contamination drowns in it, and every verifier is handed `rm` recipes aimed at thousands of legitimate build artifacts. What separates the two sets is not the pattern, which is unbounded, but **who wrote the rule**: an ignore file the commit carries is ordinary repo hygiene every reader of that tree sees identically, and `check-ignore -v` names the source file per path, so the reconciliation asks git that question rather than inferring it from the name. One exception, stated because it is the whitelist form's whole trick: a rule from the commit that hides _everything_ (`*` with `!`-negations) vouches for nothing, so it is not believed either.

The isolation is what makes the residue rare; the reader rule and the tripwire are what keep a rare event from becoming a false Critical. The one is a guarantee, and guarantees are one regression away from being false — which is exactly the situation the reader was in before.

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

## Why the version axis is not only git

`base-tree` answers "and what did it do before", which is the git axis, and for two years that was the only axis this pipeline had. It leaves a whole class of claim unfalsifiable: the code is asserted to handle a version of something it does not ship — the runtime it will be executed by, a dependency's next major, a wire format that will gain a field. Nothing in the diff, the merge base, or the test suite can settle that, because every one of them runs on the version the harness already has. CI does not settle it either, and the way it fails to is the trap: a green matrix reads as "this works" when it only ever said "this works on the versions in the matrix".

The measurement that made this concrete cost one download. Node 22 reports 11 heap spaces, eight of them old-generation, so an eight-name old-generation set classifies every space that runtime exposes with nothing left over — and would have been reported as complete on that evidence alone. Node 24 reports 13: the two extra names, `shared_trusted_space` and `shared_trusted_large_object_space`, are both old-generation, and are exactly the kind a set written against the runtime in hand does not contain. Whether a given set covers them is a one-line question — `v8.getHeapSpaceStatistics()` on both — and unanswerable by reading.

So the capability is deliberately small. One other version, named by the claim rather than swept; the smallest discriminator rather than the suite; both outputs quoted. The cost asymmetry is the point — a runtime download and one `-e` against `base-tree`'s install-and-build — and it is also the reason to cap it: a capability this cheap invites a matrix, and a matrix spends the review's budget answering versions nobody asked about. An unfetchable version stays `witness: not run`, exactly like infrastructure the harness lacks, because a claim the harness cannot reach is a fact about the harness.

## Why the A/B gained a live-stack pairing

`base-tree` made the other program buildable; `drive` made one run observable. The step that stayed by hand was the A/B itself — and in the maintainer verifications this pipeline keeps borrowing from (one real daemon, a PR arm and a base arm on the same event stream), the pairing is precisely where a hand-rolled A/B stops being evidence. Three facts carry the comparison, and each was re-established by hand every time: that both arms ran the **same bytes** (two hand-written drive calls drift by a flag, and the difference then measures the harness), that the **shared upstream** outlived both arms (a daemon that dies between the arms turns arm B into an observation of a corpse), and that a difference is only quotable when **both arms actually completed**. `ab-drive` owns exactly those three: one script serves both arms verbatim (digested, `AB_ARM`/`AB_ARM_ROOT` the only variation), the shared process is started, readiness-polled, liveness-checked at each arm's end and killed unconditionally, and the report's `observed` gate goes false the moment a difference could be the harness's.

One default is deliberately opinionated: the shared process is **fresh per arm**. With a single instance and sequential arms, whatever arm A mutates is arm B's starting state — a false difference manufactured by the harness, which is the one failure an A/B exists to rule out. `--shared-once` is the opt-in for the observer shape, where the arms only watch and the sameness of the upstream instance is the point. That inversion puts the confound-safe behaviour on the path of least resistance and makes the risky shape a declaration.

## Why hunk necessity is measured, not read

`test-efficacy` already reverts, so the distinction is worth stating: its revert probe asks whether the **test** gates the change — revert the source, expect the suite to go red, `Source: [test]`. `revert-hunk` asks the reversed question, whether the **change** gates the behaviour: with a probe passing on the intact tree, take one hunk back out and re-run the same probe. A probe that still passes has measured one of two things — a hunk that is not load-bearing (dead weight, or a "fix" whose real fix is a different hunk), or a probe too weak to distinguish the trees — and either reading changes what the review may claim about the diff. This is the mutation A/B maintainer verification performs on nearly every PR it drives, and the half that was hand-done is the transcription half: extracting hunk N from a 5 000-line diff with sed ranges, where an off-by-one silently tests a mutation different from the one the report names. The command extracts verbatim — headers, context, `\ No newline` markers — and applies through git's own patch engine, so what runs is what the diff says.

A hunk that refuses to revert independently is reported as a fact, never forced: its context overlapping another hunk's edits IS the answer to a coupling question ("are these two hunks one fix?"), and forcing the apply would manufacture a tree no commit describes and measure that instead.

## Why the table sweep is called out separately from the impact sweep

The impact sweep's oracle rule — an external authority, never a reimplementation — was written for parsers and predicates, where the temptation to mirror is obvious enough that naming it is usually enough. The hardcoded enumeration is the same failure wearing a disguise: a table of another system's namespace (heap spaces, error codes, MIME types, status codes, locales) is small, legible, and looks like data rather than logic, so a verifier checks it by reading it against a list they type out — and a hand-typed list is a mirror, with the additional hazard that a table short enough to retype accurately is a table one feels confident about.

Two properties make the check worth naming rather than leaving to the general rule. First, the literal is already in the diff, so the sweep's population comes free: parse the table out of the source, take the set difference against the authority at runtime, done. Second, the two directions are different findings with different severities, which a "does the table look right" reading collapses. A name the table has and the authority does not is dead weight. A name the **authority** has and the table does not is an under-count — and an under-count is invisible to every test written against the table, because the table is what the test enumerates. That asymmetry is the whole reason the check pays: the failure it catches is the one the diff's own tests cannot.

## Why an aggregate is verified by removing contributors, not by instrumenting the reader

A claim about an aggregate — this total is a maximum and not a sum; this field is per-child and not fleet-wide; a child that reports nothing is skipped rather than counted as zero — cannot be settled from the aggregate alone, and the obvious repair is to add a per-component dump. That repair costs the verdict its standing. The numbers then come out of a build the review edited, and the one thing a witness is for is being a run of the code under review rather than a run of the reviewer's version of it.

Removing a contributor inverts the dependency. The reader is untouched, the population changes, and both readings come from unmodified code. The delta is the removed contributor's own value only where the rule is a sum; the general form is weaker and more useful — how the aggregate responds to a population it did not choose is the combining rule itself, and a population reduced to one contributor reads that contributor outright. It is also usually available — processes can be killed, workspaces unregistered, feeds dropped — and it produces the two numbers a sum-versus-maximum question needs without any per-component surface existing at all. A daemon holding two ACP children answered exactly that: summed RSS moved 193.6 → 377.5 MB across the two while the reported heap peak moved 103.5 → 103.7 MB. That pair excludes a sum — a sum would have moved with the RSS — and no more than that on its own; a fleet-wide maximum, a per-component reading following one child, and the parent's own heap all reproduce it. Which of those it is takes the second removal: take the population down to one contributor and the reading becomes that contributor's own value, or does not.

The one discipline it needs is identifying what you removed by something the product did not choose for you. Two children of the same daemon are indistinguishable in `ps`; removing "the first one" and reporting the remainder as the second's value answers a question nobody asked. A working directory, a port, a registered id — anything the harness can read back and name — turns the removal into a measurement.

## Why the round-3 lenses are prose, not detectors

Seven lenses joined the briefs from one verification round, and each is a judgment with a crisp trigger rather than a decidable predicate — which is what separates a brief lens from a subcommand here:

- **A borrowed idiom, missing what made it work at home.** The `&#64;` rewrite was lifted from a workflow where the _code ancestor_ did the protecting; the entity was belt-and-braces, and only the braces were copied. The check — read the source context of a lifted defensive construct, name what it provided — requires understanding which surrounding condition was load-bearing.
- **A second parser is a divergence hunt.** A sanitizer's model of markdown against GitHub's parse: every input the two read differently is a bypass. Finding the divergent input is the work; a tool can only confirm one once named.
- **A `fixed` ruling on a divergence-class defect is a ruling about the family.** Round 6 of the same verification closed the fence-shaped entrance into a raw-HTML block and left the code-span entrance beside it open — same divergence, adjacent syntax. The re-check bar in Step 6 now says it outright: for a **bounded** family, enumerate the sibling entrances before ruling `fixed`, report a still-open sibling as a new finding, and keep the two rulings separate (the original's `fixed` stands when its own input is closed). For an **unbounded** surface — one whose entrances cannot be enumerated and closed one by one (hand-rolled parsing of untrusted input, a re-implemented grammar) — the rule forks instead of enumerating: do not file sibling N; collapse the family into one class-level finding (witnessed by one demonstrated corner, carrying the strongest severity/confidence any sibling showed) and supersede the prior siblings under it, closed only when the structural change lands. Judgment again: knowing which inputs are "the same mechanism" — and whether that mechanism has a last corner — is the understanding a detector cannot supply.
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
- **The anchor names its model.** Incremental scoping is a same-model contract — "clean up to `sha`" is one model's verdict. The cache path has paired its anchor with `lastModelId` from the start, but enforced the contract only in the same-SHA skip case (a re-run under a different model gets a full second opinion, not a skip); its differing-SHA incremental branch carried no model condition until this change. The marker's anchor shipped bare, so the recovery path had no way to honour the contract at all: a round run under model B that recovered model A's anchor would scope `sha..HEAD` past code B never reviewed — permanently, since each clean round re-anchors past the last. The marker now carries `model` beside `sha`, riding and falling with the anchor (withheld on fail-closed and truncated rounds alike; an id over the marker's cap withholds the PAIR — a truncated id is a prefix, and a prefix can equal another model's full id; dropped by the parser when the sha beside it did not survive), and Step 1's recovered-anchor gate requires it to match the running model — absent, on markers from before the field, counts as a mismatch: the work list still carries (rulings re-assert against the code, so they cross models safely), only the anchor does not. Two boundaries of that carriage: the identity the marker carries is the one the session publishes (`QWEN_CODE_MODEL`, injected at the CLI boundaries), with the model-written state field only the fallback for runs no session published — so a run with a session-published model certifies with it even if the state JSON typed another id (the channel is not a forgery boundary: the launching command can still override the env, and recovery accepts any well-formed own-account marker); and `review.attribution: false` withholds it with the footer, because the setting's contract is whether the posted review names its model, and the marker rides the posted body. One scope on that first boundary: it bounds the MARKER, whose identity is injected at the CLI boundaries — the cache path's `lastModelId` remains what the model types at Step 8 (no CLI writer exists for that file) — typed as the fetch report's `reviewModelId`, the CLI-published qualified identity, but still model-typed — so a forged cache id can defeat the gate without exceeding the pre-change baseline, whose differing-SHA branch carried no model condition at all.

Two consequences of those boundaries are worth naming rather than discovering. Ids are **carried, not renumbered**: a still-standing finding is re-reported under the id it already has, that id is written into the comment right after the severity marker, and `buildLedger` reads it back — because a ledger that renumbered by position would key the next round's work list to ids the report riding beside it never used, and `R1-2 names the same claim in every round` is the entire payoff. And own-account recovery means a PR reviewed from **two** accounts — a maintainer locally, a bot in CI — keeps two independent ledgers, each with its own round counter and its own `R2-1`; that is the honest reading of "only this account's reviews can claim what this account stood behind", but it does mean the ids are scoped to the account that wrote them, not to the PR.

## Why the marker carries a closure list (the successor-chain sentinel)

The ledger tracks ids, carries and supersession, but nothing read the _lineage_. On #9659 the finding counts converged cleanly to one by round 9, then rebounded to 6, 6, 4 — and the rebound was one subsystem: the stop-round blocker-dating chain produced three generations of successor Criticals (R9-1 → R10-2/3/4 → R11-4/R11-6 → R12-1/R12-2), each generation caused by the previous round's fix growing the mechanism. Every finding was individually correct, so every round looked locally normal; recognizing the divergence took a manual round-count analysis and cost four rounds of patch-and-regress. The recurrence cluster says "the file sees findings again"; what it cannot say is "the fix closed one and the mechanism grew another" — that claim needs the _closures_, which no round recorded.

So the marker now carries one bounded `closed` list: composing round N diffs the recovered work list against the findings it is about to post, and each vanished Critical id is recorded as `{r: N, id, f}` — `fixed` and `superseded` both read as closure, and a positional diff cannot tell them apart, which the advisory note does not need. The sentinel is then a pure walk inside `diagnoseConvergence` (K=2, the current round included): a fresh Critical on a file that closed one at round N-1 AND closes one at round N fires a `successor-chain` recommendation naming the subsystem and the chain (`R9-1 → R10-2 → R11-4`), rendered into the convergence observation the body already carries. On the #9659 shape it fires at round 11, one round before the human analysis caught it. The design choices, each deliberate:

- **One generation, no carry-forward.** The check reads closures at N (minted while composing) and N-1 (read back off the previous marker), so the marker carries only its own round's mint — older entries are dead bytes.
- **Advisory, never a cap, never the anchor.** A divergence is a property of the code under review, not of what this round read. It sheds ABOVE the anchor pair in the byte-budget cascade — a full-diff re-review costs more than a lost lineage hint — and shedding it never sets `dropped`, because closures certify no range.
- **Thin history stays silent.** Minting closes on claim identity, not id identity (a claim re-posted under a re-minted id still stands), and stays silent wherever absence from the posting set is not a ruling: a previous list with `dropped` set (a missing id may be the budget, not a ruling), a diff-only round, a round that answered "cannot tell" on a Critical, and a pure-foreign previous list. Every marker written before the field existed simply has none.
- **Only Criticals, only real files.** Suggestion churn is not the patch-and-regress signal, and the `(body)`/`(unknown)` stand-ins name no subsystem — the check applies the cluster join's own `k`-flag rule, so a real file spelled like a stand-in still clusters.

## Why candidates are deduped against the carried ledger before the verify shard

The posting layer has always dropped a confirmed finding that is already reported on the PR, and it sits at exactly the wrong end of the pipeline for the job: by the time it runs, the candidate has been derived by a finder and traced by a verifier, and on a re-review loop that cost repeats every round while the original threads stay open. Measured on PR #9729, round 12 confirmed seven already-reported Suggestions and round 13 eight, each carried through derivation and verification before being discarded; the deferral list fed the same loop — by round 15 it held sixteen items the rounds kept re-deriving (issue #10105).

So Step 4 now runs `dedup-candidates` between the finder union and the shard write: a deterministic match of the pooled candidates against the carried ledger — the recovered posted work list, plus the previous round's findings-artifact deferral entries when the artifact is on this machine AND is from the side file's own round — by file, anchor proximity and claim similarity. The model is out of the matching loop for the same reason the script-lint gate keeps it out of linting: a prose instruction to finders not to re-derive known findings is a nudge, and nudges have not moved strong models reliably (the scripts-nobody-ran incident is the measured shape of that).

Three choices define its failure directions. The match bars are conservative and asymmetric on purpose — a candidate kept in error rides to verification where the posting-layer drop still catches it (the status quo, kept as the backstop), while a candidate dropped in error would be a new finding lost with nothing downstream to recover it; a Critical candidate therefore never drops against a non-Critical entry, so an escalation always reaches a verifier. The drop is licensed by the ruling, not a replacement for it — a matched ledger entry is still ruled against the code at Step 6, so the claim degrades to ruling rigor rather than disappearing, which is also why a planted marker entry (the ledger is recovered from a writable surface) diverts a candidate without retiring its claim. And the disclosure is deterministic: `compose-review` reads the report the command wrote, bound to the plan diff's hash exactly as the script-lint report is, so the set-aside count reaches the posted body mechanically instead of by the model remembering to say so. Artifact `R` entries deliberately do not participate — only the side file speaks for posted findings (an old artifact's entry may name a claim later rounds ruled `fixed`, and matching it would lose a real regression), and a low-confidence terminal-only finding must never absorb a candidate at all, because nothing downstream rules on it. The deferral half is further fenced to the side file's round: the artifact's outcomes are only as fresh as the round that saved it — rounds alternate machines by design, and a copy from any other round (or one whose round is unrecoverable) drops nothing at all, because its idea of which deferrals still stand can be a round stale. A same-diff report merge re-validates a leftover drop against the carriers this invocation loaded for the same reason — a killed run's citation of an entry a later round closed must not reach the disclosure. Every uncertain state here degrades to keeping the candidate.

## Why a Critical is deferred by its axes, never by its severity (#10291)

The convergence posture's whole mechanism is a posting bar that rises with the rounds: from round 6 (or earlier, on the flat-trend signal) only Criticals post and everything else is recorded. On #9659 that bar stopped working at round 17 and the loop oscillated to round 23 — 7, 5, 3, 5, 4, 1, 6 new Criticals per round, 31 in all, near-zero false positives — because the `Critical` class encoded three orthogonal merge decisions in one bit: which way the defect fails, what it is measured against, and how often it triggers. Past the convergence rounds _everything that matters_ still landed on the floor, so the floor filtered nothing. Roughly half of each round's findings were fail-closed corners on defenses added in earlier rounds — real relative to the feature's ideal, zero-regression relative to the merge base (before the PR, a sparse checkout had no incremental review either) — and the reviewer, grading against the ideal, was right for issue priority and wrong for a merge gate.

So two of those axes now travel with the finding as fields, stated by the verifier off the same witness that confirmed it (the probe's two sides show whether the certification was wrong or the path was withheld; the A/B's base arm shows whether the merge base handled the trigger): `direction` — `certifies-falsely` (a wrong result presented as correct: the core promise broken) or `fails-closed` (refuses, wedges, degrades to absence: coverage narrowed); and `baseline` — `regression` (the base did it right) or `new-surface` (the failing path does not exist at the base). The floor reads them, and the rule is deliberately the narrowest one the evidence supports: **a Critical defers only when it is `fails-closed` AND `new-surface`**, because that is the one combination where merging certifies nothing false and regresses nothing. A wrong-result finding blocks at either baseline (of the ~25 findings the issue classified on #9659, the ~6 in the certification direction were all worth blocking on); a regression blocks in either direction (a merge gate grades against the merge base — that is the whole point of the second axis); a Critical missing or contradicting an axis is one the floor cannot classify, and a blocker in doubt posts. The third axis — trigger frequency — is not carried: the issue named it optional, and a "corner" is a judgement no witness settles.

Three boundaries keep the rule honest, each borrowed from the Suggestion deferral it extends:

- **The floor, not the round, licenses it — and only the `critical` floor.** The rounds-2–5 code-age rule never touches a Critical. In code the licence is the ENFORCEMENT reading (`criticalFloorInEffect`), because the split moves a blocker out of the posting set and a posture the module had to guess at must not do that; a deferrable Critical arriving when the floor is not in effect is relocated into the body Criticals and posts, exactly as every Critical entry was before.
- **The classification is the review's own, on the claim line.** The posted comment carries the axes as bracket tags beside the id, the way it carries `[probe]`, and both the enforcement backstop and the ledger marker read them off that one line — never the body's writable tail, where a forged pair would defer every drafted Critical at once. The marker stores them as one-letter fields (`d`, `b`) so the next round's work-list table shows a carried Critical's axes and the autofix tooling (#9907) can key on them; a spelling this version does not know normalises to absent, like the stand-in flag, and never drops the entry.
- **Absence never classifies.** Every consumer reads a missing axis as "posts at any floor". The verifier is told to omit an axis its witness cannot settle rather than guess, the artifact refuses a misspelled one, and the drafted-comment arm ignores a self-contradicting pair — because the failure direction that matters is a guess on either axis completing the pair and taking a blocker off the pull request.

A deferred Critical's record is the deferred Suggestion's record: the posted deferral line (which names it `Critical` and shows its tags, under a header that says why), its `D<round>-<n>` entry in the findings artifact, the terminal report — and, like every deferral, it leaves the work list and re-posts nothing. Its relation to the closure mint (#9905) follows the mint's existing id join, and has three shapes. A Critical POSTED in an earlier round and deferred now bears its `R` id in the title, so the mint reads it as a re-post and does not close it. A Critical deferred on DISCOVERY — the dominant shape in the #9659 replay — bears no id any posted work list held (its artifact id is a `D` id the readback does not read), so the mint fails closed for that round exactly as it already does for a discovery-deferred Suggestion: absence never reads as a fix, at the cost of that round's true closures. A RE-deferral of a once-posted Critical is the same case one round later — its `R` id is absent from the previous POSTED work list. The second and third shapes are the pre-existing doctrine for any id-less or unplaceable deferral entry, not a horizon this feature adds; carrying the round's deferred ids in the marker would let a re-deferral join by them, and is left for a follow-up. A discovery deferral has no prior id to carry. Replaying #9659 under the rule: the ~6 certification-direction findings still block, the ~19 fail-closed corners route to follow-up, and the loop plausibly goes quiet around round 19 instead of 23.

## Why `--resume` continues a run from the harness's records, not a checkpoint file

A long local review that dies part-way — a dropped connection, a killed terminal — used to have to start over: on a large PR, minutes of re-fetching, re-chunking and re-launching before the first finding existed again. `--resume` continues it instead, and it stores no new checkpoint state at all, because the persistent checkpoint already existed: the prompt records are the obligations, the harness transcripts are the evidence (each ends with the agent's own final text), the per-round `.findings.md` files are the orchestrator's cumulative state, and the plan's mtime is the run epoch every fence keys on. What was missing was only that nothing read them back.

**Resume is a LOCAL convenience.** The on-disk state is written only by the trusted CLI and the developer running it — there is no adversarial second writer racing the same disk. (CI does not resume: its retry re-runs the review fresh, because a CI attempt runs no-sandbox on the reviewed PR's own code and `runNonInteractiveCli`'s cleanup deletes the attempt's worktree on exit, so there is no interrupted state left to continue.) That scoping is what keeps the mechanism small: the ruling asks only whether the state is genuinely UNCHANGED and resumable, never whether a field on disk was forged.

So `--resume` is three small mechanisms over existing state. `fetch-pr --resume` rules on facts it gathers itself — the worktree still at `fetchedSha` and clean (`git status --porcelain`), the diff bytes hashing to the plan's `diffSha256` (content is the checkpoint key: changed input re-runs by construction), the live head unmoved, the resume cap unspent — and on a pass it skips the stale-state sweep and, critically, does not rewrite the plan, so the first attempt's records stay inside every reader's fence. A run-sessions ledger written by `fetch-pr` tells the transcript readers which earlier sessions belong to this run; `coverageFromTranscripts`, `verificationGaps`, retirement and the cost ledger read the union and need no new judgment, because their pairing bar is content-shaped — a verbatim-delivered CLI prompt plus an opened brief or diff. `recover-findings` closes the one real gap: the interrupted orchestrator's context is gone, so the certified agents' final texts are read back out of the transcripts and handed to the new session as a CLI-authored file.

The refusal directions all point the same way: anything that no longer matches or cannot be read (missing report, worktree moved or dirty, diff-hash mismatch, head moved, unreadable ledger) reads as "start fresh" — never as a silent continuation of stale work. The resume cap reads two counters — the resume marker's count, cross-capped by the session ledger's resume count — so deleting `resume.json` alone does not reset it. An in-run drift restart is recorded when its Step 1 re-entry refuses with `head-moved` and falls through to the fresh fetch the restart wants. And budget round stamps are deliberately dropped on resume because a span across the death gap would price a round at hours — the gate falls back to its conservative constant, whose failure direction is an early stop with a disclosure; a round-cap stop, being the CLI's own record of an exhausted cap rather than a stale time-budget stop, is kept.

## Why the incremental scope widens by one import hop

The narrowing publishes the PR's own sections for the files a round touched, and `narrow-diff.ts` carries the argument for building the scope that way rather than checking a separately captured one. This is the other half, and it goes the opposite direction: the narrowing is sound only for files the delta can see.

The widening exists because "clean" is a verdict about the code as it stood. The previous round cleared a caller against the callee it imported THEN; the fix under review moves the callee, and a scope that holds only the interdiff never re-opens the caller — the breakage retires silently, permanently, because the next clean round re-anchors past it. So every still-clean source file one import hop from a changed file re-enters the scope with its full-range hunks, and the plan records why (`incremental.interaction[]`), so the chunk brief can direct its agent at the seam — "do your uses of what changed still hold" — instead of a from-scratch re-review that re-reports what round 1 already ruled on. One hop, dependents only, source files only: the callee-side risk lives in the changed file's own chunk (its agent reads callees from the worktree), test dependents are `build-test`'s job, and a barrel re-export between caller and callee hides the edge — a documented miss that leaves exactly the floor incremental review had before widening existed. The specifier scan is a regex heuristic on purpose, and its error directions are chosen: a false positive reviews a file once more than needed, a false negative never drops below the unwidened floor. A round that only REVERTS needs none of this: the undone file is gone from the PR's own diff, so the narrowing refuses to narrow at all and the round reviews the full range — over-review, which is the direction every refusal here leans.

It cannot be folded into the narrowing, because the file it adds is one the delta capture provably does not contain — an importer of a changed file is unchanged by definition. So it runs on the narrowing's own selection, after its guards have passed, and it only ever adds: with no edge to follow the widened round publishes exactly what the unwidened one would, which makes the narrowing the floor rather than a second path that could disagree with it.

The local flow anchors on content, not on a commit, because it has no commit to anchor on and is forbidden from making one: the reviewed state is a dirty working tree, and `local-diff.ts`'s standing constraint — nothing on the capture path writes to the index, the worktree, or any ref — rules out snapshot commits and stashes. `git hash-object` without `-w` computes the blob id of the current bytes and writes nothing, so the anchor is the hashed per-file state of exactly what the plan covered, plus the HEAD the diff was measured against. The identity is `<mode>:<blob>`, not the blob alone — an exec-bit flip or a file↔symlink typechange is its own diff lines, so identical bytes under a different mode are not an identical change; symlinks hash their link text at 120000, exactly what `git diff` renders, never the resolved target's bytes. Whatever cannot be captured faithfully — a submodule gitlink (the pinned diff flags deliberately keep those visible), a FIFO, a path git C-quoted out of an invalid-UTF-8 filename — is marked `unhashable`, which never compares equal, not even to itself: "could not capture it twice" is not "unchanged", and each of those shapes was measured comparing stable under the naive scheme, silently leaving incremental scope forever. The capture also re-snapshots the diff after hashing and withholds the candidate unless the two captures are byte-identical — the one race where the anchor could certify bytes no round reviewed, closed by refusing to anchor rather than by pretending the window is empty. HEAD is hashed into the state id AND checked as a separate hard gate — the redundancy is for legibility's sake — "HEAD moved since the last local round" is a reason a user can act on, where a mere state-id mismatch is not — and it is load-bearing: the captured diff is HEAD-vs-worktree, so under a moved HEAD identical worktree bytes describe a different change under review (a reset exposes commits no round ever read). The candidate/cache split mirrors the PR flow's marker rules: the capture writes this round's anchor deterministically on every run, and only Step 8's clean-high-effort gate promotes it to `.qwen/review-cache/`, so a fail-closed round can never anchor the next round's skip past scope nobody reviewed.

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

## Why a confirmed Critical carries a witness

The verify brief accumulated three execution capabilities — the probe, the A/B, extract-step — and every one of them was **optional**, spent at the verifier's discretion. Mining the maintainer's dogfood corpus (356 review sessions and 182 real-environment verification sessions, 2026-06 through 2026-08) measured what discretion produces: in the review rounds that held up, evidence-gathering was ~80% of all tool calls and **every posted hard finding quoted executed output** — a probe's two sides, a repo-wide count, a failing test's text. The counterexample is the rule's origin: the one round-1 claim written from a reading alone was retracted publicly in round 2 when its first measurement returned zero (see the measured entry). The witness rule inverts the default for the findings that post at the highest severity: the executed evidence **is** the confirmation; a reading is a reason to go get one, or to say in one line why none can run.

The enforcement shape is borrowed from the `— [unverified]` tag rather than from the brief, and the borrowing includes the tag's machine half: "no witness and no reason ⇒ low confidence" is first a sort the orchestrator performs on observable state, and then a demotion `qwen review findings` applies in code at canonicalization — a high-confidence `[review]`-source Critical with no `witness` field is filed at low confidence, each named on stderr. The rule shipped without the code half first, and the PR's own dogfood review caught it: the precedent being cited (compose-review machine-reads the surviving tags) HAS code, `validateFindings` defaults an omitted confidence to `high` — the fail-open direction — and the same command already demotes Criticals mechanically for test-delta, so the pattern was local. Deterministic sources are exempt: a `[build]`/`[test]`/`[probe]` finding is itself a run's output, and demanding a second witness of it would demote findings the pipeline treats as pre-confirmed. A verifier that traced a genuinely unrunnable claim still posts it — the one-line reason is cheap, and writing it is exactly the moment the verifier notices when the claim was runnable after all. The field rides the findings artifact (`witness`, optional) for the same reason `failureScenario` does: the report and the comment bodies quote one recorded string instead of transcribing the evidence twice more, and transcription is this skill's best-documented failure mode.

The impact sweep earned its place as a named witness form because it does two jobs no single-instance confirmation can: it converts severity from adjective to measurement ("195 of 434 real step bodies"), and it retracts as mechanically as it confirms — a sweep that returns zero is a false Critical caught before posting instead of after. Its external-authority guard exists because both of its measured failures were the same failure: an oracle that reimplemented the logic under test inherited its blind spots and manufactured findings out of its own bugs.

## Why the witness rule grew to cover Suggestions

The rule shipped Critical-only, on the argument that a Critical blocks a merge and so carries the highest cost of being wrong. What that scoping missed is that the posting surface does not distinguish: a Suggestion lands on the author's screen as an inline comment on the same terms as a Critical ("Why Suggestion-level findings are posted as inline comments, like Critical", above), so an unexecuted claim rides onto the PR through the Suggestion door with nothing demanding its evidence. The extension closes that door: both postable severities owe a witness or the one-line reason, and the demotion for arriving with neither is the same — low confidence, terminal-only. `Nice to have` stays exempt because it is terminal-only by construction; there is nothing for the rule to hold back.

The same change tightened the escape hatch. `not run — <why>` was doing double duty as a licence: any reason satisfied it, including no reason at all. The toll is now the named capability that came closest — the probe you could not seed, the A/B whose base would not build — because naming it is the moment a verifier notices the claim was runnable after all, and because a reader weighing a low-confidence finding needs to know which measurement is missing, not merely that one is. The machine half (`holdUnwitnessedFindings`) treats a reason-less `not run` line as no witness at all; judging the QUALITY of a named reason stays with humans, since a mechanical check of prose substance would be exactly the kind of mirror-oracle this document already rejects.

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

**Guardrails, because an unverified pass is recall-limited by construction.** These guardrails defend against findings that no verifier ever checked, which since medium became a verified fan-out means **low and `--topology minimal` alone**; medium shares only the cache and posting rules (its Approve cap is Step 6's own rule, not one of these).

- Labeled **unverified**; no Approve/Request-changes verdict is emitted. A verdict is a claim the pipeline earns in Steps 4–5; a quick pass claims findings, not absence of findings.
- Never posts to the PR: `--comment` forces high at low effort, and the parser forces `comment.effective` to false on the minimal arm (terminal-only); a "post comments" follow-up is declined in both.
- Never consults or writes the incremental cache — otherwise a medium run's SHA would make a later high run report "No new changes since last review", silently converting a quick pass into a full-review verdict.
- Scope handling (worktree, diff capture, chunk plan) is identical at all levels. The levels change who reads the diff and what runs afterwards, never how the diff is obtained — the base-resolution and truncation traps do not care how fast the user wants the answer.

**Defaults:** PR targets → high (the product is a public verdict); local-diff / file-path targets → medium (the product is fast feedback; the closing tip advertises `--effort high`). Findings caps exist only at the unverified levels — at high effort, verification is the noise filter, so no cap is needed.

## LLM call budget

**`--topology minimal` — 0 subagent calls.** The minimal arm (issue #9783, Step 3M) is a single careful pass over the diff in the orchestrator's own context — no fan-out, no verification, no reverse audit, no build/test. It costs one model turn, the same shape as the low tier's inline pass, and it is priced here for completeness, not as a recommended default: it exists so the full pipeline and this minimal prompt can be run over the same PR set and compared per model. This section tracks per-topology _cost_; the A/B the minimal arm enables extends it with per-model _quality_, which is what decides whether any cell of a future model-family × effort routing table routes away from the full pipeline. Until that data exists, every review runs the topology below.

**Small diffs (≤ 500 source lines AND ≤ 3200 total diff lines, Step 3A, high effort) — 17-28 calls (typically 17-19):**

| Stage                   | Calls               | Why                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review agents           | 14 (+0-2)           | issue fidelity + 3 procedural correctness walks (1a/1b/1c) + security + 3 quality slices (3a/3b/3c) + perf/tests + 3 undirected personas + build&test, plus 0-2 diff-specialized finders; cross-repo skips Agents 7 and 1c (12), non-PR skips Agent 0 (13)                |
| Sharded verification    | `ceil(F/8)`         | F = findings; typically 1-2; keeps each verifier's job small on high-finding reviews                                                                                                                                                                                      |
| Iterative reverse audit | 2-10                | loop ends after two consecutive dry rounds; 10-round hard cap — one auditor a round on 3A, so the marginal round is one call. A 3A diff is never "huge": `effective = max(src, total/8) ≤ max(500, 400)`, so the huge tier cannot reach this table                        |
| **Total**               | **~17-28 (~15-27)** | Row maxima do not co-occur on typical runs (~17-19 is common), but the honest sum of ranges is 17-28 same-repo, 15-27 cross-repo/local. **Low effort: 0 subagent calls** — the angle rotation runs in the orchestrator's own context; medium launches its reduced fan-out |

**Large diffs (> 500 source lines OR > 3200 total diff lines, Step 3B, high effort) — `ceil(diffLines / 400)` chunk agents + `5..7` whole-diff agents + `3H` invariant agents (H = heavy files) + `ceil(F/8)` verify (F = findings) + `rounds × chunks` reverse audit.** The reverse audit dominates: it fans out one auditor per chunk per round, and the stop rule needs two consecutive dry rounds (hard cap 5 — **3 for a huge diff, effective ≥ 3000 lines, when the run has a deadline**, which narrows the per-chunk multiplier to `2..3`; a huge diff with no deadline keeps the 3B cap of 5, so the multiplier stays `2..5`). PR #6457 (5801 diff lines, 19 chunks, 1 heavy file) costs ~27-29 first-wave calls, then `19 × (2..5) = 38-95` reverse auditors — ~66-126 calls total depending on how long the audit keeps finding (a huge-diff cap-3 run of the same shape narrows this to `19 × (2..3) = 38-57`); ~70 is the clean-run floor, and the count scales with chunks and findings, not a fixed ceiling.

That is roughly 4x the small-diff budget, and it buys the thing the small-diff topology cannot deliver at that size: coverage. Ten dimension agents (the roster of the day; fourteen now) on a 5801-line diff each read the same truncated 14% window (see "Why the diff is a file, not a command"), so nine of the ten calls were redundant reads of the same hunks. Nineteen chunk agents each read a distinct ~390-line territory, and every line of the diff has exactly one accountable owner. The comparison to make is not ~70 calls vs ~17: PR #6457 took **eight** review rounds at 12-14 calls each — over 100 calls — and was still surfacing Criticals in code that had been in the diff since the first commit.

Competitors: Copilot uses 1 call, Gemini uses 2, Claude /ultrareview uses 5-20 (cloud). Ours biases toward higher recall — the assumption is that "find more issues per round" is more valuable than minimizing per-run cost, because every missed issue forces the user into another `/review` iteration.

## Why the diff is a file, not a command

Agents used to be handed `git diff main...HEAD` and told to run it. At the time of the measurements below, Shell tool output passed through `truncateToolOutput` with `ShellTool.maxOutputChars = 30_000` and `keep: 'both'`, and the 30K trigger was also the preview budget: `threshold / 5` characters went to the head and the remainder to the tail. Shell now uses a 30K persistence trigger by default, lets an explicit `truncateToolOutputThreshold` override it, and keeps an approximately 4K head-and-tail model preview. Direct `git diff` output still cannot guarantee complete review coverage because both the default and the independent final budgets can shorten it; the file-and-chunk design below remains authoritative.

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

The convergence concern that motivated the summary is real but narrower than it looked: GitHub's Outdated-collapse handles every suggestion the author actually acts on, which is the common case. What remains is a suggestion the author declines and leaves untouched — its line does not change, so the thread stays open and a later run can post a near-duplicate. That residue is bounded by the presubmit Overlap check (`blockOnExistingComments`), which blocks submission when a new finding lands on the same `(path, line)` as a live Qwen comment on the same commit — with one deliberate exception (#9208): a carried-forward ledger finding that re-posts its own original thread carries the original's ledger id and is bucketed `repost` (exempted) instead of blocked; otherwise the carried re-post of a declined suggestion would itself be dropped as a location overlap and the finding would never reach the page.

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

| Approach                                            | LLM calls          | Notes                                                                                                                    |
| --------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Copilot (1 agent)                                   | 1                  | Lowest cost, lowest coverage                                                                                             |
| Gemini (2 LLM tasks)                                | 2                  | Good cost, medium coverage                                                                                               |
| Our design (5 agents, N verify)                     | 21                 | 5+15+1 — too expensive                                                                                                   |
| Our design (5 agents, batch verify, single reverse) | 7                  | 5+1+1 — original design                                                                                                  |
| Our design (9 agents, iterative reverse)            | 11-13              | 9+1+(1-3) — +50% cost for meaningfully higher recall                                                                     |
| Our design (10 agents)                              | 12-14              | 10+1+(1-3) — adds issue-fidelity/root-cause gate                                                                         |
| Our design (14 agents + effort levels, current)     | 17-28 high / 0 low | 14(+0-2)+ceil(F/8)+(2-10) under 3A; low runs inline with no subagents, 3-6 angles by diff size — cost scales with intent |
| Claude /ultrareview                                 | 5-20               | Cloud-hosted, cost on Anthropic                                                                                          |

## Future optimization: Fork Subagent

> Dependency: [Fork Subagent proposal](https://github.com/wenshao/codeagents/blob/main/docs/comparison/qwen-code-improvement-report-p0-p1-core.md#2-fork-subagentp0)

**Current problem:** Each of the ~17-28 LLM calls (14-16 review + sharded verify + 2-10 reverse audit rounds) creates a new subagent from scratch. At ~52K per agent (50K system + 2K task), that is ~880K-1.5M input tokens with massive redundancy. The cost grew along with the agent count — Fork Subagent matters even more under the current 14-agent design than under the original 5-agent design. (Effort levels bound the cost from the other side: low runs spawn no subagents at all, and medium spawns the reduced fan-out.)

**Fork Subagent solution:** Instead of creating independent subagents, fork the current conversation. All forks inherit the parent's full context (system prompt, conversation history, Step 1/1.1/1.5 results) and share a prompt cache prefix. The API caches the common prefix once; each fork only pays for its unique delta (~2K per agent).

```
Current (independent subagents):
  Agent 1: [50K system] + [2K task]  = 52K
  Agent 2: [50K system] + [2K task]  = 52K
  ...× 17-28 agents                 = ~880K-1.5M total input tokens

With Fork + prompt cache sharing:
  Cached prefix: [50K system + conversation history]  (cached once)
  Fork 1: [cache hit] + [2K delta]   = ~2K effective
  Fork 2: [cache hit] + [2K delta]   = ~2K effective
  ...× 17-28 forks                  = ~50K cached + ~34-56K delta = ~84-106K total
```

**Additional benefits for /review:**

- Forked agents inherit PR context and review rules — no need to repeat in each agent prompt
- SKILL.md workaround "Do NOT paste the full diff into each agent's prompt" becomes unnecessary — fork already has the context
- Verification and reverse audit agents inherit all prior findings naturally
- Agent 6 personas can fork from a shared diff-loaded base, paying only the persona-framing delta

**Estimated savings:** ~90-93% token reduction (~880K-1.5M → ~84-106K) with zero quality impact. The savings ratio is now even more compelling than under the 5-agent design.

**Why not implemented now:** Fork Subagent requires changes to the Qwen Code core (`AgentTool`, `forkSubagent.ts`, `CacheSafeParams`). This is a platform-level feature (~400 lines, ~5 days), not a /review-specific change. When available, /review should be updated to use fork instead of independent subagents.

## Why the applied fix is audited by a scoped agent, not re-reviewed

Step 6B's rule — do not re-run Steps 1–6 to check your own work — is right, and its consequence was that `--fix` output shipped with no independent check at all. The mutation guidance in that step is addressed to the same agent that made the edit, and nothing checks whether it was followed. Meanwhile the fix round is the loop's largest single source of its own next round: a third of every post-first-round finding was introduced by the fix immediately before it (the #9578 measurement, below). The fix round was the one place the pipeline let a change through unread.

A full re-review of the edited tree is the wrong repair, and not only because the rule says so. It would produce a verdict about different code and let it stand as this review's; it would rediscover the findings just applied and re-file them as the fixer's; and it costs a whole round to reach a defect class that a bounded question reaches directly. The #9793 post-mortem names that class precisely. The fix's three intended sites were mutation-probed and every mutant was caught, and both Criticals the next round filed were still fix-introduced — a hand-picked `hops < 16` beneath a configurable `MAX_SUBAGENT_DEPTH_LIMIT = 100` nothing tied together, and a `callId`-only dedup written once one registry entry could newly host several runtimes. Neither was "a guard with no test". Both were **assumptions the edit newly made that nothing pinned**, and a probe of the sites the fixer intended to change cannot reach an assumption the fixer did not know it was making.

So the check is one agent whose whole brief is that question — for every applied hunk, name the assumption it introduces and say whether anything in the tree pins it; report only the unpinned — and four constraints keep it from becoming the re-review the rule forbids:

- **Its input is the applied hunks, never the reviewed diff.** `fix-delta` snapshots the working tree before the first edit (a tree object written through a throwaway index — the user's index and the shared stash stack are never touched) and diffs the tree against that record afterwards, with the review's own side files excluded by pathspec. An agent that has not seen the diff cannot rediscover the review's findings, and the brief declares `readsDiff: false` so the builder cannot hand it one.
- **It reports one thing.** Not the dimension set, not defects: an unpinned assumption, with the pin that would close it. Its brief carries none of the finder machinery — no finding format, no severity ladder, no Exclusion Criteria, no recall rule, no project review rules — because each of those is what turns a reader into a reviewer.
- **It produces no verdict, and its output never becomes an entry in the findings artifact.** An unpinned assumption is a disclosure: it rides the affected finding's `outcomeNote` — persisted into the rebuilt artifact by `applyOutcomes` and deliberately round-tripped by `validateFindings` — and a terminal block, and nothing downstream — the verdict, the fix-induced census, the posted comments — reads that field. The one route by which the rule could be violated through the back door is closed by keeping the output out of the artifact's entry list — the one shape everything downstream reads — not by keeping it out of the file: a test enforcing "never enters the artifact" would strip `outcomeNote` and break the disclosure channel this same bullet mandates, while a change that starts rendering the field into posted comments removes the guarantee without adding an entry.
- **It is one call, bounded by what `--fix` edited.** The brief is budget-exempt because its load is the hunks, not the diff the ceiling is derived from, and it writes nothing: the tree it reads is the user's, with the fix in it, and a probe left there is the user's problem. A pin is quoted, not proven by mutation.

**What `fix-delta` will not certify.** The hunks are the audit's whole input, so the command's second job is to say when they are not the whole edit — the failure direction over-warns, and it never silences a blind spot. Four surfaces get that treatment. **Content the superproject tree cannot record**: a submodule or nested repository enters the tree as its gitlink alone, so an edit inside one moves nothing — the command probes each and records, per path it can answer for, a DIGEST of the state it found: the uncommitted entries AND the repository's identity (HEAD, branch, stash count). The first half makes "already dirty at snapshot time" a checkable claim rather than a boolean (a bare boolean let a level-2 gitlink that merely moved stamp its parent, after which a real edit inside the parent was filed as dirt that was already there); the second half is why clean paths carry a digest too — a fix COMMITTED or stashed inside a repository an ignored directory hides leaves its status empty at both moments and the superproject trees record nothing of it, and the moved identity is the one trace it leaves. Paths the probe cannot answer for at all — an unreadable directory, a repository whose status will not run, an ignored tree past the walk budget — are disclosed rather than assumed clean, and never enter the baseline. What the probe prunes it prunes by what a path IS, never by its name: the review's own worktrees are the repositories git's own `worktrees/` registry lists under the `review-pr-*` family, and a `git init` planted under that name, or a repository one level under a side-file family directory, is discovered and probed like any other — name-keyed pruning hid each of those from every probe route while the capture pathspec hid them from both trees. The same distinction reaches the capture: the families are excluded because the flow writes them UNTRACKED, so the tracked half of a family match is user content and is recorded after the exclusion has run. **Every spawn is pinned against the tree it measures**, the discipline `worktree.ts` states for its tripwire — the probe children inside discovered repositories and the outer `read-tree`/`add`/`write-tree`/`status`/`ls-files`/`check-attr` against the audited repository alike, since the audited repository's `.git/config` is the same writable surface one level up: `-c core.fsmonitor=`, because `core.fsmonitor` runs a command from that config (measured: on git 2.43 `add`/`status`/`ls-files`/`write-tree` all executed a planted hook; on 2.55 `write-tree` alone did), and `--work-tree <path>`, because a repo-local `core.worktree` otherwise redirects the command at a pristine decoy. The one plant a pin cannot meet is a `core.worktree` in the audited repository that steers `rev-parse --show-toplevel` itself — the pin's own argument — so root derivation is GATED instead: the tree git names must contain the directory the command runs in, and a root that does not is refused, disclosed by the flow as `Fix audit: not run`. **Repo-local config that shapes the capture and the rendering** cannot be overridden the same way, so it is named instead: a `filter.<name>.clean` or `filter.<name>.process` decides what `add -A` stores for a path (a real edit absent from both trees, or bytes the worktree never held attested as an edit), `.git/info/exclude` and `core.excludesFile` drop a new file from the capture, and a `diff` attribute resolving to `-diff` or a driver turns a text fix's hunks into an opaque binary patch the auditor cannot read. Each is read fresh at BOTH moments — every one of these files is plantable between the snapshot and the `--since` — and printed on stderr beside the blind-spot lines; Step 6B has the orchestrator repeat every such line under the **Fix audit** heading, so the qualification is disclosed with the audit rather than certified past.

The audit is not gated on effort because the step it follows already is: an effective `--fix` floors the effort at medium, so no unverified pass ever reaches it. It sees only `fixed` outcomes — a finding reverted as wrong has no edit to audit — and it does not act on what it finds: pinning an assumption is another edit, and another edit is another audit. That half of the loop stays with the reader, which is where an edit to their working tree belongs.

## Measured incidents behind the SKILL.md rules

The blocks below are incident narratives moved out of SKILL.md (which is loaded into the orchestrator's context on every run). Each one is the story behind a rule that still lives there; the rule references it as `(measured; DESIGN.md — <title>)`.

### The approach that no finding could name

One change to `extractAndStripMeta` took three attempts across two PRs. #9097 (3 rounds, 18 findings) added a timeout to the vm call; #9136 (6 rounds, 56 findings) moved the walk inside the vm and ended up spawning a child process per call, growing 228 → 920 source diff lines. #9325 landed it in one commit by deleting the evaluation entirely and parsing the literal instead.

All 74 findings were individually correct. Each round found a real hole the previous patch did not cover. But every finding is anchored to a `file:line` in the current diff — so the review could say where the approach leaked, never that a different approach would retire all of the leaks at once. The fix that worked took all 74 findings with it.

`did not converge within the reverse-audit round cap` was emitted four times across the two PRs, filed as a coverage gap rather than as a conclusion about the change. The approach signal exists to state that conclusion to a human instead. See `docs/design/2026-08-17-review-approach-signal.md`.

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

### The probe residue an auditor almost filed

Reviewing PR #9118 at `662d98f1fa`, a round-5 reverse auditor read `compose-review.ts` in the shared review worktree while a Step 4 verifier had a probe live in the same tree: the file carried the probe's mutant, and a `__probe__.test.ts` sat beside it that no commit contains. The auditor came within a step of filing the residue as a Critical. It recovered by improvising a fallback no brief mentions — re-reading the evidence with `git show HEAD:` instead of from the working tree — and two other agents in the same run independently reported the contamination ("worktree contamination … act before further verification"). The final review was not corrupted, but only because three concurrent agents happened to notice and one of them happened to improvise correctly. Filed as #9207; the verifier's probes moved to their own worktree, and the fallback the auditor invented became a rule in every code-reading brief.

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

### The serial 3B convergence rounds

Two v0.21.9 CI reviews of large chunked PRs spent 77–80% of their wall clock inside the reverse-audit loop, not the fan-out. A 291-minute review ran its 28-agent fan-out in 63 minutes (22%) and then three serial reverse-audit rounds in 223 (round boundaries measured at +65, +134, +190 min); a 252-minute review ran six serial rounds of ~30–37 minutes each. On 3B the rounds ran one at a time because the convergence pair — rounds 1 and 2 launched together, which the 3A path already uses to collapse two serial rounds into one wall — was 3A-only. Its arithmetic is per-territory, not whole-diff: a chunk dry in round 1 leaves its slice of the cumulative list unchanged, so that chunk's round-2 auditor re-runs substantively the same audit — the independent-rerun-paid-as-dependent shape the 3A pair removes, present on every chunk. Pairing rounds 1 and 2 on 3B launches each chunk's two establishing auditors together, saving one round's wall (~30–56 minutes measured) off every chunked review, at the same one-round suppression window the 3A pair and the pipelined loop already accept. The saving is bounded by the agent pool's concurrency: where the pool holds both rounds' auditors it is a full round, and where it does not the doubled launch is still never worse than the two serial rounds it replaces — ceil(2C/N) waves against the serial shape's 2·ceil(C/N), for C chunks on an N-slot pool, and the first never exceeds the second. The deadline gate prices the pair by the same waves: a round-2 build admitted while round 1 is still in flight pays both members' wall, so near the deadline the pair is refused as one unit and degrades to round 1 alone, instead of being committed at one round's price for up to two rounds' wall. The pair leaves one conservative mark on the ledger: rounds 1 and 2 are stamped seconds apart at the pair's start, so after the pair returns, the span from round 2's stamp to the next admission covers the pair's whole wall, and every solo round after it prices at up to twice its true cost — near the deadline the loop can stop a round earlier than the serial shape would have. Accepted: an over-priced gate refuses a round that would have fit — a capped verdict that posts — never the killed-before-compose shape it exists to prevent.

### The rounds a rejected finding bought (PR #8353)

The 15th review round of #8353 (its audit rounds numbered 1–5 within that run; `R15-1` is the incremental-review ledger's naming, not an audit round): audit round 2 dry; round 3's sole finding rejected by its verifier with direct counter-evidence — the claimed compound behavior lived entirely in unchanged code. The rejection removed the entry from the cumulative list, but not the reset it had already applied to the dry counter. Under the forward pairing the rule licenses, round 4's dry return completed the two-dry evidence the moment it landed — the retired round 3 plus dry round 4 — and round 5 (~15–20 minutes) was the waste: it audited nothing the loop had not already answered.

### The artifact root that pointed at qwen-home

Every one of six measured CI reviews (2026-08-05/06) spent 1.5–3 minutes at Step 8 rediscovering the same fact: `save-artifact` resolved its containment root from `QWEN_CODE_PROJECT_DIR`, and that variable does not name the main checkout in any environment — the harness exports it as `Storage.getProjectDir()`, the session-storage directory under the runtime base where the harness's own transcripts live. The helper refused its own inputs ("must be inside the workspace"), and each orchestrator improvised a different workaround: one overrode the env var to the repo, one copied the inputs into the qwen-home mirror and copied the artifact back, others retried path shapes until one landed. The env preference was wrong 100% of the time it was consulted; the command's cwd — the main checkout, where the skill runs every subcommand — was right in every measured run.

### The one-command-per-turn tail

Measured across the same six CI reviews: the post-verdict bookkeeping — Markdown report, cost-ledger, save-artifact, `record_artifact`, the incremental-cache write, cleanup — ran one command per model turn, 4–6 minutes of wall clock after the review's outcome was already decided (and, on posting runs, already on the PR), stretching past 7 minutes when the qwen-home fumbling above joined it. Every command in the tail is cheap; the turns are not — the same arithmetic that batches the Step 1 setup calls, unapplied to the other end of the run.

### The forty-one minute wave

Two measured runs of the same 14-agent Step 3A fan-out, on diffs of comparable size, took 11.7 and 41 minutes — and the wave's wall clock is its slowest agent, so the whole review inherited the difference. The slow wave's tail was not review depth: individual agents spent 40-100 model calls exploring the tree (the pattern a sibling PR had already named as the next optimization target), while healthy agents on the same class of diff settle at 25-45 calls with indistinguishable findings. The budget that answers this is soft on purpose: a hard cap would convert the pathology into silent truncation, so the brief tells the agent to stop exploring at the ceiling, file what it holds, and disclose the checks it did not get to — the disclosure lands in the same receipt machinery that already judges whiffs.

### The six-hour timeouts

A survey of one recent CI window found 26 review-pr jobs timing out — ~122 hours of compute, zero posted, several the same PR retried and re-timed-out. The wall clock is model inference, not code execution: at the orchestrator level 82-88% of it is spent inside subagents, and inside a subagent ~81% is model turns (reading the diff, reasoning) — the one shell-heavy agent is Build & Test. So the timeout driver on a huge PR is the sheer volume of model work: dozens of finder and chunk agents reading a 4,000-5,300-line diff, then a reverse-audit loop whose every round re-reads that diff against a growing findings list (~90 min a round). Five rounds alone (450 min) exceed the six-hour ceiling before the fan-out is counted.

The elastic budget answers this at the size band where the review otherwise posts nothing. `reverseAuditRounds` drops from five to three for a huge diff (effective ≥ 3000 lines) — one audit round above the convergence floor of two, since the all-dry rounds-1-and-2 shape reaches CONVERGED under any cap of two or more (the convergence check runs before the round-cap gate); the extra round buys hot chunks one more pass before the cap — and `specialistCap` sheds Agent 8 to zero there, because an Agent 8 whole-diff pass on top of the base fan-out is the marginal cost that tips a too-big review over the wall while the per-chunk fan-out already covers the ground. Neither drops a required dimension: the reverse audit still runs, and Agent 8 was never a required agent. In a time-budgeted CI run the deadline gate already refuses a round that will not fit; this static cap is the belt it works under and the only bound a local run has. The cap refusal writes a marker `compose-review` caps the verdict on, so a non-converged stop at the cap discloses like a budget stop rather than resting on the orchestrator's relay.

### The killed-before-compose tail (PR #8687)

A 4,269-line, 21-file cross-worktree git guard — a security PR whose adversarial surface is near-unbounded — ran its reverse audit to a **correct** budget stop: the deadline gate refused round 3 with ~110 minutes and the whole reserve in hand, exactly as designed. Then the run died anyway, and posted nothing, holding ~20 E2E-confirmed Critical bypasses. The tail after the stop was the killer: a single hand-rolled verification agent re-running a 15-family shell/git bypass battery — each family spun up a temp git repo and executed real payloads — consumed the entire remaining budget, and the outer wall hit mid-verification, before compose-review ever ran.

The reserve was sized (#8368) as one number covering "verification + compose + submit," which is correct for a normal tail where verification is a per-finding re-trace. It is wrong for a security PR, where verification cost scales with the finding count AND with a per-finding cost that has no bound — real filesystem E2E — while compose and submit stay bounded (one CLI call, a handful of `gh` calls). So the two must not share one undifferentiated reserve: a distinct, smaller **compose floor** is carved out, and the verifier — not the reverse-audit builder — is gated on it. Below the floor `agent-prompt --role verify` refuses to build, the findings keep their `— [unverified]` tag for compose-review to cap, and compose runs. The prose half closes the bypass the gate cannot see: the tail's verification goes through the gated builder, never a hand-rolled `agent`, and no fresh re-verification pass is invented for findings already confirmed. Compose and submit are non-negotiable; a review that stops verifying still posts everything it proved.

### The divergence the static finders could not see (PR #8687)

The same guard is an **abstract interpreter of bash**: it re-implements how a shell resolves `git`'s working tree so it can deny a cross-worktree mutation before the shell runs it. A guard shaped like that has a defect class the fixed dimensions do not name. The `/review` run (qwen3.8-max) found real bugs by the dozen — but they clustered on the **token/syntax layer**: a comment token that swallows the command, a glob, a redirect that aborts a flag loop, an `-oc` bundle. An independent reviewer (gpt-5.6-sol) filed a different layer entirely, and every finding was one shape: **state-propagation divergence**. A shell function runs in the current shell, so its `cd` and its `export -f` survive the call; a command substitution inherits `set -a` but does not propagate its mutations out; a function named `git` shadows the program and must resolve before the built-in dispatch. The guard's recursive evaluator modeled each boundary and got the _propagation_ wrong — computed a nested body's post-state and discarded it, initialized a nested scope to a default instead of inheriting, dispatched the built-in before consulting a shadowing definition — so a later path-free `git` was judged against a cwd the real shell had already left, and the mutation was allowed.

Two properties made this class invisible to the finders and not to the outside reviewer. First, it is **non-local**: the bug is a value dropped at one call site and the harm is a check that fires stale at another, and on a 4,269-line evaluator the two sit chunks apart — a line-by-line walk sees a plausible `nested.cwdAfter` return and a plausible later check, and nothing links them. Second, it needs a **differential oracle**: you cannot see that the model diverges from bash unless you know precisely what bash does at that boundary, and a model asked to hold all of bash's scoping semantics in its head will not — but a model that _runs_ the payload against real bash and traces the same payload through the guard sees the two disagree. The verifier already had that oracle (it probes, it A/Bs); the finders did not, and discovery-by-execution is exactly what this class needs, so the oracle belonged upstream of a finding, not only downstream of one.

The fix is two briefs, not a new agent — the lens goes where an agent already reads. Agent 2 (Security) gains the **model-of-EXECUTION divergence** bullet, distinct from its existing second-parser (syntax) bullet: enumerate the boundaries where the modeled system carries state across a call, name what the real system propagates or isolates that the model does not, and — when the boundary is subtle — build the payload, run it against real bash/git, trace it through the model, and file the divergence with both observed behaviours. That reaches the 3A dimension fan-out, where Agent 2 walks the whole diff. On a 3B territory fan-out Agent 2 does not run (the roster launches chunk agents and the test matrix, not role 2) — but when the manifest declares the diff a modeled executable system, `buildChunkAgentPrompt` attaches the same lens (`MODELED_SYSTEM_EXECUTION_LENS`, one source for both topologies) to each chunk agent, scoped to its territory, so the within-territory half is covered on both. The cross-chunk contract — a divergence whose add and check sit in different chunks — still falls to the reverse-audit layer receipts and the cap, with invariant-c as a heavy-file backstop. The lens itself now names two bug shapes: state DISCARDED across a call boundary, and state that only ACCUMULATES (an add-only map of definitions or options the real system can remove with `unset -f`/`unalias`/`set +a`) — the second added after a review of the guard found its `definedBodies` map gained entries but modeled no removal. The cross-chunk half is the whole-file invariant checklist: invariant-c gains the **recursive-evaluator state-return contract** — enumerate every state the real system threads across a recursive boundary and every recursive call site, and check the caller merges back exactly what the real system propagates and isolates exactly what it isolates. It is the early-return failure one level up: state computed, then dropped by a caller that never reads the return. As a whole-file agent invariant-c runs only on files the diff rewrote heavily enough to trip the invariant checklist — a modeled-system file that grew incrementally may not, so the cross-chunk contract ultimately backstops on the reverse-audit layer receipts and the deterministic cap below, not on invariant-c alone. Neither edit adds a role, so neither can be shed by the budget on the huge diffs where this class lives — the mistake Agent 8 would have made, since `specialistCap` is zero above the huge-diff floor precisely here. What the finders lacked was never the lines; it was the question, and the oracle to answer it with.

The question also needs a stop rule that respects it. The reverse audit converges on "two consecutive dry rounds" — no auditor found a new gap — which is sound evidence about the layer the auditors walked and silent about every layer they did not. On this guard the token layer filled every round while the state layer went unexamined, and a dry round on the token layer said nothing about it, so the loop could converge with a whole class untouched. The auditor brief now asks, for a modeled executable system, that each defect layer be walked and **receipted on its own line** — `Layer walked: <id>` — the `Budget gap:` discipline, a line the tooling reads rather than prose it guesses at. `audit-layers.ts` parses those receipts into per-layer coverage; a run that receipts `lexing` and `expansion` but never `scope-propagation` has named its own blind spot. Empirically the receipt requirement changes the model's behaviour on the target model: on a synthetic evaluator with a planted state-propagation defect, the same qwen3.8-max auditor emitted **zero** layer receipts under the old brief and a full **six** under the new one, walking (and filing findings against) the `resolution-order`, `inheritance`, and `toctou` layers a flat "find gaps" pass left untouched.

Coverage feeds a cap, not the stop rule — deliberately, and this is where the change stops for now. `layerAuditGate` (in `compose-review`, model out of the loop like `scriptLintGate`) reads the reverse-audit returns and emits one `unreviewedDimensions` entry per unwalked layer, which caps a would-be Approve to Comment and discloses the gap. It is **opt-in and inert by default**: it fires only when a `.qwen/review-context.json` matching rule — read from the trusted base branch — sets the `modeled-executable-system` domain on the diff, so no ordinary review is touched, and it rides an existing manifest field rather than the strict context schema. And it moves in one direction only: it can **withhold** an Approve, never end the audit loop early, never block a Request changes, never retire a chunk. Making an unwalked layer actually _extend_ the loop — turning "two dry rounds" into "two dry rounds AND every declared layer walked" — is the larger, riskier half, and it is staged behind an A/B on real modeled-system PRs rather than shipped on this reasoning: a stop rule that never converges is a worse failure than one that stops a layer early, and the measured evidence that discriminates them does not exist yet. The cap is the safe increment that makes the coverage visible and consequential while that evidence is gathered.

### The read-only claim retracted in round 2 (PR #8225)

A maintainer-dogfood round-1 finding asserted head-comment leakage against the text the tool actually scans, written from a reading of the code. Round 2 swept all 434 real `run:` step bodies in the repo through the tool and measured that claim's coverage at **zero** — true of workflow files, false of the extracted text the tool operates on — and the round-2 review had to open with a public correction: "I asserted it without verifying." The same sweep, in the same pass, gave the surviving findings their scale (195 of 434 real step bodies affected): one measurement both retracted the unexecuted claim and armed the executed ones.

### The mirrored oracle's false positives (PR #8225)

Two sweeps in the same dogfood series manufactured findings out of their own bugs: a round-2 sweep unconditionally filtered `set -e` lines and reported four leaks that were not there, and a round-7 differential oracle misread a shell continuation line as a command position and reported one miss that was not one. Both oracles were reimplementations of the logic under test — a mirror of the implementation shares its blind spots. The round-7 fix handed adjudication to bash itself, and the false red vanished; that is why a sweep's oracle must be an external authority, and why a nonzero count is spot-checked by reading one hit before it is quoted.

### The inherited tool surface

`AgentCore.prepareTools` has two branches. A subagent type that declares a `tools` list is built with `getFunctionDeclarationsFiltered(allowedNames)`; a type that declares none inherits everything — `getFunctionDeclarations({ includeDeferred: true })`, deferred tools included. The comment above that branch states the reasoning: subagents are one-shot, so they "don't have the same 'save tokens' lifecycle as the main chat."

That premise does not hold for a review. A review names 13-14 subagents, each runs several turns, and a tool block is re-declared on every one of them. `general-purpose` — the type the skill mandated — is the only builtin that declares no `tools`; `Explore` declares seven and `statusline-setup` three.

Measured with a recording endpoint, on a 6-file / 115-line diff, driving one real dimension agent (1a) end to end through its four turns — read brief, read diff page 1, read diff page 2, report. The three arms differ only in `subagent_type`; same fixture, same launch prompt, same isolated `QWEN_HOME`, and the orchestrator's own turns are identical across all three:

| `subagent_type`                        | tools declared | tokens/turn | delivered |
| -------------------------------------- | -------------- | ----------- | --------- |
| `general-purpose` (inherit everything) | 51             | 21,178      | 139,013   |
| deferral applied to subagents          | 10             | 7,758       | 84,537    |
| `review-agent` (explicit list)         | 6              | 3,447       | 55,897    |

Of the 51 measured at the time, thirty-five were `computer_use__*` desktop-automation schemas, 11,011 tokens per turn on their own. Across a 13-agent roster the difference between the first and last row is ~1.08M prompt tokens on a 115-line change.

The per-turn record behind the first and last rows, so the totals above can be re-derived rather than taken on trust — `system` + `messages` + `tools` is that turn's whole prompt:

| turn | what the agent did | `general-purpose` sys / msgs / tools | `review-agent` sys / msgs / tools |
| ---- | ------------------ | ------------------------------------ | --------------------------------- |
| 1    | read the brief     | 5,286 / 3,623 / 21,178               | 5,357 / 504 / 3,447               |
| 2    | read diff page 1   | 5,286 / 6,349 / 21,178               | 5,357 / 3,230 / 3,447             |
| 3    | read diff page 2   | 5,286 / 10,609 / 21,178              | 5,357 / 7,490 / 3,447             |
| 4    | report             | 5,286 / 12,576 / 21,178              | 5,357 / 9,457 / 3,447             |

The 83,116-token gap decomposes exactly: tool declarations 4 × 17,731 = **70,924**, the skills catalogue 4 × 3,119 = **12,476**, and the system prompt −284 (this agent's is marginally longer than `general-purpose`'s).

The middle row is the alternative that was measured and rejected: making the deferral that trims the orchestrator apply to subagents too. It saves less, because deferral is not designed to go below the core tool set — it holds back MCP and low-frequency built-ins and declares the ~14 core tools regardless, so a subagent would still carry `skill`, `tool_search`, `notebook_edit` and the rest. An explicit list goes under that floor.

The catalogue line above is the second-order half, and it is **15%** of the gap — a sixth, not the 3.7% a per-turn-against-a-four-turn-total reading gives. Omitting `SKILL` means `willHaveSkillTool()` no longer injects the skills catalogue into the agent's first user message; that message is 3,119 tokens lighter (504 against 3,623), and because the first message is re-sent on every subsequent turn the saving is charged four times, not once. Any per-turn figure in this section is charged per turn.

It is also the smaller change: applying deferral to subagents would alter every `tools: ['*']` config in the way that branch's own comment warns about, while a review-specific type touches nothing outside the review.

One argument for that ordering was checked and does **not** hold, and is recorded here because it appeared in an earlier draft of this section: a subagent revealing a deferred tool does not pollute the orchestrator. `rebuildToolRegistryOnOverride` builds a fresh registry per launch and rebinds `getToolRegistry` on the override config, so `revealDeferredTool` mutates a launch-scoped registry that cannot reach the parent's declarations or its prompt-cache prefix. The rejection rests on the measurement and the blast radius, not on cache pollution.

What the closed list gives up, since the numbers above are only the saving side. `getFunctionDeclarationsFiltered` drops unknown names silently and declares any name it does resolve, so nothing here is free either way — naming a deferred tool would cost its schema, not zero. Against the inherited surface a review part loses: `agent` (`prepareTools` special-cases it and nesting is allowed by default, so this is a real removal — review parts are leaf workers, and a nested fan-out is findings the orchestrator never collects); `web_fetch`, 652 tokens/turn, which the verifier brief's "corroborate via the vendor's own tracker" used directly and now reaches only through what `run_shell_command` can call; and every discovered MCP tool, which matters when a project's own `## Code Review` rules name one. `lsp` is not in the list of losses — it was not in the inherited surface measured here either. Restoring any of them is a per-role question, and a per-role type would add its own description line to the Agent tool declaration in every session, so it is not free at the other end.

Two adjacent findings, neither introduced here and neither fixed here, both surfaced because this is the first shipped type with a restricted list. `coreToolScheduler`'s skill-activation reminder means to gate on whether the model can actually invoke a skill — its own comment says so — but it reads `toolRegistry.getTool(SKILL)`, and SKILL is registered unconditionally, so the gate is always true. A review part therefore still gets a reminder naming a tool it was never declared, and the announcement is marked consumed in the shared Config, so the orchestrator that does hold the Skill tool never learns the skill activated. Separately, `buildMcpServerInstructionsReminder` has no gate at all, beside a skills reminder and a deferred-tools reminder that both have one, so an MCP server's own `instructions` prose still rides in every part's first message and is re-sent every turn. Fixing either means changing what every subagent receives, not only a review's, so each belongs in its own change.

The capability that goes with the second-order saving should be named with it: dropping SKILL means a review part can no longer invoke a project skill at all — this repository ships 25 of them — so the 12,476 tokens are bought with that, not for free.

One consequence of the name. `SubagentManager.loadSubagent` resolves session > project > user > extension > builtin and builtin names are not reserved (`validation.ts` reserves only `self/system/user/model/tool/config/default/main`), so a user-authored `.qwen/agents/review-agent.md` shadows this entry for every launch a review makes. If theirs declares no `tools` the whole saving is gone with no diagnostic, and — because `deleteSubagent` checks `isBuiltinAgent(name)` before it checks level — their own file can no longer be removed through `/agents`. That precedence is deliberate and is how any builtin is customised; it is recorded here because `review-agent` is a likelier name for a user to have chosen than `Explore` or `statusline-setup`.

**How to re-run this measurement.** Every figure above is reproducible with commands this repository already ships — no private script, which is why none is committed. Two arms differ only in `subagent_type`; build the second by reverting the review-path sources to the merge base and bundling separately:

```bash
git checkout <merge-base> -- packages/core/src/subagents/ \
  packages/core/src/skills/bundled/review/ \
  packages/cli/src/commands/review/agent-prompt.ts \
  packages/cli/src/commands/review/agent-prompt.test.ts
npm run build:packages && npm run bundle && cp -R dist /tmp/ab/dist-base
git reset --hard HEAD && npm run build:packages && npm run bundle && cp -R dist /tmp/ab/dist-head
```

The test file is on that list for a reason that is easy to miss: it imports `REVIEW_BUILTIN_SUBAGENT_TYPE`, which the reverted core no longer exports, so leaving it at HEAD fails `build:packages` with TS2724 — and the `&&` then swallows the bundle step, leaving whatever `dist/` happened to be there before. Reverting the sources alone is not enough; anything that _references_ them has to go back too.

**Per-turn token counts** (the 21,178 / 3,447 / 55,897 figures) come from pointing the product at a recording OpenAI-compatible endpoint and tokenising each captured request body with cl100k. `qwen review agent-prompt --plan <plan> --roster` builds the launch prompt; one orchestrator turn launches one dimension agent, and the endpoint answers with that agent's own scripted `read_file` calls so it walks all four turns. What matters is that the record keeps the request **whole**: `qwen review mock-provider` truncates its record at 8 KB, which is smaller than a single tool block, so its log cannot be the source for these numbers.

**The environment is part of the measurement.** The 51-tool arm was the product default at the time, not a local quirk: 35 of the 51 were `computer_use__*`, and `tools.computerUse.enabled` defaulted to true. Run each arm under its own `QWEN_HOME` so a stray extension or skill cannot differ between them.

**Run-level figures** (688 vs 542 calls, 59.5M vs 29.5M input, the 95%/93% cache rates) need no harness at all — they are two real reviews of one PR, read back from the product's own ledger:

```bash
QWEN_HOME=/tmp/ab/home-<arm> QWEN_CODE_CLI=/tmp/ab/dist-<arm>/cli.js \
  qwen review run <pr> --json --approval-mode yolo
```

Give each arm a **fresh working tree and `QWEN_HOME`**. This is the step that is easy to skip and fatal to skip: `.qwen/review-cache/pr-<n>.json` makes a second run of the same PR an incremental re-review, so it would reuse the first arm's findings and the comparison would measure nothing. The cache file is also where each run records the `lastModelId` it actually used — worth reading back rather than trusting the settings that were meant to apply.

### The fix round that wrote the next round's findings (#9578)

Provenance analysis of six multi-round takeover pull requests attributed each post-first-round finding to the commit that introduced the line it anchors on. Roughly **a third** of them were introduced by the fix round immediately preceding the review that found them, and the dominant shape was a **guard or branch added with no test of its own**: the deterministic gate re-runs only the tests that exist, so an unwitnessed guard passes every gate, and its hole resurfaces as a new finding one round later. The loop is therefore not merely slow to converge — a measurable share of every round's work is work the previous round created.

The fix landed first on the loop side (#9578: the autofix agent must mutation-probe each new guard before it commits), and that half reaches exactly one fixer. The reviewer-side half has to reach all of them, because most pull requests are not fixed by a bot the review can configure: whoever fixes a finding — contributor, maintainer, or agent — reads only the comment. So the acceptance criterion moves into the finding itself (`fixWitness`) and into the posted comment: name the test that must go red if the fix is removed. A fixer told the criterion closes the hole in the round they are already working; a fixer not told it ships the guard and meets the criterion as a finding next round.

Two properties keep the rule from costing what it saves. It **never gates reporting** — a finding whose fix cannot be pinned is filed with `N/A`, because a bar on reporting would trade rounds for missed defects, and the reviewer's own evidence rule (`witness`) is the one that governs what confirms. And it is one sentence of ordinary prose at the end of the body, not a section: the comment budget is the scarce resource this review already trims the deferral list to protect.

### The three notes only a live stack surfaced (PR #9131)

A maintainer verification of PR #9131 built the PR head and the merge base, stood up one real `qwen serve` daemon, and drove both builds as arms of the same event stream. Its three non-blocking notes were all side effects of the harness, not products of reading the diff: the PR's new error toast could never render its own message (`formatError` returns `error.message` for every realistic failure, so the new fallback string was unreachable — observed as a bare "Failed to fetch" in the failure screenshot); the mutation bookkeeping grew without bound (`skillMutationsByCwd` appends every mutation, is never pruned, and the effect re-scans the whole array per event); and the reviewer test plan's step 3 was unreproducible through the UI (a session-less tab has no event stream at all — measured as zero `settings_changed` frames on both arms). Under the then-current brief a verifier who saw any of these was told not to look for new problems, and the observations had nowhere to go. The incidental-findings channel is that comment's practice made a rule: report what the run put in front of you, claim no verdict on it, and let a later round's verifier rule.

### The two fix-introduced Criticals (PR #9793)

A `--fix` round applied its findings, mutation-probed the three sites it had set out to change, and watched every mutant get caught. The next round filed two Criticals, and both were introduced by that fix: a hand-picked `hops < 16` bound below the configurable `MAX_SUBAGENT_DEPTH_LIMIT = 100` (`config.ts:1506`), which reintroduced the hang the PR had fixed, and a `callId`-only dedup written once the fix made one registry entry host several runtimes, which routed a user's approval answer to the wrong agent. Neither was a guard with no test. Both were assumptions the edit newly introduced that nothing in the tree pinned, and a probe of the intended fix sites — the only self-check the step ran — could not reach them. Step 6B's fix audit exists to ask, of every applied hunk, exactly the question that probe did not.

### The fix whose premises were wrong (#10153)

`fixWitness` pins the fix's **claim** — does the fix do what it says. Nothing pinned the fix's **premises** — the assumptions a fix newly introduces — and those are a different defect class that passes a `fixWitness`-grade check cleanly. Two Criticals on one merged nested-approval fix (#9793) were both of this class; both had a test that went red when the fix was removed, and both were still wrong. A hand-picked `hops < 16` lineage-walk cap sat below the user-configurable `MAX_SUBAGENT_DEPTH_LIMIT = 100`, so deep lineages silently reintroduced the very hang the fix was for — the test proved the bridge worked, not that the bound was right. And parking approvals from several runtimes onto one registry entry broke a `callId` uniqueness (`call_qwen_1` restarts per conversation) that dedup and resolve relied on elsewhere, so a user's answer was routed to the wrong agent — the test proved approvals parked, not that the key was still unique. The shapes are **a new constant that must respect an existing configured limit** and **a newly shared resource invalidating a uniqueness assumption held elsewhere**, and the agent that found each defect had already run the greps that would have named the fact, so carrying it costs close to nothing.

So the finding gains a second optional field beside `fixWitness`, carried the same way (`fixConstraint`): an existing fact the fix must not violate, with its source. Two properties differ from its sibling, and both are deliberate. It is **omitted when nothing was observed, never `N/A`** — `fixWitness` means something as `N/A` ("nothing to pin"), an absent constraint carries no information, and comment volume is a measured concern (#9177); the command drops the literal so the comment body can key on presence alone. And its evidence bar is the **`witness` bar, not the `fixWitness` bar** — quote the constant or give the `file:line`, or omit — because the failure costs are asymmetric: a wrong `fixWitness` is one test not written, a wrong constraint is confidently-stated misdirection the fixer will follow, so "be careful about concurrency" is forbidden in the field exactly as "this looks risky" is forbidden in the failure scenario. The field reaches the fixer who reads the posted comment, which is the loop with no other brake; the `--fix` path's own audit of a fix's premises is #10154. A fix that invents a new mechanism rather than following the suggested one is outside both.

### The floor that could not floor (#9659)

Rounds 17–23 of #9659 produced 31 new Criticals with near-zero false positives — the bot applied the written definition correctly — and new Criticals per round ran 7, 5, 3, 5, 4, 1, 6: a stable oscillation, not a decay. Of the ~25 the issue classified, about 6 were _certifies-falsely_ (a decided stop or a promoted anchor over bytes no round read); the other ~19 were _fails-closed_ corners on defenses added in earlier rounds (a sparse-checkout wedge, a dirty submodule pointer, a git 2.43 + skip-worktree + in-cone-deletion three-way), most of them zero-regression against the merge base. The convergence posture was engaged the whole time and could let none of them through, because its floor read one bit — `Critical` — that carried three decisions. The fix (#10291) is the `direction`/`baseline` fields and the one-combination deferral rule in the "Why a Critical is deferred by its axes" section above.
