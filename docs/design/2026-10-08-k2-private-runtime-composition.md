# K2 private original Runtime composition

[English](2026-10-08-k2-private-runtime-composition.md) | [简体中文](2026-10-08-k2-private-runtime-composition.zh-CN.md)

Status: implemented operator/context prerequisite with bounded local software
verification. Refs #12380, #13395 and Draft PR #13526. Connected private Hosted
attachment, native file execution and complete retirement remain unfinished.

## Problem and current state

The offline private CREATE commits the original Session and request pin, and
the CSI provisioner can reserve and attest its original Pod. Before this entry,
no production caller assembled that provisioner. The ordinary embedded Broker
rejects Kubernetes and resolves Workspace Sessions through a LOCAL alias. Its
Workspace transport installs a legacy context and activates the old workspace
gate; passing the private profile through it would acquire the wrong authority.
Using only `HttpRuntimeTransport` is also insufficient: its acquisition is a
no-op, so the private context would never be installed.

The private entry serves one explicitly selected, already committed private
Session. It does not create a replacement Session, register storage, install
cluster protection or mint another placement pin.

## Composition

A private `WorkspaceCsiRuntimeMain serve <reviewed-runtime-json> <port>` command
constructs the existing JDBC repositories, CSI reservation store, original CSI
provisioner, Runtime Broker service and authenticated loopback HTTP server. Its
JSON names the registration, original Session UUID and `runtimeRequestKey`
returned by private CREATE, digest-pinned image,
command, immutable worker artifacts and installed protection identity.
Credentials stay in environment settings and Kubernetes token/CA files;
neither request JSON nor output contains them. Configuration parsing is bounded
and rejects duplicate, unknown and trailing JSON fields. The command uses
`K2_JDBC_URL`, `K2_JDBC_USER`, `K2_JDBC_PASSWORD`, `K2_AGENT_REVISION`,
`K2_CLUSTER_DOMAIN`, `K2_KUBERNETES_API_URL`, `K2_KUBERNETES_TOKEN_FILE`,
`K2_KUBERNETES_CA_FILE`, `K2_RUNTIME_BROKER_TOKEN` and the existing
`QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID` /
`QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY` settings. It binds only loopback
on an explicitly chosen port from 1024 through 65535. The existing Maven
packaging produces a separate `csi-runtime` executable JAR for this command.

The resolver reads the committed Session through `requireCsiRequest` in a
fresh, bounded transaction on the original datasource connection, locks the
placement domain first, then the existing retention tenant row, and verifies
the registered storage. The tenant lock may initialize its existing lock row;
it does not create another Session or placement pin. The resolver accepts only
the configured Session and expected `runtimeRequestKey`, and refuses lifecycle
authority. The returned scope
comes from that readback; caller Workspace identifiers, saved receipts and
journal heads do not grant authority.

The private transport acquires the original bootstrap Runtime Session with
`runtimeSessionId == harnessSessionId == original Session UUID`. Before context
RPC it locks the original placement domain and reads the original Session pin,
binding, reservation and persisted ACQUIRING/READY Runtime Session on the same
physical transaction connection. It requires READY/non-draining binding,
original request/seed/lease/resource handle, reserved physical identity,
attested CSI identity and the original context descriptor at revision 1. The
shared original-connection single-Session guard also rejects additional or
foreign Runtime Session rows; making that existing guard callable from this
transport does not relax its predicates. It invokes the
existing CSI protocol 2 `installContext` outside the transaction, then repeats
the authoritative read and compares binding and Runtime Session versions before
accepting the response. The existing original repository READY CAS remains the
last admission fence. No SQL row lock spans network I/O.

An install response is not an execution grant. This prerequisite transport
refuses tool control/execute/cancel and ordinary release. Native file bind,
preparation and dispatch require their separate original journal admission.
Stopping the operator process closes local executors and HTTP listeners; it
does not retire the original Pod or release reserved storage.

## Failure and race semantics

Wrong Session, profile, registration, pin, scope, owner, generation, lease,
reservation or state fails before worker RPC. A seal winning before RPC refuses
installation. A seal or identity/version change while the response is pending
refuses admission afterward and retains the original reservation and uncertain
installation. Timeout, transport failure and restart never authorize replacement
or ordinary release. Current readbacks and the original CAS must both succeed;
a previously green local fixture cannot replace them.

The existing provisioning and startup reconciliation rules remain in charge of
Pod creation and adoption. The command does not weaken their API provenance,
digest/UID checks, ambiguity blockers or backend-specific registration guard.
In particular, its current disk guard is still the existing ACK-specific
implementation; this change does not claim generic CSI backend acceptance.

## Hosted attachment boundary

The subsequent internal Hosted entry must use the authenticated original
`/session` protocol and current boot identity. Its Session Store URL must come
from trusted private startup configuration, not a caller descriptor. It must
correlate the original Broker acquisition's private capability/scope with the
original SQL Store, use its scoped writer credential, and create only the exact
private definition. Public create/load profile selection stays closed.

A same-boot attachment may replay its cached owner. Cold load cannot silently
install a new activation: original writer generation and activation epoch are
fixed at 1, and current SQL admission refuses replacement. Failed initialization
must retain uncertain authority; detach/delete must not call ordinary writer
seal or runtime release. This composition alone does not implement attachment.

## Files and consumers

| Area                                                            | Change and consumer                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed-agent-server/.../store/WorkspaceCsiRuntimeMain.java`   | Private executable operator and existing Broker HTTP server composition.                                                                    |
| `managed-agent-server/.../store/WorkspaceCsiRuntimeAccess.java` | Original Session resolver and context acquisition guard consumed by that operator.                                                          |
| `managed-agent-server/pom.xml`                                  | Separate `csi-runtime` executable packaging; the ordinary Spring entry remains unchanged.                                                   |
| `runtime-broker/.../JdbcCsiFilesRetirementGuard.java`           | Existing single-Session guard exposed for the private transport; original binding, session and tool repositories retain the same predicate. |
| Collocated Java tests                                           | Original CREATE/JDBC admission, wrong identity, seal races and RPC refusal.                                                                 |
| This bilingual design                                           | Production entry, trust boundaries and acceptance limits.                                                                                   |

No public Spring provisioner selection, Hosted profile whitelist, wire schema,
database migration or second placement authority is introduced.

## Validation and acceptance

First probe the global `qwen` CLI and record its capability limitations. Then
use an explicit standalone JDBC/HTTP fallback against the existing production
classes to demonstrate the missing composition/context path. After
implementation, exercise the actual new composition with original CREATE,
repositories and authenticated Broker HTTP. Cover correct acquire/replay,
wrong credentials/Session/profile/pin/reservation, context identity, seal before
and during RPC, sealed/changed admission, closed tool/release operations and
owned resource cleanup. Record raw requests and before/after SQL state.

Independent verification exercised the classifier JAR through Spring Boot
PropertiesLauncher with an owned external H2 driver. Actual Main HTTP proved
authentication, warm, original ACQUIRING-to-READY acquisition and read-only
retry. Direct original JDBC/HTTP probes recorded the install request, no SQL
transaction during RPC, stable retry identity, full 53-table comparisons and
late-response refusal after a competing seal or version change. The resolver
may initialize one existing tenant lock row; this is recorded separately from
read-only acquisition. Valid history control and ordinary release remain
refused, and Main shutdown retains RESERVED storage. Global CLI limitations,
initial probe failures, executable origins and cleanup are recorded in the
separate E2E report.

Build/typecheck/bundle, focused Java tests and static checks passed before the
independent window. Its private CREATE setup used original production classes
with a synthetic Kubernetes API/attestation seam and an owned context HTTP
receiver; it did not run a physical CSI worker or production Hosted session. An H2
fixture or simulated Kubernetes observation proves only its tested software
boundary; it is not MySQL lock proof, physical CSI evidence or complete K2.
Current-commit MySQL RC/warmed RR, trusted production Hosted attachment,
read/write/edit, native file history, publication/receipt/checkpoint closure,
aggregated DRAINED/RELEASED, physical writer termination, NodeUnpublish and safe
reuse still require their own connected acceptance.

## Open decisions

This entry intentionally consumes an existing registration and private CREATE.
The private deployment supplies reviewed credentials and cluster protection;
automated discovery or public configuration is outside this change. The exact
trusted Hosted startup configuration and native file dispatch are addressed in
their next dependent implementation, without treating the context receipt as a
grant.
