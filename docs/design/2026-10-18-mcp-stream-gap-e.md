# Hosted MCP fault gates FG12e: stream gaps

[English](2026-10-18-mcp-stream-gap-e.md) | [简体中文](2026-10-18-mcp-stream-gap-e.zh-CN.md)

## Problem and scope

Issue #14447 is Stage F round FG12 of #12380: fault gates for the Hosted MCP domains `mcp_configuration` and `mcp_operation`. This slice disconnects the public and WebShell event streams during a long MCP tool call and during a configuration replacement, then resumes with `Last-Event-ID` / `afterSequence`.

The gate requires no duplicates and no gaps; the observer's disconnect neither cancels nor re-invokes the call, so the fixture effect count stays 1. The issue notes that MCP records emit no task events (H1 design `:27`), so this gate is thin and may fold into FG12f.

## Current state

- The Harness publishes public and WebShell event streams from its journal; `Last-Event-ID` / `afterSequence` resume from a sequence.
- The FG12c/d rig has the `ext://hold` long call and the Broker-proxy control hold; this slice reuses that rig.
- The exact stream routes are verified at implementation; the WebShell route is an open question.

## Gate ledger

| Case                   | Injection                                                   | Expect                                                                               |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `stream-gap-long-call` | connect, start a held `ext://hold` call, disconnect, resume | contiguous events (no gap/duplicate); effect count 1; no cancel and no second invoke |
| `stream-gap-replace`   | disconnect during a configuration replacement, then resume  | contiguous events; exactly one configure; revision 2                                 |
| `web-shell-stream-gap` | the WebShell stream variant                                 | same as above; route availability is an open question                                |

## Decisions

1. **Reuse the FG12c rig.** The long call uses `ext://hold`; the replacement uses the proxy control hold.
2. **Resume with the last observed sequence.** Use `Last-Event-ID` / `afterSequence` and assert the resumed sequence is contiguous, with no duplicate event id.
3. **The disconnect must not abort the turn.** The fixture effect count stays 1 and the wire shows no second `mcp-invoke` or `mcp-configure`.
4. **Fold or standalone.** The issue calls this gate thin. Verify the public and WebShell routes first; if the WebShell stream is not exposed by the packaged harness, fold the gate into FG12f's delivery cell rather than invent a second rig.
5. **A standalone class only if the routes justify it.** `HostedMcpStreamFaultGatesIT` would re-pin the six fork accounts; a folded gate adds no class and no budget change.

## Fixture design

- Reuse the FG12c boot; an SSE client that reconnects with the last event id; the hold fixture; the proxy wire.
- Evidence lands in `target/fg12-cases/fg12e/<tenant>/` if the gate is standalone; the workflow already uploads `target/fg12-cases/`.
- The WebShell stream route is verified before the case is promised.

## Budget

Standalone -> the six fork accounts are re-pinned in the same diff. Folded into FG12f -> the budget is unchanged.

## Acceptance

- The resumed sequence has no gap or duplicate; the effect count is 1; no second configure or invoke.
- Both design docs stay in sync.
- If folded, the FG12f design records the stream case and this doc points at it.

## Open questions

- The public and WebShell stream routes in the packaged harness; whether both support `Last-Event-ID` and `afterSequence`.
- Fold into FG12f vs standalone; the issue itself notes the gate is thin.
