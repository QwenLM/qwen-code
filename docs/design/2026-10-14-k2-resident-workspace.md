# K2 first release: resident Workspace file runtime

[English](2026-10-14-k2-resident-workspace.md) | [简体中文](2026-10-14-k2-resident-workspace.zh-CN.md)

## Status and scope

This change extracts the resident Workspace first release from the cumulative
K2 proposal in PR #13526 onto the current main baseline. It adds public file
execution and logical Session handoff. Private retirement, physical release,
node collectors and cross-Workspace volume reuse are not included in this diff.
Existing main implementations of private CSI behavior remain unchanged.

Each configured tenant/Workspace owns one original resident Pod and one fixed
CSI PVC. The public Read/Write/Edit profile permits one unfinished Session and
one active tool context. Closing that Session settles its work and revokes its
context while retaining the binding and physical storage reservation. The next
Session uses the same original runtime and files.

## Problem and existing implementation

Public Workspace execution currently resolves a local directory and uses
Session isolation. Close drains bindings and requires runtime stop. Keeping a
Pod alive alone would not prevent overlapping Sessions or reuse of old authority.

Main already supplies CSI registration, protected storage reservation, the
Workspace-scoped fixed-PVC provisioner, boot-3 managed-context workers, file
tools, durable Runtime Sessions and logical context release. The resident path
connects those existing components to public Workspace admission and close; it
does not need the cumulative branch's private native-history or retirement work.

## Configuration and ownership

An administrator explicitly maps tenant, Workspace, generation, CSI registration,
namespace protection, immutable worker image, command and optional artifacts.
Duplicate Workspace, storage alias or physical volume assignments are rejected.
Public callers cannot select a Pod, PVC, worker endpoint or runtime identity.
A CSI registration alone does not enable execution.

The mapping requires Workspace isolation, the files profile, no local mount
mapping or local Workspace creation root, and no child-sharing or local reboot/recovery mode. Shell, MCP, Hooks,
background execution and in-place Session cwd changes are unavailable. A cwd can
be selected when creating the next Session.

The request has a null isolation key and the resident capability digest;
Harness and Runtime Session IDs remain distinct real IDs. It uses main's ordinary
CSI managed-context boot, not the private CSI file profile. The adapter forwards
both the original request and the Broker-persisted provision seed to the
existing provider. The unseeded entry point cannot reconstruct credentials.

The CSI reservation retains the original binding, runtime generation and
physical owner. Logical release changes only the Runtime Session ownership:
`binding_id`, `runtime_generation`, `csi_phase = RESERVED` and the original
reservation identity remain. An expiry, failed RPC or missing Pod cannot transfer
storage to another Workspace or tenant.

This change adds no database migration or schema extension. It uses main's
canonical V1–V5 catalog and millisecond timestamps. Existing refusal of legacy,
partial and foreign catalogs remains; it does not rewrite old persisted evidence.

## Admission and execution

Creation locks the actual Workspace row and checks unfinished Sessions and
unreleased Runtime Sessions before insertion. ACTIVE, CLOSING, DELETING or
unresolved prior work blocks another Session. Idempotent creation returns the
original admission. Child Sessions cannot share the resident runtime.

Resolution and dispatch verify tenant, Workspace generation, storage, current
Session status and actor grant, original binding and full lease. Broker admission
and dispatch apply the durable logical Session fence to the resident Workspace
profile. Another context is refused before inserting an overlapping owner.

Acquisition installs the context for its actual Runtime Session and activates it
after the storage claim. The worker allows one resident context at a time and
permanently refuses reactivation after release. Inactive old contexts do not
claim the next Session's working directory. Both the file tools and provider
manifest are limited to Read/Write/Edit. No failure falls back to the primary
runtime or a local directory.

## Close, restart and failure behavior

The existing lifecycle settles the Hosted journal and detaches its writer.
Resident close sweeps only the original Harness Session's Runtime Sessions in
the exact shared binding, settles and releases them, and verifies that no
original active context or execution remains. It does not drain the binding,
delete the Pod/PVC, unpublish the volume or clear the physical owner.

Cleanup accepts only a persisted Runtime Session with matching binding,
generation, Scope and Harness owner. Missing resident owners cannot create
cleanup tombstones. The original lifecycle claim reaches release admission;
completed cleanup replays without another worker release. Main's legacy
Session-isolated tombstone path remains unchanged.

An uncertain release leaves the Session unfinished and storage claimed, blocking
the next admission. A normal application/Broker restart loads the original saved
runtime identity against the retained database. Worker or Pod replacement,
container restart, changed mount, missing resources or ambiguous recovery keeps
the Workspace unavailable. Automatic replacement and ownership transfer are
outside this release.

## Kubernetes admission and deployment

The original Kubernetes API may inject DNS configuration, including ACK
NodeLocal DNSCache. The provisioner accepts only bounded `nameservers`,
`searches` and closed `options` entries with a name and optional string value.
Kubernetes validates DNS addresses and domains. The complete admitted Pod spec,
including DNS, enters the persisted digest; later changes refuse restore or
reconcile. No other unknown Pod fields are admitted, and the worker endpoint
still uses the original Pod's literal IP.

Use the existing registration operator and offline protection renderer, then pin
the actual namespace/policy/binding identities. The image must contain Node 22+
and the built CLI. The worker uses UID/GID 1000, a read-only root filesystem,
no added capabilities or service-account token, a fixed PVC and temporary
emptyDir, with restartPolicy Never. The application must reach the original
Kubernetes API and worker endpoint. The [configuration guide](../../deploy/k2-resident/README.md)
contains the template and existing operator invocation. Installing this feature
does not require a privileged node collector.

## Changes and split boundary

The application and embedded Broker remain in `packages/managed-agent-server`.
The change adds explicit configuration, a resident adapter/profile and ownership
checks; connects public creation, resolution and logical close; carries the
resolved capability into Hosted; and enforces exclusive, revocable file contexts
in the existing CLI worker.

No Core source, Go module, collector deployment, new public API route, new tool
parameter or migration is introduced. Private boot/history/finalization,
application retirement and physical-release extensions stay in PR #13526. The
existing main code for those areas is not deleted or weakened.

## Validation and acceptance

The split must be built and tested independently. Required checks cover Node
build/typecheck/bundle, focused worker/Hosted consumers, Java admission/ownership,
configuration, transport, lifecycle, lock ordering and static checks. Tests must
show two sequential Sessions retaining exact file bytes, original identity and
storage reservation; concurrent admission and same-key replay; old-context and
foreign/uncertain-owner refusal; and logical-only close/retry.

The ordinary public integration fixture uses real Spring HTTP, H2, Hosted,
journal writers and worker/provider processes. Its test-only provider declares
an ordinary boot-2 placement; public constructors retain the production CSI
provider and JDBC checks. Application reconstruction creates fresh Spring,
Broker, DataSource and repository instances while keeping the original worker.
It verifies same-JVM reconstruction, not process-crash recovery or a CSI mount.
Scoped evidence readers use the original DataSource, hash sensitive values and
write no lifecycle state or public SQL endpoint.

Earlier ACK acceptance remains bound to runtime `53f24ba09` and its original
helpers. It is useful background, not acceptance of this new split. A new cloud
run, MySQL concurrency/recovery, external-model behavior, process-crash and
database-HA qualification are separate checks. Unavailable checks and skipped
cases must be reported explicitly. Independent verification, two clean full-diff
self-audit passes and maintainer architecture review precede a shipping claim.

## Deferred work and operating cost

Automatic physical retirement, privileged collectors, physical stop/CSI unpublish
proof, qualified historical retirement credentials, cross-Workspace safe volume
reuse, multiple writers and automatic lost-Pod recovery are deferred. Resident
Pod/node/storage costs continue after Session close. Operators must retain these
resources until a separately authorized maintenance plan can safely remove them;
ordinary maintenance cleanup does not prove physical release or safe reuse.
