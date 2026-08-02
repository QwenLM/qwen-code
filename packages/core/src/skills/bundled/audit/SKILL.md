---
name: audit
description: Audit existing code (a module or directory) for correctness bugs, security vulnerabilities, quality problems, performance issues, and test-coverage gaps — no diff, no PR. Use when the user asks to audit, deep-review, or assess a legacy/existing module or directory. Invoke with `/audit <path>`; add `--effort low|medium|high` (defaults to medium). Single files are covered by `/review <file-path>` instead.
argument-hint: '<directory-path> [--effort low|medium|high]'
allowedTools:
  - task
  - run_shell_command
  - grep_search
  - read_file
  - write_file
  - glob
---

# Legacy Code Audit

You are an expert code auditor. Your job is to audit a directory of **existing, merged code** — there is no diff, no PR, and no baseline — and produce a verified, deduplicated, theme-clustered findings report.

**Critical rules (most commonly violated — read these first):**

1. **This is a read-only audit.** Do not modify any source file under audit — yours or your agents'. The report is the only artifact. Post nothing anywhere (no PR, no issue, no comment). Fixing is the user's follow-up decision, not this run's.
2. **Every command below is written `"${QWEN_CODE_CLI:-qwen}" audit …` — copy it as written.** `QWEN_CODE_CLI` is the entry of the CLI running this skill; a bare `qwen` may be an older global install that lacks `audit` entirely.
3. **Single files are not audited here.** If the target resolves to a file, stop and tell the user: `/review <file-path>` already covers that case. `plan-files` rejects file targets with the same message — relay it, do not work around it.
4. **Silence is better than noise.** An audit of 8k lines that lands 40 findings will be read the way 40 findings deserve — which is not at all. Every finding that reaches the report has a concrete failure scenario that survived verification. Unverified or unprovable suspicion is dropped, not downgraded.
5. **Do not call `todo_write` during an audit.** This document is the plan; report progress in normal output.

## Step 0: Parse the target

Do not parse or retype the arguments yourself. The CLI has written the raw argument string to the session-private file named by the `<skill-args-file>` note at the end of your instructions. Pass that file on stdin to the deterministic parser:

```bash
"${QWEN_CODE_CLI:-qwen}" audit parse-args --stdin \
  --out .qwen/audit/args-<ts>.json < <the exact path in the skill-args-file note>
```

Read the verdict and use its `targetPathAbsolute` and `effort` verbatim. The parser requires exactly one directory, accepts `--effort low|medium|high` in spaced or equals form, resolves the directory, and rejects files, unknown flags, and ambiguous extra tokens. Never interpolate `targetPathAbsolute` back into shell syntax — it may contain spaces or shell metacharacters.

If the args file is absent, ask the user for the directory — do not audit a guessed target.

## Step 1: Plan

```bash
"${QWEN_CODE_CLI:-qwen}" audit plan-files \
  --args-report .qwen/audit/args-<ts>.json \
  --out .qwen/audit/plan-<ts>.json
```

The fixed args-report path, not the user's path, crosses the shell boundary. Read the plan JSON. It fixes **what will be audited**: the production files (subjects), test files (evidence), the topology (`whole` or `chunked`), the chunks, the heavy files, and the **roster** — the list of agents this audit must launch, computed by code from the effort tier. Do not shrink the roster: an omitted agent is invisible precisely because it is an omission. You may only launch **more** than the roster when a finding in Step 3 justifies a specialist.

If the plan reports 0 production files, stop: say what was found instead (tests/docs/generated only, or nothing) and ask for the right directory.

## Step 2: Effort-gated execution

### low — inline audit

Read the production files yourself, in rotating passes: (1) correctness, (2) security/trust boundaries, (3) structure/consistency. Cap at 10 findings, each marked **unverified**. Skip Steps 3-5; write the report in Step 6 with `effort: low` in the header and the unverified marker visible.

### medium / high — fan-out

Continue to Step 3.

## Step 3: Launch the roster

Read `roster`, `topology`, `chunks`, `wholeModuleRoles`, and `heavyFiles` from the plan. The agent set is deterministic:

- **whole topology**: one agent per role in `roster`.
- **chunked topology**: **one chunk agent per chunk** (its brief folds all territory-scoped lenses into one), plus one agent per role in `wholeModuleRoles` (their walks — cross-file tracing, reuse, test coverage, personas — are meaningless per-chunk). Example: 18 chunks + 4 whole-module roles = 22 agents.
- **every topology, medium/high**: for each path in `heavyFiles`, launch three additional whole-file agents: `invariant-a`, `invariant-b`, and `invariant-c`. This is a measured three-way split, not one combined checklist.

Launch in waves sized to keep the machine responsive; do not idle between waves — say briefly which wave is out. Within each wave, issue all Agent tool calls in one response so they run concurrently. Set `subagent_type: "general-purpose"` and `run_in_background: false` on every call: Step 4 depends on the complete findings, so a fire-and-forget wave is invalid.

For each agent, print its exact prompt and launch a `general-purpose` agent with it:

```bash
"${QWEN_CODE_CLI:-qwen}" audit agent-prompt --plan .qwen/audit/plan-<ts>.json --role <role>
# folded territory brief for chunk agents:
"${QWEN_CODE_CLI:-qwen}" audit agent-prompt --plan .qwen/audit/plan-<ts>.json --chunk <id>
# three independent invariant briefs for every heavy file:
"${QWEN_CODE_CLI:-qwen}" audit agent-prompt --plan .qwen/audit/plan-<ts>.json \
  --role invariant-a --file <heavy-file>
# repeat for invariant-b and invariant-c
```

Launch with the printed prompt **verbatim**, plus one orchestrator addition:

- **Output path**: `Write your findings to .qwen/audit/findings-<role>-<ts>.md` (roles), `.qwen/audit/findings-chunk-<id>-<ts>.md` (chunk agents), or `.qwen/audit/findings-<invariant-role>-<file-slug>-<ts>.md` (heavy-file agents).

For `high` effort the roster also includes `6b` and `6c`; they run in the same wave as the whole-module agents. Do not shrink the roster or the chunk fan-out: an omitted agent is invisible precisely because it is an omission. You may only launch **more** than the plan requires when a finding justifies a specialist.

While agents run, do not idle-wait in silence — say briefly which roles are out.

## Step 4: Verify

For each findings file, extract the findings and shard them (at most 6 per shard). Launch one verifier per shard with:

> Rule on each finding. For each: read the cited code and decide **confirmed** or **rejected**. A finding is confirmed only if its failure scenario is constructible against the real code — quote the lines that prove it, or for claims decidable by execution, run a scratch probe (a tsx/vitest script, deleted after) and paste the output; a probe must be shown to flip under the implied fix. **When two findings contradict each other — or a finding contradicts the code's own comment — settle it by execution, never by judgment.** Severity check: a miss that falls through to a conservative backstop is a downgrade (Suggestion); a miss where a rule/config/allow makes the module the final authority is Critical. A documented limitation is rejected as reported, but harm the admission does not cover stands on its own merits.

Rejected findings are dropped with the reason kept in the report's appendix.

## Step 5: Deduplicate by root cause

Cluster the confirmed findings by **root cause**, not by location: the same underlying defect often arrives from several agents at different abstractions (a parser divergence, its security consequence, its missing test). Each cluster:

- keeps the strongest evidence (end-to-end probe > unit probe > code read),
- records **"found independently by N agents"** — independent discovery is confidence evidence, and the report shows it,
- merges locations and failure scenarios.

## high effort: reverse audit

Before the final report, run up to 3 reverse-audit rounds. Each round, launch one fresh `general-purpose` agent with:

> This audit's verified findings and coverage claim to be complete. Presume both are wrong: find one defect the audit missed (a finding class, an unwalked path, an over-confident rejection) or one confirmed finding that does not survive re-verification. Report only concrete, evidenced contradictions.

Each round's contradictions are verified (Step 4 rules) and merged into the finding set. Stop after two consecutive rounds with no new contradiction. Only then continue to Step 6, so the report and terminal counts describe the final result.

## Step 6: Report and summary

Write `.qwen/audit/<dir-slug>-<ts>.md`:

```markdown
# Audit report: <path> (<date>)

effort: <tier> · files: <n> · source lines: <n> · agents: <roles launched>

## Critical

<clusters, each with: title, locations, failure scenario, evidence tier,
"found independently by N agents" when applicable>

## Suggestion

<same shape>

## Appendix: rejected findings

<finding, rejecting verification reason>
```

Then the terminal summary — short: counts by severity and theme, plus the top 3 clusters by severity and evidence strength. Do not paste the full report. End with: report path, and suggested follow-ups (fix a cluster, file issues, re-audit after) listed, not performed.

## Language

The report and terminal summary follow the output language preference; agent `description` fields follow it too. Code, commands, file paths, and probe output stay verbatim.
