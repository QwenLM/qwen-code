# Original Hook recovery during Workspace retirement

[English](2026-10-08-original-hook-recovery.md) | [简体中文](2026-10-08-original-hook-recovery.zh-CN.md)

Status: recovery implemented; validation requirements below.

## Problem

An idle local `hosted-workspace-files/1` Workspace can have an original command
Hook RuntimeSession. After End and Delete effects are durably recorded, a
Broker restart loses its process-local Session context. Releasing the still-live
original READY Session then returns `runtime_reconciliation_required`, so Hook
detach cannot finish. If the original worker also exited, the existing drain
path instead requires that absent worker to answer a Session release request.
Both cases can leave retirement blocked despite settled lifecycle effects.

The fresh native baseline reproduces the live-worker failure after a Spring
restart. Earlier all-process-crash and OS-reboot observations identify the
absent-worker path; they retain their original commit attribution and require
new final verification. No unsafe retirement was observed in those cases.

A native mixed-fault candidate also reproduces a retained-holder dependency:
the managed provisioner refuses stopping the absent original worker while its
settled Hook Session still holds storage. The normal transport release is the
only path that clears that holder, but the absent worker cannot answer it.

## Scope and constraints

Keep the existing idle ACTIVE Workspace admission, End then Delete order,
issued credentials, current lifecycle claim, original journal writer, ACL,
permanent DRAINING fence, and atomic retirement transaction. Preserve independent
L2 CLOSED/ARCHIVED deletion. Unknown executions or incomplete original-worker
identity may remain blocked indefinitely.

Do not create a replacement Runtime, replay effects, infer physical stop from
HTTP 404 or transport failure, change migrations, or expand Shell/MCP/CSI/L4
lifecycle support. The native command-Hook test uses a private authenticated
catalog; it does not establish a new public producer or profile.

## Recovery behavior

For a saved managed Session whose Harness is durably draining, re-observe the
original READY worker using the saved provision seed, resource handle, Runtime
instance, lease, epoch, and endpoint. Restore only that original Session context
and use the existing release transaction, execution sweep, busy checks, and
confirmed transport reply. Ordinary unfenced release and LOST generations with
unreleased Sessions retain their existing refusal.

Within the existing claimed binding drain, a matching NOT_FOUND observation
can request the provisioner's existing `stopDrained` operation only when no
active execution remains. NOT_FOUND and JOURNAL_LOST are not stop receipts.
The provisioner must still verify the original durable registration and native
PID/boot identity, including the existing trusted same-machine reboot rule.

Hook detach can encounter the absent worker before Workspace close starts its
binding drain. With the durable Harness drain fence and matching original
absence evidence, route that release through the same claimed binding drain.
It rechecks the original identity under the claim and releases all original
Sessions only after persisting the stop receipt. The writer must still seal
before Workspace retirement can complete.

Persist the matching original stop receipt under the renewable operation claim
before logically releasing any saved Session. Then use the existing guarded
Session release transactions without contacting a worker proven stopped.
The managed provisioner permits physical stop with a retained original holder
only for a claimed local DRAINING generation with a valid holder tuple and zero
active executions. The holder remains reserved throughout physical stop.
A stopped-only repository transaction checks the original identity, persisted
receipt, caller's claim owner/generation and database lease before atomically
clearing that Session's exact LOCAL holder and releasing the Session. A valid
holder for another original Session in the same binding is retained until that
Session releases. Foreign or malformed holders refuse the transaction.
Continue to require zero active executions. A failed, expired, or fenced claim
cannot persist a late receipt or release those Sessions. If the Broker exits
after receipt persistence, the next claimed drain resumes from the durable
receipt rather than requiring a live worker or stopping a new one.

## Ownership and downstream contracts

RuntimeSession release remains original-session and persisted-workspace scoped.
There is no new HTTP route or lifecycle authority. The Broker's drain remains
the only owner of stopped-Session cleanup; the managed server still requires
the current lifecycle claim and settled effects before detach and Workspace
close. Hook detach still precedes writer sealing, and the lifecycle store still
checks every original binding and writer before the atomic tombstone.

Consumers are the existing Runtime release HTTP handler, EmbeddedRuntimeBroker
Workspace close adapter, HostedHookSession release, HostedHarnessSession detach,
SessionLifecycleCoordinator, WorkspaceLifecycleStore, WorkspaceRuntimeProvisioner,
WorkspaceExecutionStore, and the JDBC/in-memory binding repositories. Public READY
admission and execution ownership remain unchanged.

Standalone JDBC Broker initialization also creates the existing execution-holder
table with the same columns, defaults, primary key, and indexes as the Server's
current migrated schema. The stopped-Session transaction can therefore use the
same storage-holder contract in either deployment. Existing Server migrations
remain unchanged; retaining their CSI columns does not enable CSI retirement.

## Validation and acceptance

Run build, typecheck, and targeted Broker tests. Pin exact original READY
identity, the drain fence, absence evidence, stop refusal, foreign receipt,
receipt persistence across restart, and late completion fencing. Retain LOST
Session, unknown execution, and READY-but-unusable refusal controls.
Verify atomic holder/Session rollback for expired or replaced claims, foreign
holder identity and unknown executions, and same-claim renewal and multiple
original Sessions without clearing the wrong holder.
Compare the standalone Broker and migrated Server holder-table shapes, and run
the managed Server holder rollback and provisioner refusal controls.

The independent test engineer freezes exact products and runs one new native
case per fault: Spring restart, all original product processes crashing, and
actual OS reboot, plus Broker restart with original workers exited while the
Harness retains its Hook attachment. Each must preserve original binding/generation/handle and
effect bytes, execute End and Delete once each, avoid replacement workers or
model replay, confirm original stop receipts, seal the original writer, and
commit one retirement tombstone. Record raw command failures separately from
product outcomes. Verify a bounded unknown-worker refusal on a fresh resource.

These checks do not establish full deployment/load acceptance. The existing
O(history) scan and tenant serialization costs still require maintainer
architecture and load review.
