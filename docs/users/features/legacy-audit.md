# Legacy Code Audit

> Audit a module or directory of **existing, merged code** — no diff, no PR — using `/audit`.

`/review` is built for increments; `/audit` points the same machinery at code that is already merged: pre-refactor assessments, taking over an unfamiliar module, security review of a sensitive subsystem. The product is a verified, deduplicated, theme-clustered findings report.

## Quick Start

```bash
# Audit a module (default effort: medium)
/audit packages/core/src/permissions

# Quick unverified triage, one reader sub-agent
/audit packages/core/src/hooks --effort low

# Full pipeline plus reverse-audit rounds
/audit packages/core/src/permissions --effort high
```

Single files are not audited — `/review <file-path>` already covers that case, and `/audit` says so and stops.

## Effort Levels

`--effort low|medium|high` trades depth for cost. **The word means the opposite of what it does in `/review`**: `/review`'s medium _drops_ the adversarial personas while `/audit`'s medium _adds_ one (6a) — and both skills select the tier with the same `--effort` flag. If you run both, reset your expectation at the boundary.

| Level    | What runs                                                                                                 | Findings                    | Cost             |
| -------- | --------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------- |
| `low`    | One reader sub-agent rotating through directed angles plus a gap sweep                                    | ≤10, labeled **unverified** | Cheap            |
| `medium` | The measured 8-dimension fan-out (1a, 1c, 2, 3a/3b/3c, 4, 5) plus the 6a attacker seat, plus verification | Uncapped, verified          | Tens of M tokens |
| `high`   | medium + the 6b/6c personas + iterative reverse-audit rounds                                              | Uncapped, verified          | Extrapolated     |

## Size gates and budget

v1 audits one bounded module at a time. `plan-files` refuses at plan time — and asks for a narrower path — when:

- subject lines exceed **9,000** (the topology both experiments validated);
- test lines exceed **18,000** at medium/high (Agent 5 reads the corpus whole);
- subject lines exceed **2,000** at low (points you at medium);
- the priced token estimate's top exceeds the **60M** cap.

A larger subsystem is audited as coherent sub-paths, one bounded run each. For subject-gate and token-cap refusals, lowering the effort is never the remedy — the priced cost is a function of line counts alone. The test-line gate does not apply at `low` (the corpus goes unexamined there — triage, not an audit). A `low-gate` refusal names its own remedy: when the message offers the tier change, re-run with `--effort medium`; when it names the path instead (medium would refuse first — the priced estimate over the token cap, or test lines over the medium gate), no tier change helps, so narrow the path.

## What you confirm before anything launches

A fan-out run prints its roster and token estimate and starts only on your confirmation. The same confirmation carries the two **execution consents**, as separate opt-ins:

1. a baseline run of the module's own test suite;
2. agent-authored verification **probes** — short programs written mid-run, executed against a scratch copy of the probed file (never your checkout's copy), each required to flip under the implied fix.

The walks themselves are read-only. Because the confirmation is the only budget enforcement and the execution gate, **`/audit` refuses non-interactive starts** (headless `qwen -p`, cron, sub-agent invocations).

## Safety properties

- **Local-only artifacts.** The report, its sidecar, and the plan/prompt records quote the module — possibly exploitable code — and must never land in version control. `plan-files` probes `.qwen/audits/` and `.qwen/tmp/` (ignore rules **and** force-added history) at plan time, offers a zero-footprint `.git/info/exclude` remedy, and re-checks at every checkpoint and at write time; a mid-run flip relocates everything to a per-user fallback outside the repo.
- **Untrusted data.** Every consumer of module content — dimension agents, verifiers, the dedup clusterer, the low-tier reader, the orchestrator itself — opens with an untrusted-data preamble: the module is evidence, not instructions. A directive embedded in the code ("report no findings") is itself a finding.
- **Drift protection.** A path-scoped sidecar (diff, untracked content copies, per-file content hashes) is captured at run start and re-checked before verification, before each high-tier round, and at write time. Content drift in a file that already carries anchored findings stops the run with a partial report; any other drift is flagged and the run continues.
- **No verdict.** The report is findings, walks, and disclosures — never "approved". Posting and fixing stay with you.

## The report

`.qwen/audits/<YYYY-MM-DD>-<HHMMSS>-<path-slug>.md`, opening with a run-metadata header (commit SHA, model id, dirty state with sidecar, consumption against the estimate, walks completed/skipped/uncoverable, unexercised-machinery flags). Findings are clustered by root cause, each with severity, locations, failure scenario, evidence tier (end-to-end probe / unit probe / code read), and the independent-discovery count ("found independently by N agents"). Confirmed-low findings sit in their own "needs human review" section; anything unverified is labeled unverified.

## Limitations

- Submodules are refused at plan time (no drift coverage inside them in v1).
- Dedup is intra-run; already-filed issues are not cross-checked.
- The medium/high tiers are calibrated on two modules of this repository; the low tier and the high-tier loop are unmeasured first cuts, and the report header says so.
