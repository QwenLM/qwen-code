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

Add a hybrid `CodeMode` option while preserving the direct default and the
strict `CodeModeOnly` exposure policy. Both code modes share the corrected
`exec` failure guidance and exact-name collision precedence described below.

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
force `direct`. Container execution exposes direct tools only: selecting
`code_mode` emits a warning and provides no `exec`; `code_mode_only` is rejected.

## Exposure policy

| Surface              | `direct`                    | `code_mode`                     | `code_mode_only` |
| -------------------- | --------------------------- | ------------------------------- | ---------------- |
| Ordinary eager tools | Direct                      | Direct and nested               | Nested only      |
| Deferred tools       | `tool_search` + `tool_call` | Bridge and nested               | Nested only      |
| Direct-control tools | Direct                      | Direct only                     | Direct only      |
| `exec`               | Not registered              | Direct                          | Direct           |
| Hidden bridge tools  | Existing direct behavior    | Direct where already applicable | Hidden           |

In `code_mode`, ordinary visible tool descriptions gain an `exec` declaration
for that tool. The `exec` description keeps the complete `ALL_TOOLS` metadata
without duplicating every schema. With both bridge tools available, `tool_search`
returns deferred parameter schemas without changing the top-level declarations.
Match each returned schema name exactly to `ALL_TOOLS.name`, then invoke
`tools[entry.jsName]` with arguments shaped by that schema. If there is no entry,
do not normalize or guess a binding; use `tool_call` outside `exec`, or an
available direct tool, subject to normal validation and approval.

When either bridge half is absent or the agent surface is filtered, `exec`
includes signatures for nested tools whose schemas are otherwise unavailable.
In `code_mode_only`, all nested declarations live in the `exec` description.
Both bridge tools are hidden, deferred reminders and the incomplete-bridge
warning are skipped, and on the session surface `tools.eager` /
`tools.visible` do not reduce those nested schemas. Callable tools remain
available through `exec`. An AgentCore surface (subagent, headless agent,
arena) narrows the nested binding set by its own allowlist, so a tool demoted
by `tools.eager` has no nested binding there.

Nested bindings prefer an exact canonical JavaScript name over names rewritten
to that property. Other collisions retain canonical-name ordering; omitted
bindings remain absent from nested signatures and are never advertised as
reachable through `exec`.

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
- A denied or failed nested call rejects its promise. An uncaught rejection
  aborts `exec`; catching an expected rejection lets the program continue. Keep
  calls that may be refused out of a batch that would need to be repeated.

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
- Both code modes dispatch an exact canonical name to that tool under a
  normalization collision and describe caught versus uncaught failures accurately.
- Context accounting charges only emitted declarations; container fallback and
  withheld-tool warnings describe the actual available bindings.
