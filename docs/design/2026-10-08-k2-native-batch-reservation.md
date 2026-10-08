# K2-A2: original native batch reservations

[English](2026-10-08-k2-native-batch-reservation.md) |
[简体中文](2026-10-08-k2-native-batch-reservation.zh-CN.md)

Status: private original reservations, resources and complete current batch reads
are implemented with bounded independent local evidence from 2026-10-08. The
remaining native chain and target qualification are pending. Pre-change source
baseline: `d50fae9da9ffa2ecbf81e4a61b98f6ec56da0843`. Original input/wake,
text/thought conversation, streamed model records and the private authenticated
Hosted attachment/Java text entry are implemented with bounded local evidence.
The earlier input/wake increment remains historical evidence for its own scope.
This is the next dependency of
the [native file chain](2026-10-07-k2-native-file-execution.md), within the
full K2 objective and Draft PR #13526. It does not replace native history,
execution, consumption, retirement or physical qualification with allocation
success. Proposal #12380 and tracker #13395 remain open.

## 1. Problem and current state

At that baseline the private proof admits genesis, activation install/renew, original
input/wake, the once-only initial checkpoint, complete bounded text/thought
messages, original model attempts/streamed records and atomic turn settlement.
The private Hosted owner invokes the shared runner with the fixed original
Session and settled history, but supplies no tool-turn callback. Original
function-call Parts, file-history intent and tool outcomes remain closed.
The private worker still has no admitted native file executor.

Hosted commits the assistant before tool reservation, but prepares raw file
history before reservations. It publishes each input into an in-memory staging
map, reserves that invocation, then publishes its definition and tool intent.
`publish` is not an upload: input/definition bytes ordinarily reach the DB only
with a later native transaction. Consequently neither a supplied ref nor a
putative STAGED DB row can prove their bytes during reservation. A crash after
SQL acceptance but before tool intent can also lose the random call/ref IDs and
in-memory bytes.

The original SQL reference stores Session, prompt, call and request digest, but
does not distinguish two assistant batches in one prompt. Locking the caller's
listed execution IDs cannot prove that no accepted Read, Write or Edit was
omitted. Filtering to PREPARED first can conceal accepted conflicting/terminal
rows. Before the preceding bounded fix, private retries compared the newly
minted server candidate ID with the original ID and could refuse exact replay.

The preceding bounded bugfix compared immutable request identity after current
live admission checks. This implementation closes that resource-free generic
private admission, including historical terminal retries. Exact replay now uses
the separate byte-qualified private entry; old resource-free rows are test-only
historical fixtures for the existing continuation fences.

Preserve one native journal and the original resource and execution tables.
Add the missing durable allocation identity and original bytes before intent.
No second batch authority, caller paths or self-reported prepared flags are
introduced.

## 2. Closed reservation and ownership

Use the existing authenticated `executions:prepare` entry with a separate
private exact shape. Preserve ordinary Tool-v2/v3/provider request shapes.
The private request adds only `inputBytesBase64` and
`toolDefinitionBytesBase64` to the existing envelope. Ref metadata exists once,
inside the reference; files do not use `runtimeProtocol: 3`, `inputDigest` or
publication credentials. Select the branch from the persisted original
`csi-files-retirement/1` request, not an optional caller profile flag.

Base64 fields are resource bodies, not structural IDs. Decode canonical,
nonempty Base64 with its own 87384-character encoded and 65536-byte decoded
bounds; the 512-character ID validator must not reject real declarations.

| Reference field     | Original producer and meaning                                                |
| ------------------- | ---------------------------------------------------------------------------- |
| `sessionId`         | Fixed original Runtime Session; also the owner/Harness Session               |
| `promptId`          | Original prompt/turn UUID                                                    |
| `callId`            | Once-allocated Runtime call ID; distinct from the model function ID          |
| `argsDigest`        | Existing name for SHA-256 of exact payload JSON UTF-8, with `sha256:` prefix |
| `batchId`           | UUID of the already-committed original assistant message                     |
| `functionCallId`    | That assistant's original function call ID                                   |
| `partIndex`         | Unique function-call part position in that original message                  |
| `ordinal`           | Position in the original request list, retaining refusal gaps                |
| `inputRef`          | Original closed `managed-tool-input` durable ref                             |
| `toolDefinitionRef` | Original closed `managed-tool-definition` durable ref                        |

The request reference has exactly these ten fields; persisted reference adds
only existing `dispatchMode: "deferred"`. Each ref keeps the existing exact
`resourceId`, `kind`, `schemaVersion`, `byteLength`, `digest` shape, schema 1,
bare lowercase SHA-256 and the 64 KiB inline limit. Structural positions are
nonnegative safe integers. The envelope's Session, turn, call and digest must
agree with the reference. Idempotency remains `<runtimeSessionId>:<callId>`.

Decode and verify both original byte arrays before accepting allocation. Input
is the existing exact `{harnessSessionId,runtimeSessionId,payloadJson}` wrapper.
Verify the original roles and hash the exact `payloadJson` string; then parse
its `{toolName,input}` payload. Its enclosing resource hash is a different
digest. Validate the finite Read/Write/Edit contract and model function/part
mapping, including the original file-path normalization. Definition identity
and bytes must match the declared original tool, never widen the finite worker
manifest. Do not reserialize the payload to compute its request digest.

This entry is persisted-owner scoped. Authentication alone is not authority:
the original request pin, original activation/conversation, current parent and
fixed READY Runtime Session must qualify on the same connection. Public
Hosted/Spring selection and legacy private worker refusals remain closed.

## 3. Atomic original allocation and resources

Use the original DataSource and transaction. Keep parent-first locking:
placement domain, tenant retention, sorted request slots and binding history,
original private Session pin, native head/journal/resource proof, fixed Runtime
Session, then stable execution-row order. Source bytes are bounded before SQL;
do not hold this transaction across worker or other network I/O.

Recovery discovers refs in execution rows. Before locking the fixed Runtime
Session/executions, inventory and lock the original Session's input/definition
resource rows in stable order on this connection. After enumerating executions,
join their exact refs back to that inventory and verify bytes. Do not lock an
execution and then acquire resource locks in reverse order. Inventory alone
does not qualify PUBLISHED bytes as native references.

Fresh acceptance must qualify the committed original assistant and current
native conversation. Native conversation admission must be implemented in
both fresh acceptance and the complete historical fold before this path is
enabled; a new-message lookup that skips an unqualified prefix is insufficient.
No staged assistant can select a batch.

In that same transaction, insert each original input/definition into the
existing resource table as `PUBLISHED`, `MYSQL_INLINE`, with exact original
scope/ref/bytes, and insert the original PREPARED execution reference. A reused
resource ID must match all immutable metadata and raw bytes; a mismatch rolls
back both resources and execution. The original SQL row retains the refs after
an ambiguous reply. No `resource_ref`, journal revision, dispatch authorization
or file grant is created by this step.

PUBLISHED inputs are durable allocation evidence only. They are not equivalent
to REFERENCED native evidence. The existing public result-kind whitelist stays
unchanged. Add narrow private resource verification and recovery reading only
when the current original allocation names the exact input/definition ref. Do
not register these resources as collectible publication objects. Their original
obligation remains until qualified private finalization.

An exact idempotent request returns the original receipt/ID after revalidating
the original immutable request tuple. Compare request identity, not the new
server candidate ID, and never replace an accepted row. Changed refs, bytes,
assistant/function/part, digest or original roles conflict. A direct generic
repository mutation cannot bypass the private resource/identity checks.

## 4. Complete membership, intent and recovery

Reserve every accepted member before committing the schema-2 history intent.
Split the current reservation/tool-intent loop for the private producer:
commit assistant, fix inputs/definitions and call IDs, complete reservation
attempts, commit native history intent, obtain qualified original preparation,
commit native prepared, then tool intents and dispatch checkpoint. Keep ordinary
producer order unchanged.

Read-only batches do not create backup intent. They still reserve the entire
batch first. Their first native tool intent freezes allocation under the same
full-member fence; each tool intent references/promotes its exact resources,
and the dispatch checkpoint must match the complete frozen allocation and all
committed intents before any member executes. Later reservation cannot enlarge
that batch. A mixed batch's history intent includes its accepted Read members,
although paths/backups derive only from mutations.

On the original connection, enumerate all potentially relevant original SQL
allocations in stable execution-hash pages of 100 with the existing 4096-entry
refusal bound. Include all states and conflicting historical identities;
qualify exact original binding/generation/owner/runtime/turn and reference
`batchId`, then compare the complete selected collection with every intent
invocation, including Read. Do not query a caller-supplied ID subset, or remove
non-PREPARED rows before comparison. Every selected member must independently
match the committed assistant, original bytes/refs and intended transition.
Different assistant UUIDs partition successive batches within one prompt.

Intent commit holds the same parent and native-head fence as reservation.
After it accepts a batch, a new nonidentical reservation for that batch refuses;
an exact replay returns only the original receipt. A preceding unresolved
intent/prepared batch also prevents a later assistant from escaping the
obligation. Parent locking serializes the membership observation with new row
insertion; it is not cross-process physical I/O authorization.

The intent transaction explicitly collects invocation input/definition refs.
After exact original allocation validation, it promotes these PUBLISHED
resources to REFERENCED and inserts their revision associations atomically with
the native intent. Existing `commitResources` does not currently perform this
promotion. Every later prepared/replay/history reader must still check original
revision/ref association, scope, bytes, length and hash. A rejected commit rolls
back promotion and association; it retains the previously accepted allocation
and PUBLISHED resources. Collect `intentRef` in the prepared revision without
recursively copying the entire predecessor chain into each transaction.

Cold recovery needs an authenticated, persisted-original-owner batch read that
returns the full immutable allocation identities/refs and states, under the same
bounded current SQL and native proof. Existing execution `status` does not
return those refs. A selector identifies the original assistant, never supplies
membership. Read the two original resource bytes through the narrow allocation
reader and reuse exact calls/refs; do not call `prepareRequests` to mint new
identities. If no allocation exists, the qualified committed assistant may
begin allocation once. If any exists, all known original identities must be
recovered before filling any proven never-accepted member.

Use the existing authenticated Broker origin with a private
`POST /executions:read-batch` entry. Its exact request is protocolVersion,
requestId, harnessSessionId, runtimeSessionId, promptId and batchId; it supplies
no member IDs or paths. Return protocolVersion, those owner/Session/prompt/batch
identities, the original runtime binding/generation, and all members. Each
member returns its original executionCallId, current state, complete stored
reference, inputBytesBase64 and toolDefinitionBytesBase64. The same-Connection
original-allocation reader qualifies those bytes before returning them. This
avoids widening the public Session Store PUBLISHED whitelist or adding a
generic resource publish/read authority. The actual private turn consumes this
read on ambiguous reservation before making any decision about absence.

A deterministic no-row reservation refusal retains its ordinal gap. Timeout,
lost response or unknown status is not a refusal: exact retry/current full-batch
read must establish the original row, otherwise remain pending and block
dispatch. A missing, corrupt or ambiguously associated resource also blocks;
do not heal it with a new resource UUID. A read-only replay never grants a new
dispatch after seal. Explicit continuation/seal policy remains part of the
subsequent native grant and settlement implementation.

A missing SQL member does not prove why a model request was refused. Cold
recovery may fill an absent member only after the complete current read and
parent/head fence establish absence and the immutable assistant/function tuple
is recovered. An accepted pre-intent member that is cancelled, not_started or
UNKNOWN cannot be removed to submit a smaller batch or relabelled PREPARED.
It blocks new intent/dispatch until the original qualified cancellation or
retirement path settles that obligation; this step does not invent that path.

Keep local and cumulative ordinals distinct. Current `tool.intent`/history
`batchId` is the assistant UUID. Checkpoint retains its previous cumulative
batch ID and items; current global ordinal is
`max(localOrdinal, previousMaximum + 1)`, updating the maximum in accepted
order. Prior max 9 and accepted locals 0,2 yield globals 10,11; no prior items
yield 0,2. Verify model/part/function/execution mapping without equating the
two batch IDs or ordinal roles.

## 5. Real consumers and implementation order

The private production caller now exists in `hosted-csi-session.ts`, entered
through the authenticated private attachment and Java text command described in
[private Hosted attachment](2026-10-08-k2-private-hosted-attachment.md).
It uses the deployment-pinned Store origin, original warmed Broker binding,
`LocalManagedSessionAuthority.open`, original input admission and sink-backed
messages. Extend that actual caller with a finite private tool turn passed to
`runHostedHarnessTurn`; do not introduce another runner, optional profile flag,
public selector or ordinary create/load path.

Keep the original Session model-slot guard, null Hook operation and actual
modelScope/streamed records. A new private tool implementation must satisfy the
public methods consumed by the shared model and turn runner; ordinary Hosted
continues using its existing implementation. The current concrete callback type
must not force the private implementation to construct ordinary prompt-scoped
Runtime ownership, raw preparation or turn-finish release.

The real model caller preserves complete Parts and replaces each original
function Part ID with the corresponding collected request ID before the tool
callback. Commit that original assistant once through the existing callback;
its returned UUID identifies this batch. `partIndex` indexes complete Parts,
while `ordinal` indexes function requests and retains definitive refusal gaps.
The base file declaration array already contains exactly Read/Write/Edit.
Persist the actual final advertised declaration, including full
`name`, `description`, and `parametersJsonSchema`; the ordinary implementation
appends backup semantics to mutation descriptions. A name-only object or a
reconstructed narrower declaration is not the original advertised bytes.
Collect actual producer bytes in the independent baseline before selecting the
closed function-Part grammar.

The private producer advertises the same finite base declarations and the
existing non-MCP backup description for Write/Edit. Share that finite
declaration transformation with its ordinary caller; do not instantiate the
ordinary turn to obtain it. Java pins the complete observed declaration
contract, rather than accepting any schema with one of the three names.

The independent d50fae9 producer baseline captured five original Parts (thought,
visible text and three function calls), three non-UUID request IDs, and the
complete 1850-byte declaration array. Those supplied FunctionDeclarations are
distinct from the OpenAI SDK wire: the existing SDK removes
`additionalProperties: false` from Read/Edit parameters in that capture.
Retain both observations. The durable definition pins the complete supplied
declaration, not a claim that its bytes equal the transformed SDK request.

The original function ID need not be a UUID. It is the collected request ID
remapped into the preserved full Parts, distinct from the Runtime call UUID and
optional provider ID. Provider decorations are neither discarded nor admitted
by inference. Validate the observed private producer grammar and keep the full
message resource, parent, admitted input and original model attempt as proof.

The shared fold must distinguish a final text assistant from an assistant with
pending function requests. Retain the latter's original UUID, ordered functions,
part positions and local ordinals in the derived conversation prefix. Pending
work prevents ordinary turn settlement, replacement input, a new model attempt
or another assistant from clearing that obligation. Fresh acceptance and full
historical replay enforce the same rule; a TypeScript suspension alone is not
the SQL fence. Later qualified result consumption, rather than allocation,
permits the original conversation to continue.

That caller verifies the persisted reserved profile and exact genesis
definition `{engine,sessionId,toolProfile}` and root `{cwd}`. It uses the
existing finite three-tool digest/manifest, not a new manifest. Private acquire
uses that digest; private Runtime Session stays the original owner UUID across
turns instead of promptId. The private branch uses schema2 history/control,
private capability/policy bindings and original retained ACK/finish semantics;
it must never call ordinary turn-finish release. Merely passing a private
string in extras does not establish these consumers. Connect actual model
declarations, execution and `consumeResults` through the existing model caller.

| Layer                   | Required connected consumers                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private Hosted producer | Internal private profile/three-tool construction, assistant commit, definition/input bytes before reservation, once-only allocation/recovery, complete reservation loop before history intent |
| Broker entry            | Exact private HTTP/body parser and service branch, fixed original Session, immutable candidate resources, original receipt replay; ordinary prepare remains unchanged                         |
| Original JDBC           | Same-connection native conversation qualification, atomic PUBLISHED resources/PREPARED row, full-member current read, history-intent reservation fence                                        |
| Session Store           | Narrow allocation-resource verifier/read/recovery and atomic intent promotion; existing public result publication is unchanged                                                                |
| Native history          | Fresh commit, replay and complete fold share assistant/refs/membership and schema2 idle→intent→prepared→idle rules                                                                            |
| Wire/continuation       | Strict private eleven-field reference consumer, original Tool-v2 wire projection after validation; legacy exact shapes stay separate                                                          |
| Checkpoint/recovery     | Original full private reference in snapshot, schema-aware proof and resource closure; no legacy schema1 pending cleanup for schema2                                                           |

Concrete source consumers include `hosted-workspace-tool-turn.ts`,
`hosted-workspace-broker.ts`, `http-managed-session-store.ts`,
`original-file-checkpoint.ts`, `RuntimeBrokerHttpServer`,
`RuntimeBrokerService`, `JdbcRuntimeBindingRepository`,
`JdbcToolExecutionRepository`, `HttpRuntimeTransport`,
`JdbcCsiActivationAdmission`, `ManagedSessionStore`,
`WorkspaceRecoveryReader` and `WorkspaceCsiCheckpointSnapshotStore`.

The historical first bounded conversation increment accepted only the actual
original `submitInput` transaction. Its two events are `input.accepted` followed
by `wake.requested`, with the same occurrence time and no top-level subject.
Their closed payloads bind the same original prompt/input UUID, `hosted-harness`
source, `input` wake reason, original accepted-event ID and sequence, and the
nested turn subject. Deadline is null or an original bounded timestamp. The command ID is the prompt UUID; its content digest is
the bare SHA-256 of the original `managed-input` bytes. The original
`managed-admission` body is exactly `{promptId,digest}`, where `digest` is that
same hash with the `sha256:` prefix. Input bytes contain a nonempty array of
closed `{type:"text",text}` blocks, each with nonempty text. Preserve arbitrary
text, including Unicode, newlines and text longer than structural ID limits;
each original resource remains limited to 64 KiB. A matching transaction hash
does not replace these checks or the original revision/ref association.

Fresh acceptance remains inside the original READY binding, native writer and
live activation fence. Fresh and historical validation use one transition
function; the historical fold remembers the accepted input UUID as derived
state, without another table or caller-supplied projection. Another fresh input
cannot stack on that unsettled input. The once-only empty Harness checkpoint
may follow input/wake using their actual coverage, with null turn/prompt identity;
activation renewals preserve the input and checkpoint. Non-checkpoint metadata
does not repeat the retained head checkpoint. Replay derives the same state
from the full original journal and stays read-only, including during DRAINING;
it does not impose current READY or current expiry on historical events. New
input during DRAINING still refuses.

That historical increment did not admit messages, model attempts or settlement.
The later private text/streamed turn now qualifies those actual producers,
including original settlement. This implementation adds original function Parts
and a pending-batch fence; later tool checkpoint phases remain closed. Input/wake and an empty checkpoint alone still identify no
assistant batch, allocate no file call and grant no worker I/O.

First connect original conversation admission and atomic durable reservations,
including full-member recovery. Next consume that same evidence in schema2
intent/prepared and the trusted worker readback protocol. Finally connect the
same composer/history to actual execution, complete outcomes/results/messages,
checkpoint and Hosted `consumed=true`, preserving original retained evidence.
Do not claim the first step completes A2 or use its receipt as the later grant.

### Current integrated increment

The implementation connects original function-call assistant qualification in
the shared fresh/history fold, the actual private Hosted callback, atomic
allocation/resources and a complete current batch read. It fixes every accepted
member's resource IDs and exact byte arrays before any reservation, retaining
them across a lost reply. It clones the finite declarations and pins their
complete supplied bytes before returning them to the SDK. The persisted SQL
reference also undergoes strict UTF-8, duplicate-key and trailing-JSON checks.
Both generic repository admission and HTTP/service entry enforce the persisted
private contract; the old resource-free private shape is closed. The independent
local observations and their limits are recorded in section 6.

Return the derived original conversation/batch proof on the same JDBC Connection
before the fixed Runtime Session lock. Inventory/lock resource rows first, then
lock the Runtime Session and every potentially relevant execution row; compare
complete membership including terminal and conflicting identities. Keep the
original tables and journal as the authority.

A successful allocation alone does not settle the native turn. Until intent,
prepared, tool intent/checkpoint and worker grant consume this exact proof, the
new stored reference remains unclaimable and private preparation/dispatch/file
I/O remains closed. Use the shared recovery-required exception path to preserve
the original unresolved input/assistant and accepted resources; a generic error
must not turn that allocation into ordinary settlement. The full goal still
requires original intent promotion, actual file execution/results/consumption
and physical retirement/handoff; this increment is their dependency.

The complete-batch read recovers allocation bytes and identities for the
persisted original owner. It does not grant a new process boot or make the
current create-only private attachment a cold-owner adoption path. Qualifying
that owner recovery remains part of the subsequent continuation implementation.

## 6. Validation and acceptance

Run the global CLI baseline before any source edit; record its real Java/CSI
entry gap and use a production-entry script fallback where necessary. Use the
actual native assistant/input/definition and transaction producers, actual
Broker service/HTTP/JDBC and Session Store commit/read paths. An injected
helper return value is not proof of any qualified prefix.

The bounded input/wake prerequisite has local independent evidence for both
actual producer orders: input/wake before the initial empty checkpoint, and the
checkpoint before long Unicode/newline input. It retains input/checkpoint across
renewal, keeps exact replay read-only across all 53 tables, refuses another
unsettled input and fresh input during DRAINING, and refuses digest-valid
semantic mutations and damaged original revision/bytes. Historical renewal
replay and a genuinely fresh renewal were checked separately. This used the
actual native HTTP adapter/collector and production Spring transaction/JDBC
methods on owned H2 fixtures, with synthetic Pod metadata and zero worker I/O.
It qualifies this bounded prerequisite only. The matrix below remains the
acceptance requirement; the current allocation subset has the bounded evidence
recorded below, while intent/grant, concurrency and target qualification remain
open.

| Group           | Required observation                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/replay | Same request returns the original execution ID and resources; changed tuple/bytes conflicts; no second row or replacement resource                                                                                      |
| Atomicity       | Failure at either resource or row insertion rolls back the entire new allocation; accepted rows survive lost replies with exact original bytes                                                                          |
| Membership      | Current reads include every state and reject conflicting identities; later intent/grant validation must reject omitted Read, extra/duplicate/foreign or invalid-state members, changed function/part and late insertion |
| Resources       | In-memory staged ref alone is insufficient; public unassociated PUBLISHED input stays refused; private allocation reading qualifies exact stored refs/bytes; later intent promotion/association is atomic               |
| Recovery        | Crash before intent recovers original complete allocation/ref/bytes; ambiguous membership blocks without reminting IDs; schema1 cleanup cannot discard schema2 preparation                                              |
| Concurrency     | Real parent/head competitions, current RC and warmed RR reads observe complete membership; no SQL lock spans worker I/O                                                                                                 |
| Compatibility   | Ordinary Tool-v2/v3/provider references and result publication stay compatible; public/legacy private gates remain closed                                                                                               |

Run relevant focused tests, build, typecheck, applicable bundle and Java static
checks. Independent test-engineer verification, two complete self-audits and
the repository's actual review workflow follow. H2, local fixtures and a green
allocation test do not establish MySQL races, Linux CSI, real worker grant,
complete K2 or maintainer approval.

### Current bounded post-change evidence

The independent local run completed eight distinct groups: ordinary bundled
Read; a complete three-member private allocation/read; response loss after the
first and second accepted members; rollback at the second resource insert and
execution insert; retirement before the first reservation; and a 101-member
batch crossing the 100-row page. Its 250 private labelled predicates are checks
within those groups, not 250 separate scenarios. The actual private attachment,
Java text producer, Node owner/model SDK/shared runner, native HTTP transactions
and Broker HTTP/JDBC paths produced the original assistant and allocations.
Owned deterministic model responses, a compiled provisioning fixture, synthetic
Kubernetes metadata, Spring MockMvc and H2 remain explicit test seams. This did
not execute Linux CSI, MySQL or a cloud worker.

Original complete Parts, non-UUID function IDs, assistant/function/part mapping,
457/663/726-byte supplied definitions and raw input bytes survived reservation
and full reads. Only original resource/execution tables changed for successful
allocation: resources stayed PUBLISHED/MYSQL_INLINE, with no revision
association, file grant or worker file call. Exact replay retained the original
ID and all 53 tables. Lost replies retained one or two original allocations;
both injected insert faults rolled back the full allocation. Complete reads
rejected the tested corrupt references/bytes and related foreign identities.
The seven execution-state read cases used explicitly restored SQL state fixtures,
not production state transitions.

The retirement group first demonstrated the real unclaimed-operation refusal,
then claimed the owned original operation and successfully sealed the original
binding/reservation to DRAINING. Only then did fresh prepare refuse with
`runtime_admission_closed`, without allocation or further table changes. This
qualifies a serialized software admission fence, not a concurrent MySQL race,
physical termination, DRAINED, NodeUnpublish or RELEASED. Three fresh derived
input/attempt/assistant requests passed Node structural parsing and were refused
by native admission, but have additional semantic differences; the input retains
the old wake subject/source-event association. Without paired valid nonpending
controls these do not isolate the pending-only fence. The start probe's
`runtime_payload_invalid` is a parser refusal, not grant qualification. A valid
final settlement suffix was unavailable and was not fabricated.

The first real verification exposed the 512-character structural-ID validation
of Base64 resource bodies. The resource-specific decoder repair passed the
subsequent groups. Preserve that failure and all test-utility startup/envelope/
retirement setup failures beside the final report; none is silently relabelled
as a pass. Loaded Java origins qualified 207 production classes, four compiled
test fixtures and 22 nested SDK classes separately. Of 529 unique observed Node
origins, 112 lack a prelaunch anchor in at least one window and have only
load-time/final byte assurance. This is not retroactive prelaunch proof.

The retained final report SHA-256 is
`7b5a3c848914f70544ee8fe95a1138ccd751ed11a95978980967fc67e619332e`,
and its 965-artifact manifest SHA-256 is
`a6882e64581fa57d1c0b69fe144db1fa6f7352c7530b7207cbb01b38db301f6e`.
The separate platform-prose erratum corrects the retained environment to Darwin
25.6.0/arm64, Node 22/Java 21 without changing either original artifact. Owned
processes, ports, temporary roots and H2 resources were cleaned; the input and
artifact freeze was released at `2026-10-08T16:33:17.551568Z`. Evidence stays in
the git-ignored `.qwen/e2e-tests/` working artifacts and the PR report. It does
not qualify the remaining original intent/prepared, worker grant/execution,
consumption, RC/RR races, Linux CSI or complete K2 acceptance.

## 7. Remaining decisions and qualification

The durable allocation choice and exact wire above are decided for this
implementation; no alternate batch ledger or generic resource-publish endpoint
is planned. The internal private caller now has a reservation-only native tool
callback; original function-call qualification, atomic resources/allocation and
complete current reads have the bounded local observations above. The actual
private caller demonstrated original full Parts, non-UUID function IDs,
complete supplied declarations and assistant/function/part mapping. Precise
pending-only negative isolation and subsequent continuation qualification remain
open. Native
intent, preparation, execution and result consumption remain closed.
Fresh admission and historical folding must use the same grammar
and preserve their context across activation renewal; a kind allowlist or
latest-assistant-only lookup cannot substitute for this validation. Each new
field must have a real producer and consumer.

The worker grant still needs its own closed immutable bootstrap trust and
current original SQL/native readback, local preparation barrier and seal race
semantics. It cannot rely on a global Harness bearer, caller URL, signed stale
snapshot or receipt alone. No worker preparation/execution route opens until
that producer and consumer are connected and verified. All writer/lifecycle
coverage, immutable cut, aggregate DRAINED, trusted physical termination,
NodeUnpublish, atomic RELEASED, safe reuse and fresh full target-cluster matrix
remain required by the full K2 design.
