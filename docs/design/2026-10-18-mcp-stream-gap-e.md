# Hosted MCP fault gates FG12e: stream gaps

[English](2026-10-18-mcp-stream-gap-e.md) | [简体中文](2026-10-18-mcp-stream-gap-e.zh-CN.md)

## Problem and scope

Issue #14447 lists a public/WebShell stream disconnect/resume gate during a long MCP tool call and during a configuration replacement. This design finds that the MCP records emit no task events (the issue itself cites H1 design `:27`), the `ext://hold` fixture is a raw `resource_read` rather than a tool call, and the public/WebShell streams carry the Spring event store's turn/agent events, not MCP record events.

A standalone gate around the raw operation observes no events; the lane's model/tool path can drive an MCP tool call. **Decision: defer the stream assertions to FG12f**, reusing the existing model/tool fixture; no standalone class and no new budget accounts.

## Current state

- The public stream is `GET /v1/agents/sessions/{sessionId}/events`, served by `ManagedEventStreamService`; it resumes with `Last-Event-ID` / `after`.
- The WebShell stream is `POST /api/agent/web-shell/v1/events/stream`, with `afterSequence` in the body; it has no `Last-Event-ID` header. The two routes are not one mechanism.
- Both streams replay the Spring event store (`ma_public_event` / event records), not the Harness journal. The Harness `/session/:id/events` is a third route.
- The MCP raw-operation fixture (`ext://hold`) produces no turn/tool events. The lane does have model-driven turns: `HostedExtensionsIT.modelReply()` emits `tool_calls` for the discovered MCP tool and submits turns through the public events API; the FG12c rig starts a local model server and drives a baseline prompt. `HostedMcpRestartFaultGatesIT.modelReply()` (FG12c) emits `FG12C_DONE`; `HostedMcpReplyLossIT` (FG12a) emits `FG12_DONE`. Neither stub emits `tool_calls`; `HostedExtensionsIT.modelReply()` does, so a tool call needs that path or a stub that emits one.

## Ledger

No standalone FG12e ledger. A stream-resume case belongs to FG12f / turn delivery; this slice records the rationale and the route facts and does not create a vacuous gate.

## Decisions

1. **Fold FG12e into FG12f.** No `HostedMcpStreamFaultGatesIT`, no new fork-budget accounts, no `fg12e` evidence root.
2. **The public and WebShell streams differ.** The public route resumes by header; the WebShell route by body cursor. Do not write a single resume mechanism.
3. **The stream source is the Spring event store**, not the Harness journal; a witness must read the right sequence.
4. **The deferral is a scope choice, not a missing fixture.** The existing model/tool path can drive a stream-resume case; FG12f should reuse `HostedExtensionsIT.modelReply()` (tool_calls) or teach the stub to emit a tool call, not budget a new model fixture.

## Acceptance

- The FG12f design records the deferral and reuses the existing model/tool fixture for any stream case.
- This doc points at FG12f and does not claim an MCP stream gate.
- No new class, no budget change.

## Open questions

- Is a generic turn-level public/WebShell stream-resume gate worth a separate slice, given the existing model/tool fixture?
- Does the WebShell route need its own resume contract in the FG12f design?
