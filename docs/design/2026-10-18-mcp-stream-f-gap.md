# Hosted MCP fault gates FG12f: stream gaps during a tool call

[English](2026-10-18-mcp-stream-f-gap.md) | [简体中文](2026-10-18-mcp-stream-f-gap.zh-CN.md)

## Problem and scope

Issue #14447 asks for a public/WebShell stream disconnect-and-resume gate during a long MCP tool call and during a configuration replacement. FG12e established that the MCP raw-operation fixture produces no task events, so the gate has to ride the model-driven tool-call path; this slice is that gate and the last letter of the round.

The observable contract under test is the Spring event store's sequence: a client that disconnects after some event and reconnects with its last seen cursor must receive the rest exactly once, with no gap and no duplicate, while the in-flight MCP tool call completes exactly once.

## Current state

- The public stream is `GET /v1/agents/sessions/{sessionId}/events`; `stream=true` or `Accept: text/event-stream` selects SSE. The cursor comes from the `Last-Event-ID` header, or the `after` query parameter when the header is absent. Frames carry `id` (sequence), `event` (type) and a JSON `data` body whose `sequence` equals the frame id.
- The WebShell stream is `POST /api/agent/web-shell/v1/events/stream` with `sessionId` and `afterSequence` in the body. It has no header cursor; the two routes are separate mechanisms.
- Both streams replay the Spring event store, not the Harness journal.
- `HostedExtensionsIT.modelReply()` already emits `tool_calls` for the discovered MCP tool and submits turns through the public events API. `HostedSessionRelayFaultGatesIT` already has an SSE observer that validates each frame's `id`/`event` against its `data.sequence` and can be closed and reopened with a cursor.
- The MCP fixture's only tool, `append`, answers immediately, so it cannot hold a call open across a disconnect.

## Decisions

1. **One new class, three cases.** The gate is `HostedMcpStreamGapIT` with a public-route case, a WebShell-route case and a configuration-replacement case. No new fixture account and no new budget account beyond the class itself.
2. **Teach the existing fixture to hold, keyed by the tool argument.** The `append` tool answers `value: "EXT_HOLD"` only after a release marker appears in its work directory, and records the wait. Every other value keeps its current behaviour, so the existing extension gates are untouched.
3. **Two resume mechanisms, two cases.** The public case resumes with `Last-Event-ID`; the WebShell case resumes with `afterSequence`. A single case would pin one mechanism and silently cover the other.
4. **The assertion is the union across connections.** For each route the case asserts: no sequence appears on both connections, the sequences seen after the resume are strictly greater than the last one seen before it, and the tool result event appears exactly once in the union. A resume that replays or skips fails all three shapes differently, so the case cannot pass on a cursor that is ignored.
5. **Replacement rides the same held call.** The third case commits a new MCP server revision to the Agent while the call is held, then releases it: the stream stays contiguous across the replacement, the in-flight call's result is not lost, the running Session stays pinned to the revision it started on, and the fixture's physical append happens exactly once. The Harness-private configuration route cannot carry this: it requires the client id the Broker mints for its own Session, which a Spring-created Session never exposes, so it answers `hosted_session_not_found`. Runtime MCP connection replacement is therefore not covered by this slice and is recorded as a gap rather than claimed.
6. **Budget is re-pinned from the measurement.** The class joins the shared fork, so the six accounts move by the case runtime measured locally at the end of implementation, not by an estimate: 121.1 s for the three cases on JDK 21 + MySQL 8.0.46 on the merged base, budgeted at 2x (242 s), which moves the healthy sum from 5743 s to 5985 s, the fork from 6353 s to 6585 s and the Verify step to 120 minutes.

## Acceptance

- Three cases green on the MySQL 8.x lane; each fails if either cursor is ignored.
- A mutation witness: ignore the resume cursor and the public case must go red on a duplicate sequence, not on a timeout.
- The extension fixture's existing gates stay green.
- Shared fork budget re-pinned in the workflow, the Maven profile, the meta test and its comment chain in the same diff.
- Bilingual design doc updated in the same change.

## Open questions

- Whether the WebShell route should grow a header cursor for parity. It is not required for this gate and the client sends its cursor in the body today.
- Whether a generic turn-level resume gate belongs outside MCP. This slice only claims the MCP tool-call path.
