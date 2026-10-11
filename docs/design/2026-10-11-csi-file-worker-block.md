# Private CSI file worker and retained history

[English](2026-10-11-csi-file-worker-block.md) | [简体中文](2026-10-11-csi-file-worker-block.zh-CN.md)

## Purpose and baseline

This is a worker-side feature extracted from PR #13526 at
`edef0d54c246eeb554727564e50b3dab200a5cf5`, based on main
`fce50611b665989494df5fbd8bc91b4cad7b723c`. Main already has CSI mount
identity, retained read sources and the ordinary managed worker. It has no
private file worker. This PR supplies a complete worker-side chain from its
existing container boot entry to descriptor-backed Read/Write/Edit and retained
file history. It is proposed as a Draft for architectural review.

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

| Layer                           | Responsibility                                                                                                            | Consumer                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| File boot and wire contracts    | Closed JSON, exact identity, lease, incarnation, Pod/storage/mount attestation                                            | Container worker startup and private HTTP routes           |
| Native readback client          | Authenticated current bind/prepare/execute evidence, closed grant/resource validation                                     | File history binding/preparation and native tool execution |
| Composer and descriptor backend | One original Session, verified root, no-follow traversal, original observation and writes, retained backup authentication | Actual Core Read/Write/Edit tools                          |
| Retained history                | Snapshot/preimage preparation and authenticated backup observations without generic rewind or deletion                    | The same composer and executor history instance            |
| Core mutation contract          | Optional scoped observations and mutations with no ambient pathname fallback                                              | The descriptor backend supplied to the actual tool Config  |

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
retained history and workspace memory guard consumers. Tests and shared wire
fixtures accompany these layers.

No Java SQL issuer, migrations, Hosted runner, Session activation/recovery,
original checkpoint proof, application finalize, physical release or public
profile selection is included. The existing local Java refusal PR #13893 and
publication lock-order PR #13894 remain independently reviewable.

## Validation and acceptance

Run the global CLI baseline first. Verify the current main/installed worker
cannot select this new boot contract; a failure to reach CSI execution is an
absent-feature baseline, not a pre-existing production bug.

On the candidate, validate boot 4/5 parsing and actual container entry dispatch,
legacy refusal, context/attestation authorization and closed-route handling.
For the execution contract, use a real HTTP authority fixture and the actual
worker, composer, executor, Core tools and retained storage. Observe a complete
bind/prepare/Read/Write/Edit/history-snapshot sequence, original preimages and
result bytes. Tampered identities/grants/resources, wrong ownership, unavailable
authority and sealed admission must cause no new file effects.

Keep fixture transport evidence distinct from real SQL issuer evidence. On a
non-Linux host, any Linux mount/descriptor mapping must be explicitly labelled;
unmodified production startup must still refuse unsupported mounts. No such
probe qualifies Linux CSI or target-cluster lifetime behavior.

Acceptance for this Draft requires root build/typecheck/bundle, focused Core and
CLI regression tests, scoped formatting/lint, independent test-engineer reports
and two clean full-diff audits. Review must assess the cross-package contract
and required remote authority together. Deployment and full native acceptance
remain later gates.

## Risks and follow-up

This is a large feature across Core and CLI, requiring maintainer architectural
review under the repository's production-line advisory. The worker authority
producer is not available on main and must be integrated separately before
ordinary private Sessions can use the component.

Further PRs should supply persisted Session/native SQL authority, the Hosted
execution/receipt/consumption chain, cold recovery and complete retirement
qualification. The open design question is whether the worker-side module and
its strict remote contract should land first or travel with that producer.
