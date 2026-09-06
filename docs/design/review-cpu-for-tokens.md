# /review: trade CPU for tokens (prompt-cache baseline + glue sinking)

**Status:** implemented & verified (2026-08-07) — workstream A closed by
measurement (no client change); workstream B shipped as `match-remote`,
E2E-verified through the skill (see `.qwen/e2e-tests/review-cpu-for-tokens.md`
— an untracked, machine-local run archive, not committed)
**Date:** 2026-08-07
**Scope:** `/review` token economy — two workstreams, one measurement-gated,
one deterministic.

## Problem

A high-effort PR review launches 17-23 model calls. DESIGN.md's token-cost
analysis prices that at ~880K-1.2M input tokens, dominated by a ~50K shared
prefix (system prompt + tool declarations + startup prelude) re-delivered once
per agent. Two ways to spend less without spending recall:

1. **Shared prefix / prompt caching.** Every review agent is a fresh
   `general-purpose` subagent. If the prefix they all share is byte-identical
   and the provider caches it, agents 2..N pay for the prefix once. The
   question is whether that is already happening, and if not, why.
2. **Glue sinking.** The pipeline's established direction (DESIGN.md —
   "deterministic halves as subcommands"; #8642) moves deterministic
   orchestrator judgments out of model turns and into tested subcommands.
   Most judgment points are already sunk; an inventory of what remains found
   one candidate worth taking.

Both workstreams keep the recall-first contract: nothing here changes what a
review covers or what evidence a verdict requires.

## Investigation findings

### The caching chain is already built end to end

- **Wire layer.** The DashScope provider already applies cache control
  (`addDashScopeCacheControl` in
  `packages/core/src/core/openaiContentGenerator/provider/dashscope.ts`):
  `cache_control: {type: 'ephemeral'}` on the system message, on the last
  message for streaming requests, and on the last tool declaration. Enabled
  by default (`enableCacheControl !== false`).
- **Response parsing.** The OpenAI-compatible converter reads both
  `usage.prompt_tokens_details.cached_tokens` and the top-level
  `cached_tokens` shape into `cachedContentTokenCount`.
- **Measurement.** `qwen review cost-ledger` already aggregates per-agent
  `input / cached / output / thinking` token counts from the harness's own
  transcript records — the same records `check-coverage` trusts. Step 8
  archives the ledger beside every saved report. No new instrumentation is
  needed to answer "is the cache hitting".

### The prefix should already be byte-identical across a fan-out

A review agent's request prefix, in wire order:

| Part               | Source                                                                                                                                                            | Varies across agents in one run?                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System instruction | builtin `general-purpose` template (static text) + non-interactive suffix + user memory + auto-memory (`buildChatSystemPrompt` in `agents/runtime/agent-core.ts`) | No — same template, same parent session                                                                                                                                                      |
| Tool declarations  | Parent registry copied into the per-agent override (`rebuildToolRegistryOnOverride`)                                                                              | No — same tool set, deterministic registry order                                                                                                                                             |
| Startup prelude    | `getInitialChatHistory` → date + platform + cwd + folder structure                                                                                                | No — all agents pinned to the same worktree (`working_dir`) or the same main checkout; folder structure is capped at 20 items, alphabetically sorted, and skips `node_modules`/`.git`/`dist` |
| Task prompt        | Per-agent block from `agent-prompt --roster`                                                                                                                      | **Yes — this is the tail, after the shared prefix**                                                                                                                                          |

The codebase already optimizes the prelude order for prefix caching ("Stable
parts first ... so prefix-caching servers retain the KV-cache", comment in
`getInitialChatHistory`), and forks already exist specifically to share a
byte-identical cache prefix. Review agents cannot be forks (they must return
findings inline), but they do not need to be: their prefix is structurally
identical already.

**Consequence:** the client side has no identified drift to fix. The open
question is empirical — does DashScope actually serve cache hits for this
shape on qwen3.8-max? That is a measurement, not a code change, and the
measurement exists (cost-ledger `cached` column). Candidate causes to
investigate if the baseline shows misses: server-side minimum cacheable size,
cache TTL vs. agent wall clock, concurrent first-write races across the
fan-out, or the `ephemeral` marker semantics on this endpoint. Several of
these live server-side and may need the model-service team's input.

### Glue inventory: one candidate survives

Walked SKILL.md step by step for remaining model-turn judgment points. Most
are already subcommands (parse-args, capture-local, fetch-pr, plan-diff,
load-rules, repo-context, agent-prompt, check-coverage, findings,
resolve-anchors, compose-review, presubmit, submit, script-lint, test-plan,
base-tree, test-delta, extract-step, save-artifact, cost-ledger, cleanup).
What remains:

| Residual judgment                                                                                                                                                          | Disposition                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step 1 remote matching** (pr-url: parse `git remote -v`, match host + owner/repo by exact segments; bare pr-number: pick the remote whose URL is the derived owner/repo) | **Sink.** Deterministic parsing with two shipped bug classes: a substring match once matched `shao/qwen-code` against a `wenshao/qwen-code` remote (reviewed one repo, posted to another), and a guessed owner/repo once stopped a review before it read any code. Prose rules with bug histories are exactly the class DESIGN.md moves into code. |
| Incremental-cache check (compare two JSON fields, three branches)                                                                                                          | Keep as prose — ~3 lines; sinking grows the prompt more than it saves (DESIGN.md: every subcommand is part of the prompt cost).                                                                                                                                                                                                                    |
| Step 3C angles, whiff checks, Agent 8 selection, dedup/pattern aggregation, open-Critical re-check, skipped-CI-check ruling                                                | Keep — semantic judgments; the pipeline's discipline is that heuristics feed agents, never rule for them.                                                                                                                                                                                                                                          |
| Step 8 report rendering                                                                                                                                                    | Keep — #8642 already batched the tail into four responses; the remaining prose is genuine prose (summary, output-language headings).                                                                                                                                                                                                               |
| Step 5 cumulative-findings merge                                                                                                                                           | Keep — mechanical-looking, but its inputs are verifier verdicts the orchestrator extracts from natural language; the mechanical half is one file edit per round.                                                                                                                                                                                   |

## Proposal

### Workstream A — cache-hit baseline (measurement first, gates any code)

Run one same-repo PR review at medium effort with the current build, read the
cost-ledger, and record per-agent `input` vs `cached`:

- **Hit rate high** (agents 2..N read most of the shared prefix from cache):
  no client change. Document the result in this design doc's history and in
  the DESIGN.md cost table, and close the workstream.
- **Hit rate low:** diagnose before changing anything. Order of checks:
  1. Confirm prefix identity empirically (capture two agents' first request
     bodies via the mock provider / HTTP trace; diff the prefix).
  2. If prefixes differ, find the drift and fix it (the table above is the
     suspect list).
  3. If prefixes are identical but no hits land, the question moves to the
     DashScope side (marker semantics, minimum size, TTL, concurrency) —
     raise with the model-service team before adding client workarounds.

No code is written for this workstream until the baseline picks a branch.

**Baseline result (2026-08-07, PR #8651, medium effort, frozen bundle of this
commit):** the hit-rate-high branch, decisively. Aggregated from the harness
transcripts (the same records `cost-ledger` reads): 12 agents, 184 model
calls, 12.87M input tokens, 12.0M cached — **93.3% of input served from
cache**. Two structural observations:

- **The prefix is byte-identical across the fan-out, empirically.** Every
  agent's first request prices at 34,250 ± 7 input tokens; three agents
  whose first request landed after an earlier agent's write read 30,311 of
  those tokens (88-89%) from cache. The shared prefix is ~34K tokens, and
  it is shared.
- **The cross-agent miss is a concurrent first-write race, not drift.** 11
  agents launch in one response; 8 of their first requests raced the cache
  write and paid full price for the prefix once each. Everything after the
  first call of every agent hits (the multi-turn history anchors). The race
  costs ~2% of the run's input tokens. A warm-up request before the fan-out
  could close it, but that is one extra model call and new mechanism for a
  ~2% token delta on an already-93% hit rate — rejected under
  simplicity-first. The fan-out's wall clock is worth more than the prefix
  write race.

**Workstream A closes with no client change.** The chain that produces this
(wire-level cache control, prefix-friendly prelude ordering, byte-identical
subagent prefixes) is already in place; the DESIGN.md "~880K-1.2M input
tokens" figure is raw re-delivered tokens, not billed cost — the cache
serves the bulk of it.

### Workstream B — `qwen review match-remote`

One new read-only subcommand owning the remote-resolution rule SKILL.md
currently carries as prose in two places (pr-url matching in Step 1, and
remote selection for bare pr-numbers).

**Interface:**

```bash
qwen review match-remote --owner <owner> --repo <repo> [--host <host>]
# prints the matched remote name on stdout; exits 6 when no remote matches
```

- Reads `git remote -v` and parses each URL structurally — the two shapes
  `git@<host>:<owner>/<repo>.git` and `https://<host>/<owner>/<repo>(.git)`.
- A remote matches only when its host equals `--host` (default
  `github.com`) AND its owner/repo (`.git` suffix stripped) equals the
  arguments, both compared case-insensitively as whole segments. Substring
  containment is exactly what shipped the wrong-repo bug; the parser never
  does it.
- Exactly one match → print its name, exit 0. Zero → exit 6 with `none` on
  stdout (the lightweight-mode signal). Multiple → print all, exit 7 with a
  `warning:` line; the orchestrator stops rather than picks (same rule as
  today's prose).
- Not a git repository / git unavailable → exit 1 (fail-closed, like the
  other gates).

**SKILL.md delta:** Step 1's two prose paragraphs (exact-segment parse, fork
layout, guessing prohibition) collapse to "run `match-remote`; a printed
name means worktree flow, exit 6 means lightweight mode". Net prompt size
is roughly neutral (measured from this PR's SKILL.md hunks: ~720 chars
added net) — the bash invocation and exit-code prose offset the removed
rule text; the win is determinism and tests, not size. `fetch-pr`'s
interface is unchanged (still takes `--remote`), and the lightweight-mode
branch keeps its current shape, so no other step moves.

**Tests:** table-driven, mirroring parse-args' suite style — the two URL
shapes, `.git` suffix, case-insensitivity, the `shao/qwen-code` vs
`wenshao/qwen-code` regression row, fork layout (origin = fork, upstream =
target), GHE host mismatch, multiple-match, zero-match, malformed remote
URLs. The bug history supplies the first rows.

**Host resolution for bare PR numbers:** a bare number has no URL to take
a host from, so Step 1 asks `gh repo view` for the repo's URL as well and
passes its authority as `--host`. `gh` resolves that URL through its own
default-host resolution — an operator-exported `GH_HOST` or, without one,
its auth config — so the matcher compares against exactly the host the
rest of the pipeline routes at. (The first cut omitted `--host` and let
the matcher inherit `GH_HOST` itself, assuming `gh`'s routing always came
from that env; `gh` also resolves a GHE host from its auth config alone,
and an operator using only that was compared against github.com and
hard-stopped at exit 6 — caught by this PR's own review.) With `--host`
omitted, the matcher's fallback is unchanged: an explicit flag wins, else
an operator-exported `GH_HOST`, else github.com.

### Files affected

- `packages/cli/src/commands/review/match-remote.ts` (new) + collocated
  test; pure parsing/matching core in `review/lib/remote-match.ts` + its
  table-driven test.
- `packages/cli/src/commands/review.ts` — registration + demand message;
  `review.test.ts` — the registration list.
- `packages/core/src/skills/bundled/review/SKILL.md` — Step 1 shrinks.
- `docs/design/review-cpu-for-tokens.md` — baseline results appended.

### Scope boundaries (explicitly out)

- No change to agent fan-out, rosters, briefs, verification, reverse audit,
  verdict computation, or posting.
- No incremental-cache subcommand, no report-rendering subcommand (see
  inventory).
- No per-agent effort or per-agent model overrides — a separate proposal
  (directions A/B in the token-economy discussion), not this one.
- No AST-level diff pre-digestion — needs its own A/B evidence first.

## Open questions

1. ~~**DashScope cache behavior on qwen3.8-max**~~ — answered by the
   baseline: yes, cross-request prefix hits are served within one API key's
   concurrent requests (93.3% of the run's input cached); the only gap is
   the concurrent first-write race on the fan-out's first requests, judged
   not worth a mechanism.
2. **Exit-code numbering** — the review subcommands already use 3
   (gate refusal / not covered), 4 (budget), 5 (converged) for
   structured outcomes; this doc claims 6 for "no matching remote" and 7
   for "several match", keeping 1/2 for error/misuse. Conflicts checked
   against the current suite; the implementation pins them.
