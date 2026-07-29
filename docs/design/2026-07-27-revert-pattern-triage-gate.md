# Revert-pattern triage gate

Date: 2026-07-27
Status: Proposed
Area: CI triage — `.github/workflows/qwen-triage.yml`, `.qwen/skills/triage/`

## Problem

Small behavior-neutral maintenance PRs currently consume the same multi-stage
triage and model review capacity as behavior changes. The original proposal
(PR #7414) attempted to filter these out, but a maintainer measurement of the
live backlog showed only a ~2% hit rate — the feature targeted a near-nonexistent
problem.

Meanwhile, the repo has **111 revert commits** across its history (19 in July
2026 alone), and **61.5% of reverts occur within 24 hours of merge** — meaning
the problem is caught quickly but after it's already on `main`. The real cost
is not reviewing harmless PRs; it's merging PRs that have to be rolled back.

This design proposes a data-backed triage gate that targets the PRs that
actually cause reverts, not the ones that are already harmless.

## Data

### Methodology

Three-phase analysis of the repo's full revert history:

1. **Collection**: `git log --all --grep="^Revert "` found 111 revert commits.
   Each revert's body was parsed for `This reverts commit <hash>`, then the
   original commit was traced back to its PR via `gh api`. Result: 46 unique
   reverted PRs (59 reverts traceable to a PR number; 52 reverts only had the
   original commit title without a PR link).

2. **Enrichment**: For each reverted PR, extracted triage-time observable
   signals: touch scope (core/auth/providers/tools/services), diff size, review
   round count, bot Critical findings, CHANGES_REQUESTED cycles, merge→revert
   time gap, self-revert, E2E verification presence. 31 of 46 PRs were
   successfully enriched; 15 are deleted and inaccessible (HTTP 404).

3. **Control group comparison**: Sampled 60 recently-merged-but-not-reverted
   PRs and extracted the same signals. Computed precision (TP / (TP + FP))
   and recall for each signal.

Scripts and raw data (local analysis artifacts, not committed):
`.qwen/scripts/revert-analysis-*.mjs`, `.qwen/scripts/revert-data-*.json`,
`.qwen/scripts/revert-analysis-report-v2.json`.

### Signal precision and recall

| Signal                       | Precision | Recall | Reverted (n=31) | Control (n=60) |
| ---------------------------- | --------- | ------ | --------------- | -------------- |
| `touches_high_risk`          | **66.7%** | 32.3%  | 10              | 5              |
| `non_maintainer + high_risk` | **58.3%** | 22.6%  | 7               | 5              |
| `core + contested`           | **50.0%** | 19.4%  | 6               | 6              |
| `non_maintainer + core`      | 46.2%     | 38.7%  | 12              | 14             |
| `touches_core`               | 44.7%     | 54.8%  | 17              | 21             |
| `has_contested_pattern`      | 40.9%     | 29.0%  | 9               | 13             |
| `had_changes_requested`      | 40.7%     | 35.5%  | 11              | 16             |
| `non_maintainer`             | 39.6%     | 67.7%  | 21              | 32             |
| `large_diff_gt_200`          | 37.0%     | 54.8%  | 17              | 29             |
| `critical_count > 0`         | 28.6%     | 12.9%  | 4               | 10             |
| `fast_revert_24h`            | 100.0%    | 25.8%  | 8               | 0              |
| `self_reverted`              | 100.0%    | 9.7%   | 3               | 0              |

**Sampling caveat:** precision is computed on a 1:1.9 case-control ratio (31
reverted vs 60 control), while the repo's actual base rate is ~1.37% (46/3358).
Precision (PPV) is the metric most sensitive to this enrichment — the true
positive predictive value at the repo base rate is much lower (e.g. ~5% for
`touches_high_risk`). Sensitivity (recall) and specificity are invariant to
the sampling ratio and are the appropriate metrics for comparing signals.
The _ranking_ of signals by precision is still valid (it is monotone in the
likelihood ratio at fixed n), but the absolute values should not be quoted
to contributors as posterior probabilities.

`fast_revert_24h` and `self_reverted` have 100% precision but are
**post-merge signals** — they cannot be used as triage gates because they are
only observable after the PR is already merged and reverted. They confirm the
problem exists but don't help prevent it.

`critical_count > 0` was initially thought to be a strong signal (the bot
flagged the exact root cause in case studies like PR #6866), but after
correcting the regex to only match `**[Critical]**` tags (not the bare word
"critical" in prose like "no critical blockers"), the precision dropped to
28.6%. The bot is too trigger-happy with Critical findings — 16.7% of
control-group PRs also have Critical tags.

### High-risk path definition

The `touches_high_risk` signal checks whether any changed file matches these
subsystem patterns:

- `openaiContentGenerator` — streaming response parsing
- `streamingToolCallParser` — tool call stream parsing
- `geminiChat` — Gemini chat pipeline
- `acpConnection` — ACP process spawning
- `shell.ts` / `shellExecutionService` — shell tool execution
- `mcp-client` / `mcp-pool` — MCP server management
- `LspServer` — LSP server management
- `acp-integration` — ACP session integration
- `relaunch.ts` — desktop app relaunch lifecycle
- `sandbox.ts` — sandbox process management
- `electron-run-as-node` — Electron node-mode entry point (path match)

These are the paths where incorrect changes are most likely to cause
observable regressions that require reversion.

### Merge→revert time gap

Of 13 PRs with valid (non-negative, post-merge) gap data:

- Median: 4 hours
- Within 24h: 61.5%
- Within 72h: 84.6%
- Max: 97 hours

This confirms that revert-causing defects surface quickly after merge, but
the damage is already on `main`.

### Flip-flop PRs

8 PRs were reverted multiple times (revert → re-revert cycles), indicating
unresolved contention:

- PR #6754 (3 reverts), PR #6751 (3 reverts), PR #3433 (3 reverts)
- PR #6869 (2 reverts), PR #5668 (2 reverts), PR #3567 (2 reverts),
  PR #3478 (2 reverts), PR #5060 (2 reverts)

These flip-flop PRs are the highest-cost outcomes — they consume multiple
review rounds, multiple merge/revert cycles, and often require patch releases.

## Design

### High-risk path escalation

When a non-maintainer PR touches any high-risk path (see definition above),
Stage 1 triage escalates the PR to the deepest review tier instead of the
normal path. This does **not** block or close the PR — it ensures the full
`/review` pipeline runs with maximum agent coverage.

This is the strongest triage-time signal: 10 of 31 reverted PRs (32.3%
sensitivity) touched these paths, vs 5 of 60 control PRs (91.7% specificity;
Fisher p = 0.006).

Implementation: the Stage 1e skill text instructs the triage model to run
`gh pr view --json files | grep -E '...'` against the high-risk path patterns.
No workflow YAML change is needed — the detection runs inside the skill,
not as a separate workflow step.

### What this design does NOT do

- **Does not auto-close or auto-reject PRs.** The gate escalates review depth
  and recommends maintainer attention; it never blocks merge or closes the PR.
- **Does not use bot Critical findings as a signal.** The data shows 28.6%
  precision — the bot flags Criticals on 16.7% of safe PRs too. Criticals are
  too noisy to gate on.
- **Does not filter by PR size alone.** `large_diff_gt_200` has 37.0%
  precision — size without context is not predictive.
- **Does not require E2E verification for all PRs.** `no_e2e` is not
  discriminative — 100% of the control group also lacks E2E comments, so
  the signal cannot distinguish revert-prone PRs from safe ones.

## Comparison to PR #7414

|                     | PR #7414 (behavior-neutral)         | This design (revert-pattern)               |
| ------------------- | ----------------------------------- | ------------------------------------------ |
| Signal              | "diff is entirely behavior-neutral" | "touches high-risk paths"                  |
| Revert recall       | unmeasured (no reverts to compare)  | 32.3% (10/31)                              |
| Specificity         | n/a                                 | 91.7% (55/60)                              |
| Targets             | harmless PRs (cost: low)            | dangerous PRs (cost: high)                 |
| False positive cost | skips review on a useful PR         | escalates review depth (extra review time) |

## Files changed

- `.qwen/skills/triage/references/pr-workflow.md` — add the Stage 1e high-risk
  path checklist. The detection runs inside the triage skill (the model runs
  `gh api --paginate … | grep …` itself),
  so no workflow YAML change is needed.
- `scripts/tests/qwen-triage-workflow.test.js` — assert the high-risk path
  routing strings exist in the triage skill markdown.
- `.github/scripts/qwen-triage-workflow.test.mjs` — the same assertions in
  the node:test runner.

## Non-goals / follow-ups

- **Bot Critical refinement.** The current bot Critical detection is too noisy
  (28.6% precision). If the bot could distinguish "unresolved Critical" from
  "resolved Critical" (by checking whether the finding thread was marked
  resolved), the signal might become useful. This is a separate bot
  improvement, not a triage gate change.
- **Time-aligned control group.** The current control group is sampled from
  the 200 most recently merged PRs, but reverted PRs span 2025–2026. A
  time-aligned control group would give more precise false-positive rates.
  The `gh pr list` API doesn't support deep pagination, so this requires a
  GraphQL cursor-based fetch.
- **Recovering 15 deleted PRs.** 15 of 46 reverted PRs are deleted and
  inaccessible via the GitHub API. Their patterns may differ from the 31
  we could enrich. No recovery path exists — GitHub permanently deletes
  closed PRs in certain states.
- **Flip-flop detection as a real-time gate.** The current analysis detects
  flip-flops retrospectively (after multiple reverts). A real-time version
  would monitor for revert→re-revert patterns on `main` and alert maintainers.
  This requires a separate monitoring workflow, not a triage gate.
- **Expanding the high-risk path list.** The current list is manually curated
  from the reverted PR file paths. As the codebase evolves, new high-risk
  paths may emerge. A periodic re-run of the analysis scripts would keep the
  list current.
