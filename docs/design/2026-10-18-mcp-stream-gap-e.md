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

## Follow-up: Runtime connection replacement (2026-10-22)

After FG12f, the #14447 status table and the #12380 Stage F table still listed one open e boundary: an actual Runtime MCP connection replacement. FG12f's replacement case (its decision 5) commits a new AgentDefinition revision while the running Session stays pinned, so no Runtime connection is replaced. FG12f said the Harness-private configuration route cannot carry the case for a Spring-created Session. That limit belongs to the test surface, not the product:

- The Harness mints the client id when it opens a Session for a create or a load (`clientId: randomUUID()` in `hosted-harness-session.ts`) and returns it in the attachment. The Broker is not involved. Spring keeps the id on the `HarnessSessionRef` in `QwenHostedHarnessConnector.attachments` and sends it on every Harness call. The public API never exposes it, so a test that uses only the public API cannot send the command.
- Spring never sends `POST /session/:id/mcp/configurations`, so explicit replacement stays Harness-private, as the issue states. Since #15119 `HostedHarnessClient` does send the Session MCP management route (`POST /session/:id/mcp/management`), but that route refuses with `hosted_turn_active` while a Turn is active, so a change sent through Spring cannot land while a call is held. The FG13 Hook gates already read the same attachment to call Harness-private status routes. This cell does the same.
- The route refuses while `mcpBusy`, `mcpRecovering` or `blocked` is set. It does not refuse while a Turn is active, so a replacement can land while a model-driven MCP tool call is held.
- The Runtime opens the replacement as a new connection: a higher `configRevision`, a new connection generation and a new stdio process. It then marks the older sibling `retiring`. A sibling with a pending call is closed only after that call settles: `settled()` closes a retiring connection once its `pending` map is empty.

### The cell

`HostedMcpStreamGapIT#runtimeConnectionReplacementDuringTheHeldCallKeepsBothStreamsOnMySql` runs in the existing class and boot:

1. Publish revision 1, create the Session, open a public and a WebShell observer, and submit `EXT_HOLD`. The fixture parks the call on the revision 1 process. Cut both observers.
2. Send the configure command for revision 2 with `expectedRevision: 1` under Spring's attachment. The command settles while the call is still held.
3. Release the call, wait for the Turn, and resume each observer with its own cursor (`Last-Event-ID` or `afterSequence`).
4. Submit `EXT_REPLACED`.

The cell asserts:

- Each route's union is the committed ledger from sequence 1, with no gap and no duplicate, and carries the held call's result exactly once.
- The replacement starts a second server process (revisions `[1, 2]`) and commits a second settled configuration with a higher connection generation, and the public catalog reports revision 2. At that point the revision 1 process is still alive and no effect has happened.
- The held call is answered once, by the process it started on: the model sees `EXT_MCP_1_EXT_HOLD` and the effect's pid is the revision 1 pid. The revision 1 process exits after its call drains.
- The next call runs on the replacement: the model sees `EXT_MCP_2_EXT_REPLACED` and the effect's pid is the revision 2 pid. No third process starts, and the proof file has two rows.

### Witnesses

Each witness mutates the packaged bundle the class runs (`dist/`). Both are red:

- **M1 (Runtime):** close a retiring sibling even while its call is pending. Red at "revision 1 is retiring, not closed, while its call holds", right after the replacement settles.
- **M2 (Harness):** keep a server's first catalog after a replacement (`catalogs.set` only when absent). Red at "Turn … expected COMPLETED": the held call still answers once, but the refresh before the next model request re-configures the stale revision 1 catalog, which the Runtime refuses, and the Turn fails with `Runtime MCP configuration failed.`

### Budget

Measured on Linux aarch64, JDK 21, MySQL 8.4.6: the cell takes 12.9 s, 13.8 s and 13.7 s in three class runs, and the class is green 4/4 in 143.3 s, 144.6 s and 144.4 s. Run alone, with the cold boot, it takes 25.9 s. It is shorter than the other three cases because its second Turn writes into the half-open SSE connections the cut clients left, so Tomcat's 30 s graceful shutdown has no request to wait for. The cell is budgeted at 2x its largest in-class time: +28 s on top of the FG11d queue-one cell (#15187), so the healthy sum moves from 10636 s to 10664 s and the fork from 11236 s to 11264 s. 11864 s of fork plus wrap still fits the 198-minute Verify step with 16 s left, so the job ceiling is unchanged.

### Not covered

- A change sent through Spring's Session MCP management route (#15119). It refuses while a Turn is active, so it cannot land during a held call, and this cell does not exercise it.
- A replacement while a raw `mcp_operation` is in flight. The route answers `409 hosted_mcp_operation_active` while `mcpBusy` is set.
- A retiring connection that fails to drain, a non-stdio transport, and a Harness or Spring restart after a replacement.
- The close-time release of the superseded configuration. The cell leaves the Session open; FG12a's configure-replacement case (`HostedMcpReplyLossIT`) closes a replaced Session through the Harness.
