# Legacy Code Audit (`/audit`)

## Context

`/review` is built for increments: every step of its orchestration assumes a
diff, a base, and (usually) a PR. Demand has emerged to point the same
machinery at **existing code** — a module or directory that needs a deep
audit (pre-refactor assessment, taking over unfamiliar code, security review
of a sensitive subsystem).

Before designing, we measured whether the machinery actually transfers. An
A/B experiment (`.qwen/investigations/legacy-review-ab/`) audited
`packages/core/src/permissions/` (12 files, 7,638 production lines) two ways:

- **Naive baseline** — one agent, module context only, no methodology.
  Result: 2 confirmed Criticals, 0 false positives, ~2.3M tokens. Better
  than expected (it probed spontaneously) but opportunistic: whatever caught
  its attention first got depth; whole dimensions went unexplored.
- **Dimension fan-out** — 8 agents with the `/review` briefs re-anchored
  from "walk the diff" to "walk these files" (1a, 1c, 2, 3a/3b/3c, 4, 5).
  Result: **17 confirmed Criticals** (independently re-verified by probe),
  0 false positives, ~32.5M tokens.

The findings the fan-out added were not marginal. The single most severe —
`cat $(rm -rf /tmp/x)` evaluating to `allow` under `deny: ["Bash(rm *)"]`,
end-to-end — was touched by the naive agent but filed as a Suggestion
without proving the consequence. The cross-file tracer (1c) found the two
Criticals nobody else could: the AUTO destructive-command guard being
skipped on any L4-allow, and session-rule deletion silently no-oping in the
permissions dialog. Both required assembling a three-file chain — the
finding class that only exists because one agent owns the cross-file walk.

Two more measurements shape this design:

- **Duplication is structural, not incidental.** The command-substitution
  bypass was found independently by 3 agents; the interpreter-strip gap by
  3; session-commit dead infrastructure by 3. Any legacy-audit pipeline
  needs dedup as a first-class step.
- **Cost concentrates in the walks, not the files.** The three most
  expensive agents (1c 6.8M, 5 6.4M, 3a 6.2M tokens) are the ones whose
  briefs demand repo-wide greps or mutation reasoning — and they are also
  the ones that produced findings no other agent could. Effort tiers must
  cut by expected marginal yield, not by price.

## Scope and non-goals

**In scope:** auditing a directory or module of existing, merged code —
`/audit <path>`. The product is a verified, deduplicated, theme-clustered
findings report.

**Out of scope:**

- Single files — already covered by `/review <file-path>`; `/audit` should
  say so and delegate.
- Whole-repository scans — no evidence anyone can act on 50 findings at
  once; the scoping UX should steer to module-sized targets.
- Posting anything anywhere — no PR, no comments, no auto-filed issues in
  v1. The report is the artifact; filing is the user's follow-up decision.
- Fixing — v1 reports; a `--fix`-style apply step is a later decision.

## Design

### A new skill, not a mode of `/review`

`/review`'s SKILL.md is ~1,200 lines in which nearly every step is anchored
to diff/base/PR assumptions: the worktree flow, merge-base resolution, the
removed-behavior agent whose entire evidence source is `-` lines, anchor
validation, the incremental cache, PR posting. Bolting a second semantic
onto it branches every step. The cost of a new skill is re-stating the
shared philosophy (silence over noise, failure scenarios, verification
discipline); the benefit is that neither document lies about its flow.

What is reused is the **TypeScript layer**, which is mostly
target-agnostic: `agent-prompt` roster/brief printing, the findings schema,
`check-coverage` transcript verification, budget/ledger machinery, and the
chunk-tiling logic from `plan-diff`.

### Target resolution and planning

`/audit <path>` resolves a directory (or file set) and runs a new
subcommand, `qwen audit plan-files <path>`, which plays the role
`plan-diff` plays for diffs:

- enumerates production files under the path (respecting the review
  exclusions: no `*.test.*` as _subjects_ — tests are evidence and the
  test-coverage agent's subject), classifies them (source / docs /
  generated) with the same rules `plan-diff` uses;
- counts source lines and applies the topology gate: below it, dimension
  agents each read the whole file set (the experiment's topology, good to
  roughly 5–8k lines); above it, tiles files into ~400-line chunks and
  fans out per-chunk agents with folded-in dimension briefs, mirroring
  Step 3B — with whole-module agents retained for the walks that are
  meaningless per-chunk (1c cross-file, 3a reuse, 5 test-coverage);
- marks heavy files (large, mostly-rewritten equivalents: big stateful
  classes) for the invariant-checklist triple, which the experiment
  confirmed transfers unchanged.

No worktree, no base resolution, no merge base — the tree under audit is
the user's own checkout, read-only.

### Roster

Roles are the `/review` briefs with their anchor re-pointed, which the
experiment showed is a mechanical change: "walk every hunk line by line"
becomes "walk every production file line by line"; "for every block the
diff adds" becomes "for every non-trivial block in the module".

| Role                 | Legacy re-anchor                        | Notes                                                            |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| 1a line-by-line      | every file, every line                  | unchanged checklist                                              |
| 1c cross-file tracer | module's exports × repo callers         | produced the two unique Criticals; mandatory                     |
| 2 security           | threat model of the module              | needs the legacy severity heuristic below                        |
| 3a/3b/3c quality     | module vs codebase                      | 3a's "does this exist already" found the two-splitter root cause |
| 4 performance        | trace the hot path first                | require a named hot path + cost shape                            |
| 5 test coverage      | tests as subject; mutation-test mindset | historical-bug parity walk transfers directly                    |
| 6a/6b/6c personas    | high effort only                        | untested in the experiment                                       |
| invariant a/b/c      | heavy files only                        | unchanged                                                        |

**Dropped:** Agent 0 (no issue), 1b (no deletions — its entire evidence
source is `-` lines), 7 (nothing was merged; build/test state is the
user's own), 8 (diff-specialized; a module-specialized variant is an open
question, not v1).

### The pre-existing inversion and legacy severity heuristics

`/review` rejects findings about pre-existing code; in a legacy audit
_everything_ is pre-existing, and the exclusion inverts. Two replacement
disciplines keep precision without an author to consult:

1. **The failure scenario is the bar.** Intent is unknowable for merged
   code ("maybe it's deliberate") — so no finding without a constructible
   trigger and a named wrong outcome survives. The experiment's zero false
   positives across 9 agents came from this, not from luck.
2. **Severity is decided by who the authority is on the failure path.**
   The security agent converged on a heuristic worth generalizing into the
   briefs: a miss that falls through to a conservative backstop is a
   downgrade; a miss where a _rule/config/allow_ makes the module itself
   the final authority is the Critical. Legacy code is full of
   backstops; grading without identifying them inflates everything to
   Critical or deflates it to noise.

### Dedup and verification

Measured overlap makes dedup mandatory: the same root cause arrives from
up to three agents, at different abstractions (a splitter divergence, its
security consequence, its missing test). Dedup must cluster by **root
cause**, not by location — a naive path:line merge would have kept the
experiment's three substitution findings separate. This is an LLM
clustering step over the findings file, with each cluster keeping the
strongest evidence (an end-to-end probe beats a unit probe beats a
read-based claim).

Verification keeps the `/review` shape — sharded batches ruling on each
finding's failure scenario against the real code — with one addition from
the experiment: the verifier's strongest tool for legacy claims is a
**runnable probe** (the decisive evidence in the experiment was
`PermissionManager.evaluate()` returning `allow`), and the brief should
say so explicitly, including the discipline that a probe must be shown to
flip under the implied fix.

### Output

- **The artifact:** a markdown report at `.qwen/audit/<path-slug>-<ts>.md`,
  findings clustered by theme/root cause, each with severity, locations,
  failure scenario, and the evidence tier (end-to-end probe / unit probe /
  code read).
- **The terminal:** a short summary — counts by severity and theme, plus
  the top clusters — not the full list. The report is for acting on; the
  terminal is for deciding whether to.
- **No verdict.** There is nothing to approve. The run ends at the
  report; suggested follow-ups (file issues, fix a cluster, re-audit
  after) are listed, not performed.

### Effort tiers

- **low** — inline read by the orchestrator itself, angle rotation as in
  `/review` low; unverified findings, capped. For "is this module worth a
  real audit".
- **medium** (default) — the experiment's roster: 1a, 1c, 2, 3a/3b/3c, 4,
  5 + verification. The measured configuration; this _is_ the evidence.
- **high** — medium + personas (6a/6b/6c) + iterative reverse audit with
  the two-consecutive-dry-rounds stop rule. Unmeasured; flagged as
  extrapolation in the report header until replicated.

The naive single-agent pass is **not** a tier: it measured strictly worse
than every tier that includes the fan-out, and offering it would launder
an inferior audit under the same command name.

## Rejected alternatives

- **A mode inside `/review`.** Branches every step of a 1,200-line
  document whose flow correctness is enforced by subcommands keyed to the
  diff assumptions. See above.
- **Whole-repo scans.** Cost scales linearly with size while actionability
  collapses; no measured demand. Module scope is the demonstrated use
  case.
- **Auto-filing issues from findings.** Every posted artifact is public
  and permanent; the experiment's findings needed maintainer adjudication
  on severity more than once (the naive arm's two grading inversions).
  Humans file; the audit informs.
- **Cutting the expensive agents for the default tier.** 1c/3a/5 are 60%
  of the cost and produced the unique, most-severe findings. The tiers cut
  elsewhere.

## Open questions

- **Replication.** All conclusions rest on one module, one round. A second
  module (different character — e.g. a state-machine-heavy subsystem, not
  a parser) must reproduce the fan-out's margin before this ships as more
  than an experiment.
- **Module-specialized finders.** `/review`'s Agent 8 writes a
  domain-specific brief per diff; whether a per-module equivalent (cron
  schedulers, protocol state machines) earns its cost is untested.
- **Incremental re-audit.** Content-hash per file would let a re-audit
  scope to changed files; plausible, unmeasured, not v1.

## Verification

- Unit: `plan-files` tiling/classification/topology gates; roster
  selection per tier; the dedup clusterer's merge behavior on synthetic
  overlapping findings.
- Integration: the second-module replication run, with the same
  independent-adjudication protocol as the first experiment (findings
  accepted only on quoted code or a runnable probe).
- Dogfood: audit a module whose maintainers can confirm or reject the
  Criticals, as PR #6457's confirmed-defect set calibrated `/review`.
