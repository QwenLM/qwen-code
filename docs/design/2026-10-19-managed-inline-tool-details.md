# Managed tool details on expansion

[English](2026-10-19-managed-inline-tool-details.md) | [简体中文](2026-10-19-managed-inline-tool-details.zh-CN.md)

## Problem and scope

Managed lifecycle events carry names and statuses, while saved tool arguments, output and errors remain in private committed history. Failed ReadFile cards therefore expand without diagnostics and successful Shell cards show unavailable output. Elapsed time also caused an empty execution-details section.

ReadFile and Shell details should be loaded only when a user expands a settled card. Preparing every result for display must not scan preceding history or copy private text into lifecycle events. This change preserves tool execution, path validation, Runtime selection and the independent O3 Artifact publication/download policies.

## Read policy and ownership

Add `POST /api/agent/web-shell/v1/tool-details/get`, using the existing Session/Item request. It is a persisted Workspace-scoped read: require a trusted actor, current Session visibility and Workspace read grant, and recheck them before returning. Responses use `Cache-Control: private, no-store`. The route never starts a Harness, acquires a Runtime, executes a command or falls back to another Workspace.

The read is enabled by default. Administrators can disable it with `qwen.managed-agent.harness.tool-details-enabled=false`, or `QWEN_MANAGED_AGENT_TOOL_DETAILS_ENABLED=false`. Any authorized Session/Workspace reader may read these bounded tool details. Artifact publication and original-download permissions remain independent; no extra publication switch or object storage is required. Saved text can contain sensitive content and is not automatically redacted.

Disabling the setting denies new detail requests. It does not remove previously published inline history or change approved O3 previews. Existing inline data retains its current rendering. New lifecycle events contain no detail text or arguments, and the server does not backfill public events.

## Retained history and bounds

Resolve the persisted Item and Turn to the original prompt, tool name and call ID. Support only `read_file` and `run_shell_command`, and match the exact Session, Workspace, prompt, call ID and name in committed assistant/result messages. Read validation errors even when no execution receipt exists. Preserve both saved output and error text, and distinguish missing text from an explicitly recorded empty string.

Keep a lifecycle source sequence in new Items/events. Resolve legacy Items from a retained public event source key. Use the newer Item/event sequence to start at that tool's journal transaction; newer Turns cannot displace old results from the scan window. A later committed result invalidates an already opened card's read even if its status is unchanged. With no retained pointer, the bounded search starts at the journal head. Missing or pruned history stays unavailable.

Each query scans at most 512 journal transactions and reads at most 8 MiB of journal/message bytes. Reject oversized journal rows before transferring them. Verify the journal digest and each committed resource reference; support ordinary and chunked messages. This is a bounded lookup performed only on expansion, not a constant-time index or a reconstruction of removed data.

Return only scalar display arguments: `file_path`, `path`, `offset`, `limit` for ReadFile, and `command`, `directory`, `timeout` for Shell. Filter unknown fields and malformed scalar types. Omit arguments exceeding 4 KiB instead of marking otherwise complete output truncated. Bound saved text to 8 KiB and 200 lines, reporting both local and upstream output truncation. Media, private capture references and raw stdout/stderr downloads remain outside this route.

## Client behavior

The Managed transcript supplies a detail loader to ReadFile/Shell cards. Closed cards issue no detail requests. An expanded settled card missing input or output shows a loading state, reads its own Session/Item, then reuses existing renderers. Already available input/output need no additional read. Missing output has an unavailable hint; recorded empty output has a distinct empty hint.

Closing a card or changing provider, Session or tool identity aborts outstanding reads. Check response identity and lifecycle revision before display so a late response cannot expose another Session's content. A newer completion source sequence reloads details even when a terminal receipt arrived first. Shell execution details render only when actual rows exist; elapsed time remains in the status header.

## Validation and acceptance

- Before expansion, no detail HTTP request, preceding-history argument lookup or inline detail publication occurs.
- Expanding saved failed ReadFile and completed Shell cards shows their own diagnostics, command and output; refresh and reopen work without executing a tool.
- Old retained results work without public backfill; empty, missing and truncated results remain distinguishable.
- Wrong tenants, missing actors, revoked Workspace grants, deleting Sessions, disabled reads and unsupported tools return no private details.
- Exact matching, corruption, chunked resources, byte limits, allowlisted arguments, late results and cancelled/stale client requests have focused coverage.
- Run root build/typecheck/bundle, affected producer/reducer/component and browser checks, API/surface contract tests, Maven verification and disposable MySQL 8.4 integration checks. Do not send a prompt to the user's running Session or modify its database.

## Limits

Retain private committed results as before; this change delays their display read rather than their persistence. The first expansion adds one HTTP round trip. Deep or large histories exceeding the fixed read budget remain unavailable. Live output, detached-task artifacts, media, raw capture traversal, new indexes and reconstructing pruned history are outside this fix.
