# K2 first release: resident Workspace tool runtime

[English](2026-10-14-k2-resident-workspace.md) | [简体中文](2026-10-14-k2-resident-workspace.zh-CN.md)

## Status and scope

The user approved this first-release scope on 2026-10-14. The resident branches
are implemented. Local checks and independent worker protocol, Java data and
Spring configuration validation have passed. The ordinary public Hosted handoff
has passed locally with H2 and declared placement. The ACK application starts,
but its first Turn failed during worker admission and normal close remains
blocked; the complete ACK handoff remains unverified. This
document supersedes the automatic retirement
and volume reuse requirements of the earlier K2 completion plan for this release.
Those designs and their evidence remain future work, not acceptance evidence for
this release.

Each tenant/Workspace has an exclusive resident tool runtime, one original Pod
and one fixed CSI PVC. The first release supports the public files tool profile.
It permits one unfinished Session per Workspace. Ending that Session settles its
work and revokes its tool context; it retains the runtime binding and physical
storage reservation. The next Session uses the same runtime and files.

## Implementation before this change

The Broker already separates runtime bindings from Runtime Sessions. Ordinary
Runtime Session release does not release its binding. The managed-context worker
already installs and closes independent contexts. The CSI provisioner has a
Workspace-scoped, null-isolation-key branch using a fixed PVC and boot version 3.
It pins the original Pod, Secret, node, container, image and mount identity.

Before this change, public Workspace execution resolves a local directory and uses
Session isolation. Its storage holder release clears the binding. Public close
drains bindings and requires worker stop. Workspace-scoped Broker admission also
skips the logical Session fence. This change adds explicit resident branches.
Simply disabling Pod deletion does not provide safe Session handoff.

## Configuration and permanent ownership

An administrator supplies explicit resident Workspace mappings and Kubernetes
connection settings. Each mapping fixes tenant, Workspace, generation, CSI
registration, namespace protection, image digest, worker command and artifact
pins. Configuration rejects duplicate Workspace, storage alias and physical
volume assignments. The public API cannot supply a Pod, PVC, runtime identity or
worker endpoint. Unconfigured CSI storage remains unavailable.

The original Kubernetes API and its admission controllers may supply DNS
configuration, including ACK NodeLocal DNSCache injection. The provisioner
accepts only the `nameservers`, `searches` and `options` DNS fields, with bounded
string lists and closed option objects containing a name and optional string
value. Kubernetes remains responsible for validating DNS addresses and domains.
This does not add general support for unknown Pod fields. The complete admitted
Pod spec, including DNS, enters the existing persisted digest; a later DNS change
refuses restore or reconcile. Resolver addresses are infrastructure configuration,
not caller-supplied runtime identity. The worker endpoint still uses the original
Pod's literal IP. See the [ACK injection contract](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/configure-nodelocal-dnscache).

The selected request uses Workspace isolation with a null isolation key, the
`resident-workspace-files/1` capability digest, and the fixed storage ID. Session
IDs remain real independent IDs. The shared request key is never written into
`ma_session.runtime_request_key`: that column belongs to the old private CSI
retirement lane and is covered by its generated guard.

The existing CSI reservation pins the shared binding and generation. The actual
Runtime Session row owns the logical context; Session release changes that row
to RELEASED and never writes the physical owner. It retains
`binding_id`, `runtime_generation`, `csi_phase = RESERVED` and the original
reservation identity. No expiration, failed RPC or lost Pod permits another
Workspace or tenant to take ownership.

## Session admission and tools

Creation locks the real `ma_workspace` row and checks current unfinished
Sessions and unresolved Runtime Sessions before insertion. ACTIVE, CLOSING,
DELETING or unresolved prior work blocks a second Session. Idempotent creation
returns the original admission. A child Session cannot share this first-release
runtime. The public files profile and existing actor grants remain required.

Resolution and dispatch verify the current tenant/Workspace/generation/storage,
Session status, grant, original binding and full lease. Broker admission checks
the durable logical Session fence for this Workspace-scoped profile. Acquisition
installs a context for the real Runtime Session and activates it only after the
storage claim. The worker permits one active resident context. Releasing a
context permanently closes its admission; replaying an old activation cannot
reopen it. No failure falls back to the primary runtime or a local directory.

## Close, restart and failure behavior

The existing Session lifecycle settles the Hosted journal and detaches its
writer. Resident close sweeps only Runtime Sessions belonging to that original
Harness Session in the exact shared binding. It settles and releases them using
the existing release protocol, verifies no active original context remains, and
never calls binding drain, Pod deletion or physical storage release.

Original cleanup accepts a resident binding only with its already persisted
Runtime Session, matching binding, generation, Scope and Harness owner. Missing
resident owners cannot create a cleanup tombstone. The original lifecycle claim
is passed to release admission, and completed cleanup replays without another
worker release. The legacy Session-isolated tombstone path remains available.

An uncertain release leaves the Session unfinished and storage claimed. A new
Session remains blocked. Broker restart recovers the original saved runtime
identity; worker or Pod replacement, missing resources, changed mount, container
restart or ambiguous recovery keeps the Workspace unavailable. There is no
automatic replacement or ownership transfer in this release.

## Changes by layer

- Managed server configuration: explicit resident mapping and Kubernetes inputs.
- Creation and execution stores: single Session admission and exact Runtime
  Session ownership checks that retain the permanent physical reservation.
- Resolver, provisioner and transport: select the configured Workspace/PVC and
  install the actual Session context on the shared runtime.
- Broker: durable Workspace Session admission and logical-only close sweep.
- Worker: resident context activation exclusivity and permanent old-context
  revocation.

## Validation and acceptance

Tests must show two sequential Sessions share the same request, binding, Pod/PVC
identity and retained files; the first cannot execute or reactivate after close.
Concurrent creation, stale generation/grant/context, outstanding work, uncertain
release, foreign tenant/Workspace and changed original runtime must refuse.
Close must issue no binding release, Pod/PVC DELETE or CSI unpublish. Existing
local Workspace and private CSI retirement behavior must retain their guards.

Allowed local data, H2 and worker protocol tests prove only their stated layers.
They do not prove an actual Linux CSI mount or ACK deployment. Previously refused
native acceptance operations are not retried through this architecture change.
Build, typecheck, focused tests, independent validation and two clean full-diff
audits precede a completion claim. Deployment and cloud acceptance remain separate
from local implementation validation.

The ordinary public lifecycle integration test uses real Spring HTTP, H2,
Hosted Harness, journal writers and worker/provider processes on macOS. A
package-private Broker constructor accepts an explicit test placement provider;
every public constructor retains the production CSI provisioner and JDBC checks.
The fixture uses boot 2, an ordinary directory and a declared synthetic placement
handle. It does not emulate CSI boot 3 or qualify a Pod, mount or physical release.
The second Session must read the first Session's unique bytes before editing
them; both Sessions close through the public API and must seal their journals
and release their original Runtime Sessions while retaining the shared binding
and complete physical ownership rows.

Warm and acquisition HTTP responses carry the original resolved Scope's
isolation class, including the resident profile. Hosted validates this field
alongside the capability digest; it does not infer isolation from a profile name
or substitute a default when the field is missing.

## Deferred work

Automatic Pod/PVC retirement, privileged node evidence collector, physical stop
and unpublish proof, historical retirement credentials, cross-Workspace volume
reuse, multiwriter Sessions, in-place Session cwd changes, Shell/MCP/Hook profiles and automatic lost-Pod
recovery are outside this first release. Administrators retain the resident
resources and their ongoing cost until a separately authorized maintenance plan
can safely retire them.

The directory may be selected when creating a new Session. The first release
does not advertise or admit an in-place cwd change on a resident Session.
