# Resident Workspace retirement and retained physical progress

[English](2026-10-20-k2-physical-retirement-progress.md) | [简体中文](2026-10-20-k2-physical-retirement-progress.zh-CN.md)

## Status and delivery boundary

As of 2026-10-20, this is a design-only follow-up to the simplified #14758 at
`c6820459026adf3619c9080b5b73cacc52922998`. The resident Read/Write/Edit runtime
is already implemented by #14340. This PR remains Draft and implements no
resident Workspace retirement command, admission fence or physical cleanup.
The [resident runtime design](2026-10-14-k2-resident-workspace.md) remains the
first-release contract.

The former #14765 implementation at
`5535175e0f1b087a498a2822a092d8d1e85788ee` remains in history but is withdrawn
from this tree. Its node-source protocols, physical coordinator, inventory
extension, companion table and V14 migration are not carried forward. The
installation/cold-bootstrap proposal #14761 is closed and is not a prerequisite.
Main's existing runtime, private retirement and recovery implementations remain
unchanged.

## Problem and existing behavior

Normal resident Session close settles work, revokes the logical context and
releases its Runtime Session. The shared binding remains `READY`, storage remains
`RESERVED`, and the next Session can reuse the original Pod, PVC and files. A
successful close is not authorization to retire that Workspace or delete its Pod.

The existing private application-retirement `DRAINED` result belongs to a
Session-isolated profile pinned to the original generation-1 owner. Its isolation
key is the original Session. It cannot serve as a resident Workspace drain
receipt: a resident binding spans successive Sessions and has no Session isolation
key. Reusing that result or changing only its labels would bypass the missing
Workspace-level admission decision.

The future capability needs an explicit maintenance request that first prevents
new work, then records narrowly scoped original-Pod deletion attempts. It must
preserve occupied storage whenever physical completion is unproven.

## Trust boundary and supported platform

Inherit the resident runtime's trust in the administrator, Kubernetes control
plane, host and qualified ACK Disk CSI. Storage remains limited to
`diskplugin.csi.alibabacloud.com`, `ReadWriteOncePod`, `Filesystem` and `ext4`,
with matching registered disk serial. Preserve tenant, actor, Workspace and
runtime generations, original Pod/container, mount, PVC/PV and protection checks.

This proposal does not require Go node services, a custom containerd/shim,
cold-bootstrap installation, source journals or independent continuous host
confinement proof. Platform trust still does not turn lease expiry, node failure,
a successful DELETE reply or Pod absence into proof of CSI unpublish or safe
volume reuse.

## Proposed Workspace retirement admission

Retirement is a separate, explicitly authorized operation on one persisted
tenant/Workspace and its current generation. The initial implementation should
accept only an idle Workspace: all public Sessions must have completed their
lifecycle, all Runtime Sessions must be `RELEASED`, and every tool execution must
be `SETTLED`. An active or uncertain Session, writer, execution or release refuses
retirement. Forced cancellation and recovery of interrupted work are outside
this increment.

Admission must lock the same Workspace row used by Session creation. In one
transaction it must revalidate actor authority and all original ownership,
persist an immutable idempotent retirement plan, and move the Workspace from
`ACTIVE` to `DRAINING` while fencing the original binding against new acquisition
and dispatch. Either a competing Session is admitted first and retirement is
refused, or retirement wins and the Session is refused. A stale registration,
foreign actor or mismatched generation cannot create or advance the plan.

Persist the tenant, Workspace generation, actor/request digest, original binding
and runtime generation, storage registration revision, physical-volume identity,
namespace/protection identities, and original Pod UID/specification digest. Keep
credentials out of the plan. An idempotent retry returns that same plan; a
different request cannot overwrite it. Recheck authorization for later mutations.

The durable fence must cover Session creation and resolution, Runtime Session
acquisition/activation, tool dispatch, restore/provisioning and maintenance retry.
Audit the registry, resident admission, execution authority, Broker and resident
provisioner together. Existing `DRAINING` state alone is not a claim that every
consumer already enforces this proposed workflow. Specify and test the full SQL
lock order against Session close and existing recovery before implementation.

After the fence commits, failures or lease expiry must not restore `ACTIVE`,
clear the original slot, create a replacement generation or fall back to a
primary/local runtime. This first maintenance increment has no automatic abort
or resume-to-service operation.

## Proposed deletion progress

Use a private maintenance surface scoped to the persisted Workspace and original
binding. Ordinary Session close and file tools do not invoke it. The surface and
credential contract require implementation review; this PR exposes no new API
or executable command.

Before a deletion attempt, corroborate the pinned namespace/protection, PVC/PV,
registration and original Pod identity through the trusted Kubernetes API.
Reject changed UID/specification, unexpected owners/finalizers, an already
deleting Pod or ambiguous platform observations. Missing resources or an
unavailable node must preserve the fence and reservation. Do not delete PVC/PV,
Secrets or namespace protection as part of this operation.

Persist the exact normal Pod DELETE request before transmission, including the
original UID and observed `resourceVersion` preconditions, a 30-second grace
period and Background propagation. Use one durable sender claim per attempt.
All network calls occur outside SQL transactions; each later write revalidates
the original plan and claim generation. Bound and retain actual HTTP status and
reply bytes without synthesizing a reply after transport failure.

One `resourceVersion` may be attempted at most once. A crash after persistence
but before transmission is indistinguishable from a lost reply and remains
`UNKNOWN`; recovery must not resend that request. A fresh, verified observation
with a different version may authorize an explicit next attempt, with at most
eight attempts. Restarting a process must not reset the counter or the fence.

Conceptual progress distinguishes a saved plan/fence, recorded attempts, observed
deletion and Pod absence. These are observations, not a physical-completion
state machine. Neither HTTP 200/202/404 nor a later GET finding no original Pod
grants `STOPPED`, `UNPUBLISHED` or `RELEASED` authority. Keep the binding fenced,
the original active slot retained and storage `RESERVED`. Physical stop,
CSI unpublish, final release and volume reuse require a separate qualified design.

## Persistence and compatibility

Start from the published canonical schema and existing Workspace/operation
ledgers. Prefer a separately versioned resident maintenance record over
reinterpreting the private Session-isolated retirement inventory. Exact operation
and work kinds, key constraints and payload limits must be specified with the
implementation; current canonical CHECK constraints do not admit arbitrary new
kinds. Any necessary schema changes must follow the current shared-schema policy
and update all validators and consumers together.

Do not restore the former node-source table, source-associated inventory or V14
companion migration. No database or protocol change is made by this design PR.
Main's retained snapshots, schema validation and private retirement semantics
remain intact. Mutable maintenance progress must not invalidate immutable
historical application snapshots or relax their integrity checks.

## Failure and acceptance requirements

| Scenario                                         | Required future observation                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary A→close→B handoff                       | Before maintenance, B reads A's exact file bytes on the same original Pod/PVC; ordinary close retains `READY`/`RESERVED`.       |
| Idle retirement races with creation              | The Workspace lock admits one outcome; an active Session refuses retirement, and a committed fence refuses every later Session. |
| Old context or stale maintenance caller          | Reactivation, acquisition and dispatch refuse; foreign actor, generation or claim cannot advance progress.                      |
| Process crash or lost DELETE reply               | The fence, plan, counter and unknown attempt survive; no duplicate send for the same version and no replacement Pod.            |
| Replaced/deleting/missing Pod or changed storage | No new unsafe DELETE; status preserves the original identity and reservation without claiming physical completion.              |
| 200/202/404/409, timeout or node loss            | Preserve the actual response or unknown outcome; never release storage or authorize another owner.                              |

Future verification must separate component/H2, real MySQL with independent
connections, independent application/Broker processes and target ACK results.
Test the entire race and crash boundary, including persistence-before-send,
send-before-reply and reply-before-save. Validate malformed plans, retained bytes,
stale credentials, claim generations and ownership drift against the production
admission path, rather than manufacturing the old source-associated `DRAINED`.

This revision runs documentation formatting, bilingual/reference checks and a
full-tree comparison against #14758. It does not run new Node/Maven runtime tests,
MySQL, independent-process or ACK retirement acceptance. All proposed runtime
acceptance remains pending. Earlier #14765 fixtures and test reports remain tied
to the withdrawn candidate and do not validate this design's implementation.

## Implementation gates and deferred work

Before implementing, review the Workspace maintenance authority and credential
surface, full consumer/lock-order audit, canonical persistence contract and ACK
qualification plan. Then implement and test idle admission/fencing before adding
network deletion. Keep each stage's evidence bound to its exact source commit.

Shell, MCP, Hooks, active-Session forced drain, automatic replacement or resume,
node installation, physical-release proof, destructive storage cleanup and
cross-Workspace volume reuse remain deferred. Resident Pod/node/storage costs
continue while resources are retained, including after an uncertain retirement.
