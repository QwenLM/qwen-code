# /review Design Document

> Architecture decisions, trade-offs, and rejected alternatives for the `/review` skill.

## Why 12 agents + 1 verify + iterative reverse, not 1 agent?

**Considered:**

- **1 agent (Copilot approach):** Single agent with tool-calling, reads and reviews in one pass. Cheapest (1 LLM call). But dimensional coverage depends entirely on one prompt's attention — easy to miss performance issues while focused on security.
- **5 parallel agents (original design):** Each agent focuses on one dimension. Higher coverage through forced diversity of perspective. Limited by combined Correctness+Security and a single undirected pass — recall ceiling left findings on the table that the user only discovered in subsequent /review rounds.
- **9 parallel agents:** 6 review dimensions (Correctness, Security, Code Quality, Performance, Test Coverage, Undirected) + Build & Test. Undirected runs as 3 personas in parallel.
- **10 parallel agents:** The 9-agent design plus Issue Fidelity & Root-Cause Ownership, which compares linked issue evidence against the PR's claimed fix before accepting a client-side change.
- **12 parallel agents (current):** The 10-agent design with Correctness split into three procedural walks — 1a line-by-line scan, 1b removed-behavior audit, 1c cross-file tracer — plus up to 2 optional diff-specialized finders (Agent 8) when one domain dominates the diff.

**Decision:** 12 agents. The marginal cost (12x vs 1x) is acceptable because:

1. All 12 agents are submitted in one response and run concurrently up to the runtime's tool-call cap (default 10, `QWEN_CODE_MAX_TOOL_CONCURRENCY`) — wall time is bounded by roughly two waves at worst, still far below twelve sequential agents
2. Dimensional focus produces higher recall (fewer missed issues)
3. Three undirected personas (attacker / 3am-oncall / maintainer) catch cross-dimensional issues that a single undirected agent's prompt-induced bias would miss
4. Issue Fidelity prevents a common false approval mode: a PR can be internally well-tested while solving only the author's mistaken diagnosis, not the linked issue's original failure
5. The "Silence is better than noise" principle + verification controls precision

### Why split Correctness from Security

A single Correctness+Security agent has split attention — empirically one dimension dominates the output and the other is shallow. Different mindsets too: correctness asks "does this do what it intends," security asks "what unintended thing can a hostile actor make this do." Splitting forces both to get full attention.

### Why a dedicated Test Coverage agent

Test gaps are a systematic blind spot. Review agents focused on bugs in the new code itself rarely look at whether the change came with adequate tests. A dedicated agent that asks "what scenarios in this diff are untested?" catches misses no other dimension hits.

### Why a dedicated Issue Fidelity agent

Bugfix PRs often carry their own diagnosis in the PR body, but that diagnosis can be wrong. The linked issue's original reproduction, observed payload, expected behavior, and maintainer comments must be checked before judging whether the implementation is a real fix. The implementation deliberately keeps issue discovery out of `pr-context`: the Issue Fidelity agent fetches GitHub's closing-issue metadata with `gh pr view --json closingIssuesReferences`, then fetches relevant issue discussions with `gh issue view --json title,body,comments` (the `--json` form is required — it returns the issue **body**, which `--comments` alone omits). This keeps relevance judgment in the agent instead of baking fragile PR-body parsing into TypeScript. The agent runs only for PR targets — a local-diff or file-path review has no PR or linked issue, so it is skipped there (11 agents instead of 12).

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

Diff size is a bad proxy for review risk, because tests dominate it. Across this repo's last 40 merged PRs the median diff is **41% test code**, and 14 of the 40 are more than half tests. A gate on raw diff lines sends a change of 173 production lines that ships 489 lines of new tests into the territory fan-out, where the production code ends up owned by a single chunk agent — while under the dimension fan-out it would have been read by ten lenses (the diff-reading dimension agents: twelve minus Issue Fidelity and Build & Test).

Territory fan-out is worth it when there is a lot of _risky_ code to divide, not a lot of _lines_. So the gate is `srcDiffLines > 500`, with a second clause `diffLines > 3200` as an attention bound: past that point asking ten diff-reading lenses each to swallow the whole diff dilutes all of them, and the chunk topology's base cost (`ceil(diffLines / 400) + 4`, counting the whole-diff agents that read the diff — Build & Test reads none) crosses twelve about there. It is not a promise of fewer calls — a heavy file adds three invariant agents and a dominant domain up to two specialized finders — but of one accountable reader per line instead of ten diluted ones. On the 40-PR sample the second clause never fires; it exists for a changeset dominated by tests or generated files.

Re-gating moved 6 of those 40 PRs from 3B back to 3A and cost 22 extra agents in total across all 40 — about 5% — measured under the earlier 10-agent 3A roster; under the current 12-agent roster the same six PRs cost 2 more each, ~34 extra (~7%). It buys those six PRs ten review lenses on their production code instead of one.

Chunking itself is unchanged: the plan still tiles every line, tests and generated files included. Only the count of reviewers and their brief change. `heavy` is likewise restricted to `source` files — the invariant checklist asks about fields, timers, collections, and error taxonomies, and a rewritten test file has none of those.

### Why `plan-diff` exists

Step 3B's chunk agents are defined as "one per entry in `chunks[]`", and only `fetch-pr` produced a chunk plan. A local-diff review, or a cross-repo review in lightweight mode, therefore routed into a topology it had no chunk list for: no receipts, no tiling guarantee, and the orchestrator left to improvise line ranges. Two of the four review paths were promised a mechanism the skill could not deliver.

`qwen review plan-diff <diff-file>` reads a captured diff and emits the same `chunks[]`, `files[]` and topology counts. Redirecting `git diff` or `gh pr diff` to a file already bypasses the 30 000-char shell cap, so all four paths now share one code path. It cannot decide `heavy` — that needs a tree to read the post-change file from — so a bare diff gets chunk agents but no invariant agents.

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

- **`parse-args`** owns the grammar. Every previously-shipped parsing bug is a named row in its table-driven tests.
- **`compose-review`** owns event selection and body composition — the C/S table (counting body Criticals and discarded Suggestions), the event caps (cannot-tell existing Criticals, uncoverable chunks, unreviewed dimensions, context-unavailable), the downgrade carve-outs, and the clause composition. Its truth-table tests pin each shipped bug; writing them immediately caught one more instance of the class (all Suggestions discarded → S=0 → APPROVE). 422 recovery stops being a hand-derived recomposition: it is the same call with updated counts, so the "recompute may never upgrade the verdict" guarantee holds by construction.
- **`pr-context`** ends the fetch-prose chain at its root: review bodies render **in full** (a body-only blocker lives only there; a capped body names its review id so the tail stays fetchable one object at a time), and replied Critical threads are quarantined into their own section instead of settling into "Already discussed" — a reply alone never retires a blocker. The `gh` wrapper's `maxBuffer` rises to 64 MiB, closing the ENOBUFS that killed two subcommands mid-review on a comment-heavy PR.

What deliberately stays prose: everything judgment-shaped — what counts as a Critical, verification, the posting gate's authorization semantics, the angles. A truth table cannot decide whether a finding is real; it can guarantee that a real finding is never mislabeled, dropped by a downgrade, or approved past.

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

- **Always-full (original):** every `/review` runs the full pipeline. Right for a PR verdict; wrong for a 5-line pre-commit sanity check — 12 agents, sharded verification, and ≥2 reverse-audit rounds to re-derive what one reader could see in a single pass.
- **A `--quick` boolean:** two modes, but "quick" hides what is and isn't checked (rules? cross-file? build?).
- **Three levels (chosen):** **low** = one orchestrator pass over the chunk plan, hunk-visible bugs only, ≤8 findings. **medium** = the finder angles (1a, 1b, 1c, quality/altitude, performance, conventions) run **sequentially in the orchestrator's own context** — inline sequencing, not subagents, is what makes the level cheap — ≤12 findings. **high** = the full pipeline, unchanged.

**Guardrails, because a quick pass is recall-limited by construction.** "Quick pass" means **low and medium together** — they differ in depth (one diff pass vs. sequential finder angles; ≤8 vs. ≤12 findings) but share every guardrail below, because what the guardrails defend against is the same at both: findings that no verifier ever checked.

- Labeled **unverified**; no Approve/Request-changes verdict is emitted. A verdict is a claim the pipeline earns in Steps 4–5; a quick pass claims findings, not absence of findings.
- Never posts to the PR: `--comment` forces high, and a "post comments" follow-up after a quick pass is declined.
- Never consults or writes the incremental cache — otherwise a medium run's SHA would make a later high run report "No new changes since last review", silently converting a quick pass into a full-review verdict.
- Scope handling (worktree, diff capture, chunk plan) is identical at all levels. The levels change who reads the diff and what runs afterwards, never how the diff is obtained — the base-resolution and truncation traps do not care how fast the user wants the answer.

**Defaults:** PR targets → high (the product is a public verdict); local-diff / file-path targets → medium (the product is fast feedback; the closing tip advertises `--effort high`). Findings caps exist only at the unverified levels — at high effort, verification is the noise filter, so no cap is needed.

## LLM call budget

**Small diffs (≤ 500 source lines AND ≤ 3200 total diff lines, Step 3A, high effort) — typically 15-19 calls:**

| Stage                   | Calls               | Why                                                                                                                                                                                                                                      |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review agents           | 12 (+0-2)           | issue fidelity + 3 procedural correctness walks (1a/1b/1c) + security/quality/perf/tests + 3 undirected personas + build&test, plus 0-2 diff-specialized finders; cross-repo skips Agents 7 and 1c (10), non-PR skips Agent 0 (11)       |
| Sharded verification    | `ceil(F/8)`         | F = findings; typically 1-2; keeps each verifier's job small on high-finding reviews                                                                                                                                                     |
| Iterative reverse audit | 2-5                 | loop ends after two consecutive dry rounds; 5-round hard cap                                                                                                                                                                             |
| **Total**               | **~15-21 (~13-20)** | Row maxima do not co-occur on typical runs (~15-17 is common), but the honest sum of ranges is 15-21 same-repo, 13-20 cross-repo/local. **Low/medium effort: 0 subagent calls** — the inline pass runs in the orchestrator's own context |

**Large diffs (> 500 source lines OR > 3200 total diff lines, Step 3B, high effort) — `ceil(diffLines / 400)` chunk agents + `5..7` whole-diff agents + `3H` invariant agents (H = heavy files) + `ceil(F/8)` verify (F = findings) + `rounds × chunks` reverse audit.** The reverse audit dominates: it fans out one auditor per chunk per round, and the stop rule needs two consecutive dry rounds (hard cap 5). PR #6457 (5801 diff lines, 19 chunks, 1 heavy file) costs ~27-29 first-wave calls, then `19 × (2..5) = 38-95` reverse auditors — ~66-126 calls total depending on how long the audit keeps finding; ~70 is the clean-run floor, and the count scales with chunks and findings, not a fixed ceiling.

That is roughly 4x the small-diff budget, and it buys the thing the small-diff topology cannot deliver at that size: coverage. Ten dimension agents (the roster of the day; twelve now) on a 5801-line diff each read the same truncated 14% window (see "Why the diff is a file, not a command"), so nine of the ten calls were redundant reads of the same hunks. Nineteen chunk agents each read a distinct ~390-line territory, and every line of the diff has exactly one accountable owner. The comparison to make is not ~70 calls vs ~17: PR #6457 took **eight** review rounds at 12-14 calls each — over 100 calls — and was still surfacing Criticals in code that had been in the diff since the first commit.

Competitors: Copilot uses 1 call, Gemini uses 2, Claude /ultrareview uses 5-20 (cloud). Ours biases toward higher recall — the assumption is that "find more issues per round" is more valuable than minimizing per-run cost, because every missed issue forces the user into another `/review` iteration.

## Why the diff is a file, not a command

Agents used to be handed `git diff main...HEAD` and told to run it. Shell tool output passes through `truncateToolOutput` with `ShellTool.maxOutputChars = 30_000` and `keep: 'both'`, which allocates `threshold / 5` characters to the head and the remainder to the tail.

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

| Approach                                            | LLM calls            | Notes                                                                                                |
| --------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| Copilot (1 agent)                                   | 1                    | Lowest cost, lowest coverage                                                                         |
| Gemini (2 LLM tasks)                                | 2                    | Good cost, medium coverage                                                                           |
| Our design (5 agents, N verify)                     | 21                   | 5+15+1 — too expensive                                                                               |
| Our design (5 agents, batch verify, single reverse) | 7                    | 5+1+1 — original design                                                                              |
| Our design (9 agents, iterative reverse)            | 11-13                | 9+1+(1-3) — +50% cost for meaningfully higher recall                                                 |
| Our design (10 agents)                              | 12-14                | 10+1+(1-3) — adds issue-fidelity/root-cause gate                                                     |
| Our design (12 agents + effort levels, current)     | 15-19 high / 0 quick | 12(+0-2)+ceil(F/8)+(2-5) under 3A; low/medium run inline with no subagents — cost scales with intent |
| Claude /ultrareview                                 | 5-20                 | Cloud-hosted, cost on Anthropic                                                                      |

## Future optimization: Fork Subagent

> Dependency: [Fork Subagent proposal](https://github.com/wenshao/codeagents/blob/main/docs/comparison/qwen-code-improvement-report-p0-p1-core.md#2-fork-subagentp0)

**Current problem:** Each of the ~15-21 LLM calls (12-14 review + sharded verify + 2-5 reverse audit rounds) creates a new subagent from scratch. At ~52K per agent (50K system + 2K task), that is ~780K-1.1M input tokens with massive redundancy. The cost grew along with the agent count — Fork Subagent matters even more under the current 12-agent design than under the original 5-agent design. (Effort levels bound the cost from the other side: low/medium runs spawn no subagents at all.)

**Fork Subagent solution:** Instead of creating independent subagents, fork the current conversation. All forks inherit the parent's full context (system prompt, conversation history, Step 1/1.1/1.5 results) and share a prompt cache prefix. The API caches the common prefix once; each fork only pays for its unique delta (~2K per agent).

```
Current (independent subagents):
  Agent 1: [50K system] + [2K task]  = 52K
  Agent 2: [50K system] + [2K task]  = 52K
  ...× 15-21 agents                 = ~780K-1.1M total input tokens

With Fork + prompt cache sharing:
  Cached prefix: [50K system + conversation history]  (cached once)
  Fork 1: [cache hit] + [2K delta]   = ~2K effective
  Fork 2: [cache hit] + [2K delta]   = ~2K effective
  ...× 15-21 forks                  = ~50K cached + ~30-42K delta = ~80-92K total
```

**Additional benefits for /review:**

- Forked agents inherit PR context and review rules — no need to repeat in each agent prompt
- SKILL.md workaround "Do NOT paste the full diff into each agent's prompt" becomes unnecessary — fork already has the context
- Verification and reverse audit agents inherit all prior findings naturally
- Agent 6 personas can fork from a shared diff-loaded base, paying only the persona-framing delta

**Estimated savings:** ~88-92% token reduction (~780K-1.1M → ~80-92K) with zero quality impact. The savings ratio is now even more compelling than under the 5-agent design.

**Why not implemented now:** Fork Subagent requires changes to the Qwen Code core (`AgentTool`, `forkSubagent.ts`, `CacheSafeParams`). This is a platform-level feature (~400 lines, ~5 days), not a /review-specific change. When available, /review should be updated to use fork instead of independent subagents.
