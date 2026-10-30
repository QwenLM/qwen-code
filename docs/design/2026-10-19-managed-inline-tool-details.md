# Managed tool details on expansion

[English](2026-10-19-managed-inline-tool-details.md) | [简体中文](2026-10-19-managed-inline-tool-details.zh-CN.md)

## Problem and scope

Managed lifecycle events carry names and statuses, while saved tool arguments, output and errors remain in private committed history. Failed ReadFile cards therefore expand without diagnostics and successful Shell cards show unavailable output. Elapsed time also caused an empty execution-details section.

ReadFile and Shell details should be loaded only when a user expands a settled card. Preparing every result for display must not scan preceding history or copy private text into lifecycle events. This change preserves tool execution, path validation, Runtime selection and the independent O3 Artifact publication/download policies.

## Read policy and ownership

Contract version `1.70.0` adds `POST /api/agent/web-shell/v1/tool-details/get`, using the existing Session/Item request. It is a persisted Workspace-scoped read: require a trusted actor, current Session visibility and Workspace read grant, and recheck them before returning. Responses use `Cache-Control: private, no-store`. The route never starts a Harness, acquires a Runtime, executes a command or falls back to another Workspace.

Any authorized Session/Workspace reader may read these bounded tool details without a feature switch. Artifact publication and original-download permissions remain independent; no extra publication switch or object storage is required. Saved text can contain sensitive content and is not automatically redacted.

Existing inline data and approved O3 previews retain their current rendering. New lifecycle events contain no detail text or arguments, and the server does not backfill public events.

## Retained history and bounds

Resolve the persisted Item and Turn to the original prompt, tool name and call ID. Support only `read_file` and `run_shell_command`, and match the exact Session, Workspace, prompt, call ID and name in committed assistant/result messages. Read validation errors even when no execution receipt exists. Preserve both saved output and error text, and distinguish missing text from an explicitly recorded empty string.

Keep a lifecycle source sequence in new Items/events. Resolve legacy Items from a retained public event source key. Use the newer Item/event sequence to start at that tool's journal transaction; newer Turns cannot displace old results from the scan window. A later committed result invalidates an already opened card's read even if its status is unchanged. With no retained pointer, the bounded search starts at the journal head. Missing or pruned history stays unavailable.

Each query scans at most 512 journal transactions and reads at most 8 MiB of journal/message bytes. Reject oversized journal rows before transferring them. Verify the journal digest and each committed resource reference; support ordinary and chunked messages. This is a bounded lookup performed only on expansion, not a constant-time index or a reconstruction of removed data.

Return only scalar display arguments: `file_path`, `path` for ReadFile, and `command`, `directory`, `timeout` for Shell. Filter unknown fields and malformed scalar types. Omit arguments exceeding 4 KiB instead of marking otherwise complete output truncated. Bound saved text to 8 KiB and 200 lines, reporting both local and upstream output truncation. Media, private capture references and raw stdout/stderr downloads remain outside this route.

For Shell, also return optional `shellResult` from the matching committed record's `toolCallResult.resultDisplay`, requiring the same call ID and an exact matching function response. Use the existing version-1 `ShellResultDisplay` shape: output/display text, directory, nullable safe-integer exit code/signal/PID, nullable error, outcome, notices, truncation and output-file paths. Validate field types and outcome, allow at most 32 notices and 32 paths, and copy only those display fields. Divide a separate combined 8 KiB/200-line text budget between output, display text, error and notices; directory and output-file paths share an 8 KiB UTF-8 budget. Preserve saved truncation and flag additional shortening. Invalid, unsupported, oversized-path or mismatched displays fall back to legacy text. Keep the existing `output` field for older clients; if response text is missing, use the saved display text. Reading structure uses the same private message and adds no history scan or publication.

## Client behavior

The Managed transcript supplies a detail loader to ReadFile/Shell cards. Closed cards issue no detail requests. An expanded settled card missing input or output shows a loading state, reads its own Session/Item, then reuses existing renderers. Already available input/output need no additional read. Missing output has an unavailable hint; recorded empty output has a distinct empty hint. ReadFile and Shell share the recorded-output check for empty text blocks and opaque raw results.

Closing a card or changing provider, Session or tool identity aborts outstanding reads. Check response identity and lifecycle revision before display so a late response cannot expose another Session's content. A newer completion source sequence reloads details even when a terminal receipt arrived first. Shell execution details render only when actual rows exist; elapsed time remains in the status header.

Pass a loaded `shellResult` unchanged as `rawOutput` to the shared daemon Shell renderer. It takes precedence over an existing plain-text preview when a detail read occurs, so the existing card displays execution metadata, errors and notices with its normal success/failure/timeout/cancellation semantics. With no valid structure, retain the legacy text behavior. Existing complete inline input/output still needs no extra request; this does not introduce live output or attempt to infer execution fields from text.

## Validation and acceptance

- Before expansion, no detail HTTP request, preceding-history argument lookup or inline detail publication occurs.
- Expanding saved failed ReadFile and completed Shell cards shows their own diagnostics, command and output; refresh and reopen work without executing a tool.
- Old retained results work without public backfill; empty, missing and truncated results remain distinguishable.
- Obsolete feature-switch configuration cannot disable authorized reads.
- Wrong tenants, missing actors, revoked Workspace grants, deleting Sessions and unsupported tools return no private details.
- Exact matching, corruption, chunked resources, byte limits, allowlisted arguments, late results and cancelled/stale client requests have focused coverage.
- Saved structured Shell results reach the shared renderer with execution metadata intact; malformed/wrong-call displays fall back to text, unknown private fields never leave the route, and combined text/path budgets are enforced. Browser checks cover success, failure, timeout and cancellation while preserving lazy requests.
- Run root build/typecheck/bundle, affected producer/reducer/component and browser checks, API/surface contract tests, Maven verification and disposable MySQL 8.4 integration checks. Do not send a prompt to the user's running Session or modify its database.

## Limits

Retain private committed results as before; this change delays their display read rather than their persistence. The first expansion adds one HTTP round trip. Deep or large histories exceeding the fixed read budget remain unavailable. Live output, detached-task artifacts, media, raw capture traversal, new indexes and reconstructing pruned history are outside this fix.
