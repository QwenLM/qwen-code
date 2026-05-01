# /review Design Document

> Architecture decisions, trade-offs, and rejected alternatives for the `/review` skill.

## Why 9 agents + 1 verify + iterative reverse, not 1 agent?

**Considered:**

- **1 agent (Copilot approach):** Single agent with tool-calling, reads and reviews in one pass. Cheapest (1 LLM call). But dimensional coverage depends entirely on one prompt's attention — easy to miss performance issues while focused on security.
- **5 parallel agents (original design):** Each agent focuses on one dimension. Higher coverage through forced diversity of perspective. Limited by combined Correctness+Security and a single undirected pass — recall ceiling left findings on the table that the user only discovered in subsequent /review rounds.
- **9 parallel agents (current):** 6 review dimensions (Correctness, Security, Code Quality, Performance, Test Coverage, Undirected) + Build & Test. Undirected runs as 3 personas in parallel.

**Decision:** 9 agents. The marginal cost (9x vs 1x) is acceptable because:

1. Parallel execution means time cost is ~1x (all 9 agents launch in one response)
2. Dimensional focus produces higher recall (fewer missed issues)
3. Three undirected personas (attacker / 3am-oncall / maintainer) catch cross-dimensional issues that a single undirected agent's prompt-induced bias would miss
4. The "Silence is better than noise" principle + verification controls precision

### Why split Correctness from Security

A single Correctness+Security agent has split attention — empirically one dimension dominates the output and the other is shallow. Different mindsets too: correctness asks "does this do what it intends," security asks "what unintended thing can a hostile actor make this do." Splitting forces both to get full attention.

### Why a dedicated Test Coverage agent

Test gaps are a systematic blind spot. Review agents focused on bugs in the new code itself rarely look at whether the change came with adequate tests. A dedicated agent that asks "what scenarios in this diff are untested?" catches misses no other dimension hits.

### Why three undirected personas instead of one or many

A single undirected agent has prompt-induced bias and tends to find the same kinds of issues across runs. Three personas — attacker / 3am-oncall / maintainer — force completely different mental traversals, and the union of findings is meaningfully larger than 1.5× a single agent.

Empirically, ensemble diversity drops sharply past 3-5 sampled paths. Three is the sweet spot: enough to break single-prompt bias, few enough that the marginal cost stays bounded.

## Why batch verification instead of N independent agents?

**Considered:**

- **N independent agents (original design):** One verification agent per finding. Each reads code independently. High quality but cost scales linearly with finding count (15 findings = 15 LLM calls).
- **1 batch agent (chosen):** Single agent receives all findings, verifies each one. Fixed cost.

**Decision:** Batch. The quality difference is minimal — a single agent verifying 15 findings has MORE context than 15 independent agents (sees cross-finding relationships). Cost drops from O(N) to O(1).

## Why reverse audit is a separate step, and why iterative

### Why separate from verification

- **Merge with verification:** Verification agent also looks for gaps. Saves 1 LLM call.
- **Separate step (chosen):** Reverse audit is a full diff re-read, not a finding check. Different cognitive task.

Verification is targeted (check specific claims at specific locations). Reverse audit is open-ended (scan entire diff for missed issues). Combining overloads one agent with two fundamentally different tasks, degrading both.

### Why iterative (multi-round)

A single reverse audit pass leaves whatever the reverse audit agent itself missed. Each new round receives the cumulative finding list from prior rounds, so it focuses on what's left undiscovered. Empirically, most PRs converge in 1-2 rounds; the 3-round hard cap prevents runaway cost on pathological cases.

### Why cap at 3 rounds, not unlimited

Diminishing returns. Past round 3, the marginal yield is low and a stuck-loop hazard rises (the model may fabricate issues to satisfy the "find more" framing). The "No issues found" termination already exits early on most PRs — the cap is a safety net, not the common path.

**Optimization preserved:** Reverse audit findings skip verification (across all rounds). The agent has full context, so output is inherently high-confidence.

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

- Linter warnings → terminal only, not PR comments
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

**Original behavior:** if Step 7 resolved verdict to `APPROVE`, the API event was submitted as `APPROVE` without any check on CI status.

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

## Why the deterministic checks live as `qwen review` subcommands

**Original behavior:** Step 9's three pre-submission checks (self-PR detection, CI status, existing-comment classification) and Step 11's cleanup were inlined in SKILL.md as `gh api` / `git` shell commands. The LLM ran each command itself, parsed the output, and applied the classification logic.

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

**Exception:** Autofix uses a blocking y/n because it modifies code — higher stakes require explicit consent.

## LLM call budget (variable, ~11-13)

| Stage                   | Calls             | Why                                                                 |
| ----------------------- | ----------------- | ------------------------------------------------------------------- |
| Deterministic analysis  | 0                 | Shell commands — ground truth for free                              |
| Review agents           | 9 (8)             | 6 dimensions + 3 undirected personas; Agent 7 skipped in cross-repo |
| Batch verification      | 1                 | O(1) not O(N) — batch is as good as individual                      |
| Iterative reverse audit | 1-3               | Loop until "No issues found" or 3-round hard cap                    |
| **Total**               | **11-13 (10-12)** | Same-repo: 11-13; cross-repo lightweight: 10-12                     |

The exact count depends on how many iterative reverse audit rounds run. Most PRs converge after 1-2 rounds; the cap prevents runaway cost.

Competitors: Copilot uses 1 call, Gemini uses 2, Claude /ultrareview uses 5-20 (cloud). Our 11-13 biases toward higher recall — the assumption is that "find more issues per round" is more valuable than minimizing per-run cost, because every missed issue forces the user into another `/review` iteration.

## Why cross-repo uses lightweight mode

CLI tools are inherently repo-local. Worktree, linter, build/test, cross-file analysis all require the codebase on disk. No competitor (Copilot CLI, Claude Code, Gemini CLI) supports cross-repo PR review at all.

Our lightweight mode is the best a CLI can do: GitHub API calls work cross-repo (`gh pr diff <url>`, `gh pr view <url>`, `gh api .../comments`), so LLM review and PR comment posting work. Everything that needs local files is skipped. This is strictly better than "not supported."

Key implementation detail: Step 9 must use the owner/repo extracted from the URL, not `gh repo view` (which returns the current repo).

## Why auto-discover tools from CI config instead of user configuration

**Considered:**

- **`.qwen/review-tools.md`**: Let projects define custom lint/build/test commands. Precise, but requires users to learn a new config format and maintain it.
- **Auto-discovery from CI config (chosen)**: Read `.github/workflows/*.yml`, `Makefile`, etc. to find what commands the project already runs in CI. Zero user effort.

**Decision:** Auto-discovery. Every project already defines its tool chain in CI config. Reading those files leverages existing knowledge without asking users to duplicate it. The LLM is capable of parsing YAML workflow files and extracting the relevant commands. Falls back gracefully: if no CI config exists, Step 3 is simply skipped and LLM agents still review the diff.

## Rejected alternatives

| Idea                                                         | Why rejected                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `.qwen/review-tools.md` for custom tool config               | Requires users to learn a new format. Auto-discovery from CI config achieves the same result with zero user effort.       |
| Use fast model for verification/reverse audit                | User requirement: quality first. Fast models may miss subtle issues.                                                      |
| Reduce to 2 agents (like Gemini)                             | Loses dimensional focus. Gemini compensates with deterministic tasks; we already have those AND want higher LLM coverage. |
| Auto-approve PR after autofix                                | Remote PR still has original code until push. Approving unfixed code is misleading.                                       |
| `mktemp` for temp files                                      | Over-engineering for a prompt. `{target}` suffix is sufficient for CLI concurrent sessions.                               |
| Mermaid diagrams in docs                                     | Only renders on GitHub. ASCII diagrams are universally compatible.                                                        |
| `gh pr checkout --detach` for worktree                       | It modifies the current working tree, defeating the purpose of worktree isolation.                                        |
| Shell-like tokenizer for argument parsing                    | LLM handles quoted arguments naturally from conversation context.                                                         |
| Model attribution via LLM self-identification                | Unreliable (hallucination risk). `{{model}}` template variable from `config.getModel()` is accurate.                      |
| Verbose agent prompts (no length limit)                      | 9 long prompts exceed output token budget → model falls back to serial. Each prompt must be ≤200 words for parallel.      |
| Relaxed parallel instruction ("if you can't fit 5, try 3+2") | Model always takes the fallback. Strict "MUST include all in one response" is required.                                   |

## Token cost analysis

For a PR with 15 findings:

| Approach                                            | LLM calls | Notes                                                |
| --------------------------------------------------- | --------- | ---------------------------------------------------- |
| Copilot (1 agent)                                   | 1         | Lowest cost, lowest coverage                         |
| Gemini (2 LLM tasks)                                | 2         | Good cost, medium coverage                           |
| Our design (5 agents, N verify)                     | 21        | 5+15+1 — too expensive                               |
| Our design (5 agents, batch verify, single reverse) | 7         | 5+1+1 — original design                              |
| Our design (9 agents, iterative reverse, current)   | 11-13     | 9+1+(1-3) — +50% cost for meaningfully higher recall |
| Claude /ultrareview                                 | 5-20      | Cloud-hosted, cost on Anthropic                      |

## Future optimization: Fork Subagent

> Dependency: [Fork Subagent proposal](https://github.com/wenshao/codeagents/blob/main/docs/comparison/qwen-code-improvement-report-p0-p1-core.md#2-fork-subagentp0)

**Current problem:** Each of the 11-13 LLM calls (9 review + 1 verify + 1-3 reverse audit rounds) creates a new subagent from scratch. The system prompt (~50K tokens) is sent independently to each, totaling ~550-650K input tokens with massive redundancy. The cost grew along with the agent count — Fork Subagent matters more under the current 9-agent design than under the original 5-agent design.

**Fork Subagent solution:** Instead of creating independent subagents, fork the current conversation. All forks inherit the parent's full context (system prompt, conversation history, Step 1/1.1/1.5 results) and share a prompt cache prefix. The API caches the common prefix once; each fork only pays for its unique delta (~2K per agent).

```
Current (independent subagents):
  Agent 1: [50K system] + [2K task]  = 52K
  Agent 2: [50K system] + [2K task]  = 52K
  ...× 11-13 agents                 = ~570-680K total input tokens

With Fork + prompt cache sharing:
  Cached prefix: [50K system + conversation history]  (cached once)
  Fork 1: [cache hit] + [2K delta]   = ~2K effective
  Fork 2: [cache hit] + [2K delta]   = ~2K effective
  ...× 11-13 forks                  = ~50K cached + ~22-26K delta = ~72-76K total
```

**Additional benefits for /review:**

- Forked agents inherit Step 3 linter results, PR context, review rules — no need to repeat in each agent prompt
- SKILL.md workaround "Do NOT paste the full diff into each agent's prompt" becomes unnecessary — fork already has the context
- Verification and reverse audit agents inherit all prior findings naturally
- Agent 6 personas can fork from a shared diff-loaded base, paying only the persona-framing delta

**Estimated savings:** ~85-90% token reduction (~620K → ~75K) with zero quality impact. The savings ratio is now even more compelling than under the 5-agent design.

**Why not implemented now:** Fork Subagent requires changes to the Qwen Code core (`AgentTool`, `forkSubagent.ts`, `CacheSafeParams`). This is a platform-level feature (~400 lines, ~5 days), not a /review-specific change. When available, /review should be updated to use fork instead of independent subagents.
