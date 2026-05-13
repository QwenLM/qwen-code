---
name: agent-reproduce-align
description: Use after a Codex or Claude Code feature has been implemented in Qwen Code to run the selected reference agent and Qwen Code under the same scenario, capture HTTP and terminal traces, compare request bodies, tool/function schemas, outputs, and iterate until the reproduced behavior is close enough.
---

# Agent Reproduce Align

## Purpose

Use this skill when Qwen Code already has a candidate implementation and needs evidence-based parity with a selected reference agent: `codex` or `claude-code`. The goal is not byte-for-byte equality; it is matching the observable contract that matters for the feature.

Default target repo: the current working directory. Use a user-specified path only when the user explicitly provides one.

## Reference Agent Selection

Use the same reference agent selected during `$agent-reproduce-feature`. If the earlier choice is unavailable, ask once and record the answer in the scenario or run notes.

## Workflow

1. Re-state the parity target:
   - feature name and trigger
   - selected reference agent
   - one baseline prompt or interaction script
   - acceptable differences
   - must-match fields
2. Run the reference agent and Qwen Code in separate capture directories with the same scenario.
3. Normalize traces with `scripts/normalize_trace.py`.
4. Compare normalized traces with `scripts/compare_traces.py`.
5. Inspect differences in this order:
   - missing tool/function names
   - schema shape and required fields
   - model settings and response mode
   - prompt role/order differences that affect behavior
   - terminal-visible output and exit status
6. Patch Qwen Code, rerun the smallest failing scenario, and repeat.
7. Preserve only redacted minimal fixtures in the repo.

Read `references/alignment-workflow.md` before the first comparison pass.

## Common Commands

Normalize:

```sh
skills/agent-reproduce-align/scripts/normalize_trace.py \
  .repro-runs/reference/http.jsonl \
  > .repro-runs/reference/normalized.json
```

Compare:

```sh
skills/agent-reproduce-align/scripts/compare_traces.py \
  .repro-runs/reference/normalized.json \
  .repro-runs/qwen/normalized.json
```

Run a paired shell scenario:

```sh
skills/agent-reproduce-align/scripts/run_pair_capture.sh \
  .repro-runs/slash-help \
  "codex exec '/help'" \
  "npm test -- --runInBand"
```

For Claude Code, replace the first command with the discovered Claude Code command. Use the paired runner only when shell quoting is simple. For interactive slash commands, run the two captures manually with tmux so each side can receive the same keystrokes.

## Comparison Rules

- Compare contracts before wording. Exact prompt text is usually implementation detail.
- Treat absent schemas, wrong required fields, or wrong argument names as high-signal failures.
- Treat output ordering as significant only when the user-visible workflow depends on it.
- Do not chase provider-specific endpoints, model names, IDs, timestamps, token counts, or ephemeral headers unless the feature depends on them.
- Stop when Qwen Code passes the user-visible scenario and the remaining trace differences are documented as intentional.

## Done Criteria

- Reference-agent and Qwen Code traces for the same scenario exist locally.
- The normalized comparison has no unexplained must-match differences.
- Qwen Code tests or smoke commands cover the fixed behavior.
- Any remaining mismatch is written down in the task notes or Qwen Code docs when it affects users.
