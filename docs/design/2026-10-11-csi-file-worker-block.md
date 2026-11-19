# Private CSI file worker, retained history and local-process isolation

[English](2026-10-11-csi-file-worker-block.md) | [简体中文](2026-10-11-csi-file-worker-block.zh-CN.md)

## Purpose and baseline

This is a worker-side feature extracted from PR #13526 at
`edef0d54c246eeb554727564e50b3dab200a5cf5`, based on main
`fce50611b665989494df5fbd8bc91b4cad7b723c`. Main already has CSI mount
identity, retained read sources and the ordinary managed worker. It has no
private file worker. This PR supplies a complete worker-side chain from its
existing container boot entry to descriptor-backed Read/Write/Edit and retained
file history, together with the Java local-process refusal previously proposed
in PR #13893. It is proposed as a Draft for architectural review.

Java and Node share the exact private capability manifest and digest. The Java
embedding API can construct the reserved Session-isolated request, but the
local-process provisioner refuses it before storage resolution, process effects
or durable registration. Main has no ordinary production caller selecting this
capability. This is preparatory feature work, not a fix to an existing main CSI
production path. Combining the boundary and its dedicated worker does not add
the native authority producer.

The Java native SQL issuer and Hosted Session orchestration remain separate
features. This worker requires their remote authority contract; main cannot yet
produce that authority through its ordinary production Session path. Synthetic
authority responses can verify this component's contract, but do not qualify
SQL admission, an end-to-end Hosted turn or Kubernetes deployment.

## Included chain

The existing managed runtime CLI reads a container boot document and dispatches
boot versions 4 and 5 to the dedicated file worker. The legacy stdin/context
worker refuses the exact private capability. Version 4 provides construction,
attestation and context installation only. Version 5 also pins the authority
origin and supports file execution when that authority supplies valid evidence.

| Layer                           | Responsibility                                                                                                            | Consumer                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Java profile and local refusal  | Canonical Session request identity; refusal before any local-process lifecycle effect                                     | Embeddable Broker requests, durable reconciliation and operator observations |
| File boot and wire contracts    | Closed JSON, exact identity, lease, incarnation, Pod/storage/mount attestation                                            | Container worker startup and private HTTP routes                             |
| Native readback client          | Authenticated current bind/prepare/execute evidence, closed grant/resource validation                                     | File history binding/preparation and native tool execution                   |
| Composer and descriptor backend | One original Session, verified root, no-follow traversal, original observation and writes, retained backup authentication | Actual Core Read/Write/Edit tools                                            |
| Retained history                | Snapshot/preimage preparation and authenticated backup observations without generic rewind or deletion                    | The same composer and executor history instance                              |
| Core mutation contract          | Optional scoped observations and mutations with no ambient pathname fallback                                              | The descriptor backend supplied to the actual tool Config                    |

Binding authenticates the current installed context and authority before
constructing tools. Preparation validates the complete accepted membership and
original inputs before retaining preimages. Execution authenticates the exact
grant, installed Session and prepared history, then uses the same tools and
history. The backend remains on the original root and retained descriptors.
Retries preserve identities and do not substitute an unrelated history instance.

## Decisions and constraints

The capability manifest and protocol fixtures retain PR #13526's bytes. The
new scoped mutation and retained storage parameters have actual production
setters in the composer and read sites in the tools, history and executor.
Ordinary workers do not select this backend and retain their current behavior.

Private team-memory secret checks are anchored at the verified Session working
directory supplied by the composer, specifically its `.qwen/team-memory`
subtree. They do not search for an ancestor Git root, even when the working
directory is below a repository root. Ordinary tools retain their nearest-Git-root
and realpath classification. This difference is intentional: private tools must
not discover a host repository outside the admitted descriptor root; the backend
rejects paths outside that root and symlink traversal.

File history retains its original Session and directory. Reinstalling a different
context digest for that Session conflicts, and a changed mount identity refuses
admission. Binding, preparation and snapshots already require the current tool
directory to match history; execution repeats that same fence before effects.
Changing cwd therefore requires installation for a new Session instead of reusing
history from another directory.

Boot 5 validates the native installation contract before recording it: the
operation id is derived from the original Session and context revision is 1.
Noncanonical reinstall keys and unsupported first revisions refuse without
replacing the installed record. Exact canonical replays preserve the binding.
Authority failures before composition or preimage preparation can retry. A failed
preparation can also retry when history and retained storage are proven unchanged;
changed or unverifiable effects seal execution and report
`managed_csi_history_retirement_required`, including already queued snapshots.
Its retained pins are preserved and its preparation is never silently recopied.

Preparation excludes execution until its retained observation and failure
inspection finish. An active executor invocation refuses preparation before
authority readback or preimage effects. A new execution, including one whose
native readback began earlier, refuses before executor admission while preparation
is active. These timing refusals leave the Session usable and can retry after the
current operation finishes; they do not retire history or wait indefinitely for
an idle backend. Snapshot retains its existing idle-backend requirement.

History preparation projects the largest possible next snapshot, file records
and retained pins before copying, with 1 KiB reserved for the authority envelope.
It enforces 100 snapshots and the 64 KiB history response budget. Conservative
capacity refusal reports `managed_csi_history_capacity_exceeded` and leaves the
prior snapshot and Session usable. It may refuse earlier than an exact
reuse-aware budget. Settled execution responses allow the executor's existing
1 MiB result budget plus the bounded 16 KiB request envelope, so UTF-8 Read
results are not rejected merely because their byte count exceeds 64 KiB.

Write and Edit rethrow errors caught by their outer mutation wrapper when the
signal is aborted, preserving cancellation propagation at the Core tool API.
Non-aborted wrapper failures remain typed tool errors. This does not change the
scheduler's existing cancellation classification or the tools' inner catches.
Write uses this outer catch only with scoped `textFileIo`; the ordinary path
delegates directly to its existing body, preserving pre-write rejections such
as a regular-file parent, with or without cancellation.

The scoped writer retains exact pre-write bytes and restores them on a refused
partial write while preserving the original inode and mode. A failed new-file
write removes its own leaf. Rollback verifies original descriptor/named-entry
identity and backup alias fences, and completes without the cancelled signal.
Only the exact cancellation reason is recoverable after successful rollback;
storage failures, including ENOSPC, and failed rollback close the backend even
when original bytes were restored. The worker reports execution unavailable and
requires retirement rather than treating restored bytes as storage recovery.
Missing files and initial non-file path shapes refuse one request; mount, inode,
device, backup pin and
inventory changes remain fatal. This is recovery from observed write errors,
not qualification of crash atomicity or persistent device failure recovery.
Retained readiness deduplicates working paths across snapshots, but still checks
each failed backup and authenticates current storage. Full inventory checking
remains in place; this change does not claim linear total cost with growing pins.

New scoped working files and directories request modes `0600` and `0700`,
respectively, with further restriction by the process umask. Under umask `022`
these differ from ordinary Write's `0644` and `0755` defaults. Existing-file updates
preserve the original mode; callers sharing a volume with other UIDs must account
for these creation modes.

The Java request retains canonical Session UUID isolation, Workspace generation
and storage identity, root-relative working directory and a canonical absolute
mount root using the existing Broker encoding. Refusal checks the exact
capability digest regardless of provisioner kind or isolation class. It covers
request creation, both provision overloads, resource creation/adoption,
reconciliation, confirmation, operator registration/stop observation and
release. Both Session and Workspace isolation return non-retryable HTTP 409
`runtime_provision_failed`; asynchronous operations return failed completion
stages. Other well-formed unknown digests retain main's behavior. The refusal
does not authorize native execution, retirement or release.

The extraction also closes three worker-side gaps found during dependency
review. The retained executor uses lexical containment and delegates no-follow
admission to the original descriptor backend, instead of observing ambient
realpaths. Preparation compares the declared request digest with the original
payload bytes before retaining preimages. Execute readback requires a closed
input wrapper owned by the same harness and runtime Session and verifies its
payload digest, including read-only calls that have no preparation.

Keep main's special-file admission, zero-length handling and `O_NOCTTY` reads,
current mount root lifetime checks, sibling ownership fence and aggregate worker
cleanup. Extract only the new worker dispatch and file contracts from older
source files, rather than replacing main with PR #13526's versions.

Routes are owned by the one live worker Session from its immutable boot. They
use the exact lease/token/incarnation and installed context. Native readback is
owned by the separately configured authority origin and current persisted
Session; the worker cannot mint its own SQL authorization. Missing, malformed,
conflicting, stale or unavailable evidence refuses before file effects. There
is no fallback to the ordinary worker, another Session or a replacement mount.

Backend failure closes admission. Cleanup joins outstanding operations and
retains errors. Retained snapshots do not authorize rewind, backup pruning,
retirement or reuse. Drain remains a refusal boundary and reports
`DRAINING`/`BLOCKED`; this increment does not establish `QUIESCENT`, physical
termination, CSI unpublish or volume release.

## Files and exclusions

The production scope is the new `managed-csi-file-*` and
`managed-csi-native-readback` modules in `packages/cli/src/serve`, their container
entry and context/executor/history wiring, plus the Core file mutation,
retained history and workspace memory guard consumers, plus the Java profile
identity and local-process provisioner refusal. Tests and shared wire fixtures
accompany these layers.

No Java SQL issuer, migrations, Hosted runner, Session activation/recovery,
original checkpoint proof, application finalize, physical release or public
profile selection is included. PR #13893 is incorporated and superseded by this
component. Publication lock-order PR #13894 remains independent because it
corrects the ordinary SQL publication path and does not depend on this worker.

## Validation and acceptance

Run the global CLI baseline first. Verify the current main/installed worker
cannot select this new boot contract; a failure to reach CSI execution is an
absent-feature baseline, not a pre-existing production bug.

Inject the planned digest through the Java embedding API and verify refusal
before resolver calls, child markers, durable directory changes or operator
effects. Cover both isolation classes and every lifecycle entry, including
synthetic handles and registrations; these fixtures do not establish historical
private registrations. Check canonical profile identities and Java/Node digest
equality. Existing ordinary and durable Java workers must remain usable with
the same freshly built candidate Node bundle, including context installation,
attestation, confirmation and reopened Broker adoption.

On the candidate, validate boot 4/5 parsing and actual container entry dispatch,
legacy refusal, context/attestation authorization and closed-route handling.
For the execution contract, use a real HTTP authority fixture and the actual
worker, composer, executor, Core tools and retained storage. Observe a complete
bind/prepare/Read/Write/Edit/history-snapshot sequence, original preimages and
result bytes. Tampered identities/grants/resources, wrong ownership, unavailable
authority and sealed admission must cause no new file effects.

Also verify illegal context installations do not replace the accepted identity,
pre-effect authority failures can retry, post-effect preparation failure refuses
queued snapshots with the retirement code, and capacity refusal precedes copies.
Overlap preparation with new execution, pending native readback and an active
executor invocation: timing refusals must precede file effects, then the same
requests and a later snapshot must succeed without retiring the Session.
After cancellation or partial write failure, compare complete original bytes,
inode and mode; genuine integrity failure must still close admission. Exercise a
Chinese Read result above 64 KiB and an exact retry through the real HTTP worker.

Keep fixture transport evidence distinct from real SQL issuer evidence. On a
non-Linux host, any Linux mount/descriptor mapping must be explicitly labelled;
unmodified production startup must still refuse unsupported mounts. No such
probe qualifies Linux CSI or target-cluster lifetime behavior.

Acceptance for this Draft requires root build/typecheck/bundle, focused Core and
CLI regression tests, scoped formatting/lint, independent test-engineer reports
and two clean full-diff audits, plus focused Java tests, Checkstyle, SpotBugs and
packaging. Review must assess the cross-package contract
and required remote authority together. Deployment and full native acceptance
remain later gates.

## Risks and follow-up

This is a large feature across Core, CLI and Java, requiring maintainer architectural
review under the repository's production-line advisory. The worker authority
producer is not available on main and must be integrated separately before
ordinary private Sessions can use the component.

Further PRs should supply persisted Session/native SQL authority, the Hosted
execution/receipt/consumption chain, cold recovery and complete retirement
qualification. The open design question is whether the worker-side module and
its strict remote contract should land first or travel with that producer.
