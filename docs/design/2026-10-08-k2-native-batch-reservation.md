# K2-A2: original native batch reservations

[English](2026-10-08-k2-native-batch-reservation.md) |
[简体中文](2026-10-08-k2-native-batch-reservation.zh-CN.md)

Status: batch reservation remains proposed, not implemented or verified. Source
baseline: `b23b4c22a8b1fbc2e790f8c424ae9466186a6b66`. The bounded input/wake
prerequisite described below is implemented and independently verified locally.
This is the next dependency of
the [native file chain](2026-10-07-k2-native-file-execution.md), within the
full K2 objective and Draft PR #13526. It does not replace native history,
execution, consumption, retirement or physical qualification with allocation
success. Proposal #12380 and tracker #13395 remain open.

## 1. Problem and current state

The current private proof admits genesis, activation install/renew, original
input/wake and the once-only initial checkpoint. Generic numeric transaction hashes now verify,
but a committed assistant, file-history intent and tool outcome still have no
private semantic admission. The worker constructs no file history or executor.

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

The preceding bounded bugfix changed that existing retry comparison to the
immutable request identity, after all current live admission checks. It returns
the original receipt in its current state without another allocation or grant.
This does not implement the proposed batch/reference/resource contract below.

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

No TypeScript private Harness production caller exists today. Add one internal
checked-in runner that consumes a reviewed connection descriptor and the
original private CREATE/Session. The descriptor supplies connection details,
not profile or grant authority. Reuse the original warmed binding,
`createHttpManagedSessionStores`, `openManagedSession`,
`createManagedHarnessHandle` and the sink-backed message commit. It actually
constructs the required private turn branch and passes it to
`runHostedHarnessTextTurn`; do not add an unused optional private flag. Keep
the public Hosted profile union/create/load, Spring CREATE, ServeOptions and
environment selectors unchanged.

Use the existing `ManagedHookActivationController.runTurn` Session model-slot
guard and its real modelScope. Its turn operation is null and does not create a
Hook worker or replacement activation. This preserves actual main model-attempt
events and ownership; separate Harness handles alone do not serialize a Session.
The private native grammar must qualify those real events before this runner
can progress. No optional text-delta or Hook producer is implicitly required.

Explicitly use original `submitInput` to commit input.accepted/wake.requested
together from original prompt blocks and admission bytes. A sink-written user
message and an empty initial checkpoint do not admit input. The existing model
caller returns the final assistant instead of committing it; the runner must
commit that returned message and the original turn_result through the sink.
Its no-tool path currently returns only text/model and loses the provider's
full Parts, while its tool path retains the actual model-history Parts but
warms an ordinary Runtime Session keyed by promptId. The private caller must
preserve actual Parts and use the fixed original Runtime Session; a private
string or an empty tool callback does not connect these consumers.
Preserve the exact message parent chain. Model function partIndex
indexes full parts, ordinal indexes function requests, and tool definitions
contain real name/description/parametersJsonSchema rather than `{name}` alone.

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

The implemented first bounded conversation increment accepts only the actual
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

This increment does not admit user/assistant messages, model attempts, turn
settlement or later checkpoint phases. Those actual producers and their
transitions still need independent qualification and the chosen real private
runner. Until original settlement is qualified, the unsettled-input fence cannot
be cleared or replaced. Input/wake and an empty checkpoint alone identify no
assistant batch, allocate no file call and grant no worker I/O.

First connect original conversation admission and atomic durable reservations,
including full-member recovery. Next consume that same evidence in schema2
intent/prepared and the trusted worker readback protocol. Finally connect the
same composer/history to actual execution, complete outcomes/results/messages,
checkpoint and Hosted `consumed=true`, preserving original retained evidence.
Do not claim the first step completes A2 or use its receipt as the later grant.

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
It qualifies this bounded prerequisite only; the batch matrix below is still
required and unverified.

| Group           | Required observation                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/replay | Same request returns the original execution ID and resources; changed tuple/bytes conflicts; no second row or replacement resource                                                       |
| Atomicity       | Failure at either resource or row insertion rolls back the entire new allocation; accepted rows survive lost replies with exact original bytes                                           |
| Membership      | Accepted Read omission, extra/duplicate/foreign/terminal row, changed function/part and later insertion refuse; deterministic refusal gaps and two batches in one prompt remain distinct |
| Resources       | In-memory staged ref alone is insufficient; unassociated PUBLISHED input is refused; intent promotion/association is atomic and original hashes are rechecked                            |
| Recovery        | Crash before intent recovers original complete allocation/ref/bytes; ambiguous membership blocks without reminting IDs; schema1 cleanup cannot discard schema2 preparation               |
| Concurrency     | Real parent/head competitions, current RC and warmed RR reads observe complete membership; no SQL lock spans worker I/O                                                                  |
| Compatibility   | Ordinary Tool-v2/v3/provider references and result publication stay compatible; public/legacy private gates remain closed                                                                |

Run relevant focused tests, build, typecheck, applicable bundle and Java static
checks. Independent test-engineer verification, two complete self-audits and
the repository's actual review workflow follow. H2, local fixtures and a green
allocation test do not establish MySQL races, Linux CSI, real worker grant,
complete K2 or maintainer approval.

## 7. Remaining decisions and qualification

The durable allocation choice and exact wire above are decided for this
implementation; no alternate batch ledger or generic resource-publish endpoint
is planned. The internal private caller above is chosen but not implemented.
The exact native conversation grammar still needs actual producer fixtures
before enabling allocation: message envelope/content, user/prompt parent chain,
assistant/function/part mapping and any model-attempt/stream events the chosen
caller emits. Fresh admission and historical folding must use the same grammar
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
