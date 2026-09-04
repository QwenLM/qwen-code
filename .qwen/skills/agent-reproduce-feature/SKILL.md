---
name: agent-reproduce-feature
description: Use when reproducing an existing Codex or Claude Code feature in Qwen Code or another agent CLI by choosing a reference agent, capturing HTTP request bodies, prompts, tool/function schemas, terminal output, and then implementing the matching behavior in the target repo.
---

# Agent Reproduce Feature

## Purpose

Use this skill to turn an observed feature from a reference agent into an implementation task for Qwen Code. The workflow treats the current session as the outer harness and runs a nested reference agent process as the program under test.

Default target repo: the current working directory. Use a user-specified path only when the user explicitly provides one.

## Reference Agent Selection

Start by selecting exactly one reference agent:

- `codex`: use nested Codex as the reference implementation.
- `claude-code`: use nested Claude Code as the reference implementation.

If the user did not choose one, ask once before capture. Then discover the local commands instead of assuming them:

```sh
command -v codex || true
command -v claude || command -v claude-code || true
```

Record the selected adapter in the run notes or scenario:

```json
{
  "reference_agent": "codex",
  "reference_interactive_command": "codex",
  "reference_headless_command": "codex exec",
  "target_agent": "qwen-code",
  "target_repo": "."
}
```

## Workflow

1. Define the feature surface in one sentence: command, trigger, expected UI/output, and a minimal prompt that exercises it.
2. Select `codex` or `claude-code` as the reference agent and discover its local launch command.
3. Inspect the target repo enough to identify the likely module boundaries and Qwen Code launch command before changing code.
4. Run the nested reference agent against the feature with capture enabled:
   - Local state capture via `scripts/capture_state.py` before and after the
     scenario.
   - HTTP/body capture via `scripts/run_with_mitm.sh`.
   - Terminal capture via `scripts/run_tmux_capture.sh` when the feature is interactive or TUI-visible.
   - Headless/non-interactive execution when the feature has a stable command-line path.
5. Extract behavioral facts from the trace:
   - system/developer prompt deltas relevant to the feature
   - request body shape, including `messages`, `tools`, `functions`, schemas, tool choice, model settings
   - visible terminal states and command output
   - local agent state changes, file edits, exit status, and error paths
6. Implement the smallest compatible behavior in Qwen Code using its existing patterns.
7. Add focused tests or a reproducible smoke command.
8. Hand off to `$agent-reproduce-align` when implementation exists and parity needs iteration.

Read `references/capture-workflow.md` before running capture for the first time in a session.

## Capture Defaults

Prefer a fresh output directory per run:

```sh
mkdir -p .repro-runs/slash-command-baseline
.qwen/skills/agent-reproduce-feature/scripts/run_with_mitm.sh \
  .repro-runs/slash-command-baseline \
  -- codex exec "exercise the Codex feature here"
```

For Claude Code, use the discovered headless command if available; otherwise use tmux:

```sh
.qwen/skills/agent-reproduce-feature/scripts/run_tmux_capture.sh \
  .repro-runs/slash-command-claude \
  claude
```

For interactive slash commands or terminal rendering, use tmux:

```sh
.qwen/skills/agent-reproduce-feature/scripts/run_tmux_capture.sh \
  .repro-runs/slash-command-tui \
  codex
```

The mitm script sets common proxy and CA variables for Node, Python, and curl-based CLIs. If TLS fails, read the certificate notes in `references/capture-workflow.md` and fix trust before interpreting missing traffic as product behavior.

Capture reference-agent state before and after a run:

```sh
.qwen/skills/agent-reproduce-feature/scripts/capture_state.py \
  snapshot .repro-runs/slash-command-baseline/state-before \
  --agent codex

# Run the reference scenario here.

.qwen/skills/agent-reproduce-feature/scripts/capture_state.py \
  snapshot .repro-runs/slash-command-baseline/state-after \
  --agent codex

.qwen/skills/agent-reproduce-feature/scripts/capture_state.py \
  diff \
  .repro-runs/slash-command-baseline/state-before \
  .repro-runs/slash-command-baseline/state-after \
  --out-dir .repro-runs/slash-command-baseline/state-diff
```

Use `--agent claude-code` to snapshot `~/.claude` instead of `~/.codex`.
Use `--root PATH` only for a custom state directory or tests.

## Implementation Rules

- Do not copy all captured prompt text into Qwen Code. Convert it into the minimum behavior, schema, or test needed.
- Treat captured request bodies as sensitive local artifacts. Redact tokens before saving examples into docs, commits, issues, or PRs.
- Treat state diffs as sensitive local artifacts too. The state tool redacts
  common token shapes and omits content for sensitive paths, but review
  `state-diff.md` before copying any excerpt into a tracked file.
- Keep the first implementation narrow: one feature, one trigger path, one observable parity target.
- Prefer compatibility tests that assert behavior over brittle tests that assert exact prompt wording.
- If a captured schema reveals a stable public contract, encode that contract as a typed structure or fixture in Qwen Code.

## Done Criteria

- A baseline reference-agent trace exists under `.repro-runs/` or an equivalent ignored/local path.
- Reference-agent state changes are captured or explicitly marked as not
  relevant for the scenario.
- Qwen Code contains a focused implementation and at least one verification path.
- Any user-visible command behavior is documented in Qwen Code if that repo already documents similar features.
- The next parity step can be run by `$agent-reproduce-align` without re-discovering the setup.
