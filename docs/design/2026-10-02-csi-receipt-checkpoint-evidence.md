# Original receipt and checkpoint evidence for CSI retirement

[English](2026-10-02-csi-receipt-checkpoint-evidence.md) | [简体中文](2026-10-02-csi-receipt-checkpoint-evidence.zh-CN.md)

Status: private read-only component implemented and locally verified, including
real MySQL integration in its historical baseline. Durable worker ACK is now implemented in the [ACK-2 follow-up](2026-10-03-csi-durable-worker-ack.md); MCP and aggregate physical/cloud qualification remain pending. This follows the locally verified
[original publication settlement consumer](2026-10-02-csi-original-publication-settlement.md)
within [K2c](2026-10-01-managed-kubernetes-k2.md).

## Problem and current behavior

An original REFERENCED publication proves that its outcome and receipt were
committed to the original Session. It does not prove that the Harness checkpoint
includes that receipt. Receipt-only commits retain the previous checkpoint pointer
in the Session head. The original Harness normally calls `resolveAwaitRuntime`
after the receipt, but this helper may return null or a previously settled
checkpoint; successful completion alone does not establish new coverage.

The existing Session authority replays committed journal bytes and reads the
checkpoint resource through its complete Harness v1 parser. Java persistence
validates checkpoint resource metadata but does not perform that semantic parse.
Reuse the native authority rather than add a second checkpoint format or parser.

Original worker ACK already permits a DRAINING parent while requiring the original
READY Runtime Session, original lease and publication receipt. The worker records
the acknowledgement in memory; the ACK path in this historical component did not persist a durable confirmation. The ACK-2 follow-up adds that persistence using trusted original provenance. A Session receipt cannot substitute for that confirmation. MCP
latest `released` state also does not establish strict drain: compatibility paths
can reach it without the normal persisted `drained` transition.

## Scope and ordered delivery

First verify the exact original receipt-to-checkpoint relationship. This is a
component observation, not a release decision. Keep the physical holder, active
slot and retirement in DRAINING. Do not modify producer admission, acquire a new
writer or activation, publish a replacement checkpoint, start a worker or change
the public CSI selector.

The sequence is:

1. Reproduce receipt-only stale coverage and establish a native API positive with
   fresh authority replay.
2. Add the smallest private coverage consumer using the existing Session authority
   and Harness parser, then connect a fixed read-only original SQL snapshot.
3. Verify and persist exact original worker ACK confirmation after the RPC, without
   broadening new-work admission or copying a Session receipt as worker evidence.
4. Verify complete original MCP configuration, operation and release histories.
5. Join qualified application evidence with original worker/container stop and
   trusted CSI unpublish evidence before designing atomic physical release.

Steps 3–5 remain separate work. No new ACK fields, migration or RPC contract is
chosen in this first checkpoint slice.

## Evidence and identity

The later aggregate inventory must enumerate all original candidates. This first
implementation observes one explicitly selected original publication and never
claims complete workspace inventory or absence of other work.

The original CSI journal and sealed binding identify the tenant, workspace,
binding/generation, reservation and physical holder. Enumerate all original
Runtime Sessions, executions and publication candidates; an empty execution list
does not exclude an orphan publication or MCP configuration. A bounded scan must
report incomplete rather than treat truncation as absence.

Locate the original REFERENCED publication's receipt revision and sequence in the
same Session journal. Match executionCallId, outcome/manifest references, outcome
bytes and receipt `historyRevision`. Here historyRevision is the event sequence,
not the SQL journal revision. Preserve the distinction between a complete
committed capture and a blocked or partial outcome.

Replay the continuous committed journal prefix and compare it with the stored
head's revision, committed sequence and commit digest. Validate resource scope,
kind, schema, length, digest and committed reference. The original
`checkpoint.committed` event must match its activation, checkpoint ID, predecessor,
stateRef, coveredSequence and boundary. The parsed body must match the same
Session, checkpoint identity and resume coverage.

Require `receipt.sequence <= checkpoint.coveredSequence`. Match the original
execution and outcome through the checkpoint's tool item or the verified consumed
history; a runtime invocationBindingId is not a Java runtimeBindingId. The initial
component accepts qualified results_ready or turn_settled states of the original
activation, or its before_model checkpoint proven by a turn_complete boundary
and the atomic C+1/C+2 companion events. An arbitrary older before_model state
does not qualify. Require no unresolved relevant tool, runtime or approval work.
The current tool state (the immediate predecessor for before_model) must retain
every original dispatch-batch execution and every later journal tool.intent
through the latest covered sequence. Consumption or turn completion cannot hide
a newly appended intent that has no represented tool state.
Native parser status `runnable` can include await_runtime and is insufficient.
Do not choose an older clean checkpoint instead of checking the newest state and
the rest of its committed prefix.

For turn completion, the existing atomic transaction uses coveredSequence=C,
turn.settled at C+1 and checkpoint.committed at C+2. Do not incorrectly demand
that its checkpoint cover those companion events; it must cover the prior
original receipt and satisfy the existing finished-turn constraints.

## Read boundary and failure behavior

Reuse fixed journal/resource read interfaces and the existing authority's open
and replay path. The inventory reader must never call an open operation that
acquires a writer, nor append, publish, seal, abort or mark recovery. It cannot
call normal resource verification that updates last_verified_at or quarantines
objects and describe that as read-only inspection.

The SQL connection must provide a genuine read-only consistent snapshot. Validate
the descriptor, complete journal prefix, resource metadata and original CSI pins
in that snapshot before semantic replay. No database locks may span object I/O
or worker RPC. The first supported inline profile must reject unsupported object
representations explicitly; missing resources cannot become empty state.

Missing or stale checkpoints, null resolution, incomplete batches, replaced
activation, opaque or corrupt resources, missing revisions, unqualified
compaction and incomplete enumeration return an explicit unresolved result.
Do not report DRAINED, release eligibility or a durable aggregate success from
this component. Later mutating confirmation stages must reacquire the original
parent-to-publication lock order after RPC/I/O and recheck all original pins.

## Validation and acceptance

The fixed private SQL exporter reads one original publication on its own MySQL
read-only repeatable-read consistent-snapshot connection. It refuses an ambient
transaction, checks the original sealed CSI identity and execution, and exports
the original Session head, transaction descriptors and REFERENCED inline bytes
with their actual resource-reference revisions. It does not export credentials.
Non-InnoDB tables, object-backed resources, missing rows and bounds exceeded are
unresolved; it never calls locking inspection or resource verification writers.
Its private JSON reader rejects fractional tokens for typed integer CSI pins
and compares terminal/result numbers with exact decimal precision.

The TypeScript snapshot adapter reuses the existing HTTP journal descriptor
validator and native scan, including checkpoint and extension-resource dependency
closures. All read handles refuse mutation. The semantic consumer replays a fresh
authority, checks the exact original receipt and complete outcome/manifest, and
cross-checks newest checkpoint identity, original dispatch, tool mapping and
uncovered suffix. before_model requires the immediately preceding original
settled-and-consumed tool checkpoint and actual atomic turn-complete companions;
a native turn-complete without consumption remains unresolved.

The initial fixed bounds are 4096 transactions/resources/resource-reference rows, 32 MiB decoded snapshot
bytes and 48 MiB JSON input. Exceeding a bound never yields a partial success.
The private CLI reads that export file and returns matched/unresolved observation;
it neither contacts the database nor advances a Harness. A copied JSON file is
an observation of its captured database state, not a live release credential.

Affected production files are the Session HTTP store's read-only adapter, the
new original-receipt checkpoint consumer, the private CLI inspection entry, the
Java CSI snapshot store, and the existing JDBC binding mapper's
same-connection read. Tests remain collocated in their own packages.

Record the global CLI baseline. Use an owned private native-API fixture where
the global CLI does not expose this boundary. Generate journal and checkpoint
state through production APIs; do not mint coverage with SQL or a `covered=true`
flag. Verify a receipt-only stale checkpoint, normal original results_ready
coverage, turn-complete C/C+1/C+2 semantics and fresh-authority replay.

Negative cases cover wrong original receipt/outcome/activation, null resolution,
incomplete tool batches, missing or opaque state, changed bytes, missing revisions
and truncated or unsupported snapshots. Observe zero writer acquisition and zero
inventory writes, provider calls or worker calls. Owned resources must be cleaned
up, and baseline and post evidence must pin the source and runtime versions.

Implementation acceptance requires focused tests, build/typecheck/bundle, two
clean self-audits and scoped review. Native memory/file baseline alone does not
qualify the SQL snapshot, durable worker ACK, MCP, physical release or new ACK
cloud execution.

## Recorded baseline

On 2026-10-02, the global CLI reported 0.24.6. An independent fixture ran current
TypeScript production APIs through the existing tsx runtime. A complete original
capture committed receipt sequence 5 while the latest ckpt-4 still covered only
3 and its tool remained in_progress. The original Harness resolver then committed
ckpt-6 in results_ready, covering 5 with the exact original outcome and invocation.
Fresh native authority replay confirmed both snapshots and the original receipt.

After results_ready, resolution of both the original and a missing execution
returned null without journal mutation. The missing execution had no receipt or
tool item; null cannot certify its coverage. This does not invent a case where
the valid original await_runtime resolver returned null before coverage. The
original receipt retry also appended nothing.

Four read-only fresh authorities acquired no writer and called no write methods.
Thirteen source/probe fingerprints stayed unchanged, and the fixture's temporary
root was removed. The fixture used inert capture bytes and synthetic process
metadata; no Shell, provider, worker, database or cloud process ran. It did not
verify SQL snapshots, Hosted publication admission, the turn-complete and wider
negative matrix, durable ACK, MCP or physical release. Those were not qualified
by that baseline.

On 2026-10-03, the implemented component passed 36 focused TypeScript tests and
50 focused Java mapping tests, build/typecheck/bundle, ESLint and Java Checkstyle.
Independent native inspection passed 42 scenarios; the built private CLI passed
the same 42 scenarios in separate subprocesses (7 matched, 35 unresolved). These
are two execution paths, not 84 distinct scenarios. Actual native API regressions
showed later unrepresented tool intents could be hidden by consumption or turn
completion; the new journal-to-tool-state guard refuses all three observed windows.

The independent owned MySQL 8.4.11 chain passed 20 groups with JDK 21.0.12.1,
Jackson 2.21.4 and UTC JVM/driver/session. The actual native Session/Java publication
APIs committed an original schemaVersion 1 admission profile and receipt sequence
5 at SQL revision 6. The fixture supplied inert producer bytes and controlled
outcome/history input; it did not run a Hosted application, model or physical tool.
A genuine read-only RR snapshot retained the complete receipt-only export while
another connection committed the original checkpoint; the next export matched
results_ready. A privileged locking-read positive control succeeded before the
same query was refused with MySQL 1792/25006 in a READ ONLY transaction. Three
fractional original JSON identity pins reproduced truncation before the private
parser fix and were refused in the final full-chain rerun. Observations left all
16 tracked tables and object bytes unchanged; owned processes, port and temporary
directory were reclaimed, and 870 inputs plus 121 dependencies stayed unchanged.

Reports are retained under `.qwen/e2e-tests/`: the native/CLI post report and the
2026-10-03 independent SQL report. Earlier 39-case/16-group runs and failed
reproductions remain historical evidence. This qualifies one explicitly selected
original publication under the fixed inline profile. Workspace-wide inventory,
durable ACK, strict MCP histories, trusted stop/unpublish, physical holder release,
new cloud execution and the CST-JVM/UTC-driver combination remain unqualified.
