# W1b: Offline Workspace Recovery Bundles

[English](2026-10-01-managed-workspace-w1b-bundle.md) | [简体中文](2026-10-01-managed-workspace-w1b-bundle.zh-CN.md)

Status: implemented; local validation passed, deployment acceptance pending.
Integrated with main `d5c22d33`, including the merged file-history dependency
[#13110](https://github.com/QwenLM/qwen-code/pull/13110) at `e083d6a6b`.
Its final preparation rollback fixes and recovery tests are preserved.
Part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
Completes the W1b slice of the [W1 recovery design](2026-09-29-managed-workspace-w1-recovery.md),
without implementing W1c placement promotion.

## 1. Problem and scope

W1a verifies surviving storage identity and private Session history. It does not
prove that a backup contains the complete shared Workspace, worker file-history
backups, authoritative journal and private resources at one recovery point.
Public transcripts, a directory name, a released holder and a list of object
names do not provide that proof.

Implement one private offline maintenance workflow for trusted single-host
Linux deployments. It covers every bound Session sharing tenant/storage,
including retained archived, closed and deleted rows; Hosted files and Shell
profiles; accepted O2 results; and the actual backup bytes used by #13110.
Unsupported profiles or unexplained references prevent a compatible recovery
point for the entire storage. Unbound Sessions remain untouched.
Plain Hosted model attempts include their original
`managed-hosted-model-route` and `managed-hosted-model-usage` resources.
Hosted Hooks and MCP Sessions remain unsupported and prevent capture of their
entire shared storage.

The first provider is `local-workspace-bundle/1`: an operator prepares a copy of
the Workspace and retained worker backup directories outside all active roots.
Maintenance compares that copy with the stopped sources, exports private
authority resources, and seals a versioned manifest. The durable SQL receipt's
manifest digest is the trust anchor. Neither chmod nor a bundle's self-reported
hash proves immutable contents. Every later read verifies the pinned bytes.

W1b does not overwrite active files, acquire a Session writer, replay effects,
rewrite history, change a ContextBinding, provision a Runtime or lift a fence.
SQL/VM rollback, hostile same-UID writers, online snapshots, cross-host
placement, host images and W1c activation are outside this acceptance.

## 2. Maintenance boundary and fixed cut

Before capture, operators close Session creation, input admission and background
dispatch; settle or cancel all admitted work; stop Harness, Session Store
writers, workers and external filesystem writers; prevent their restart; and
release or expire writer leases. Only after exact storage holders are cleared
may they establish W1a's fence. Keep these processes stopped throughout capture.
The maintenance entry requires explicit offline confirmation and checks the
observable conditions. A fence or expired lease alone never certifies stopped
processes: current creation and model-only journal paths do not read that fence.

Use distinct recovery and fence operation UUIDs. Pin the fence operation and
expected mount revision in the recovery request. A repeated recovery UUID with
different request bytes conflicts. A completed request replays its original
receipt; checking current compatibility uses a fresh verification operation.

Enumerate original `workspace_storage_id` membership with stable Session ID
pagination, not the public ACL/status/updated-at list. Save each original
creation receipt and request digest, exact seven-field ContextBinding, frozen
configuration references, public Session version/event watermark/admitted-work
state, and the real private Session Store key. Its workspace ID must not be
replaced with the product Workspace ID. Pin the private writer identity/state,
journal revision, committed sequence, last commit digest, activation epoch,
checkpoint, compaction and recovery state. Missing heads are uninitialized,
not permission to create history. Existing heads without committed genesis
refuse capture. Active work, pending lifecycle operations,
live writer leases, unsupported compaction and blocked recovery refuse capture.

Main's permanent deletion clears the private checkpoint pointer but retains its
journal and resource bytes. Pin the original retirement owner, operation,
generation, database timestamp and recovery protection; require the matching
confirmed, completed DELETE and public tombstone. Only that evidence permits a
DELETED head with no writer or checkpoint pointer. Still validate every original
journal watermark, checkpoint and resource, and require settled work. Legacy
deleted rows without retirement evidence retain strict pointer equality.
Retirement changes invalidate the fixed cut. This does not restore the Session
or reopen its writer; public Workspace-bound DELETE admission remains unavailable.

Recheck a Session before each derived commit and recheck the complete membership
and source digest before sealing or recording compatibility. New Sessions,
model-only commits, changed bindings, renewed writers and new admitted work
invalidate the old cut. No retry silently advances its watermarks.

The private head's lease fingerprint preserves the stored DATETIME(6) wall-clock
value as an ISO local date-time string, including fractional seconds. It does
not reinterpret that value as an epoch using the maintenance process timezone.
Actual lease expiry is still checked against database time on the same
connection. The earlier pre-release epoch-millisecond representation is not
silently rewritten: its sealed content can still be checked, but current
authority comparison cannot certify a head using that old fingerprint. Start
a new capture after upgrading all maintenance binaries.

## 3. Persistent workflow and private entry

Three additive tables hold recovery operations, pinned Session sources, and
asset/reference work. They are derived metadata; original creation receipts,
journals, resource rows and resource-ref rows are never modified. The next
unused Flyway migration introduces them without repairing old history.

Operation phases are `CAPTURING`, `SEALED`, `VERIFYING`, `VERIFIED` and
`INVALIDATED`. I/O interruption retains the phase and progress. Source drift
invalidates the operation. Operators investigate and start a new recovery UUID
under the still-owned fence; no operation takes over another fence.
Completion updates only the expected mutable phase, so a concurrent committed
invalidation cannot be overwritten by a stale completion request.

A previously unpinned unsupported source entry refuses capture with
`unsupported_source_entry`, invalidates that recovery UUID, and prints its type
and parent-relative path only on the operator's stderr. Paths are JSON-escaped
so unusual filenames cannot forge diagnostic lines. After correcting the
offline source and preparing a new matching copy, use a new recovery UUID.
Unsupported replacements of pinned entries and final-tree changes remain
`source_drift`. Disappearance of observed source paths still invalidates;
unreadable paths remain read failures. Unsupported candidate entries retain
candidate-validation errors.

The Java private main supports `capture`, `verify` and `inspect` with an
operator-owned JSON request and `--offline-confirmed` for mutations. Requests
identify tenant/storage, recovery UUID, fence UUID, expected mount revision,
canonical source/bundle roots, the original worker file-history root, the Node
executable and matching packaged CLI entrypoint. Verification additionally
names the sealed capture operation. JDBC credentials and optional O2 object
storage credentials are environment-only. There is no HTTP maintenance route.

Java owns JDBC, scope checks, source snapshots, pagination, conflict checks and
conditional completion. A matching packaged CLI child runs the read-only
TypeScript filesystem/protocol validator. They exchange one correlated JSON
request/response at a time over pipes; record/object bounds follow the existing
protocol limits. Child failure or an unexpected response cannot seal an
operation. No public writer token or production Harness is created.

The npm wrapper dispatches the private worker before importing the normal CLI
module graph. The bundled executable enters the CLI bootstrap directly and
therefore retains its own dispatch. The private flag is for Java's stdio child,
not a public help command. Wrapper import or startup failures report a diagnostic
and exit nonzero regardless of Node's unhandled-rejection policy.

The single-threaded private Java process owns one physical JDBC connection and
closes it on normal completion, inspection, receipt replay and failure. Each
existing transaction still commits or rolls back separately; per-record fence,
source and ownership checks are retained. No connection pool or online service
behavior changes.

Plan the offline window by filesystem entry count as well as byte size. The
[independent Linux report](https://github.com/QwenLM/qwen-code/pull/13138#issuecomment-5933639978)
measured a 20,916-entry, 77-Session capture at 829 seconds and verification at
765 seconds on a 4-vCPU/8-GiB VM before connection reuse. Its separately tested
single-connection candidate reduced a 20,500-entry capture from 806 to 221
seconds and verification from 378 to 136 seconds. These are the reviewer's
workload measurements, not a latency guarantee for this revision. Guard reads
and derived metadata writes still cost work per entry. Each capture and verify
retains its own operation, Session and asset rows for resume and receipt audit;
there is no automatic retention cleanup in W1b. Budget database space for
repeated operations; batching and garbage collection require follow-up designs
that preserve the maintenance and receipt boundaries.

The packaged maintenance artifact is `qwen-managed-agent-server-0.1.0-alpha-workspace-bundle.jar`.
Run `java -jar <artifact> capture <request.json> --offline-confirmed`,
`java -jar <artifact> verify <request.json> --offline-confirmed`, or
`java -jar <artifact> inspect <request.json>`. Deploy the schema through the normal
upgrade first; the maintenance executable does not run migrations or boot the
Broker. Configure `W1_JDBC_URL`, `W1_JDBC_USER`, and `W1_JDBC_PASSWORD`. Optional
external O2 reads use `W1_OSS_ENDPOINT`, `W1_OSS_REGION`, `W1_OSS_BUCKET` and the
existing OSS environment credential provider. Credentials are removed from the
Node child's environment. No public model service is required.

A capture request has `version: 1`, `operationId`, `tenantId`, `storageId`,
`fenceOperationId`, `mountRevision`, `sourceRoot`, `bundleRoot`, `fileHistoryRoot`,
`nodeExecutable`, and `cliEntry`. Paths are absolute; the roots must be canonical
and separate. `cliEntry` points to the matching packaged `dist/cli.js`.
Verification uses a fresh `operationId` and adds `captureOperationId`, retaining
the original scope, fence, revision and roots. Inspect needs only version,
operation/tenant/storage IDs and optionally `afterSessionId`. It reports pinned
Session sources in pages of 32 with `nextSessionId`, queue/completion counts,
registration, stable `lastErrorCode` and the original receipt. It acquires no
writer. Original absence or `not_captured` history does not require an unused
worker backup directory to exist; a referenced missing backup always fails.

Implementation consumers are the private Java main/store/reader and the matching
CLI worker, local provider and Session validator. The only shared production
changes are pure Session Store parser exports and a typed read-only W1a guard
query, plus exact private-flag dispatch in the npm entry and bundled CLI bootstrap
before normal CLI/model or inherited update startup. Existing HTTP Session readers, writers, Hosted turn routes and Runtime
worker dispatch remain on their established paths. The additive V31 work queue
indexes support asset-key paging and Session/state reference selection.

Session pages and reference queues are persisted and bounded. Read one journal
transaction or resource at a time; use protocol parsers and digest-chain checks
without accumulating a whole Session log. File bytes are hashed in 1 MiB chunks.
Temporary files are exclusively created, synced and atomically published before
their derived progress commits. Retry reuses matching bytes; conflicting
existing bytes are refused. Filesystem paths and opaque object keys never
become unchecked output paths.

## 4. Bundle format and complete closure

The operator-prepared bundle contains `workspace/` and, where retained,
`file-history/<Session ID>/`. Maintenance adds `authority/objects/<SHA-256>` blobs and the reserved
`.w1-recovery/` directory with `manifest.json`, `sessions.ndjson` and
`assets.ndjson`. Indexes are newline-delimited, versioned and streamed in stable
order. The top-level manifest records provider/version, tenant/storage,
registration, original mount revision/fence/capture IDs, fixed-cut digest,
index counts/digests and the explicit non-activation conclusion. SQL stores
the final manifest digest and original completion receipt.

Capture compares the entire candidate Workspace tree against the stopped
registered source. It records normalized relative names, entry types, basic
POSIX modes, byte lengths and content digests. Regular files and directories
are supported. Relative symlinks must resolve completely inside their own
root; enumeration never traverses symlink directories. Absolute, escaping,
cyclic or dangling links, hard-linked regular files and special files refuse.
No ACL/xattr or full host-image recovery is claimed. Candidate-only or missing
entries refuse; provider metadata and private blobs are also checked for
undeclared files. Source and candidate roots cannot alias or overlap.
On partial-inventory retries, recheck persisted original entries even without a
completed tree marker. A lost original file, Workspace root or Session backup
directory invalidates the old capture instead of accepting replacement bytes.
Replacing a pinned Workspace or backup root with a symlink or non-directory
also invalidates it; invalid roots without captured evidence still refuse.
Observed source loss during the first forward/reverse inventory pass likewise
invalidates capture. Missing candidate entries and unpinned candidate-only
entries return `snapshot_source_mismatch`, preserving the same operation for a
corrected copy. Before a complete inventory exists, an unobserved source path
with no candidate proves a mismatch, not when the path was created. Persisted
entries and completed tree membership are still rechecked for drift.

Capture initialization removes interrupted metadata publications only for the
three exact final metadata names followed by `.partial-<current operation ID>`.
Each must be a regular file with one link. Foreign operation IDs, unknown
names, links and special entries remain refused by strict enumeration.
Verification never removes these files; final files with conflicting bytes
are never overwritten.

Private exports preserve exact journal transaction bytes and source digests.
Validate genesis identity, revision/sequence continuity, commit markers and
the final pinned head. Traverse header references, typed event references,
checkpoint groups and historical domain predecessor chains. Reuse existing
record/checkpoint/message/file-history/tool-result parsers. Check owner, kind,
schema, length and digest; resource-ID metadata conflicts and unknown domains
refuse. Persistent queues and deduplication keep closure memory bounded and
prevent cyclic resource chains from looping.

For Shell, verify the original accepted publication/receipt, its ownership and
journal position, result manifest, pages, content/segments and seals, including
full-stream lengths/digests and empty streams. Export exact O2 object bytes;
do not substitute a new publication or validate object existence alone. This
maintenance reader must not renew publication/writer tokens or quarantine
production authority. An incomplete/unknown result is not a settled cut.

Require a settled initial/finished-turn cut, rather than merely a runnable
checkpoint. Awaited approvals, Runtime work, model continuation, pending file
history/undo and unresolved accepted input refuse compatible capture. Validate
reader-facing messages without rewriting their content or cwd strings.

## 5. File-history evidence

Use #13110's saved history records and owner/path validators. Follow all retained
records and their predecessors, not only the latest snapshot. Resolve backups
in the explicitly supplied original worker history volume under the owning
Harness Session ID, and compare those bytes with the operator's copied volume.
Missing/corrupt referenced backups, failed capture records, ownership conflicts
or pending history/undo refuse; never substitute current Workspace content.

Hosted records share the live reader's pure record parser, including schema,
pending message/turn consistency and the complete undo-receipt protocol from
#13144. Check exact receipt shape, UUIDs, retained prompts, unique requests and
tracked changed paths; conflict receipts cannot claim changed files. Legacy
records without receipts remain valid. Checks apply to all retained records,
without acquiring a writer or changing original resources.

A recorded null backup filename is original absence. A missing non-null backup
is corruption. No history domain means `not_captured`, not invented undo
availability. Existing historical backup metadata has no original content
digest: W1b establishes a retained-byte digest at this capture and guarantees
consistency from that point, not proof that the preimage was never corrupted
before capture. Preserve original history/undo conflict semantics.

## 6. Conclusions, compatibility and rollout

Keep `contentVerified`, `authorityCompatible` and `activation` separate.
`VERIFIED` identifies a checked bundle; `activation` is always false.
Compatibility requires exact current storage membership, bindings, admitted
states and journal watermarks, plus a valid matching maintenance boundary.
Any incompatible Session prevents compatibility for the whole shared storage.
A lost source root still permits pinned bundle content verification; it does
not authorize registration repair, mapping promotion or lifting a fence.
An old receipt is not current authorization. A future W1c consumer must recheck
the cut and expected mount revision immediately before its own transition.

Transient I/O failures retain progress for same-ID retry. Digest/scope conflicts
are reported without overwriting artifacts; source drift is invalidated. Keep
private stable diagnostics and exclude credentials from output. Inspect is
read-only. Normal W1a cold loading does not scan backup trees on every Turn.

Deploy the matching Java/CLI bundle and additive schema offline. Old binaries
ignore the new metadata/fence assumptions; they must remain stopped. Target
main in one Draft PR, with #13110 explicitly identified until merged and fully
integrated. Do not mark ready before real Linux/MySQL acceptance.

## 7. Validation and acceptance

Write the working plan in `.qwen/e2e-tests/managed-workspace-w1b-bundle.md`.
Dry-run global `qwen` first and report the absent private entry honestly; use a
maintenance-process test-script fallback rather than a fake model success.

- Capture two Workspaces and multiple files/Shell Sessions sharing storage,
  including archived rows, O2 output and a distinct history volume.
- Interrupt at every batch, blob publication, SQL progress and final receipt
  boundary. Same-ID retry produces identical indexes/digests and no authority
  mutation or duplicate references.
- Inject late creation, model-only commits, writer renewal, binding changes
  and accepted input. Refuse the old cut and preserve the fence/active tree.
- Remove/corrupt checkpoints, messages, domain predecessors, backup bytes,
  O2 pages/segments/seals and manifests. Missing empty-stream seals refuse.
- Cover root overlap, escaping/looping links, special files, undeclared entries,
  cross-Session references, prototype-named files and snapshot source mismatch.
- Distinguish original absence, uncaptured history, missing backups, pending
  undo and partial restoration. Source loss permits content-only verification;
  later authoritative work refuses compatibility.
- Exercise paginated large membership and streamed large file/output data,
  plus W1a original-receipt and cold-load regressions.

Build, typecheck, bundle, focused package tests and Java Checkstyle are required.
Use packaged Harness/worker, Java Broker and MySQL 8 on Linux for physical and
persistence gates. H2/macOS results are separate evidence, not Linux acceptance.
Complete two consecutive clean self-audit passes and independent review; attach
the measured E2E report to the single PR. There are no open provider/scope
choices; remaining acceptance evidence is recorded as pending until measured.

Measured on 2026-10-01: build/typecheck/bundle, the 63 W1b unit tests, CLI
bootstrap tests, relevant core/history tests, and focused Java tests/Checkstyle
passed. An independent maintenance-process fallback used the actual packaged
CLI child, packaged Java classes, MySQL 8.4.11 and a synthetic storage identity
reader on macOS. It captured 35 Sessions across two Workspaces, 106 assets and
56 filesystem entries; same-ID completion replay preserved the receipt and all
artifact digests. Fresh verification separated compatible content from
content-only verification after source loss. Interrupted and mid-run source
drift remained `INVALIDATED/source_drift`, without sealing or authority writes.
Original O2 protocol fixtures also passed on real MySQL with an in-memory object
store. Independent review found a concurrent completion/invalidation race and a
partial-inventory source-loss path; fixes now preserve the durable invalidation
and recheck pinned originals. Focused packaged/H2 and Node regression probes are
reported separately from the earlier full MySQL run. These author-run fixtures
do not prove live Harness/Worker/Broker or external OSS deployment acceptance.
Separately, [wenshao's deployment evidence](https://github.com/wenshao/qwen-code/tree/511e05b89edf0197a0e632b19248b9b7c0a0d636/pr13138)
tests `989baf220` on Ubuntu/ext4 with MySQL 8.4.11, deployed Broker/Harness/Worker,
real Aliyun OSS, four physical kill points, and 20,916 entries/77 Sessions.
The reviewer also compared the `8bd11d5a` bundle and found only the embedded
commit constant changed. Those measured scenarios are independent evidence at
those artifacts, not author-run validation of later review fixes or exhaustive
interruption coverage. Archived/closed/deleted membership remains synthetic coverage.
The [round-2 deployment evidence](https://github.com/wenshao/qwen-code/tree/d6194156339afff14968c881c8355e547eb2b858/pr13138/r2)
separately verifies `0919b9d8` on the same Linux rig, including the four review
fixes, five physical interruption windows and real OSS refusal controls.
It covers that revision, not the subsequent main integration. Maintainer
architecture signoff and supported-platform validation of the integrated
revision remain pending; green CI and Ready status do not close these gates.
#13110 has merged into main. This integration includes main `d5c22d33`, preserving
its V26 tool-result projection, V27 Hosted Hooks records, V28 admission indexes
and V29 admission backfill, plus V30 Session-owned tool-output retention.
This also includes #13144 file-history/undo guards, #13172 Hosted smoke gates
and #12965 migration uniqueness checks. Only unmerged W1b recovery metadata moves to V31,
with its SQL bytes unchanged. Main's migration history is not rewritten.
The [round-3 deployment report](https://github.com/QwenLM/qwen-code/pull/13138#issuecomment-5944274897)
confirms V28 on `e50e2c37`, but identifies missing ordinary Hosted model route/usage
support; its successful Linux runbook and interruption checks use that revision
plus a candidate allowlist fix. This change includes those two resource kinds
and tests journals written by the actual model activation producer, including
missing/corrupt resources and unsettled work. The external candidate evidence
does not certify later artifacts. H2 Hook domains, Hook-specific model resources
and MCP profiles remain outside W1b's closure and refuse capture; this does not
certify or activate Hook recovery.

After the ordinary model-resource fix `258c57ed`, merge CI against the newer
main refused duplicate V28 migrations. An independent packaged Flyway/H2 probe
reproduced this collision before editing; `e3055f49` moved W1b to V30. The later
main integration of #13084 occupies V30 for tool-output retention. Another
independent packaged Flyway/H2 probe reproduces that collision before editing.
V31 preserves the new main history; fresh databases and upgrading a main-V30
database require new artifact checks. The port-allocation fix `1d55ed37` is
preserved; its passing Hosted failover CI uses the prior main and does not
certify this integration. Pre-release databases that applied branch-only W1b
V27, V28 or V30 are not a supported
main upgrade path: the versions belong to different main migrations and validation
must refuse mismatching history. No automatic history repair, rollback or database
recreation is performed. Earlier Linux/OSS evidence remains attributed to its
original commits, not this subsequent integration.
