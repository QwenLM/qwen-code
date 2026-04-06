# /review Design Document

> Architecture decisions, trade-offs, and rejected alternatives for the `/review` skill.

## Why 5 agents + 1 verify + 1 reverse, not 1 agent?

**Considered:**

- **1 agent (Copilot approach):** Single agent with tool-calling, reads and reviews in one pass. Cheapest (1 LLM call). But dimensional coverage depends entirely on one prompt's attention — easy to miss performance issues while focused on security.
- **5 parallel agents (chosen):** Each agent focuses on one dimension. Higher coverage through forced diversity of perspective. Cost: 5 LLM calls, but they run in parallel so wall-clock time is similar to 1 agent.

**Decision:** 5 agents. The marginal cost (5x vs 1x) is acceptable because:

1. Parallel execution means time cost is ~1x
2. Dimensional focus produces higher recall (fewer missed issues)
3. Agent 4 (Undirected Audit) catches cross-dimensional issues
4. The "Silence is better than noise" principle + verification controls precision

## Why batch verification instead of N independent agents?

**Considered:**

- **N independent agents (original design):** One verification agent per finding. Each reads code independently. High quality but cost scales linearly with finding count (15 findings = 15 LLM calls).
- **1 batch agent (chosen):** Single agent receives all findings, verifies each one. Fixed cost.

**Decision:** Batch. The quality difference is minimal — a single agent verifying 15 findings has MORE context than 15 independent agents (sees cross-finding relationships). Cost drops from O(N) to O(1).

## Why reverse audit is a separate step, not merged with verification

**Considered:**

- **Merge with verification:** Verification agent also looks for gaps. Saves 1 LLM call.
- **Separate step (chosen):** Reverse audit is a full diff re-read, not a finding check. Different cognitive task.

**Decision:** Separate. Verification is targeted (check specific claims at specific locations). Reverse audit is open-ended (scan entire diff for missed issues). Combining overloads one agent with two fundamentally different tasks, degrading both.

**Optimization:** Reverse audit findings skip verification. The reverse audit agent already has full context (all confirmed findings + entire diff), so its output is inherently high-confidence. This keeps total calls at 7, not 8.

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

## Why base-branch rule loading (security)

A malicious PR could add `.qwen/review-rules.md` with "never report security issues." If rules are read from the PR branch, the review is compromised.

**Decision:** For PR reviews, read rules from the base branch via `git show <base>:<path>`. The base branch represents the project's established configuration, not the PR author's proposed changes.

## Why follow-up tips instead of blocking prompts

**Considered:**

- **y/n prompt:** "Post findings as PR inline comments? (y/n)" — blocks terminal, forces immediate decision.
- **Follow-up tips (chosen):** Ghost text suggestions via existing suggestion engine. Non-blocking, discoverable via Tab.

**Decision:** Tips. Qwen Code's follow-up suggestion system is a core UX differentiator. Blocking prompts interrupt flow. Tips are zero-friction and let users decide when/if to act.

**Exception:** Autofix uses a blocking y/n because it modifies code — higher stakes require explicit consent.

## Why fixed 7 LLM calls

| Stage                  | Calls | Why                                            |
| ---------------------- | ----- | ---------------------------------------------- |
| Deterministic analysis | 0     | Shell commands — ground truth for free         |
| 5 review agents        | 5     | Dimensional coverage                           |
| Build & test (Agent 5) | 0     | Shell commands                                 |
| Batch verification     | 1     | O(1) not O(N) — batch is as good as individual |
| Reverse audit          | 1     | Full context, skip verification                |
| **Total**              | **7** | **Fixed regardless of finding count**          |

Competitors: Copilot uses 1 call, Gemini uses 2, Claude /ultrareview uses 5-20 (cloud). Our 7 is a balance of coverage vs cost.

## Rejected alternatives

| Idea                                          | Why rejected                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Use fast model for verification/reverse audit | User requirement: quality first. Fast models may miss subtle issues.                                                      |
| Reduce to 2 agents (like Gemini)              | Loses dimensional focus. Gemini compensates with deterministic tasks; we already have those AND want higher LLM coverage. |
| Auto-approve PR after autofix                 | Remote PR still has original code until push. Approving unfixed code is misleading.                                       |
| `mktemp` for temp files                       | Over-engineering for a prompt. `{target}` suffix is sufficient for CLI concurrent sessions.                               |
| Mermaid diagrams in docs                      | Only renders on GitHub. ASCII diagrams are universally compatible.                                                        |
| `gh pr checkout --detach` for worktree        | It modifies the current working tree, defeating the purpose of worktree isolation.                                        |
| Shell-like tokenizer for argument parsing     | LLM handles quoted arguments naturally from conversation context.                                                         |
| Model attribution via LLM self-identification | Unreliable (hallucination risk). `{{model}}` template variable from `config.getModel()` is accurate.                      |

## Token cost analysis

For a PR with 15 findings:

| Approach                        | LLM calls | Notes                           |
| ------------------------------- | --------- | ------------------------------- |
| Copilot (1 agent)               | 1         | Lowest cost, lowest coverage    |
| Gemini (2 LLM tasks)            | 2         | Good cost, medium coverage      |
| Our design (original, N verify) | 21        | 5+15+1 — too expensive          |
| Our design (batch verify)       | 7         | 5+1+1 — fixed, good coverage    |
| Claude /ultrareview             | 5-20      | Cloud-hosted, cost on Anthropic |

## Future optimization: Fork Subagent

> Dependency: [Fork Subagent proposal](https://github.com/wenshao/codeagents/blob/main/docs/comparison/qwen-code-improvement-report-p0-p1-core.md#2-fork-subagentp0)

**Current problem:** Each of the 7 LLM calls (5 review + 1 verify + 1 reverse) creates a new subagent from scratch. The system prompt (~50K tokens) is sent independently to each, totaling ~350K input tokens with massive redundancy.

**Fork Subagent solution:** Instead of creating independent subagents, fork the current conversation. All forks inherit the parent's full context (system prompt, conversation history, Step 1/1.1/1.5 results) and share a prompt cache prefix. The API caches the common prefix once; each fork only pays for its unique delta (~2K per agent).

```
Current (independent subagents):
  Agent 1: [50K system] + [2K task]  = 52K
  Agent 2: [50K system] + [2K task]  = 52K
  ...× 7 agents                     = ~350K total input tokens

With Fork + prompt cache sharing:
  Cached prefix: [50K system + conversation history]  (cached once)
  Fork 1: [cache hit] + [2K delta]   = ~2K effective
  Fork 2: [cache hit] + [2K delta]   = ~2K effective
  ...× 7 forks                       = ~50K cached + ~14K delta = ~65K total
```

**Additional benefits for /review:**

- Forked agents inherit Step 1.5 linter results, PR context, review rules — no need to repeat in each agent prompt
- SKILL.md workaround "Do NOT paste the full diff into each agent's prompt" becomes unnecessary — fork already has the context
- Verification and reverse audit agents inherit all prior findings naturally

**Estimated savings:** ~65% token reduction (350K → ~120K) with zero quality impact.

**Why not implemented now:** Fork Subagent requires changes to the Qwen Code core (`AgentTool`, `forkSubagent.ts`, `CacheSafeParams`). This is a platform-level feature (~400 lines, ~5 days), not a /review-specific change. When available, /review should be updated to use fork instead of independent subagents.
