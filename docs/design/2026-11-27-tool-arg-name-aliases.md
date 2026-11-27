# Tool argument name aliases

[English](2026-11-27-tool-arg-name-aliases.md) | [简体中文](2026-11-27-tool-arg-name-aliases.zh-CN.md)

Status: proposed (2026-11-27).

## Problem

Some models name tool arguments after another harness's tools. The file tools
take `file_path`, and a model that sends `read_file {"path": "/repo/a.py"}`
reads nothing: schema validation fails and the model gets
`params must have required property 'file_path'`. The message names the
missing argument but not the one the model sent, which validation ignores.

On the Harness Leaderboard, Qwen Code 0.25.2 with the Flint model spent 2518 of
9274 tool calls (27 %) in 142 sampled trials on schema errors. With the aliases
below, 2375 of those calls (94 %) pass validation as sent; nearly all are
`read_file`, `write_file` or `edit` with `path` instead of `file_path`, a few
are `edit` with `old_str` / `new_str`. Most of the other 143 lack a required
argument altogether (`edit` without `new_string`). 2462 of the 2464 `path`
values were absolute. The model switched to `file_path` after an error in 104
of the 133 trials that had one, and 95 of those went back to `path` later: a
clearer message alone does not fix this model.

Measured on the current CLI (0.28.7) against a mock: every wrong name on every
tool gets only the missing-property text; an unknown key next to the right one
is ignored. Seven Bailian models (qwen3.7-plus, qwen3.8-flash, qwen-flash,
qwen-plus, qwen3-coder-flash, glm-5, deepseek-v4.1-flash) switched to
`file_path` on the next round after one injected `path` error.

## Goals

- A file-tool call that names its path `path` runs as if it had said
  `file_path`; the same for `edit`'s `old_str` / `new_str`.
- Every consumer after intake (permission checks, hooks, the Agent Host guard,
  checkpoints, telemetry, the invocation) sees the canonical names.
- A schema error names the arguments the tool did not recognise and lists the
  ones it accepts.

Not goals: guessing other names, aliases for MCP or other tools, a setting,
changing the schemas the model sees, the hosted workspace file tools (they
validate `file_path` on their own and say so).

## Design

### Aliases at tool intake

A table in core maps tool → alias → canonical name:

| Tool         | Alias     | Canonical    |
| ------------ | --------- | ------------ |
| `read_file`  | `path`    | `file_path`  |
| `write_file` | `path`    | `file_path`  |
| `edit`       | `path`    | `file_path`  |
| `edit`       | `old_str` | `old_string` |
| `edit`       | `new_str` | `new_string` |

`CoreToolScheduler` clones the arguments at intake. After resolving the tool,
including nested calls through the `tool_call` bridge, it applies aliases to
the clone. When the alias is present and the canonical name is absent, it
moves the value to the canonical name and drops the alias. When both are
present, the canonical name wins. Legacy tool names resolve before lookup.
Discovered tools keep the argument names from their own schemas.

Headless, Ink, OpenTUI, subagents and ACP on the shared loop use
`CoreToolScheduler`. Legacy ACP dispatches directly and applies the same table
to its own copy after bridge resolution, before hooks and argument-dependent
permission checks.
Both routes keep the model's own call in chat history for duplicate-replay
fingerprints.

Applying the aliases in the tool's `build` instead would leave `request.args`
with `path`: the Ink and OpenTUI edit checkpoints read `request.args.file_path`
and would skip such an edit, so it could not be rewound.

Arguments that replace a call's arguments after intake (a PreToolUse hook's
`updatedInput`, an edit in the external editor, a policy gate) are not aliased
again: they start from the canonical arguments, and a hook that writes `path`
back gets today's schema error.

### History readers

The read-residency check in the chat, microcompaction's evicted read paths and
post-compaction file restoration apply the same table to copies of the call
arguments. Microcompaction trims and unescapes the path as the file tool does,
so it invalidates the cache entry for the file whose result it cleared.
Post-compaction restoration normalizes bridged tool names before looking up
aliases. Session export counts writes and edits by the tool result's resolved
path, with the recorded `file_path` and the basename as fallbacks for older
records. This keeps same-named files in different directories distinct.

### Unknown arguments in schema errors

`BaseDeclarativeTool.validateToolParams` appends to a schema error the
top-level keys of the call that its schema does not declare, and the declared
ones:

```
params must have required property 'pattern'. Unrecognized parameters: query. Accepted parameters: pattern, glob, path, limit.
```

Omitting `additionalProperties` or setting it to `false` can allow the note.
Schemas without top-level `properties`, with an explicit
`additionalProperties` value other than `false`, or with a keyword that can
accept other keys
(`patternProperties`, `allOf`, `anyOf`, `oneOf`, `$ref`, `if`,
`dependentSchemas`, `dependencies`, `unevaluatedProperties`) skip the note.
With `additionalProperties` omitted, a key in `required` outside `properties`
also suppresses the note. For a closed schema, the note can name the extra
keys behind Ajv's `must NOT have additional properties` error. The note is
added only when schema validation reports an error. Tools such as `agent`
continue to produce their own parameter validation errors.

The note lives in the tool layer rather than in `SchemaValidator`, whose error
text other callers share.

## Risks

- A model that sends both `path` and `file_path` with different values keeps
  today's behaviour: `file_path` wins.
- The note adds a line to errors read by tests and by any client that matches
  the exact text. Tests that pin the text are updated.
- The table is a fixed list. A new harness convention needs a code change; that
  keeps the behaviour predictable.

## Validation

Unit tests cover alias normalization before hooks in the scheduler and legacy
ACP, raw history arguments, cache eviction and restoration for direct and
bridged calls, session export, and schema hints for closed, composed and
required-only keys. The bridged history fixtures represent file tools that
`tools.eager` can defer.

The [E2E report](https://github.com/QwenLM/qwen-code/pull/18500#issuecomment-7211299701)
records the mock model setup and the initial CLI, ACP and subagent results.
The acceptance cases include the following:

- headless: `read_file {"path": …}` reads the file; `write_file` and `edit`
  with `path`, `old_str`, `new_str` change the file;
- `run_shell_command {"cmd": …}` gets the note naming `cmd` and `command`;
- non-yolo: a `write_file {"path": …}` asks for approval with the file shown;
- a deny rule on the file still denies the `path` call;
- a PreToolUse hook sees `file_path`;
- ACP on both the default and legacy loops and a subagent read a file with
  `path`.

## Acceptance criteria

- The calls above behave as listed; the history keeps the model's `path`.
- Build, typecheck and the touched unit tests pass.
