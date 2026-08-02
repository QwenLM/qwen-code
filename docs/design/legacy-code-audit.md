# Legacy Code Audit (`/audit`)

## Context

`/review` is built for increments: every step of its orchestration assumes a
diff, a base, and (usually) a PR. Demand has emerged to point the same
machinery at **existing code** — a module or directory that needs a deep
audit (pre-refactor assessment, taking over unfamiliar code, security review
of a sensitive subsystem).

Before designing, we measured whether the machinery actually transfers. An
A/B experiment (working record at `.qwen/investigations/legacy-review-ab/`,
untracked; key results below) audited
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

**Replication (2026-08-03, `packages/core/src/hooks/` — 23 files, 8,516
lines, a lifecycle/event-dispatch module, deliberately different in
character from the parser-heavy permissions module):** the margin
reproduced and widened. The naive arm was much stronger this time (3
confirmed Criticals, including a redirect-based SSRF bypass) — and the
fan-out still covered all three while adding 19 more (22 total, zero
false positives on both arms, ~7× recall margin, pre-declared success
criterion was 3×; cost ratio ~24×, dominated by the cross-file tracer —
see the budget rule below). Two replication findings changed this
document: the
cross-file tracer's event-coverage walk ("does every firing path fire?")
produced two Criticals unique in the field — both adjacent-class siblings
of a historical fix; and the security agent, briefed threat-model-first,
produced four single-source Criticals at the trust boundary (including
frontmatter hooks bypassing folder trust, a workspace-writable HTTP-hook
whitelist, env-resolution paths defeating a prior secrets-stripping fix).
Full record: `.qwen/investigations/legacy-review-ab-2/REPORT.md` (untracked
working file; key results summarized above).

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
  classes) for the invariant-checklist triple — untested in the
  experiments; expected to transfer by analogy from the diff-based
  checklist, flagged as extrapolation.

No worktree, no base resolution, no merge base — the tree under audit is
the user's own checkout, read-only.

### Roster

Roles are the `/review` briefs with their anchor re-pointed, which the
experiment showed is a mechanical change: "walk every hunk line by line"
becomes "walk every production file line by line"; "for every block the
diff adds" becomes "for every non-trivial block in the module".

| Role                 | Legacy re-anchor                        | Notes                                                              |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| 1a line-by-line      | every file, every line                  | unchanged checklist                                                |
| 1c cross-file tracer | module's exports × repo callers         | produced the unique Criticals in both rounds; mandatory            |
| 2 security           | threat model first, then the checklist  | "name the adversary inputs" produced R2's trust-boundary Criticals |
| 3a/3b/3c quality     | module vs codebase                      | 3a's "does this exist already" found the two-splitter root cause   |
| 4 performance        | trace the hot path first                | require a named hot path + cost shape                              |
| 5 test coverage      | tests as subject; mutation-test mindset | historical-bug parity walk transfers directly                      |
| 6a attacker persona  | undirected                              | untested; one undirected seat at every tier ≥ medium — see below   |
| 6b/6c personas       | high effort only                        | untested in the experiments                                        |
| invariant a/b/c      | heavy files only                        | unchanged                                                          |

**Why one undirected seat survives at medium.** Round 1 dropped all three
personas on cost. Round 2 nearly produced the counterexample: the naive
arm's redirect-SSRF Critical was briefly a "the fan-out missed this"
candidate before two fan-out agents landed it independently. A fixed
dimension list has blind spots by construction; one undirected
attacker-mindset agent is the cheap hedge (one agent, not three).

**Event-coverage walk for event-driven modules (1c, conditional).** When
the module is an event/lifecycle system, 1c's brief adds: enumerate the
events the module defines, then every call-site path that should fire
each one — including early-return, error, and abort paths in the
_callers_. Round 2's two unique Criticals (a failure hook that never
fires on API-error turn ends in headless mode, and on loop detection in
ACP sessions) came from exactly this walk; both were adjacent-class
siblings of a historical fix that had covered only one UI path. **It
also made 1c the single most expensive agent of either round (16M
tokens, ~35% of the arm)** — repo-wide path enumeration scales with the
module's fan-out, so the brief needs a budget rule: deep-read at most N
call sites per event and register the rest by name, instead of reading
every caller in full.

**Dropped:** Agent 0 (no issue), 1b (no deletions — its entire evidence
source is `-` lines), 7 (nothing was merged; build/test state is the
user's own), 8 (diff-specialized; a module-specialized variant is an open
question, not v1).

### The pre-existing inversion and legacy severity heuristics

`/review` rejects findings about pre-existing code; in a legacy audit
_everything_ is pre-existing, and the exclusion inverts. Three replacement
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
3. **A documented limitation is not automatically a non-finding.** Round 2
   split two agents on this: one filed a docstring-admitted v1 limitation
   as Critical, another listed it under non-findings. The rule that
   resolves it: the admitted limitation itself is not reported — but harm
   the admission does _not_ cover (a leak window, a cross-session
   consequence, a caller contract that silently depends on the missing
   behavior) is reported on its own merits.

### Dedup and verification

Measured overlap makes dedup mandatory: the same root cause arrives from
up to four agents, at different abstractions (a splitter divergence, its
security consequence, its missing test). Dedup must cluster by **root
cause**, not by location — a naive path:line merge would have kept the
experiment's three substitution findings separate. This is an LLM
clustering step over the findings file, with each cluster keeping the
strongest evidence (an end-to-end probe beats a unit probe beats a
read-based claim). **Independent discovery is evidence, not noise:** a
root cause hit by several agents from different dimensions is a
high-confidence signal, and the cluster's report entry should say "found
independently by N agents" — Round 2's most-confirmed findings (a
redirect SSRF and a permission-merge flaw, 3-4 independent discoveries
each) were also its most severe.

Verification keeps the `/review` shape — sharded batches ruling on each
finding's failure scenario against the real code — with two additions
from the experiments: the verifier's strongest tool for legacy claims is
a **runnable probe** (the decisive evidence in Round 1 was
`PermissionManager.evaluate()` returning `allow`), including the
discipline that a probe must be shown to flip under the implied fix; and
**factual inter-agent disagreements are settled by execution, never by
adjudicator judgment** — Round 2 had two (a whitelist-bypass claim one
agent filed and another explicitly cleared; a severity split) and only a
probe resolved the first. Severity splits are settled by the
authority-on-the-failure-path heuristic (discipline 2 above). The verify
brief must name both cases.

### Output

- **The artifact:** a markdown report at `.qwen/audit/<path-slug>-<ts>.md`,
  findings clustered by theme/root cause, each with severity, locations,
  failure scenario, evidence tier (end-to-end probe / unit probe /
  code read), and independent-discovery count ("found independently by N
  agents").
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
- **medium** (default) — the replicated 8-dimension core plus the 6a
  blind-spot hedge: 1a, 1c, 2, 3a/3b/3c, 4, 5, **6a** + verification.
  Rounds 1-2 measured the 8-dimension core; 6a rests on the near-miss
  argument above, not on experiment.
- **high** — medium + the other two personas (6b/6c) + iterative reverse
  audit with the two-consecutive-dry-rounds stop rule. Unmeasured;
  flagged as extrapolation in the report header until replicated.

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
  on severity (the naive arm's grading inversion — its most severe
  finding filed as a Suggestion). Humans file; the audit informs.
- **Cutting the expensive agents for the default tier.** 1c/3a/5 are 60%
  of the cost and produced the unique, most-severe findings. The tiers cut
  elsewhere.

## Open questions

- **Module-specialized finders.** `/review`'s Agent 8 writes a
  domain-specific brief per diff; whether a per-module equivalent (cron
  schedulers, protocol state machines) earns its cost is untested.
- **Incremental re-audit.** Content-hash per file would let a re-audit
  scope to changed files; plausible, unmeasured, not v1.

## Verification

- Unit: `plan-files` tiling/classification/topology gates; roster
  selection per tier; the dedup clusterer's merge behavior on synthetic
  overlapping findings.
- ~~Integration: second-module replication~~ — **done** (hooks module,
  2026-08-03; margin reproduced at ~7× against a pre-declared 3×
  criterion, zero false positives both arms).
- Dogfood: audit a module whose maintainers can confirm or reject the
  Criticals, as PR #6457's confirmed-defect set calibrated `/review`.
