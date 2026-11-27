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

### Aliases at scheduler intake

A table in core maps tool → alias → canonical name:

| Tool         | Alias     | Canonical    |
| ------------ | --------- | ------------ |
| `read_file`  | `path`    | `file_path`  |
| `write_file` | `path`    | `file_path`  |
| `edit`       | `path`    | `file_path`  |
| `edit`       | `old_str` | `old_string` |
| `edit`       | `new_str` | `new_string` |

`CoreToolScheduler` already clones each request's `args` at intake, after the
`tool_call` bridge resolves a nested call. The aliases are applied to that
clone: when the canonical name is absent and the alias is present, the value
moves to the canonical name and the alias key is dropped. When both are
present nothing changes (the extra key is ignored, as today). The tool name is
resolved with `canonicalToolName`, so legacy names are covered.

Every execution path (headless, Ink, OpenTUI, ACP sessions, subagents, the
shared agent loop) schedules through `CoreToolScheduler`, so one place covers
them. The chat history keeps the model's own call, so duplicate-replay
fingerprints, which read history, do not change.

Applying the aliases in the tool's `build` instead would leave `request.args`
with `path`: the Ink and OpenTUI edit checkpoints read `request.args.file_path`
and would skip such an edit, so it could not be rewound.

Arguments that replace a call's arguments after intake (a PreToolUse hook's
`updatedInput`, an edit in the external editor, a policy gate) are not aliased
again: they start from the canonical arguments, and a hook that writes `path`
back gets today's schema error.

### History readers

Three places read a file path from the call as the chat history holds it, so
they would see `path`: the read-residency check in the chat (a read whose path
it cannot find is treated as unresolved, which is safe), microcompaction's
list of evicted read paths, and the file list restored after compaction. A
`path` read now runs and arms the read cache, so microcompaction must report
its path when it clears the result; otherwise a later read could be answered
as unchanged while its content is gone from the history. These readers take
the call's arguments through the same table, on a copy.

### Unknown arguments in schema errors

`BaseDeclarativeTool.validateToolParams` appends to a schema error the
top-level keys of the call that its schema does not declare, and the declared
ones:

```
params must have required property 'pattern'. Unrecognized parameters: query. Accepted parameters: pattern, glob, path, limit.
```

Schemas without top-level `properties`, with an `additionalProperties` other
than `false`, or with a keyword that can accept other keys
(`patternProperties`, `allOf`, `anyOf`, `oneOf`, `$ref`, `if`,
`dependentSchemas`, `dependencies`, `unevaluatedProperties`) get no note, so
an argument declared in a branch is never called unrecognised. A closed schema
(`additionalProperties: false`) does get one: Ajv reports
`must NOT have additional properties` without naming the key. The note is
added only to an error that validation already reports; a valid call with an
extra key stays valid. Tools that validate their parameters themselves (the
`agent` tool does) are not affected.

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

Unit tests: the alias function; scheduler intake (the tool, the PreToolUse
hook and the scheduled request see `file_path`; the caller's args are
unchanged); microcompaction and the post-compaction file list with a `path`
call; the note on and off, including closed and composed schemas. The `tool_call` bridge only reaches deferred
tools, and the file tools are not deferred, so it needs no case of its own.

End to end against a mock (`.qwen/e2e-tests/tool-arg-name-aliases/`):

- headless: `read_file {"path": …}` reads the file; `write_file` and `edit`
  with `path`, `old_str`, `new_str` change the file;
- `run_shell_command {"cmd": …}` gets the note naming `cmd` and `command`;
- non-yolo: a `write_file {"path": …}` asks for approval with the file shown;
- a deny rule on the file still denies the `path` call;
- a PreToolUse hook sees `file_path`;
- an ACP session and a subagent read a file with `path`.

## Acceptance criteria

- The calls above behave as listed; the history keeps the model's `path`.
- Build, typecheck and the touched unit tests pass.
