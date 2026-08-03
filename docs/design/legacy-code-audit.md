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
  Result: 2 confirmed Criticals, 0 self-adjudicated false positives, ~2.3M
  tokens. Better than expected (it probed spontaneously) but opportunistic:
  whatever caught its attention first got depth; whole dimensions went
  unexplored.
- **Dimension fan-out** — 8 agents with the `/review` briefs re-anchored
  from "walk the diff" to "walk these files" (1a, 1c, 2, 3a/3b/3c, 4, 5).
  Result: **17 confirmed Criticals** (independently re-verified by probe),
  zero self-adjudicated false positives, ~32.5M tokens.

The findings the fan-out added were not marginal. The single most severe —
a command substitution nested inside an allow-matched outer command
bypassing the deny rules end-to-end, the denied inner command never
consulted (the working payload is withheld from this document because the
bypass is unpatched as of writing) — was touched by the naive agent but
filed as a Suggestion without proving the consequence. The cross-file
tracer (1c) found the two Criticals nobody else could: the AUTO
destructive-command guard being skipped on any L4-allow, and session-rule
deletion silently no-oping in the permissions dialog. Both required
assembling a three-file chain — the finding class that only exists because
one agent owns the cross-file walk.

Two more measurements shape this design:

- **Duplication is structural, not incidental.** The command-substitution
  bypass was found independently by 3 agents; the interpreter-strip gap by
  3; session-commit dead infrastructure by 3. Any legacy-audit pipeline
  needs dedup as a first-class step.
- **Cost concentrates in the walks, not the files.** The three most
  expensive agents (1c 6.8M, 5 6.4M, 3a 6.2M tokens) are the ones whose
  briefs demand repo-wide greps or mutation reasoning — and they are also
  the ones that produced findings no other agent could. Effort tiers must
  cut by expected marginal yield, not by price — the budget ceiling below
  bounds the total; it does not pick which agents get cut.

**Replication (2026-08-03, `packages/core/src/hooks/` — 23 files, 8,516
lines, a lifecycle/event-dispatch module, deliberately different in
character from the parser-heavy permissions module):** the margin
reproduced — and widened in absolute terms (19 added findings vs Round
1's 15) — though the recall ratio narrowed from ~8.5× to ~7×. The naive
arm was much stronger this time (3 confirmed Criticals, including a
redirect-based SSRF bypass) — and the fan-out still covered all three
while adding 19 more (22 total, zero self-adjudicated false positives on
both arms, ~7× recall margin, pre-declared success criterion was 3×;
cost ratio ~24×, dominated by the cross-file tracer — see the budget
rule below). Two replication findings
changed this document: the cross-file tracer's event-coverage walk ("does
every firing path fire?") produced two Criticals unique in the field — both
adjacent-class siblings of a historical fix; and the security agent,
briefed threat-model-first, produced four single-source Criticals at the
trust boundary (including frontmatter hooks bypassing folder trust, a
workspace-writable HTTP-hook whitelist, env-resolution paths defeating a
prior secrets-stripping fix). Full record:
`.qwen/investigations/legacy-review-ab-2/REPORT.md` (untracked working
file; key results summarized above).

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

`/review`'s SKILL.md is over 1,000 lines in which nearly every step is
anchored to diff/base/PR assumptions: the worktree flow, merge-base
resolution, the removed-behavior agent whose entire evidence source is `-`
lines, anchor validation, the incremental cache, PR posting. Bolting a
second semantic onto it branches every step. The cost of a new skill is
re-stating the shared philosophy (silence over noise, failure scenarios,
verification discipline) — and that philosophy is carried across SKILL.md
and a companion DESIGN.md of over 500 lines, so the bill is bigger than one
section; the benefit is that neither document lies about its flow.

What is reused is the **TypeScript layer**, in two grades. **Lifts
as-is:** `agent-prompt` roster/brief printing, the findings schema, the
budget machinery's shape (a plan-derived size→work mapping; `plan-files`
supplies the line counts), and the chunk-tiling logic from `plan-diff`.
**Needs a target-kind parameter, not a lift:** the roster machinery
(`lib/roster.ts`) keys on diff metrics — the `srcDiffLines`/`diffLines`
topology gate, `hasDeletions()` (true on an empty file list by design), a
resolved PR number — so a diff-free plan misfires through it (once
`plan-files` populates per-file entries, `hasDeletions()` returns false —
its true-on-empty fail-safe only fires on an empty list — so 1b is not
required, and with no worktree or untracked files, `reviewMode()` resolves
`diff-only`, the one mode where `requiredAgents()` drops both 7 and 1c,
so the roster comes back missing the 1c this design keeps as mandatory,
and reports no territory fan-out at any module size); `check-coverage`'s
core predicate is "the agent was
pointed at diff lines AND opened the diff file", and an audit has no diff
file, so it must be re-expressed as "opened file F / range R"; and the
chunk constant counts diff lines (`DEFAULT_MAX_CHUNK_LINES = 400`), so its
source-line analog lives in `plan-files`. The trade still holds —
parameterizing target kind is cheaper than forking the document — but the
shared layer is the printing, schema, and budget shape, not the gates. The
cross-round findings ledger does not lift into v1 — see Open questions.

### Target resolution and planning

`/audit <path>` resolves a directory (or file set) and runs a new
subcommand, `qwen audit plan-files <path>`, which plays the role
`plan-diff` plays for diffs:

- enumerates production files under the path (respecting the review
  exclusions: no `*.test.*` as _subjects_ — tests are evidence and the
  test-coverage agent's subject), classifies them with the same rules
  `plan-diff` uses — all four kinds, `source` / `test` / `generated` /
  `docs`, where `test` is the kind this design most depends on: it is what
  routes files out of the subject set and into Agent 5's;
- counts source lines and applies the topology gate — a `plan-files`
  constant pinned at 9,000 source lines, above the largest module the
  experiments validated whole-file (8,516): below it, dimension agents
  each read the whole file set — the only topology either experiment
  exercised, validated at 7,638 and 8,516 lines; above it, tiles files
  into chunks of 400 source lines (`plan-files`' source-line analog of
  `/review`'s diff-line chunk constant — the unit changes; source lines
  are what a diff-free target has) and fans out per-chunk agents with
  folded-in dimension briefs, mirroring Step 3B — with whole-module
  agents retained for the walks that are meaningless per-chunk (1c
  cross-file, 3a reuse, 5 test-coverage, and any personas the tier
  includes — these are whole-module by construction). The fan-out is
  bounded by the per-run agent ceiling below — a tiling that exceeds it
  refuses the run and asks for a narrower path. The above-gate branch is
  untested extrapolation — neither experiment routed a module through it —
  and a run that does says so in the report header;
- nominates heavy-file candidates for the invariant-checklist triple —
  untested in the experiments; expected to transfer by analogy from the
  diff-based checklist, flagged as extrapolation in the report header.
  Heaviness splits by decider: `plan-files` does the deterministic half —
  nominating every source file at or above the same 300-line floor
  `classifyHeavy` uses (the legacy floor, because `classifyHeavy`
  (`lib/heavy.ts`) does not lift: it triggers on diff metrics — ≥ 300
  pre-lines AND rewrite ratio ≥ 0.4 or ≥ 800 changed lines — and an audit
  target is merged, unchanged code, so a lifted `classifyHeavy` marks
  nothing heavy and the triple silently never runs) — and the orchestrator
  makes the semantic call over the nominees: which of them hold
  long-lived mutable state (class-level fields, caches, timers,
  registries) or carry the checklist's other subject, an error taxonomy.
  A deterministic subcommand cannot decide a semantic predicate, and the
  marking is disclosed in the report header. As in `/review`'s roster,
  the triple runs only above the topology gate: below it every dimension
  agent already reads every file whole, so three more whole-file agents
  would add cost but no new view;
- detects event/lifecycle modules by emit/dispatch/subscribe call
  patterns and flags them for the 1c event-coverage brief; the detection
  outcome (detected / not detected, heuristic) rides into the report
  header, because a false negative otherwise withholds the walk silently
  — 1c still completes with its plain brief, so "walks completed" cannot
  tell "not an event module" from "detection missed".

No worktree, no base resolution, no merge base — the tree under audit is
the user's own checkout, read-only for the walks. The exceptions execute
and mutate: a runnable probe flips under the implied fix on a scratch
copy of the probed file (never the checkout's copy), and the surviving
baseline test run (Open questions) executes the module's own tests.
Audited-module code may be vendored or third-party, so the header states
that the run executed code, rather than framing execution as a read.

### Budget ceiling

The default tier is the expensive one by construction — fan-out recall is
the product — so it ships with a stated bound, not an open tab:

- **Pre-launch estimate, confirmed.** `plan-files` prints what the run
  will launch (roster by role, chunk count) and an expected token range —
  the two measured arms came in at ~4–6M tokens per 1,000 module lines
  for the 8-dimension core (32.5M at 7,638 lines; ~46M at 8,516, derived
  from the cross-file tracer's 16M at ~35% of its arm) — and the run
  starts only on user confirmation. Medium adds work no measurement
  covers (6a, the invariant triple on heavy files, verification), so the
  confirmation names that delta as unmeasured rather than pricing it
  into the range.
- **Ceiling.** Medium is capped at 60M tokens and 40 agents, both
  enforced at plan time — the agent count against the deterministic
  roster, the token cap against the estimate range's top, the
  conservative reading since actual consumption is only known at runtime
  and this design has no runtime accounting; a plan over either refuses
  and asks for a narrower path or a lower tier. Both constants are
  unmeasured first cuts — 60M is ~1.3× the larger measured arm — and they
  ride into the report header with the other unexercised-machinery flags.
  High is extrapolation: its estimate is the medium estimate multiplied
  by the round structure — a range from the earliest dry stop (initial
  fan-out + 2 rounds) to the 5-round hard cap — and the confirmation
  names that range, not the single-pass number; its total ceiling waits
  for its first measurement, and the header says so.

The ceiling bounds the total; it does not pick which agents get cut — that
stays the marginal-yield decision above.

### Roster

Roles are the `/review` briefs with their anchor re-pointed, which the
experiment showed is a mechanical change: "walk every hunk line by line"
becomes "walk every production file line by line"; "for every block the
diff adds" becomes "for every non-trivial block in the module".

| Role                 | Legacy re-anchor                        | Notes                                                                                                                                                                |
| -------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a line-by-line      | every file, every line                  | unchanged checklist                                                                                                                                                  |
| 1c cross-file tracer | module's exports × repo callers         | produced the unique Criticals in both rounds; mandatory                                                                                                              |
| 2 security           | threat model first, then the checklist  | "name the adversary inputs" produced R2's trust-boundary Criticals                                                                                                   |
| 3a/3b/3c quality     | module vs codebase                      | the roster's three existing quality slices (3a reuse, 3b altitude/abstraction fit, 3c consistency); 3a's "does this exist already" found the two-splitter root cause |
| 4 performance        | trace the hot path first                | require a named hot path + cost shape                                                                                                                                |
| 5 test coverage      | tests as subject; mutation-test mindset | historical-bug parity walk transfers directly                                                                                                                        |
| 6a attacker persona  | undirected                              | untested; one undirected seat at every tier ≥ medium — see below                                                                                                     |
| 6b/6c personas       | high effort only                        | untested in the experiments                                                                                                                                          |
| invariant a/b/c      | heavy files only                        | unchanged                                                                                                                                                            |

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
module's fan-out, so the brief needs a budget rule: deep-read at most
**N = 10** call sites per event (an unmeasured first cut) and register
the rest by name, instead of reading every caller in full — and spend
those ten deep-read slots on callers' early-return, error, and abort
paths first, because a fire-miss is only visible there and happy-path
callers are the cheap ones to register by name (Round 2's two
unique-in-the-field Criticals were both fire-misses on exactly those
paths — the class a flat per-event quota is most likely to starve). When
the budget binds, the run discloses it — which events hit the cap and
which callers were name-registered only — so the residual coverage
trade-off is stated in the report, not implicit in it.

**Dropped:** Agent 0 (no issue), 1b (no deletions — its entire evidence
source is `-` lines), Agent 7's build-gate half (nothing was merged;
build state is the user's own — its surviving half, a baseline run of
the module's existing tests, is an open question below), 8
(diff-specialized; a module-specialized variant is an open question, not
v1).

### The pre-existing inversion and legacy severity heuristics

`/review` rejects findings about pre-existing code; in a legacy audit
_everything_ is pre-existing, and the exclusion inverts. Three replacement
disciplines keep precision without an author to consult:

1. **The failure scenario is the bar.** Intent is unknowable for merged
   code ("maybe it's deliberate") — so no finding without a constructible
   trigger and a named wrong outcome survives. The experiments' zero false
   positives are self-adjudicated — 4 Criticals are maintainer-confirmed
   to date, via #8396 — and that record came from this discipline, not
   from luck; the Dogfood item in Verification is the external check.
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
read-based claim). **Dedup must never downgrade severity:** the cluster's
severity is the highest severity any member carried — the `/review` Step 4
rule — and each member's severity and failure scenario ride along on the
cluster, because a severity split is by definition one root cause graded
differently by different agents, and root-cause clustering merges those
copies before verification; without the carried members, the split rule
below would have no input to fire on. The experiments recorded the failure
mode twice: Round 1's most severe finding filed as a Suggestion by one
arm, and Round 2's explicit severity split.

**One scope line: dedup is intra-run.** v1 reads no tracker, so the
dominant legacy duplicate class — a root cause already filed as an issue
or already being fixed in flight — is not cross-checked; a pre-report grep
of open issues by each cluster's file/symbol is the cheap future version,
and until then an already-filed duplicate is caught, if at all, when the
user files the cluster.

**Independent discovery is evidence, not noise:** a root cause hit by
several agents from different dimensions is a high-confidence signal, and
the cluster's report entry should say "found independently by N agents" —
Round 2's most-confirmed findings (a redirect SSRF and a permission-merge
flaw, 3-4 independent discoveries each) were also its most severe.

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

- **The artifact:** a markdown report at
  `.qwen/audits/<YYYY-MM-DD>-<HHMMSS>-<path-slug>.md` — the `/review`
  report convention adapted: plural directory, date-first, HHMMSS so a
  same-day re-audit does not overwrite the earlier report — findings
  clustered by theme/root cause, each with severity, locations,
  failure scenario, evidence tier (end-to-end probe / unit probe /
  code read), independent-discovery count ("found independently by N
  agents"), and the verification's confidence mark (confirmed-high /
  confirmed-low, keeping the `/review` shape — the reused findings schema
  carries `confidence` on every validated finding). Confirmed-low findings
  sit in their own "needs human review" section, never mixed into the
  confirmed counts — the `/review` analog is terminal-only — and findings
  from a low-tier run are labeled unverified, so they never print
  identically to verified ones. The report opens with a run-metadata
  header: the audited commit SHA and dirty/clean state of the checkout
  (file:line anchors drift with HEAD, so a re-audit after fixes must be
  alignable with the run it follows — a promise the SHA keeps only when
  the checkout was clean; on a dirty run `/audit` writes the dirty
  `git diff` alongside the report in `.qwen/audits/` so the anchors stay
  resolvable, and the header names which case applied), the effort tier,
  and the walks
  completed or skipped with reason — a partially failed run (1c
  budget-exhausted, security agent errored) must be distinguishable from
  a full one, because "0 security findings" on a run whose security agent
  never completed is not "safe" (`/review` solves this with
  `unreviewedDimensions`). The header also carries every flag this design
  attaches to unexercised machinery — above-gate topology, the invariant
  triple's extrapolation, 6a's untested status, the event-module
  detection outcome, the unmeasured ceiling constants (60M tokens /
  40 agents), the high-tier loop, twice-whiffed reverse-audit scopes,
  budget-bound walks, unmeasured tiers — since `/audit` has no verdict
  for them to cap.
- **Local-only, verified not assumed:** the report must never land in
  version control — a real security property, since an audit of a
  security module will quote exploitable code. The property holds only
  when the project ignores `.qwen/*` and nothing re-includes or
  force-adds the audits path: this repo's own `.gitignore` re-includes
  four `.qwen/` subtrees and tracks force-added files under `.qwen/`,
  and `/audit` runs in arbitrary repositories where `.qwen/` may not be
  ignored at all. So `/audit` checks before writing — `git check-ignore`
  on the audits path, the probe `team-memory-git-status.ts` already uses
  — and refuses the run when the report would be tracked.
- **The terminal:** a short summary — counts by severity and theme, plus
  the top clusters — not the full list. The report is for acting on; the
  terminal is for deciding whether to.
- **No verdict.** There is nothing to approve. The run ends at the
  report; suggested follow-ups (file issues, fix a cluster, re-audit
  after) are listed, not performed.

### Effort tiers

- **low** — inline read by the orchestrator itself, angle rotation as in
  `/review` low minus angle B (removed behaviour — merged code has no
  deletions; the same absence that dropped agent 1b), with the surviving
  angles re-anchored from diff to module by the Roster section's
  mechanical change — B is the only outright removal — and the lifted
  three-angle floor rebased to A and C: two angles at the floor,
  disclosed in the header, since a silent shrink would land on exactly
  the small triage targets the floor exists for; unverified findings,
  capped. Unmeasured in the experiments — both rounds ran only
  the naive and fan-out arms — and flagged as such in the report header,
  like its siblings. For "is this module worth a real audit". It shares
  the single-reader shape the naive-exclusion argument below rejects,
  with the measurement against it (~7× recall behind fan-out), and
  survives that argument only because it claims no audit standing:
  labeled unverified, capped, sold as triage — a thin result reads as
  "run a real audit before concluding anything", not as a verdict on the
  module.
- **medium** (default) — the replicated 8-dimension core plus the 6a
  blind-spot hedge: 1a, 1c, 2, 3a/3b/3c, 4, 5, **6a**, plus invariant
  a/b/c on the files the heavy-marking above selects (above the topology
  gate only, as in `/review`'s roster) + verification. Rounds 1-2
  measured the 8-dimension core; 6a rests on the near-miss argument
  above, not on experiment.
- **high** — medium + the other two personas (6b/6c) + iterative reverse
  audit carrying the full `/review` Step 5 semantics, not just its stop
  rule. Each round fans out over the module with the cumulative confirmed
  list as its baseline, hunting only gaps; every return gets the
  substantive-return check — a bare "No issues found." with no evidence
  of what the auditor re-examined is a whiff, relaunched once, and a
  second bare return marks that scope not audited, cleared only when a
  later round's auditor for it returns substantively. A round is **dry**
  only when every auditor returned zero new findings _with_ the
  evidence-bearing receipt, so a round containing a twice-whiffed auditor
  is not dry and cannot end the loop on silence. Stop after two
  consecutive dry rounds, or after 5 rounds hard cap, reported as a cap
  rather than as convergence. Reverse-audit findings route through the
  same dedup and verification as fan-out findings, and each round's
  confirmed results merge into the cumulative list before the next round
  begins. Unmeasured; flagged as extrapolation in the report header until
  replicated — alongside any twice-whiffed scopes, since `/audit` has no
  verdict for that disclosure to cap.

The naive single-agent pass is **not** a tier: it measured strictly worse
than every tier that includes the fan-out, and offering it would launder
an inferior audit under the same command name. (The low tier carries the
same single-reader shape and survives only on its labeling — unverified,
capped, sold as triage — as above.)

## Rejected alternatives

- **A mode inside `/review`.** Branches every step of that 1,000-plus-line
  document, whose flow correctness is enforced by subcommands keyed to the
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
  scope to changed files; plausible, unmeasured, not v1. It is also why
  `/review`'s cross-round findings ledger is not a v1 reuse: the ledger
  is an HTML comment serialized into a posted PR review body and parsed
  back by the next round, and v1 removes every anchor it needs — no PR,
  no posted body, no verdict for the rounds to rule against. If re-audit
  lands, the ledger is the carry-forward model to reach for.
- **Baseline test run — the surviving half of Agent 7.** Build state is
  the user's own and no audit-side build gate is proposed, but running
  the module's existing tests once is cheap: a pre-existing failure in
  the audited module is itself a finding, and the run establishes the
  baseline every verification probe needs to flip against. Whether it
  joins every tier, or only tiers that run probes, is open.

## Verification

- Unit: `plan-files` tiling/classification/topology gates and its
  heavy-candidate nomination (the deterministic 300-line half; the
  orchestrator's semantic marking is model-driven, not unit-testable);
  roster selection per tier; the dedup clusterer's
  merge behavior on synthetic overlapping findings — including the
  max-severity rule (a cluster whose mildest copy is a Suggestion must
  come out at its Critical member's severity, with both scenarios
  intact).
- ~~Integration: second-module replication~~ — **done** (hooks module,
  2026-08-03; margin reproduced at ~7× against a pre-declared 3×
  criterion, zero self-adjudicated false positives both arms).
- Dogfood: audit a module whose maintainers can confirm or reject the
  Criticals — the external check the self-adjudicated precision record
  rests on — as PR #6457's confirmed-defect set calibrated `/review`.
