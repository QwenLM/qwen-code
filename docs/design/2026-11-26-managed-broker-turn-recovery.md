# Recover an active Managed Turn after Broker failover

[English](2026-11-26-managed-broker-turn-recovery.md) | [简体中文](2026-11-26-managed-broker-turn-recovery.zh-CN.md)

## Scope

Two Java replicas share MySQL and use separate embedded Runtime Brokers. The Hosted Harness and original Runtime Worker survive the loss of the first replica. The acceptance case uses a file edit in a durable local Worker.

## Recovery

If the original prompt is parked because the new Broker has yet to adopt its Runtime, record that prompt's recovery block in the resident Harness. A driven load can lift the block after it has journaled the tool result and proved that the current unsettled prompt and checkpoint are ready to continue under the current activation. `recoveredTurn` reserves the prompt until the existing continue route admits it. Writer, cleanup and cancellation blocks retain their own recovery paths.

The Broker's first lookup during adoption can see a live execution before its result is available. A later execution poll for a dispatch owned by another Broker asks the original Worker through the existing reconciliation path. Concurrent calls share a lookup and successive calls use the existing cooldown. A verified terminal result settles the same row. In-flight, unavailable or invalid evidence leaves settlement pending. Recovery preserves the execution ID and dispatch generation and sends only status requests to the Worker.

## Acceptance

Kill Java A after the Worker enters the edit. Exercise immediate cutover and cutover after Java B adopts the same Runtime while the Worker is paused. Both cases must commit one tool result, deliver it to the model, complete the original Turn ID with a final assistant reply, and produce exactly one file modification. Also verify that a separate blocked continuation is still refused.
