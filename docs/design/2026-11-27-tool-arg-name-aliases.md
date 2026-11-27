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
9274 tool calls (27 %) in 142 sampled trials on schema errors. 2412 of them
(96 %) were `read_file`, `write_file` or `edit` with `path` instead of
`file_path`; about 90 more were `edit` with `old_str` / `new_str` instead of
`old_string` / `new_string`. 2462 of the 2464 `path` values were absolute. The
model did switch to `file_path` after an error in 103 of the 133 trials that
had one, then went back to `path`: a clearer message alone does not fix this
model.

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

### Unknown arguments in schema errors

`BaseDeclarativeTool.validateToolParams` appends to a schema error the
top-level keys of the call that its schema does not declare, and the declared
ones:

```
params must have required property 'pattern'. Unrecognized parameters: query. Accepted parameters: pattern, glob, path, limit.
```

Schemas without top-level `properties`, or with `patternProperties` or an
`additionalProperties` other than `false`, get no note. A closed schema
(`additionalProperties: false`) does get one: Ajv reports
`must NOT have additional properties` without naming the key. The note is added only to an error that
validation already reports; a valid call with an extra key stays valid.

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
unchanged); the note on and off. The `tool_call` bridge only reaches deferred
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
