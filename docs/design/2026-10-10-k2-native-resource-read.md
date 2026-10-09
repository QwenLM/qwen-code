# K2 native resource read admission and completion

[English](2026-10-10-k2-native-resource-read.md) | [简体中文](2026-10-10-k2-native-resource-read.zh-CN.md)

Status: proposed; investigation complete, implementation and independent
validation pending. Baseline `f39cf1db9da6489d8d2e0562b15a10214f918da9`.
Refs #12380, #13395 and Draft PR #13526. Full K2 remains incomplete.

## Problem and current behavior

The original private file runtime restores resources through the Managed
Session HTTP resource route. The route authenticates the current writer, admits
a generic retention lease, reads the resource, updates `last_verified_at` and
deletes the lease. That lease records only hashed tenant/Session and a delivery
deadline. It has no durable original binding/resource/writer identity or
completed/unknown I/O history. Its expiry and deletion cannot establish a
complete application cut.

The current file profile produces inline native resources, rather than
`deferred_v3` publications. Existing publication validation also calls the
generic resource reader inside an ambient transaction after taking the head.
Adding a parent lock there would reverse native parent→head ordering. The
existing original CSI deferred-v3 contract is distinct from the private file
profile and must remain usable.

Hosted cold restore changes the current writer claim before installing its
successor activation. Genesis recovery also precedes first activation. A
resource read cannot unconditionally require an installed native writer.

## Goals and scope

This increment introduces a dedicated owner HTTP read boundary for actual
private native inline resources. It records original admission before the
outside-transaction resource fetch and retains a durable completion or unknown
outcome. It preserves first activation and qualified successor restore without
granting a new activation or execution capability.

Ordinary owner reads and original deferred-v3 publication validation retain
their existing reader. Generic publication read/PUT callbacks, unsupported
private historical collectors, quota expiry, physical object streams and
cut-bound historical readers remain separate increments. This design does not
certify those writers, aggregate DRAINED, physical writer termination,
NodeUnpublish, RELEASED, safe reuse or public Spring/Hosted selection. Alibaba
ACK remains an optional Kubernetes test environment.

## Owner route and admission

Keep the existing HTTP request, credential and response schemas. Change only
its store entry to a dedicated owner reader. That entry rejects an ambient
transaction: no SQL owner may hold a head while it starts a new native parent
transaction, and no SQL locks may span the resource fetch. It performs existing
scope, credential and stable-resource-ID checks first.

A nonlocking current `csi_guard` lookup routes an already persisted private
target to the native branch. It is a routing hint, never authority. Once that
branch is selected, missing/conflicting original authority fails; it never falls
back to the ordinary reader. Current CREATE allocates a fresh UUID and cannot
promote an existing ordinary Session. A general barrier against a future trusted
same-ID association remains required with full CREATE/read/PUT membership; a
raw SQL profile conversion is not a demonstrated current CREATE race.

Native admission owns a short transaction on the existing JDBC source. Acquire
placement → retention tenant → complete original slot/binding/Session pin →
journal head → exact resource metadata. Reconstruct the original request with
`JdbcCsiFilesRetirementGuard`, require READY admission, validate the actual
Workspace/current writer credential and unexpired claim, and verify the exact
resource catalog identity. Do not require installed activation or generation 1
for the current writer. The original Runtime binding remains generation 1.

Admit only the current profile's inline resource storage. A historical
object-backed private resource requires a separately qualified original
publication read and is refused by this new native boundary before object I/O;
it is not converted, quarantined or assigned fresh authority.

## Durable record

An additive migration creates `qwen_csi_resource_read`; do not rewrite published
Flyway migrations or backfill authority. Each admitted request receives a fresh
UUID, also used by its ephemeral `qwen_output_read_lease` row. Persist these
values from the locked database, not caller-supplied origin JSON:

- Tenant, Workspace, Session and original request key, binding ID, Runtime
  generation and admission binding version.
- Current writer ID/generation and credential hash, journal revision, activation
  ID/epoch. The activation may legitimately be absent or belong to the prior
  installation during qualified restore; record what was actually present.
- Exact resource ID, kind, schema version, byte length, digest and storage kind.
- State `OPEN`, `RETURNED` or `UNKNOWN`, database start/end time and bounded
  outcome code. Never store a plaintext writer credential or exception body.

Admission commits both rows before fetching inline bytes. OPEN means admitted
and not durably ended. RETURNED means the server's JDBC resource fetch returned
and its normal result-set/connection cleanup completed; it does not assert
successful verification, HTTP delivery, PVC writer stop or CSI unpublish.
UNKNOWN means the fetch/completion was uncertain. Lease expiry, a newer read,
writer takeover or a successful retry cannot close an older OPEN/UNKNOWN row.
No scheduler erases these records in this increment.

## Fetch, completion and metadata

Fetch outside the admission transaction. Compare the fetched row to the admitted
resource identity and verify actual bytes through the existing inline digest
and length checks. A returned but corrupt/missing resource has a known fetch
end and failed outcome. An exception before normal JDBC return leaves UNKNOWN;
a process crash or failed persistence may leave OPEN. Neither is drain proof.

The native fetch must propagate result-set, statement and connection cleanup
failures. Spring's generic JDBC cleanup helpers may suppress SQL close failures;
their normal query return is insufficient to record RETURNED. Use an explicit
outside-transaction JDBC resource lifetime for this boundary, and test physical
JDBC close failure separately from lease-row deletion failure.

Completion independently takes the same original parent before child locks and
checks the persisted admission's immutable origin. It may continue the original
READY or sealed DRAINING binding; it cannot adopt a replacement binding. It does
not require the admitted writer to still own the head merely to record that its
old I/O ended. Successful byte delivery and `last_verified_at` additionally
require the current matching writer grant, scope, unchanged resource identity
and unexpired delivery lease under the locked head. Verify bytes before updating
that timestamp, rather than timestamping an object that has not yet been read.

Persist RETURNED/failed outcome and remove only this ephemeral lease in that
qualified transaction. If the original parent or completion transaction is
unavailable, preserve OPEN/UNKNOWN and the original error; do not run an
unqualified cleanup transaction. UNKNOWN records retain their lease until a
later qualified policy handles it. A completion error is not converted into a
successful response. A newly opened read after sealing DRAINING is refused;
already admitted reads may finish. A later retirement inspector needs its own
cut-bound historical capability rather than reopening owner admission.

This membership ends at server-side resource fetch and verification, before
ResponseEntity serialization/network delivery. Response buffering/delivery does
not write the CSI workspace and is outside this cut. Physical object streams,
SDK retries and their uncertain close lifetimes are not certified by inline
JDBC accounting.

## Components and ownership

| Component                                      | Change and consumer                                                                                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed Session resource controller            | Session-owner route invokes the dedicated fresh-boundary reader; HTTP schema stays unchanged.                                                                                      |
| Managed Session store                          | Original admission, outside-SQL inline fetch, persisted-origin completion and qualified verification metadata. Existing generic publication reader remains separately inventoried. |
| New Flyway migration                           | Empty additive native read history with per-original binding/Session/state lookup; no fabricated legacy provenance.                                                                |
| HTTP Managed Session client and Hosted restore | Existing credential/ref verification and first/cold restore consumers require no new public switch.                                                                                |
| Future full inventory/cut                      | Must include every native read row, including OPEN/UNKNOWN and completed history, and recheck membership under the same original parent. Not implemented by this increment.        |

There is no public lifecycle route, generic authority resolver, optional dead
switch, collector deletion or release transition in this design.

## Validation and acceptance

Use `/feat-dev` sequential phases and an independent read-only test-engineer.
First attempt the global `qwen` baseline; record its actual reachability and use
a bounded Java/JDBC fallback for this private Java-only HTTP boundary. Before
implementation observe a real private CREATE→Main→Hosted→Store/SQL→Worker
resource GET, its durable lease, disappearance after completion and absence of
original completion history. Previous native runs are reusable harness sources,
not fresh evidence.

The independent baseline at the stated commit reached one actual native window:
10 successful resource GETs, one wrong-credential 403, and 10 temporary lease
insertions/deletions. All 57 discovered tables and 726 columns lacked native
read-end history. Each successful GET changed only its resource verification
timestamp; the rejected GET changed none of those tables. The global `qwen`
discovery succeeded but exposes no private Java entry, so these observations
used the actual built Main/Hosted/Store/Worker with an owned MySQL fallback.
The coordinator exited 1 because the observer's hold control compared string
references and never triggered; preserve that failure. Cold restore, held
expiry, close failure and isolation contention were not established by this
run. Correct the observer and repeat the affected groups before implementation
acceptance; this partial baseline is neither a complete test-plan pass nor K2
acceptance.

A follow-up baseline on the unchanged production reader corrected only the
ignored observer's control-string comparison. One native window completed
22 checks with all actual commands exiting 0; the held-fetch marker showed
an existing durable lease and no active SQL transaction. Lease counts were
0→1→0 before, during and after the owned release, and the GET returned 200
with exact original bytes. The old failed run remains failed. This completes
the basic GET/held-fetch observation, not natural expiry, JDBC close failure,
cold restore, original-parent isolation contention or the proposed reader's
acceptance. Those unexecuted groups and full K2 remain pending.

Acceptance requires actual native owner HTTP reads and exact resource bytes,
first activation and successor pre-install restore, stale/expired credentials,
sealed new-read refusal, already admitted read completion after seal, delayed
JDBC fetch beyond delivery expiry, uncertain fetch/completion and distinct retry
history. Observe owned MySQL READ COMMITTED and warmed REPEATABLE READ original
parent→head contention; H2 fixtures alone cannot prove those locks. Preserve
all discovered tables/columns with raw values and list exact allowed per-key
read-history/ephemeral-lease/verification-time changes. Assert unrelated
resources, original journal, execution, receipt, result, grant and Worker file
history are unchanged.

Keep ordinary HTTP resource/grant/publication regression controls and distinguish
component historical fixtures from naturally produced native authority. Run
focused Java tests, build/typecheck/bundle, appropriate Java verify, two clean
self-audits and independent exact-candidate review. Preserve failed observations
and independently clean only owned resources. Publish exact candidate/product
bindings and a separate E2E report on the same Draft PR. Full K2 acceptance and
maintainer architectural review remain open.

## Follow-up dependencies

Complete generic read/PUT/error/collector/quota writer closure, freeze unsupported
private history before object DELETE, and integrate the immutable application
cut before interpreting this table as drain eligibility. Existing OPEN/UNKNOWN
records must block that later cut even after every lease expires. Durable worker
finalize, original physical stop/unpublish, atomic release/reuse and fresh target
Linux/cloud/security/portability verification still follow; CI success or a
local fixture cannot substitute for them.
