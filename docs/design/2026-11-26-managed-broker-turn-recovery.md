# Recover an active Managed Turn after Broker failover

[English](2026-11-26-managed-broker-turn-recovery.md) | [简体中文](2026-11-26-managed-broker-turn-recovery.zh-CN.md)

## Scope

Two Java replicas share MySQL and use separate embedded Runtime Brokers. The Hosted Harness and original Runtime Worker survive the loss of the first replica. The acceptance case uses a file edit in a durable local Worker.

## Recovery

If a prompt is parked because the new Broker has yet to adopt its Runtime or because an execution status poll lost its Broker connection or timed out, record that prompt's recovery block in the resident Harness. A transient pre-drive read failure keeps that block eligible for retry. A driven load can lift the block after it has journaled the tool result and proved that the current unsettled prompt and checkpoint are ready to continue under the current activation. `recoveredTurn` reserves the prompt until the existing continue route admits it. If the continuation parks again for a Broker recovery, a subsequent driven load can obtain a new continuation admission even at the same checkpoint. Writer, cleanup and cancellation blocks retain their own recovery paths.

The Broker's first lookup during adoption can see a live execution before its result is available. A later poll for an executing or cancellation-requested dispatch owned by another Broker asks the original Worker through the existing reconciliation path. Concurrent calls share a lookup and successive calls use the existing cooldown. Each poll waits up to a fixed two seconds before returning its ledger snapshot while the shared lookup can still finish and settle the same row from a verified result. In-flight or invalid Worker evidence and Worker lookup failures leave settlement pending. If the original binding can no longer answer, the Broker returns a typed refusal and leaves the execution record unchanged. Recovery preserves the execution ID and dispatch generation and sends only status requests to the Worker.

## Acceptance

Kill Java A after the Worker enters the edit. Exercise immediate cutover and cutover after Java B adopts the same Runtime while the Worker is paused. Both cases must commit one tool result, deliver it to the model, complete the original Turn ID with a final assistant reply, and produce exactly one file modification. Also verify that a separate blocked continuation is still refused.
