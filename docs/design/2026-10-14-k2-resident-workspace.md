# K2 first release: resident Workspace tool runtime

[English](2026-10-14-k2-resident-workspace.md) | [简体中文](2026-10-14-k2-resident-workspace.zh-CN.md)

## Status and scope

The user approved this first-release scope on 2026-10-14. The resident branches
are implemented. Local checks and independent worker protocol, Java data and
Spring configuration validation have passed. The 2026-10-16 ACK acceptance on
runtime `53f24ba09` and separately frozen experiment helpers, including the
ownership reader from `a4a51655c`, completed the four direct evidence requirements:
six actual file tool calls and replies,
six ownership snapshots from the original application DataSource, concurrent
admission, and a normal application JVM restart followed by a successful second
Session. Independent checks passed 52/52, with 26/26 additional data checks.
Both Sessions closed normally while the original worker, binding identity and
physical reservation remained throughout handoff. All new trial resources were
normally cleaned and checked absent. A separate installation attempt failed its initial Turn;
its blocked close and approved synthetic-state abandonment remain recorded and
are not recovery evidence. Shipping review still has no verdict; the PR remains
Draft. This document supersedes the automatic retirement
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

The resident adapter forwards both the original request and Broker-persisted
provision seed to the selected CSI provider. The unseeded entry point remains
unavailable; it cannot reconstruct or replace the original credentials.

The existing CSI reservation pins the shared binding and generation. The actual
Runtime Session row owns the logical context; Session release changes that row
to RELEASED and never writes the physical owner. It retains
`binding_id`, `runtime_generation`, `csi_phase = RESERVED` and the original
reservation identity. No expiration, failed RPC or lost Pod permits another
Workspace or tenant to take ownership.

The current main schema uses `gmt_create` / `gmt_modified` and unsigned BIGINT
Unix epoch milliseconds for persisted timestamps. K2's complete typed inventory,
terminal expected image and operation projection use that same physical schema;
cut protocol timestamps remain canonical ISO strings and must represent exact
milliseconds. Old timestamp catalogs and old frozen images are refused, without
renaming columns or rewriting saved evidence during admission.

A Session's initial row, approval-mode pin and creation event use the same
captured admission time. The approval update still explicitly writes
`gmt_modified`; it uses that CREATE's time rather than a second clock read.
This preserves the strict initial creation facts and their whole-row comparison
without depending on two clocks landing in the same millisecond.

Within this new canonical baseline, Broker initialization and Flyway recognize
only the exact V1/V2/V3 shapes before applying the additive K2 V4 extension. They
preserve matching rows and migration-history entries, then validate the complete
V4 catalog. This is not an upgrade path for the earlier DATETIME or legacy
catalogs. Deploy this revision with a fresh database and retain the old binary
and database for historical access.

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

The ACK observations below apply to deployed runtime commit `53f24ba090d3`.
The later merge of main `4a80f0a6adb8` changes the database baseline and is verified
separately with local build, schema and public handoff regressions. The earlier
cloud observations do not establish ACK qualification of that later merge.

Local verification of that later merge passed the full Node build, typecheck and
bundle, 104 HTTP-store tests, 964 CLI consumer tests, 84 focused Broker tests and
619 focused Server tests, with two existing MySQL-only tests skipped. Checkstyle,
SpotBugs, ESLint and formatting checks passed. An additional eight-test ordinary
claim regression run separately controls state and generation rejection.

Independent source compilation reproduced all 1010 frozen production classes
byte for byte. Fifteen resident H2 tests and both ordinary public handoff tests
passed without skips. Each public flow captured six actual tool call/reply pairs
and exact A-final/B-first read bytes, with four/five same-DataSource ownership
snapshots. Application reconstruction used fresh Spring, Broker, DataSource and
repository instances while the original worker stayed alive, with one start and
zero physical releases. Actual metadata showed 34 application tables plus Flyway
history, no shadow legacy tables, and BIGINT timestamp/lease/deadline columns.
These are ordinary same-JVM H2 checks; the independent observer's missing
initializer and schema-case mistakes were preserved and corrected only in its
own inputs before repeating the same two tests.

The successful ACK attempt retained 62 contiguous response records. A performed
Write/Edit/Read; B performed Read/Edit/Read after the application JVM restarted.
All six actual call/reply pairs were captured, including explicit Write/Edit
acknowledgments. B's initial read exactly matched A's final read bytes. Both
Sessions reached `closed`; the same-key close replay returned the original
operation, and old A input returned `409 workspace_unavailable` both before and
after restart. Two concurrent distinct-key creates yielded one 202 and one
`409 workspace_busy`; two concurrent replays of the winner key returned the
same Session. This is the observed two-batch result, not a general concurrency
proof.

Six same-DataSource, read-only snapshots each captured eight fixed tables.
The original binding identity, runtime generation, seed, lease and handle
projections stayed equal. The complete exported slot, storage and owner rows
stayed equal, with CSI `RESERVED` at revision 1. Both original Runtime Sessions
were already `RELEASED` after their completed Turns and remained released after
close. The binding stayed `READY`; its attestation and operation generations,
record version and health timestamps legitimately advanced when B used it.
This does not claim the entire binding row remained unchanged.

The normal restart reopened the same file-backed H2 database in a new child
JVM (PID 20 to 277, with different incarnation IDs). The app container and
original worker retained their UID, container and image identities with zero
Kubernetes restarts. The same PV/PVC and disk handle remained throughout, and
B actually executed against that retained worker. The deterministic test model
and file-backed H2 do not qualify an external model, MySQL concurrency, crash
recovery or production database high availability. The node remained cordoned;
the installer used normal Binding API calls for only the exact experiment app
and the worker created by the original provisioner. Ordinary maintenance cleanup
does not qualify physical retirement or cross-Workspace volume reuse.

Evidence collection remains inside the experiment.
The model fixture saves only the selected run's actual tool calls and replies,
with bounded text results and exact read-byte comparisons. A test-only reader of
the original application DataSource exports scoped, consistent ownership
snapshots; it exposes no public SQL route and writes no lifecycle state. Admission
tests use independent DataSources and stores. Application reconstruction
tests preserve the original placement while creating fresh application and
Broker instances; retaining an old Broker object does not prove recovery.
The model fixture's three unit tests cover bounded capture, exact read bytes,
identity refusal and immutable retries; these tests use synthetic replies.

Independent local validation on 2026-10-16 passed 15 H2 store tests and both
ordinary public handoff tests, with no skips. Each public test retained six
actual tool replies; the second Session's initial read exactly matched the first
Session's file bytes. Four ownership snapshots were saved for the original
handoff and five for application reconstruction. The original slot, storage and
CSI reservation rows stayed identical. Both logical closes left the complete
binding unchanged; reconstruction preserved all eight captured tables while
creating fresh Spring, Broker, DataSource and repository instances. The original
placement and worker stayed alive, with one start and no physical release.
Runtime Sessions were already released after each completed Turn; public close
retained that state. This is same-JVM reconstruction with in-memory H2 and an
ordinary boot-2 placement. The separate ACK acceptance above supplies the
file-backed database reopening, new application JVM and CSI evidence; it does
not extend this local fixture's qualification.

The Session lock-order canary includes the resident store's Session locks and
the CSI inventory's Turn reads in its exact source boundary. It resolves calls
on a final method-body local only when that local directly constructs one unique
private static final nested type declared directly in the caller and has no
reassignment, shadowing or escape.
These calls retain normal audit edges: reversed lock order still fails. Unknown
receivers, aliases and ambiguous overloads remain unresolvable.

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
