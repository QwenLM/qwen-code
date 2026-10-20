# Hosted MCP fault gates FG12f: result and catalog delivery

[English](2026-10-20-mcp-result-delivery-f.md) | [简体中文](2026-10-20-mcp-result-delivery-f.zh-CN.md)

## Problem and scope

Issue #14447's FG12f row asks for four delivery behaviours: replay a committed raw result while the Broker or Runtime is unavailable; settle a raw response over 60 KiB at the output limit without leaving a hold; deliver `notifications/tools/list_changed` with a call in flight without resending that call; and settle a late conclusive reply after `outcome_unknown` exactly once. This slice gates the first three. The fourth has no production path that settles a late reply today, so it is recorded as an open gap instead of being claimed by a case.

## Current state

- `localOperationView()` in `hosted-mcp-session.ts` answers a repeated operation id from `record.resultRef` before any dispatch, so a settled result can replay without contacting the Runtime.
- `receive()` in `managed-mcp-runtime.ts` rejects a parsed result larger than `MAX_RESULT_BYTES` (`60 * 1024`) and settles it as `managed_mcp_output_limit`; the committed record carries `run.state = failed` with `run.execution = settled`, and the immediate response keeps the transport view.
- The notification handler bumps `catalogRevision`, increments `catalogChanges[kind]` and marks `discovery[kind] = 'stale'` on the live connection. It does not rewrite the `mcp_configuration` record.
- `unknown()` marks `outcome_unknown`, and `client.onclose` closes the connection together with its pending map, so a reply that arrives after that point can only settle through a same-id re-dispatch under a new connection.

## Decisions

1. **One new class, three cases.** `HostedMcpResultDeliveryIT` carries the replay, output-limit and list-change cases. It reuses the Broker-proxy rig and the private control route that the reply-loss class established.
2. **Replay is witnessed at two layers.** The same operation id is submitted twice; the second answer must equal the published `resultRef` response and must add neither a `mcp-invoke` control nor a Broker exchange. The committed record count stays at one.
3. **The output limit is witnessed through the committed record.** A 61 KiB resource read settles `managed_mcp_output_limit`, the committed record is `failed`/`settled`, the fixture records exactly one effect, and the following close reaches `released` without another invoke, so no hold is left behind.
4. **The list change is pinned to what the tree actually does.** The fixture announces `notifications/tools/list_changed` before answering a read. The case asserts one invoke, one effect and the call's original `catalogRevision`. The configuration-generation claim from the issue is not asserted, because the notification does not rewrite the configuration record in this tree; asserting it would pin behaviour that does not exist.
5. **The late reply stays out of this slice.** Settling a reply after `outcome_unknown` needs a Broker or Harness late-settle path that does not exist today; adding one is a production change, not a gate. It stays a recorded gap.
6. **Budget is re-pinned from the measurement.** The three cases measure 13.98-16.01 s across local runs on JDK 21 + MySQL 8.0.46, so at 2x they add 30 s to the healthy sum. The absolute healthy, fork, Verify and job values are pinned in `scripts/tests/hosted-process-ci.test.js` and are deliberately not restated here: they move whenever another Hosted class lands on main, and literal copies in this document drifted twice during review.

## Acceptance

- The three cases pass on the MySQL 8.x lane, and the evidence lands under `target/fg12-cases/fg12f/<tenant>/`.
- The meta roster lists `HostedMcpResultDeliveryIT`, and the fork accounts above hold in `hosted-process-ci.test.js`.
