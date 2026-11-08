# Managed checkpoint storage and live recovery blocks

[English](2026-10-22-managed-checkpoint-recovery.md) | [简体中文](2026-10-22-managed-checkpoint-recovery.zh-CN.md)

## Problem and evidence

A long Hosted Turn accumulates completed Runtime receipts in its recovery checkpoint. Those entries are the durable repeat-dispatch fence and must remain present. An isolated reproduction on main completed 73 small calls before the next `managed-checkpoint` reached 65,776 bytes and met the ordinary 65,536-byte HTTP resource limit. The existing checkpoint reader already accepts up to 1 MiB. The Harness then reported no active prompt and a recovery block, while the Java consumer kept waiting on an event stream that continued heartbeats.

## Decisions

Allow the `managed-checkpoint` resource kind up to the existing 1 MiB checkpoint parser bound in the TypeScript publisher, Java Session Store, tool publication references and CSI native readback grants. Preserve all receipt identities, ordinals, references, digests and existing resource/transaction bounds. Other ordinary resources retain 64 KiB. This introduces no new resource encoding, database schema, object-storage dependency or configuration option. TypeScript publisher oversize errors identify the resource kind, actual bytes and limit.

Inspect the status of the exact tenant/session/generation attachment every 15 seconds, independently of opaque journal control records. Only `recoveryBlocked=true` together with `hasActivePrompt=false` establishes a live recovery block. Healthy model execution and approval waits remain active. Drain and flush already-read events, then use the existing transcript API to confirm there are no authoritative journal records beyond the consumed cursor. Recheck the local event queue after the probe so an arriving terminal event takes priority. Park only under the live dispatch lease. Store a named recovery-blocked error and prevent execution redispatch and idempotent command replays. After at least 15 seconds, the dispatcher may claim it only for read-only status and journal observation at its original epoch and cursor; this branch never warms a Runtime, takes over execution, submits input or continues a checkpoint. Observation requires the original cached attachment and captures one client for all reads; a cold cache never loads or takes over a Session. Missing, unavailable or changed-generation evidence retains the park without consuming the execution retry budget. Later authoritative terminal events settle the original Turn. Until then, retain its unsettled input, Runtime ownership, policy-change barrier, lifecycle barrier and child-result watch. A sampled block alone must not close the Session or classify a child outcome unknown. Explicit cancellation remains available.

The WebShell read adapter presents this named park as `recovery_blocked`. Its existing summary polling updates the page without treating stream heartbeats as work progress. The browser disables another submission to that Session while retaining cancellation. The raw internal Turn remains active for cancellation and recovery; the change does not invent a physical stop receipt.

## Scope and rollout

This is a bounded checkpoint budget correction and live-block observation, not a general large-resource backend. Checkpoints above 1 MiB remain refused and must surface as blocked. Deploy the Java reader before a Harness can publish checkpoints above 64 KiB; older stores will still refuse them. Existing resources and journals remain readable, and the SQL schema is unchanged. User previews are not restarted until isolated validation passes.

## Validation and acceptance

Reproduce the baseline refusal with tiny tool output, then run the same 100-call fixture to completion without deleting receipts. Verify a cold reopen, unchanged call identities, and refusal above 1 MiB while ordinary resources still stop at 64 KiB. Exercise actual Java resource commit/read and reader compatibility.

Verify a heartbeat-only blocked Harness leaves the Java consumer, becomes durably parked and appears blocked through the WebShell adapter and browser provider. Healthy inactive approval waits, active model work, cancellation races and lost dispatch leases must not be misclassified. Verify bounded re-observation consumes a later terminal without replay, and unavailable evidence retains the park without consuming retries. Run affected TypeScript tests, build/typecheck/bundle, Java verification, applicable MySQL/Hosted recovery checks and independent end-to-end verification. Record unavailable environment gates explicitly.
