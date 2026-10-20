# Resident Workspace retirement and retained physical progress

[English](2026-10-20-k2-physical-retirement-progress.md) | [简体中文](2026-10-20-k2-physical-retirement-progress.zh-CN.md)

## Status and delivery boundary

The resident Read/Write/Edit runtime is already implemented by #14340 and
documented by merged #14758. This follow-up combines design and implementation
in one PR: a private maintenance command, idle admission, a durable fence,
inspection and explicit original-Pod deletion. Test evidence and native ACK
qualification are separate; unavailable checks remain pending.

The former #14765 candidate at `5535175e0f1b087a498a2822a092d8d1e85788ee`
remains in history. Its node-source coordinator, inventory extension and companion
migration are withdrawn. #14761 is closed and is not a dependency. Existing
private Session retirement and recovery retain their semantics.

## Problem and trust boundary

Normal Session close settles work, revokes the logical context and releases its
Runtime Session. Binding stays `READY`, storage stays `RESERVED`, and B reuses
A's original Pod/PVC and file bytes. This does not authorize Workspace retirement.
The private Session-isolated `DRAINED` receipt cannot retire a shared resident
binding without an isolation key.

Trust the administrator, Kubernetes control plane, host and qualified ACK Disk
CSI. Supported storage is `diskplugin.csi.alibabacloud.com`, `ReadWriteOncePod`,
`Filesystem`, `ext4` and the registered disk serial. Preserve tenant, actor,
Workspace/runtime generation, original Pod/container/mount, PVC/PV and namespace
protection checks. This does not independently prove continuous host confinement.
Lease expiry, node failure, DELETE success and Pod absence never prove physical
stop, CSI unpublish or safe volume reuse.

## Minimal maintenance entry

`ResidentWorkspaceRetirementMain` reuses the existing non-web maintenance Boot
configuration. It loads the service's DataSource, credential-encryption key and
resident mappings, starts no listener/Harness/worker and does not migrate SQL.
Commands are `inspect <request-json>`, `begin <request-json>` and
`delete-pod <request-json> <resourceVersion>`.

The trusted administrator already controls the maintenance host and deployment
credentials. A strict JSON request of at most 16 KiB names tenant, Workspace,
expected generation, actor and retirement ID. The actor is an
administrator-asserted audit identity, not authentication. Commands also require
its current Workspace `OWNER` grant. No new HTTP API, signing key or permission
framework is introduced. Callers cannot choose a replacement Pod or endpoint.
Kubernetes API/token/CA settings stay in deployment configuration; plans contain
no credentials. See the [deployment guide](../../deploy/k2-resident/README.md).

## Idle admission and durable fence

`begin` admits only an already provisioned idle Workspace: all public Sessions
are terminal, journal heads are sealed or permanently deleted with cleared writer
identity/lease, all Runtime Sessions are `RELEASED`,
and all tool executions are `SETTLED`. Unknown execution/release refuses admission.

Acquire the existing tenant `runtime_placement` guard first, then the
`output_publication` guard and the Workspace row shared with Session creation.
Use the original slot/binding, registration/reservation and child-record checks.
A live original binding coordinator claim is required. In one short transaction,
save an immutable plan, move Workspace `ACTIVE` to `DRAINING` and seal the original
binding `DRAINING` with drain requested. Revoke its old coordinator generation.
Keep the active slot and `RESERVED` owner. No network call holds SQL locks.

Creation first means retirement refuses; retirement first means creation refuses.
Same-ID/same-request replay returns the saved plan. Different actors, generations,
content or competing plans cannot overwrite it. A concurrent live maintenance
claim may refuse a duplicate; inspect/retry the same request after settlement.

| Consumer                                 | Enforcement                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session creation and resolution          | Existing Workspace `ACTIVE`, identity and actor checks; creation shares the tenant guard and Workspace row.                                          |
| Runtime acquire, activation and dispatch | Existing final binding readiness/drain, Session ownership and execution checks, including requests paused after preparation.                         |
| Warm/provision                           | Current resident Workspace identity and `ACTIVE` are checked under the tenant guard before returning/creating a binding.                             |
| Background recovery                      | Generic coordinator claims refuse a sealed resident binding, including after Broker restart. Existing version/generation checks reject stale writes. |
| Retention                                | A `DRAINING` binding and its active slot retain the original family; reservation is never cleared.                                                   |

Existing close/settlement authority remains intact. Fence older Server/Broker
binaries before enabling maintenance. There is no automatic undo or restoration.

## Explicit deletion and uncertain outcomes

`begin` performs no deletion. An explicit `delete-pod` verifies the configured
namespace/protection and PVC/PV, original Pod UID/specification/container and node
identity/readiness through the trusted API. Unexpected owner/finalizer, deleting
or missing Pod, identity changes and ambiguous observations refuse a new DELETE.

Persist exact normal DELETE bytes before transmission: original UID and observed
`resourceVersion` preconditions, 30-second grace and Background propagation. Reuse
`ma_operation` coordinator fields with a 60-second sender claim. Save the attempt
as `UNKNOWN` in SQL; only that invocation sends it. Result writes check the
original plan and live sender generation. Grant revocation blocks new actions;
an already sent attempt can still record its factual result under its claim.

Each original UID/resourceVersion is attempted once, at most eight attempts per
plan. A crash after persistence but before send is indistinguishable from a lost
reply. Restart and same-version retry read the retained attempt without resending,
even when Kubernetes is unavailable. Another explicit attempt requires a freshly
verified different version. The counter and fence survive restart.

If Kubernetes accepted a DELETE but its reply was lost, the Pod may already have
a `deletionTimestamp` or be absent. No different version can authorize a new
DELETE in either state. Same-version replay and `inspect` still read the durable
receipt; the eight-attempt cap does not override the original-Pod checks.

Retain actual HTTP status and at most 64 KiB of response bytes. A complete response
is `RETURNED`, including 200/202/404/409/503; incomplete/oversized replies and
transport failure remain `UNKNOWN`. Do not manufacture a response. `inspect`
performs no Kubernetes calls or SQL writes and returns status/digests without
credentials. Workspace/binding remain `DRAINING`, the active slot remains and
storage stays `RESERVED`. No PVC/PV, Secret or protection object is deleted.

## Persistence and compatibility

Reuse `ma_operation` with `WORKSPACE_RETIREMENT` and `ma_operation_work` with
`POD_DELETE_ATTEMPT`. A version-1 immutable plan binds the exact request, original
binding/runtime generation, original resource identity digest and configured
mapping digest. The retained original binding and mapping pin registration,
physical volume, Pod/specification and protection identities. Validate the plan
digest and those original records on subsequent use. Attempts retain exact
request bytes, version, ordinal, sender generation and response/unknown result.
Mutable progress never enters immutable application snapshots.

Append the canonical shared-schema migration for the new CHECK values and update
Server/Broker enums, initialization and validation together. Preserve published
migrations and legacy/partial/foreign catalog refusal. The new maintenance
migration does not restore the withdrawn node-source schema.

## Verification and acceptance

| Layer                             | Required observation                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component/H2                      | Owner/identity refusal, exact replay, busy and malformed-plan refusal, durable admission fences, retained slot/reservation and bounded attempts.                       |
| Independent MySQL 8.4 connections | Creation/retirement races under REPEATABLE READ, repeated requests, revoked owner, stale sender generation and original storage preservation.                          |
| Independent JVMs                  | Actual private begin/inspect/replay with retained SQL; crash before send, after send and before reply save retains unknown attempts without resend.                    |
| Target ACK                        | First prove ordinary A→close→B exact bytes on the same Pod/container/binding/PVC/PV, then explicit retirement/deletion with new work refused and reservation retained. |

Transport tests check exact request bytes, real HTTP statuses/bodies, size bounds,
timeouts, rotating tokens and no redirects/retries. Record exact source revision,
environment, identities, results and unavailable checks. H2, MySQL and loopback
HTTP are not native CSI qualification. Earlier withdrawn-candidate reports do not
validate this implementation. Scope the independent-process fixture separately
from actual ACK behavior.

## Deferred work

Shell, MCP, Hooks, forced drain of active Sessions, automatic replacement/resume,
node installation, physical-release proof, destructive storage cleanup and
cross-Workspace volume reuse remain deferred. Pod/node/storage costs continue
while resources remain, including after uncertain retirement. The
[resident runtime design](2026-10-14-k2-resident-workspace.md) remains the normal
Session handoff contract.
