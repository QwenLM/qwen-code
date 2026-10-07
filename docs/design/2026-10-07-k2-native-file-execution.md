# K2-A2: the original native file execution chain

[English](2026-10-07-k2-native-file-execution.md) | [简体中文](2026-10-07-k2-native-file-execution.zh-CN.md)

Status: connected-composition design with the initial checkpoint gate locally
implemented and independently verified on owned MySQL, 2026-10-07. Investigation baseline:
`a6cc145edf2f586604c889b186dc10a20e534761` in
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526). Original SQL
execution continuation is implemented there; the normal file chain below is not.
This extends the [K2 completion design](2026-10-06-kubernetes-k2-retirement-handoff.md)
and claims neither full A2 nor aggregate retirement nor new cloud acceptance.

## 1. Problem and scope

At the investigation baseline, private `csi-files-retirement/1` CREATE and first
activation pin exist, but the generic worker constructs Shell/MCP/Hook/monitor/
provider components and the SQL reader accepts only genesis/install/renew.
Removing a control refusal or allowing
arbitrary checkpoints would not connect those authorities safely.

The actual Hosted v2 chain is file-history preparation for Write/Edit → Broker
PREPARED → native `tool.intent` → `await_runtime` checkpoint → authorization /
worker execution → inline `managed-tool-outcome` → `message.committed` tool
result → `results_ready` → post-work file-history snapshot. Ordinary file work
has no Shell publication receipt. Qualify `HostedWorkspaceToolTurn`; the local
`ManagedRuntimeOutcomes` producer has a different receipt/outcome shape.

Support `read_file`, `write_file` and `edit` for the original Session, retained
inline resources and uncompacted history. Exclude import/restore/rewind,
Shell/glob/v3/provider/Hook/MCP/background/monitor/publication configuration.
Keep public CSI selectors disabled. K2-B physical stop/unpublish, K2-C release /
repeated handoff and K2-D deployment qualification remain required later work.

## 2. Closed worker identity and construction

Reserve outer boot version `4`, `managed-csi/2` and CSI v2 attestation/drain
routes. Wrap unchanged closed managed-context boot v2 and the registered storage
tuple; add a closed profile identity with `profile`, `sessionId` and
`capabilityDigest`. Require the exact `csi-files-retirement/1` manifest digest,
canonical CREATE Session UUID, session isolation and matching inner-context
digest. Echo this identity in v2 attestation/drain and compare immutable request,
Pod and registration identities in Java and TypeScript. Include it in the new
closed ready/context-install/receipt contracts too. The boot Session UUID names
the durable Harness owner. The first private profile explicitly chooses that
same value for its one Runtime Session, matching the existing SQL guard; those
are different identity roles and both must be verified. Its composer reuses that
fixed Runtime Session across turns, while execution turn/prompt IDs remain
separate. Legacy Hosted keeps its prompt-scoped Runtime Session IDs. Do not
broaden the SQL identity predicate or add a second pin to accommodate the legacy
composer accidentally. Old boot v3, managed-context/1 and CSI v1 records remain
closed and unchanged.

Construct only the three file tools. Restrict executor lookup as well as tool
declarations; each invocation requires the original activation and context.
Installation must match boot Session/profile configuration. Reject unsupported
configuration before constructing its runtime, registering routes or starting
timers; ignoring environment settings is insufficient.

`read_file` can invoke PDF/vision helpers. Three tool names do not prove absence
of child processes. Qualify their joined lifetime and result retention, or
report an explicit lifecycle blocker if they are used. Do not silently narrow
an existing manifest's file formats while retaining its digest. The initial
positive scenario uses ordinary text files.

Explicitly connect the Session identity through the private CSI provisioner,
boot producer, saved Secret comparison, resume, attestation, installation and
transport. Another Session cannot reuse the mount or fall back to legacy local
resolution. CSI v1 publication ACK remains workspace-only: the file chain does
not create a publication/ACK. A later session-scoped publication ACK needs its
own closed contract and qualification.

## 3. File-history storage and admission

Backups currently use `Storage.getGlobalQwenDir()/file-history/<owner>`; Pod
`HOME=/tmp` makes this an emptyDir dependency. Pass an explicit backup root for
the private composition, retaining the default for legacy callers. Use a
reserved directory under the registered volume tied to the original Session.
Pin its directory identity, reject symlinks/replaced roots and deny lexical and
resolved file-tool access to that subtree. Do not redirect global `QWEN_HOME`.
Keep backup bytes until original finalize; unavailable, interrupted or
capacity-exhausted history blocks settlement. The later cut/finalize must cover
retained backup bytes as well as native history resources.
Write/Edit must require bound, prepared history; the legacy executor fallback
that executes a mutation without any history object is forbidden here.

Hosted currently calls prepare before committing `pendingTurn`/`pendingMessageId`;
those fields are not preparation admission. For this profile, commit a versioned
exact preparation intent to the existing native file-history domain before
worker I/O. Bind original turn/message, invocation/input refs and sorted paths.
The original parent guard admits it in READY. Broker verifies those committed
bytes on the original connection, not a caller flag or cached context. Keep one
journal authority; hold no parent SQL lock across worker I/O.

Expose a narrow authenticated history branch independently of provider
lifecycle: initial empty bind, admitted prepare and snapshot in READY; no
rewind/restore. After worker seal, permit only an idle snapshot of already-bound
original history. Refuse a late prepare and retain its unresolved durable intent
as a blocker. Track preparations already running through completion and final
inventory; do not infer that a refused/failed RPC left files unchanged.

## 4. Native journal and original continuation

Extend the strict reader to actual file transaction/resource shapes. Check UTF-8,
duplicate/trailing fields, original parent UUID/sequence chain, recursively
sorted-key events/commit digests, original writer generation 1 and activation
epoch 1, and resource identity/digest/size. Structural counters stay strict
native JSON integers; arbitrary tool/message payload numbers must follow the
actual producer canonical encoding, not an indiscriminate integer restriction.
Preserve bounded history and statement timeouts.

Replay the complete original history, retaining the original install and
same-identity renewal across non-activation transactions. Derive newest
checkpoint from qualified events and compare it with the head, replacing the
permanent NULL condition. Verify checkpoint identity, covered prefix, predecessor,
activation, tool batch, runtime bindings and referenced resources. Preserve
atomic resource/journal/head commit and read-only identical-command replay.

The first implementation gate admits only the actual initial `before_model`
checkpoint, once while READY. It has one `checkpoint.committed` event, no prior
checkpoint, a NULL boundary and the original activation subject. Its covered
sequence equals the current committed prefix; its definition/config revisions
and input digest equal the original header's definition/root refs and definition
digest. Validate the complete closed checkpoint with empty initial recording,
pending work, tool/runtime/attempt/approval groups and output/follow-up state.
Verify the state ref, full events hash and commit marker. Replay retains this
checkpoint across subsequent same-identity activation renewals, and checks the
derived resource ID against the journal head. A duplicate initial checkpoint,
later phase or unrelated event remains refused. This foundation does not qualify
the connected file chain; the table below describes subsequent target behavior.

| Operation                                                           | READY                                                                                | DRAINING                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Original activation renewal                                         | Exact existing renewal                                                               | Same original renewal with live writer/activation           |
| Initial checkpoint, input/model message, preparation intent         | Validate profile and native shapes                                                   | Refuse new work                                             |
| Tool intent / dispatch checkpoint                                   | Join exact original PREPARED execution/input; authorization is separately READY-only | Refuse new dispatch                                         |
| Result message / outcome checkpoint                                 | Join original intent/execution                                                       | Only already-authorized original work before immutable seal |
| Post-work history                                                   | Compare original admitted batch/snapshot                                             | Same pre-seal batch completion, no pending preparation/undo |
| Replacement activation, recovery, ordinary release, generic control | Preserve private refusal                                                             | Preserve private refusal                                    |

Use original parent → native history → immutable retirement identity → Runtime
Session → sorted execution locks on the original connection. Require original
Session, lease, owner, input, dispatch generation and authorization. Check every
multi-call batch member, including terminal history; one matching execution is
insufficient. Derive associations from original journal/input/checkpoint bytes
and Broker records, not `continuation=true` or phase labels. Missing, ambiguous,
orphan, UNKNOWN, unsupported or oversized evidence refuses and preserves the
holder. Qualify RC and warmed RR with real parent-lock waits.

## 5. Hosted completion and retention

Populate private digest/configuration in Hosted declarations, intent bindings,
transport and checkpoint runtime bindings. Legacy Workspace digest does not
authorize this profile. Keep complete inline results; oversized/omitted output
blocks retirement. Settlement qualification compares raw Broker result, normal
conversion, durable outcome/message and checkpoint coverage.
Disable ordinary v2 ACK clearing of input/result bytes for this profile;
until-finalize cannot be implemented by the legacy disposal acknowledgement.

`resolveAwaitRuntime` writes `consumed=false`; the real consumer sets true after
a subsequent Hosted model completion. The current file verifier requires that
consumption. Do not fake it from SQL SETTLED. Exercise actual consumption while
READY for the normal positive test. When seal interrupts execution, verify
original result persistence and report the remaining unconsumed/turn-lifecycle
blocker. Qualification of an already-admitted original Harness turn's
continuation remains part of A2 writer closure; a new turn cannot hide this gap.

Ordinary Hosted finish calls Broker release. The private profile must retain
original Runtime Session and holder for later retirement-close / cut / finalize,
without invoking legacy release or reporting physical closure. Retention and
generic recovery cannot remove these resources before qualified aggregate cut.
A SQL terminal state, QUIESCENT observation or successful file RPC is not
application settlement or volume release.

## 6. Implementation order and affected consumers

Implement and qualify one connected private composition. Independently green
parser, worker or SQL fixtures do not establish a normal file chain.

| Layer             | Existing consumers to change and verify                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Identity          | Java `ManagedCsiProtocol`, provisioner/identity/transport; TS CSI envelope, container boot, attestation/drain                            |
| Worker            | managed-context file composition, executor/factory/lookup, history route and backup service; exclude full-profile lifecycle construction |
| Native authority  | `CsiNativeActivationProof`, `JdbcCsiActivationAdmission`, Session Store commit/resource/read and original checkpoint proof               |
| Hosted            | `HostedWorkspaceToolTurn`, Broker client/profile declarations, preparation-intent producer and post-work history consumer                |
| Remaining closure | Managed Agent turn/Session/lifecycle and retention writers, overall deadline, retirement-close/finalize                                  |

Update both language designs and the E2E plan with implementation. Reserve wire
values before producer/consumer changes. No public selection/deployment change.

## 7. Validation and acceptance

Record global `qwen` baseline and actual native producer bytes at current
refusals. Then start real file-only HTTP worker on owned directories, use real
Hosted producer and SQL authority, and drive read/write/edit through admission,
file effects, raw result, messages/history and checkpoints. Use isolated MySQL
for atomic rollback and locking; H2 cannot prove its lock properties. Local
directory tests do not qualify Linux NVMe/CSI provenance or cloud handoff.

Cover wrong identity/digest/context/Pod, unknown fields/numeric forms, excluded
tool/routes, reserved backup subtree/symlinks, backup failure/capacity, identical
and conflicting replay, partial multi-call results, oversized/omitted output,
RC/warmed-RR seal races, late prepare, expired writer/activation and retained
original Session. Observe bytes and actual files, not only success returns.
Rebuild/typecheck/bundle, focused tests, independent verification, self-audit and
repository review precede the same Draft PR push.

Acceptance of the connected composition requires the complete READY chain and
specified DRAINING persistence / refusal boundaries. The initial checkpoint gate
alone is implementation progress. Remaining Harness writers, aggregate cut, original finalize,
physical stop, NodeUnpublish, atomic release and fresh repeated cloud handoff
still require production evidence. Local fixtures, CI green and review timeout
prove neither full K2 nor maintainer approval.
