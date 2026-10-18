# Managed inline tool details

[English](2026-10-19-managed-inline-tool-details.md) | [简体中文](2026-10-19-managed-inline-tool-details.zh-CN.md)

Status: implemented; verified with isolated projection, H2 persistence and
Chromium transcript-replay fixtures. Full Runtime acceptance remains out of scope.

## Problem and scope

Managed tool lifecycle events carry names and statuses, while saved model-facing
arguments, output and errors stay private. Without O3 publication, a failed
ReadFile expands into a blank card and Shell cannot display its command/output.
Elapsed time also incorrectly makes an empty Shell execution-details list visible.

This change supports bounded inline details for exactly `read_file` and
`run_shell_command`. It does not change tool execution, path validation, Runtime
selection, permissions, raw captures, downloads or O3 publication verification.
Other tools remain metadata-only. A failed absolute-path read remains failed;
showing its diagnostic does not authorize that path.

## Publication and authorization

`qwen.managed-agent.harness.tool-details-enabled` defaults to `false` and can be
set through `QWEN_MANAGED_AGENT_TOOL_DETAILS_ENABLED=true`. Enabling it is an
explicit deployment decision to publish tool arguments and model-facing text,
including file contents, commands and errors, to **every authorized reader of
the Session**. This is a separate inline publication policy, not a secret
redactor, Artifact policy or per-actor debug permission.

The authenticated private Harness feed already transports committed messages.
It adds a bounded display projection from those same messages. Java independently
checks the deployment policy, tool-name/field allowlists and size bounds before
persisting the display fields in existing `item.tool_call.updated` events and
Items. The default remains metadata-only even with an upgraded Harness. Existing
Session/Workspace read authorization protects both transcript and SSE reads.

Published details become durable Session content. Disabling the setting stops
future publication; it cannot retract already published events. Enabling it does
not backfill already consumed metadata-only events. Old cards therefore show an
unavailable message until a separate, authorized backfill is designed. Original
O3 capture publication and download policies remain independent and unchanged.

## Projection and bounds

The model call ID and existing public Item identity remain unchanged. Intents
can carry the original arguments; committed tool-result messages carry output
and errors, including validation failures that never created an execution
receipt. A result can reuse arguments only from the latest preceding assistant
batch for the same prompt and matching call ID/name. There is no live Runtime
read, capture traversal, new public endpoint or execution replay.

Input contains only scalar display fields: `command`, `directory`, `timeout`,
`file_path`, `path`, `offset` and `limit`, as appropriate to the tool. Input JSON
is at most 4 KiB; output JSON is at most 8 KiB. Text truncation respects Unicode
code points and JSON escaping. `truncated=true` marks bounded previews. Output
uses only saved textual `output` and `error`; it does not copy private capture
references, transport headers/credentials, media or arbitrary outcome fields.
The approved text itself can contain sensitive data. Java drops malformed or
oversize fields independently. This display projection is not an O3 ToolResult
or an Artifact availability claim.

## UI behavior

The existing Managed reducer receives `input`, `output` and `truncated` and
preserves them in transcript replay. ReadFile displays saved errors, a clear
unavailable hint for missing details, and a distinct empty-output hint for an
explicitly empty result. Shell keeps command/output and elapsed status visible;
its execution-details section exists only when it has actual rows to display.
Existing structured Shell results and approved O3 result summaries keep their
existing rendering and lifecycle semantics.

## Validation and acceptance

Reproduce the missing fields and empty panels before changing production code.
Cover default-deny, supported tools, call matching, validation errors, empty
output, escaping/Unicode bounds and replay without executing tools. Verify the
Java policy and persisted event/Item projection using isolated fixtures, and
check browser render/reload against an isolated UI. Run affected tests, root
build/typecheck/bundle and Maven verification. Do not test by running commands in
the user's Session or resetting its database.

Acceptance requires visible saved ReadFile diagnostics and Shell arguments/output
when publishing is approved, no new disclosure with policy off, and no blank
expanded panels when historic details are unavailable. Full Hosted/fault,
Linux isolation, remote execution and upstream-model validation are outside this
display fix; their success must not be inferred from projection tests.
