---
name: codex-reproduce-feature
description: Use when reproducing an existing Codex feature in Qwen Code or another agent CLI by running Codex as the reference implementation, capturing HTTP request bodies, prompts, tool/function schemas, terminal output, and then implementing the matching behavior in the target repo.
---

# Codex Reproduce Feature

## Purpose

Use this skill to turn an observed Codex feature into an implementation task for Qwen Code. The workflow treats the current Codex session as the outer harness and runs a nested Codex process as the reference program under test.

Default target repo: the current working directory. Use a user-specified path only when the user explicitly provides one.

## Workflow

1. Define the feature surface in one sentence: command, trigger, expected UI/output, and a minimal prompt that exercises it.
2. Inspect the target repo enough to identify the likely module boundaries before changing code.
3. Run nested Codex against the feature with capture enabled:
   - HTTP/body capture via `scripts/run_with_mitm.sh`.
   - Terminal capture via `scripts/run_tmux_capture.sh` when the feature is interactive or TUI-visible.
   - Headless/non-interactive execution when the feature has a stable command-line path.
4. Extract behavioral facts from the trace:
   - system/developer prompt deltas relevant to the feature
   - request body shape, including `messages`, `tools`, `functions`, schemas, tool choice, model settings
   - visible terminal states and command output
   - file edits, exit status, and error paths
5. Implement the smallest compatible behavior in Qwen Code using its existing patterns.
6. Add focused tests or a reproducible smoke command.
7. Hand off to `$codex-reproduce-align` when implementation exists and parity needs iteration.

Read `references/capture-workflow.md` before running capture for the first time in a session.

## Capture Defaults

Prefer a fresh output directory per run:

```sh
mkdir -p .repro-runs/slash-command-baseline
skills/codex-reproduce-feature/scripts/run_with_mitm.sh \
  .repro-runs/slash-command-baseline \
  -- codex exec "exercise the Codex feature here"
```

For interactive slash commands or terminal rendering, use tmux:

```sh
skills/codex-reproduce-feature/scripts/run_tmux_capture.sh \
  .repro-runs/slash-command-tui \
  codex
```

The mitm script sets common proxy and CA variables for Node, Python, and curl-based CLIs. If TLS fails, read the certificate notes in `references/capture-workflow.md` and fix trust before interpreting missing traffic as product behavior.

## Implementation Rules

- Do not copy all captured prompt text into Qwen Code. Convert it into the minimum behavior, schema, or test needed.
- Treat captured request bodies as sensitive local artifacts. Redact tokens before saving examples into docs, commits, issues, or PRs.
- Keep the first implementation narrow: one feature, one trigger path, one observable parity target.
- Prefer compatibility tests that assert behavior over brittle tests that assert exact prompt wording.
- If a captured schema reveals a stable public contract, encode that contract as a typed structure or fixture in Qwen Code.

## Done Criteria

- A baseline Codex trace exists under `.repro-runs/` or an equivalent ignored/local path.
- Qwen Code contains a focused implementation and at least one verification path.
- Any user-visible command behavior is documented in Qwen Code if that repo already documents similar features.
- The next parity step can be run by `$codex-reproduce-align` without re-discovering the setup.
