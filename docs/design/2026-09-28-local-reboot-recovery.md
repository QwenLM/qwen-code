# Trusted Local Reboot Recovery (W0e-3)

[English](2026-09-28-local-reboot-recovery.md) | [简体中文](2026-09-28-local-reboot-recovery.zh-CN.md)

Status: implementation design, following [durable adoption](2026-09-27-local-runtime-adoption.md).

## Problem and scope

A lost Runtime journal can terminate unknown executions without proving that its writers stopped. Workspace storage must remain pinned until both physical evidence and exact holder cleanup exist. Recovery must also progress after the actor loses access or the product Session is deleted. Current authorized warm and acquire routes cannot provide that independent maintenance path.

This slice supports trusted workloads on one Linux host with administrator-managed persistent local storage. It does not isolate malicious same-UID tools, remote writers, external jobs that recreate writers, or restore/clone snapshots. Keep machine identity, local records, SQL keys and storage ownership stable. Worker-only death remains insufficient, even when no process is currently visible.

## Trusted reboot proof

Trusted local reboot recovery defaults to on. Enabling it requires durable local provisioning. Production reads machine ID and kernel boot ID; a different boot on the same saved host establishes that writers from the original boot cannot survive within the supported local-storage contract. A systemd soft reboot does not change the kernel boot ID and is not stop proof. The original registration must still validate against its complete provision seed, placement and saved handle. Missing, corrupt or old-format records cannot be reconstructed. Same-boot PID/time namespace changes remain uncertain.

Before returning evidence, the provisioner atomically tombstones the original record under its permanent per-seed lock. It returns JOURNAL_LOST and WRITERS_STOPPED for the same original host/boot/resource domain. Earlier process-exit loss evidence stays immutable; later reboot evidence closes only the physical uncertainty. A saved seed and handle suffice for interrupted startup, without inventing a missing endpoint or lease. Observation never relaunches the original seed.

## Ordered cleanup

The Broker first persists loss evidence and abandons at most 100 nonterminal executions per transaction. SETTLED receipts retain their results, but a successful receipt does not prove that tool-written files were fsynced before a power cut. ABANDONED remains terminal uncertainty and is never replayed. Loss-only cleanup leaves all physical pins intact.

Once all executions are terminal and writer-stop evidence is durable, a trusted provisioner cleanup callback handles the original saved binding. The Workspace wrapper clears its SQL storage holder using only the original tenant, storage ID, binding ID, generation and holder identity. It does not consult current actor grants, product Session status, Registry, mounts, filesystem or worker HTTP.

The cleanup transaction locks and validates the saved Binding and its live operation claim, then the original holder. It conditionally clears only an exact matching original holder. An absent holder or holder from another generation is already complete; another holder is never erased. Replaying cleanup after a crash is safe. Only after the callback completes does a final bounded transaction release Runtime Sessions, retire the Binding and clear the placement slot. A failed callback, expired claim or partial batch retains the remaining pins.

Late acquisitions must lock Binding, Runtime Session and holder in that order, and recheck READY/not-draining and original Session ownership. They cannot recreate the old holder after the loss fence. Ordinary release cannot bypass cleanup for a managed LOST generation.

## Recovery entry and scheduling

A trusted in-process `recoverBinding(bindingId, expectedGeneration)` entry loads the original saved record. It shares per-binding exclusion and SQL operation claims with interactive work, performs bounded observation and cleanup, and returns the original generation state. It never calls the current Session resolver, constructs a new placement, ensures a new resource, provisions a process or creates a replacement generation.

Spring schedules a bounded scan only when trusted local recovery is enabled. A rotating binding-ID cursor prevents long-lived uncertain records from starving later candidates. Batches cannot overlap and each observation has a deadline. Recovery is independent of active Hosted Turns and current user authorization. Live workers may be adopted, but no new execution starts. A later authorized warm may create the next generation after physical cleanup completes. No additional HTTP route or force-unlock API is introduced.

## Components and compatibility

The local store/provisioner add explicit reboot policy and seed-only evidence matching. Binding repositories expose bounded candidate discovery and a separate finalization step. The Workspace execution store enforces acquisition fencing and exact lost-holder cleanup. Embedded configuration wires the policy, wrapper callback and background coordinator. Existing SQL tables and evidence columns suffice; no migration is added. Ephemeral behavior stays available with `durable-local-process=false` (and trusted reboot recovery off); durable live-worker adoption is unchanged. The public `workspace_context` capability stays false.

## Verification and acceptance

Tests must cover both boot protocols, interrupted registration without a lease, same-host changed boot, wrong host, missing/corrupt records, same-boot PID/time namespace change, worker death with escaped descendants, more than 100 executions, crash after holder clear, stale claims and acquire callbacks, and a newer holder surviving old cleanup. A real SQL chain must recover the original saved Workspace after grant revocation, product Session deletion and Registry/mount changes, without accepting a new unauthorized execution or starting a replacement during maintenance.

Run Java HTTP/H2 tests, the existing MySQL integration profile, real-worker Stage F gates, build/typecheck, formatting and two consecutive clean full-diff audits. Synthetic boot identities prove decisions only. Physical acceptance requires a dedicated supported Linux host: record the original worker and escaped writer, reboot while preserving local disk and SQL, restart the same configuration, then verify old receipts, holder retirement and a new authorized generation. Never reboot a shared development machine as a substitute.

## Acceptance evidence and limits

An independent reviewer completed the physical gate on a dedicated Debian 12 Linux VM at W0e-3 head `8c2b626c`, including real reboot, power-cut controls, escaped writers, holder cleanup and receipt preservation ([round 3 report](https://github.com/QwenLM/qwen-code/pull/12869#issuecomment-5877187325)). Portable macOS tests and synthetic boot transitions remain separate evidence. Changes after that head require their own exact-head validation; the earlier physical run is not evidence that every later patch was reboot-tested.

The `durable-local-process`/`trusted-local-reboot-recovery` default flip ships on portable (synthetic-identity) evidence only: under the rule above, an exact-head physical acceptance for the flip head is owed as follow-up, and the flip itself does not relax that bar.
