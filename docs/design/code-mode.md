# Code Mode

[English](code-mode.md) | [简体中文](code-mode.zh-CN.md)

## Status

Implemented. The feature is experimental and opt-in.

## Problem

Qwen Code currently supports direct tool calls and `CodeModeOnly`. The latter
replaces ordinary top-level tools with `exec`, which is useful for orchestration
but prevents a model from choosing direct calls when they are clearer or more
efficient. Codex models this as three tool modes: direct, hybrid Code Mode, and
CodeModeOnly.

## Goal

Add a hybrid `CodeMode` option without changing the existing default or
`CodeModeOnly` behavior.

## Configuration

```json
{
  "tools": {
    "mode": "code_mode"
  }
}
```

The effective modes are:

| `tools.mode` value | Effective mode   |
| ------------------ | ---------------- |
| omitted / `direct` | `direct`         |
| `code_mode`        | `code_mode`      |
| `code_mode_only`   | `code_mode_only` |

This follows Codex's `ToolMode` serialized values. Safe mode and bare mode
force `direct`.

## Exposure policy

| Surface              | `direct`                 | `code_mode`                     | `code_mode_only` |
| -------------------- | ------------------------ | ------------------------------- | ---------------- |
| Ordinary eager tools | Direct                   | Direct and nested               | Nested only      |
| Deferred tools       | `tool_search`            | `tool_search` and nested        | Nested only      |
| Direct-control tools | Direct                   | Direct only                     | Direct only      |
| `exec`               | Not registered           | Direct                          | Direct           |
| Hidden bridge tools  | Existing direct behavior | Direct where already applicable | Hidden           |

In `code_mode`, ordinary visible tool descriptions gain an `exec` declaration
for that tool. The `exec` description keeps the complete `ALL_TOOLS` metadata
but does not duplicate every schema. Deferred tools gain their declaration when
their normal top-level declaration is revealed. In `code_mode_only`, the
existing behavior remains: all nested declarations live in the `exec`
description because no later top-level reveal is possible.

Filtered subagent declarations preserve the same mode. The agent's `tools`
list narrows its direct surface. Explicit ordinary-tool execution entries
narrow the nested set, while an inherited or explicitly allowed `exec` carries
all surviving code-mode-callable bindings.

## Constraints and risks

- Normal direct declarations must remain byte-for-byte unchanged in `direct`.
- Nested calls continue through the existing scheduler or ACP execution path;
  the mode must not bypass validation, permissions, hooks, cancellation, or
  telemetry.
- Duplicating every schema in hybrid mode would increase prompt size, so only
  the per-tool nested declaration is appended there.
- A denied or failed nested call aborts the whole `exec` program, so a call
  that may be refused should stay out of a batch that would need to be repeated.

## Validation

- Verify mode resolution and safe/bare-mode fallback.
- Verify direct, hybrid, and CodeModeOnly declaration surfaces.
- Verify filtered subagent declarations and nested allowlists.
- Run focused Core and CLI tests, then build and typecheck.

## Acceptance criteria

- `tools.mode: "code_mode"` registers `exec` while retaining ordinary direct
  tools and deferred discovery.
- Ordinary visible tools advertise their nested JavaScript signature.
- `tools.mode: "code_mode_only"` selects the stricter behavior.
- The default, safe-mode, and bare-mode surfaces remain direct-only.
