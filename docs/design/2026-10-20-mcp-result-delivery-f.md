# Hosted MCP fault gates FG12f: result and catalog delivery

[English](2026-10-20-mcp-result-delivery-f.md) | [简体中文](2026-10-20-mcp-result-delivery-f.zh-CN.md)

## Problem and scope

Issue #14447's FG12f row asks for four delivery behaviours: replay a committed raw result while the Broker or Runtime is unavailable; settle a raw response over 60 KiB at the output limit without leaving a hold; deliver `notifications/tools/list_changed` with a call in flight without resending that call; and settle a late conclusive reply after `outcome_unknown` exactly once. This slice gates all four on a live connection; the closed-connection variant remains open and is recorded in #14880.

## Current state

- `localOperationView()` in `hosted-mcp-session.ts` answers a repeated operation id from `record.resultRef` before any dispatch, so a settled result can replay without contacting the Runtime.
- `receive()` in `managed-mcp-runtime.ts` rejects a parsed result larger than `MAX_RESULT_BYTES` (`60 * 1024`) and settles it as `managed_mcp_output_limit`; the committed record carries `run.state = failed` with `run.execution = settled`, and the immediate response keeps the transport view.
- The notification handler bumps `catalogRevision`, increments `catalogChanges[kind]` and marks `discovery[kind] = 'stale'` on the live connection. It does not rewrite the `mcp_configuration` record.
- `unknown()` marks `outcome_unknown`, and `client.onclose` closes the connection together with its pending map, so a reply that arrives after that point can only settle through a same-id re-dispatch under a new connection.

## Decisions

1. **One new class, four cases.** `HostedMcpResultDeliveryIT` carries the replay, output-limit, list-change and late-reply cases. It reuses the Broker-proxy rig and the private control route that the reply-loss class established.
2. **Replay is witnessed at two layers.** The same operation id is submitted twice; the second answer must equal the published `resultRef` response and must add neither a `mcp-invoke` control nor a Broker exchange. The committed record count stays at one.
3. **The output limit is witnessed through the committed record.** A 61 KiB resource read settles `managed_mcp_output_limit`, the committed record is `failed`/`settled`, the fixture records exactly one effect, and the following close reaches `released` without another invoke, so no hold is left behind.
4. **The late reply is a live-connection case.** The fixture answers `ext://late` with an unparseable result, which the Runtime records as `outcome_unknown` while keeping the request in its pending map, and then answers the same id with a valid result; the case asserts the original settles once, with one effect and one invoke. No production change is involved: `unknown()` does not remove the pending entry, only `settled()` does.
5. **The list change is pinned to what the tree actually does.** The fixture announces `notifications/tools/list_changed` before answering a read. The case asserts one invoke, one effect and the call's original `catalogRevision`. The configuration-generation claim from the issue is not asserted, because the notification does not rewrite the configuration record in this tree; asserting it would pin behaviour that does not exist.
6. **The closed-connection case stays out of this slice.** The late-reply gate covers an unknown produced on a live connection. When the connection itself is gone the reply has no receiver, so that variant stays a recorded gap in #14880.
7. **Budget is re-pinned from the measurement.** The four cases measure 24.16 s on JDK 21 + MySQL 8.0.46 including a cold schema migration, so at 2x they take the class entry from 30 s to 50 s, which adds 20 s to the healthy sum. The absolute healthy, fork, Verify and job values are pinned in `scripts/tests/hosted-process-ci.test.js` and are deliberately not restated here: they move whenever another Hosted class lands on main, and literal copies in this document drifted twice during review.

## Acceptance

- The four cases pass on the MySQL 8.x lane, and the evidence lands under `target/fg12-cases/fg12f/<tenant>/`.
- The meta roster lists `HostedMcpResultDeliveryIT`, and the fork accounts above hold in `hosted-process-ci.test.js`.
