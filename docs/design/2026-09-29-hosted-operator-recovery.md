# Hosted Shell Operator Recovery

[English](2026-09-29-hosted-operator-recovery.md) | [简体中文](2026-09-29-hosted-operator-recovery.zh-CN.md)

Status: implementation design for [#12904](https://github.com/QwenLM/qwen-code/issues/12904). Depends on [W0e-3](2026-09-28-local-reboot-recovery.md).

## Problem and supported boundary

A backgrounded Shell descendant may hold a capture pipe after the leader exits. The result has `captureStatus=partial` and `captureReason=producer_lost`; the Hosted turn retains its Workspace holder because neither an exit, a process-group kill nor pipe EOF proves that escaped writers stopped. The saved Tool execution and Hosted receipt preserve the incomplete outcome. Another Session in the same storage receives `workspace_busy`.

This recovery path is limited to an explicitly opted-in Linux durable `local-process` worker on the same host boot, with its original version-2 registration, seed, lease and exact Workspace holder. Legacy ephemeral workers cannot acquire those identities retroactively. The operator, not the product Session or model, is responsible for establishing that the old worker and every possible Workspace writer have stopped and cannot restart. The software checks the original worker's identity and absence; it cannot discover arbitrary detached descendants. A false operator statement lies outside this contract.

## Local maintenance protocol

The separate `operator-recovery` server artifact has a command-line entry point and an application context without HTTP listeners, worker startup, scheduled recovery or Flyway migrations. It reads the existing database, credential key and private Runtime registration directory. The default `operator-recovery-enabled` setting is false. No product route, public capability or Shell protocol changes.

`inspect <bindingId> <generation>` reads the saved holder, the original settled Shell result and the exact local durable registration, returning the binding, Runtime Session and Shell call identifiers, holder hash, `captureStatus`, `captureReason`, preparation eligibility and any recovery ID. The invocation arguments, output and credentials are not printed. A missing or mismatched record fails closed. `prepare` repeats this read-only registration preflight before fencing.

`prepare <bindingId> <generation> <holderKey> <reason>` atomically stores one audit operation for the exact holder and moves a READY, DRAINING or RECOVERY_BLOCKED binding to `OPERATOR_RECOVERY`. A binding already LOST keeps that state and its original loss evidence; the pending audit row excludes it from the background recovery scan. Preparation clears an existing short-lived operation claim and increments the claim generation so old Broker callbacks cannot return the binding to READY. Admission, normal release and placement replacement remain blocked. The holder remains present. Repeating the same exact request returns the saved recovery ID.

The operator stops the old worker and checks all potential writers and restart sources. The evidence file is a private 0600 JSON file in the administrator-owned Runtime state directory. It contains version 1, the recovery ID, verification time, method, concrete actions, and `restartPrevention: true`. It is retained in the audit row, with a digest. A different later submission cannot overwrite it.

`complete <recoveryId> <evidenceFile>` checks the saved generation and registration under its permanent cross-process lock, requires the original process identity to be absent, and durably tombstones that registration. It persists the operator proof before publishing `JOURNAL_LOST` and `WRITERS_STOPPED` evidence for the exact original domain. A short-lived claim with the same owner as the recovery Broker protects the state transition and subsequent cleanup. W0e-3 then preserves SETTLED results, abandons unknown work without replay, conditionally clears only the original holder, releases Runtime Sessions and retires the generation. Crashes at any step leave a pinned or already-cleared exact state that the same command can safely retry, after any earlier claim expires. A retry with different proof is rejected even after completion. Old recovery attempts never clear a later holder.

The original Hosted turn remains recovery-blocked. A successful recovery only authorizes new work in the same Workspace; it does not certify complete output or durable filesystem writes from the old call.

## Storage and failure rules

The audit table has one row per binding generation. It keeps the recovery ID, original holder and storage hashes, Runtime Session and provision identity, Shell execution reference, operator, reason, timestamps, attestation and completion marker. The prepared fence and audit insertion share a SQL transaction. SQL transactions never span host observation. No attestation, mismatched identity, a live original process, ambiguous local record or database failure leaves the Workspace pinned. Only the exact saved `LOST` generation with durable stop evidence may run W0e-3 holder cleanup.

## Verification

Use the real Broker, worker, SQL Store and two Sessions to trigger an incomplete background Shell capture. Verify the persisted `producer_lost` reason and accepted output prefix, the second Session's `workspace_busy`, and continued blocking after leader exit, process-group kill, pipe EOF or elapsed time. A real detached writer must continue modifying a marker while no recovery happens automatically. After the operator verifies quiescence, `complete` enables a new Session without replaying the old call. Inject two Brokers, late callbacks, changed grants, deleted product Sessions, claim expiry, and crashes between every durable step. Run H2 contracts plus real MySQL and MariaDB migrations and execution tests. Physical Linux validation is separate from portable process tests.
