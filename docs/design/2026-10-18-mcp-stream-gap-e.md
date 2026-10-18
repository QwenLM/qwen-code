# Hosted MCP fault gates FG12e: stream gaps

[English](2026-10-18-mcp-stream-gap-e.md) | [简体中文](2026-10-18-mcp-stream-gap-e.zh-CN.md)

## Problem and scope

Issue #14447 lists a public/WebShell stream disconnect/resume gate during a long MCP tool call and during a configuration replacement. This design finds that the MCP records emit no task events (the issue itself cites H1 design `:27`), the `ext://hold` fixture is a raw `resource_read` rather than a tool call, and the public/WebShell streams carry the Spring event store's turn/agent events, not MCP record events.

A standalone MCP stream gate would assert nothing MCP-specific. **Decision: fold FG12e into FG12f**; no standalone class and no new budget accounts.

## Current state

- The public stream is `GET /v1/agents/sessions/{sessionId}/events`, served by `ManagedEventStreamService`; it resumes with `Last-Event-ID` / `after`.
- The WebShell stream is `POST /api/agent/web-shell/v1/events/stream`, with `afterSequence` in the body; it has no `Last-Event-ID` header. The two routes are not one mechanism.
- Both streams replay the Spring event store (`ma_public_event` / event records), not the Harness journal. The Harness `/session/:id/events` is a third route.
- The MCP raw-operation fixture (`ext://hold`) produces no turn/tool events, so a disconnect/resume around it observes zero MCP events. A long MCP tool call with stream events would need a real model turn, which the Hosted fault-gate lane does not have.

## Ledger

No standalone FG12e ledger. A stream-resume case belongs to FG12f / turn delivery; this slice records the rationale and the route facts and does not create a vacuous gate.

## Decisions

1. **Fold FG12e into FG12f.** No `HostedMcpStreamFaultGatesIT`, no new fork-budget accounts, no `fg12e` evidence root.
2. **The public and WebShell streams differ.** The public route resumes by header; the WebShell route by body cursor. Do not write a single resume mechanism.
3. **The stream source is the Spring event store**, not the Harness journal; a witness must read the right sequence.
4. **A future turn-level stream-resume case needs a model/turn fixture.** The Hosted gate lane has none, so it is out of scope here.

## Acceptance

- The FG12f design records the fold and, if it wants a stream case, the model/turn prerequisite.
- This doc points at FG12f and does not claim an MCP stream gate.
- No new class, no budget change.

## Open questions

- Is a generic turn-level public/WebShell stream-resume gate worth a separate slice with a model?
- Does the WebShell route need its own resume contract in the FG12f design?
