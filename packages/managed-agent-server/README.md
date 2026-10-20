# Qwen Managed Agent Server

The application lives in `packages/managed-agent-server`, alongside the Java SDK. Runtime Broker sources, resources and tests are part of this Maven module; see [Runtime Broker internals](docs/runtime-broker.md). Install the Java SDK before building this application; no separate Broker artifact is needed.

Standalone Spring Boot control plane for the Qwen Code Hosted Harness. It has
no DataWorks dependency. The default loopback listen address keeps the
header-asserted tenant model: a trusted upstream sends `X-Qwen-Tenant-Id`
and the server uses that value on every database read and write. Leaving
loopback requires authentication: set `QWEN_MANAGED_AGENT_SERVER_ADDRESS`
**and** configure signed mode (`QWEN_MANAGED_AGENT_AUTH_MODE=signed` with
`QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY`) so the broker verifies each request's
HMAC signature itself, or put an authenticated gateway in front. With the
default `auto` mode a non-loopback address refuses to start. See "Broker
authentication and writer credentials" below.

设计说明：[English](../../docs/design/2026-09-19-managed-agent-spring-server.md) |
[简体中文](../../docs/design/2026-09-19-managed-agent-spring-server.zh-CN.md)

## Java package layout

Business components live in `managedagent.session`, `workspace`, `artifact`,
`channel`, `automation`, `catalog` and `event`. Controllers and HTTP filters
remain in `managedagent.api`; shared contracts and application errors live in
`managedagent.model` and `exception`. The shared SQL aggregate remains in
`managedagent.persistence` so its transaction and locking helpers stay
package-private. Broker providers, HTTP adapters and credential protection live
in `runtimebroker.provisioning`, `transport` and `security` respectively. The
separate `maintenance` configuration remains outside the server's component scan.

These are packages in one Maven module. See the package-boundary design:
[English](../../docs/design/2026-10-19-managed-agent-package-boundaries.md) |
[简体中文](../../docs/design/2026-10-19-managed-agent-package-boundaries.zh-CN.md).

## Integration status

The Hosted path supports durable no-tool Sessions and private Workspace tool
profiles. G0 adds opt-in public creation with an initial Workspace Turn (file tools, or mandatory-approval foreground Shell under the Shell opt-in) through
the production Broker. This is not complete Workspace lifecycle, in-flight
recovery or distributed provisioning support. See the G0 section below for its
exact deployment and admission boundary, and the historical
[review corrections](../../docs/design/2026-09-25-managed-agent-review-corrections.md)
for the original split's merge gates; earlier preview timing and recovery
results below do not establish completion of later slices.

## API contract

`src/main/resources/openapi/managed-agent-public-api.openapi.json` is the
single source for the public and WebShell routes. `ManagedAgentApiContractTest`
compares the mapped routes, the `ApiModels` records and real responses with it;
`src/test/resources/openapi/contract-known-gaps.txt` lists the differences that
a later slice still has to close; none remain after D4. The WebShell client types are generated from the
same file by `npm run generate:managed-agent-api` in `packages/web-shell`.
The test-tree `SurfaceRegistry` names every mounted route, internal ones
included, with its admission rule class; `SurfaceRegistryGateTest` fails any
mounted route the registry lacks, so a new public or WebShell route needs both
a spec operation and a registry entry ([actor-roles design](../../docs/design/2026-10-07-managed-agent-actor-roles.md), D5).
Sessions created for the built-in `qwen-code` agent record the agent revision
from `QWEN_MANAGED_AGENT_REVISION` (default `1`); a Session pinned to a stored
definition records the revision it resolved at admission. `POST /v1/agents`,
`GET /v1/agents/{id}` and
`POST /v1/agents/{id}` store tenant-scoped, immutable AgentDefinition
revisions; a Session pinned to one executes that stored revision (see "Stored
agent execution" below). Every response carries `X-Request-Id`, which error
envelopes repeat as `request_id` and the logs print. Events keep the schema and
projection versions they were accepted with. They keep their Item and Part
identity too, except after Harness recovery retracts output: the retracted
deltas lose their text and identity, later deltas may name other Parts, and a
`stream.reconciled` event announces it. A client that sees one reloads the
Items and resumes after their `snapshot_through_sequence`. A
cursor below a Session's replay floor gets `409 cursor_expired` from the JSON
event query and one `agent.session.resync_required` frame from either stream
whenever the cursor is below the durable floor. Rebuilding projections or pruning
all retained events never resets that floor. Snapshot-backed pages keep their immutable
version during concurrent message changes; their scoped opaque cursor expires after
30 minutes and retains the required snapshot and subsequent replay interval.
`GET /v1/agents/sessions/{id}/turns` lists a Session's Turns newest first with
an opaque cursor, and `GET /v1/agents/sessions/{id}/turns/{turnId}` reads one.
Design: [English](../../docs/design/2026-09-27-managed-agent-api-contract.md) |
[简体中文](../../docs/design/2026-09-27-managed-agent-api-contract.zh-CN.md);
Session query: [English](../../docs/design/2026-09-27-managed-agent-session-query.md) |
[简体中文](../../docs/design/2026-09-27-managed-agent-session-query.zh-CN.md);
Event replay: [English](../../docs/design/2026-09-27-managed-agent-event-replay.md) |
[简体中文](../../docs/design/2026-09-27-managed-agent-event-replay.zh-CN.md);
Durable lifecycle: [English](../../docs/design/2026-09-28-managed-agent-durable-lifecycle.md) |
[简体中文](../../docs/design/2026-09-28-managed-agent-durable-lifecycle.zh-CN.md);
Turn queries: [English](../../docs/design/2026-09-28-managed-agent-turn-queries.md) |
[简体中文](../../docs/design/2026-09-28-managed-agent-turn-queries.zh-CN.md);
Actions (Hosted permission approvals): [English](../../docs/design/2026-09-30-managed-agent-actions.md) |
[简体中文](../../docs/design/2026-09-30-managed-agent-actions.zh-CN.md);
AgentDefinition revisions: [English](../../docs/design/2026-10-01-managed-agent-definitions.md) |
[简体中文](../../docs/design/2026-10-01-managed-agent-definitions.zh-CN.md)

## On-demand tool details

Managed ReadFile and Shell cards read saved arguments, output and errors only
when expanded, through `/api/agent/web-shell/v1/tool-details/get`, without a
feature switch. Each request requires a trusted actor and current
Session/Workspace read access, rechecked before returning. It does not require
Artifact publication or download permissions and never executes a tool or starts
a Harness.

Lifecycle events remain metadata-only. Existing retained private results can be
read without backfilling public events. Allowlisted input is limited to 4 KiB;
text is limited to 8 KiB and 200 lines, with truncation reported. Closed cards do
not fetch details. Reads stay inside the saved Session/Workspace and have a
bounded history budget.
Saved version-1 Shell display records also supply structured execution details to
the shared daemon card. Their text fields share a separate 8 KiB/200-line budget,
and directory/output-file paths share an 8 KiB budget. Unsupported or malformed
structures retain the legacy text fallback; private fields are excluded.
See the complete design:
[English](../../docs/design/2026-10-19-managed-inline-tool-details.md) |
[简体中文](../../docs/design/2026-10-19-managed-inline-tool-details.zh-CN.md).

## Tool publication storage

Tool publication depends on `ToolPublicationObjectStore`; Aliyun OSS is its default implementation. Publication remains disabled unless `qwen.managed-agent.tool-publication.enabled=true`. To use another backend, register one application `@Bean` returning `ToolPublicationObjectStore` from a configuration imported into the Spring server. The default OSS auto-configuration then backs off, and no OSS endpoint, region, bucket or credentials are needed. Common publication service URL, capacities and verification deadlines remain required. Without a custom store, existing OSS configuration and client lifecycle are unchanged.

Implement atomic create without overwrite, guarded reads, idempotent physical deletion and `validateConfiguration()` for private, durable, immutable storage. Throw `ToolPublicationStorageException` with `ACCESS_DENIED` for definite storage denial or `FAILURE` for other backend failures, preserving the original cause. Even with scheduled GC disabled, failed-publication cleanup requires deletion. Do not automatically replay completed writes or a returned stream. All server instances sharing a SQL catalog must use the same byte namespace: replacing the bean does not migrate retained objects or enable fallback to another backend.

The extension applies to the Spring server. Standalone `WorkspaceRecoveryMain` and `WorkspaceCsiWorkerAckMain` still construct their documented OSS/inline storage directly; custom-backend deployments must integrate the same backend into their maintenance tooling. No additional production backend is included. Design: [English](../../docs/design/2026-10-16-managed-tool-storage-interface.md) | [简体中文](../../docs/design/2026-10-16-managed-tool-storage-interface.zh-CN.md).

## Managed tool results (O3)

O3 publishes durable Hosted foreground Shell outcomes to Items, events and
Managed WebShell. Downloads read immutable stdout/stderr after the writer is
sealed, without reviving a Harness. The API requires a trusted actor and a
current Workspace read grant, checked at request admission and then once per
`read-revalidation-interval` while a download is in flight; a tenant header
alone cannot authorize it.

O3 requires O2 publication to be configured, including
`qwen.managed-agent.tool-publication.verification-bytes-per-second` and
`qwen.managed-agent.tool-publication.max-verification-timeout`. These required
O2 verification settings are separate from the O3 content-read timeout below.

All settings below use the `qwen.managed-agent.artifacts` prefix:

| Setting                      | Default | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                    | `false` | Enable projection and public reads when O2 object storage is configured. Receipt sources are recorded even while disabled.                                                                                                                                                                                                                                                                                                            |
| `publish-original`           | `false` | Approve original stream representations for current Workspace readers.                                                                                                                                                                                                                                                                                                                                                                |
| `publish-preview`            | `false` | Additionally approve bounded previews for every Session reader; requires original publication approval.                                                                                                                                                                                                                                                                                                                               |
| `max-concurrent-reads`       | `4`     | Maximum simultaneous content responses per server process.                                                                                                                                                                                                                                                                                                                                                                            |
| `read-timeout`               | `2m`    | Elapsed-time budget checked between stream chunks, capped by the fixed two-minute output read lease; storage requests also use the storage client's timeouts.                                                                                                                                                                                                                                                                         |
| `read-revalidation-interval` | `5s`    | How often an in-flight download re-runs the access check (workspace grant, read policy, session lifecycle); `PT0S` re-verifies every chunk. A revocation lands at the first chunk boundary after the window's end; chunks written inside the window still reach the client — up to 1 MiB for a Range request, and up to a full `read-timeout`'s worth of a streaming download. Once the re-check denies, no further chunk is written. |
| `projection-interval`        | `1s`    | Cadence of the tool-result projection pass (backfill plus claim processing). Bound through a `@Scheduled` placeholder, so a suffix-less number binds as milliseconds — unlike the typed settings above.                                                                                                                                                                                                                               |

A product can replace `ManagedArtifactPolicy` for narrower publication or
actor rules. Published previews persist in shared events. Policy changes do
not automatically reproject historical results; content requests use the
current read policy at admission and once per revalidation window thereafter.
Configure the policy before enabling projection.

Two sibling knobs tune the same relaxation elsewhere:
`qwen.managed-agent.events.read-grant-recheck-interval` (default `5s`) bounds
how often a live event stream re-checks the Workspace read grant — `PT0S`
restores the per-event check — and
`qwen.managed-agent.tool-publication.journal-head-authorization` (default
`false`) switches tool-publication authorization from the journal scan to the
session journal head's activation columns; enable it only after every writer
in the fleet runs the V36 schema's code (the rolling-window self-healing is
covered in the
[query-amplification design](../../docs/design/2026-10-02-managed-agent-query-amplification.md)
§9).
Original reads are capped at 1 MiB per Range request; full downloads use
bounded segment buffers and stream with backpressure. Deployments must retain
O2 roots and validate real OSS and slow-reader limits before enabling this
feature. O3 does not enable public Shell execution or garbage collection.

Design: [English](../../docs/design/2026-09-29-managed-tool-result-public-projection.md) |
[简体中文](../../docs/design/2026-09-29-managed-tool-result-public-projection.zh-CN.md);
revalidation window: [English](../../docs/design/2026-10-02-managed-agent-query-amplification.md) |
[简体中文](../../docs/design/2026-10-02-managed-agent-query-amplification.zh-CN.md).

## Asynchronous tool publication verification

Apply migration V68 and upgrade all servers before enabling
`qwen.managed-agent.tool-publication.async-verification-enabled` (default
`false`). Enable `journal-head-authorization` first; startup rejects async
admission without it. `verification-concurrency` defaults to `2` and controls
the dedicated verifier pool, independently of retention and GC.

Updated clients send `X-Qwen-Tool-Publication-Async: 1` and poll the existing
operation status after HTTP 202. They continue accepting direct receipts from
old or disabled servers. Older clients remain synchronous. A mode is saved
when each operation is created, so retries do not change it. `FAILED` carries
only a safe `error: {status, code}` and must be handled as a terminal error,
outside network retry handling. The adapter keeps awaiting verified success
before completing publish, seal, prefix, or finish.

For rollback, disable new async admission and leave the verifier and head
authorization running until accepted work drains. Do not downgrade the server
while pending async operations still need verification. Historical async
success replay returns the prior receipt; actual reads and final integrity
checks still validate current storage bytes.

Design and client migration contract:
[English](../../docs/design/2026-10-07-managed-tool-publication-async-verification.md) |
[简体中文](../../docs/design/2026-10-07-managed-tool-publication-async-verification.zh-CN.md).

## Experimental reference distribution

The independent Hosted Java reference distribution packages the runnable
server, operator-recovery entry point, embedded Broker component, a
configuration template, systemd unit templates, a credential bootstrap,
provenance manifest, checksums,
and deployment/upgrade instructions. Pull requests and manual dry runs build
and boot the same Linux archive; only a protected-main production dispatch
publishes an immutable prerelease. See
[Managed Agent reference deployment](../../docs/users/managed-agent-reference-deployment.md)
and the [distribution design](../../docs/design/2026-10-14-managed-agent-reference-distribution.md).
The bundled launcher also supports `--check`, a read-only preflight for
configuration, Harness reachability, ports and database grants.

## Prerequisites

- Java 21
- Maven 3.8.9+ (the SpotBugs gate's plugin declares that floor)
- MySQL 8

Run the packaged CLI with `qwen serve --profile hosted-harness` as a separate
process (the credentialed launch is spelled out in the Full WebShell
dual-path development entry below). It supports durable no-tool Sessions and
the opt-in Workspace file Turns described in the G0 section below.

Install the Java SDK before building this module:

```bash
mvn -f ../sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
```

Configure and start the server:

```bash
export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'
export SPRING_DATASOURCE_USERNAME='qwen'
export SPRING_DATASOURCE_PASSWORD='replace-me'
export QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'
export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4170'
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='replace-me'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:replace-with-64-hex-characters'

mvn spring-boot:run
```

Create a Session:

```bash
curl -sS http://127.0.0.1:8080/v1/agents/sessions \
  -H 'Content-Type: application/json' \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: create-1' \
  -d '{"agent_id":"qwen-code","input":[{"type":"input_text","text":"hello"}]}'
```

The returned `id` is an RFC UUID and is the canonical identity used by
the public API, Hosted Harness transcript, and Runtime Broker. The server does
not maintain a separate public-to-Harness Session mapping.

## Public Session lifecycle

Close, archive and delete are durable `ma_operation` execution units. Each answers
`202` with a command operation that
`GET /v1/agents/sessions/{id}/operations/{operationId}` reads back, also after a
delete; the WebShell adapter offers the same routes. The public control plane
owns lifecycle state and tenant/idempotency checks, while the Hosted Harness
remains the private title authority and the Runtime Broker owns execution
bindings.

Turn input and cancellation are recorded in the same table as `submit_input`
and `cancel` operations. Each is saved with its command, the same route reads
it back, and a retry under the key resolves to it. The Turn dispatcher stays
their only deliverer, and the Turn decides their outcome. An input completes
once a Harness admits its Turn. A cancel completes once its Turn is cancelled,
and fails with `turn_already_settled` if the Turn ended another way. Neither
blocks a lifecycle operation; an active Turn still does. Admission responses do
not carry the operation id yet. See the
[Turn command operation design](../../docs/design/2026-10-16-managed-turn-command-operations.md).

```bash
curl -sS -X PATCH \
  http://127.0.0.1:8080/v1/agents/sessions/$SESSION_ID \
  -H 'Content-Type: application/json' \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: rename-1' \
  -d '{"title":"investigate checkout failure"}'

curl -sS -X POST \
  http://127.0.0.1:8080/v1/agents/sessions/$SESSION_ID/close \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: close-1'

curl -sS \
  http://127.0.0.1:8080/v1/agents/sessions/$SESSION_ID/operations/$OPERATION_ID \
  -H 'X-Qwen-Tenant-Id: demo'

curl -sS -X POST \
  http://127.0.0.1:8080/v1/agents/sessions/$SESSION_ID/archive \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: archive-1'

curl -sS -X POST \
  http://127.0.0.1:8080/v1/agents/sessions/$SESSION_ID/unarchive \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: unarchive-1'

curl -sS -X DELETE \
  http://127.0.0.1:8080/v1/agents/sessions/$SESSION_ID \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: delete-1'
```

Close and delete reject an active Turn and seal input as soon as they are
admitted. A background worker then closes the Hosted Harness Session, waits
until no Harness holds its journal writer under an unexpired lease (the
holding Harness seals it when closing), drains the Runtime binding (fenced by
the persisted Session status the Broker checks on the warm admission resolve
for an unbound Session, so the fence survives restarts; an in-process flag is
kept only for a Session row that has vanished) and completes the operation; a
failed
attempt is retried with the dispatch backoff until it succeeds, so a `202`
never means that tools stopped (a Harness whose capability digest no longer
matches retries the same way, logged with the permanent reason — nothing
may complete honestly before an operator realigns the versions, because a
confirmation requires the Harness's own acknowledgement). When the Hosted
Harness restarts, a live
control plane adopts the new process generation: the connector renegotiates
once instead of failing every bound Session, pending Turns re-attach through
the takeover load as their retries come due, and the Session's bound boot ID
moves to the new generation without a Java restart. A Turn parked in a
supported state continues on the replacement (G3 Step 3). In a Session
without Hooks or MCP, an unfinished model round reissues its saved request
and retracts the dead owner's published prefix, and a requested native-file
approval keeps its Action and deadline; a committed terminal is projected
once. Step 3 neither reissues a model round nor resumes an approval in a
Session with Hooks or MCP, and no gate covers how such a parked Turn ends. A
takeover load that can never continue (an in-flight Shell call, an unfinished
prefix continuation, a saved request that is oversized or carries image
payloads, or other evidence a replacement cannot drive) ends the Turn as `managed_runtime_recovery_blocked` with a typed reason
instead of retrying forever. The Session row and its generation binding
survive that decline, but the declined Turn's input stays unsettled in the
journal, so the Session cannot admit a further Turn — close it and start a new
Session. See "Hosted recovery scope" below for what the first release
covers. A Harness whose journal writes stopped after a failed commit answers every close with `503` until it restarts. A delete of a closed or archived Session
needs no Harness. Archive accepts only a closed Session and completes at once;
unarchive restores it to closed. Rename waits for the Harness to durably commit
`session_metadata`. When a rename failure is recorded, its `PENDING` command becomes `FAILED`
while retaining its receipt and request digest. The same
key retries the same content with the replay flag set; changed content or a
different Session conflicts. A successful concurrent request can still complete
the receipt, and a failing sibling cannot overwrite that completed outcome. It
cannot complete a retired receipt once a later rename has completed either: that
sibling answers `409 session_mutation_superseded` and the newer public SQL title stays.
The latest title attempt is now a durable delivery with a monotonically increasing per-Session revision. The Harness checks this revision inside its journal commit and uses a stable command identity per attempt, so a late older versioned write cannot undo a newer versioned title and a lost reply can be replayed without another write. A failed same-key request retried after a later rename receives a new revision and can still win. Pending same-key retries keep their original revision. A recovery worker redelivers the latest unfinished title and completes its public receipt; older completion attempts cannot affect the newer delivery. Both inline requests and recovery workers claim before sending; failure cleanup requires the current unexpired owner. Fresh disabled or unsupported Harness requests are refused before admission. Workspace migration also refuses unfinished title delivery even when the public command is FAILED. Close, archive, delete and cwd changes wait for this delivery to settle, including when its public command is FAILED, so sealing cannot strand a title already accepted by the Harness. A delivery whose submission went unanswered is the exception (D7-2): it parks `recovery_blocked`, is never sent again, and retires its public receipt, so it holds neither later titles nor the lifecycle; the operation reconciler completes it, and shows the title, once the Session journal holds its revision's commit, and fails it once a deleted Session's complete journal lacks it ([design](../../docs/design/2026-10-17-managed-operation-reconciliation.md)). The Harness must advertise title protocol version 1 before the SDK sends a versioned title. Plain private SDK title writes remain supported and preserve the watermark. See [the concurrency design](../../docs/design/2026-10-08-managed-session-rename-delivery.md). If the command store
is unavailable during cleanup, the original API failure is preserved and the
same key can resume its receipt when storage returns. Only an in-flight
lifecycle change blocks another one. A retry with the same key from the same
actor returns the original operation once it has completed.

Harness attachment uses strict create/load semantics: create returns `409` for
an existing private Session authority, while load returns `404` for a missing
authority and never initializes one. The Java connector attempts strict create for a new binding and loads on
conflict or uncertain creation outcome. A known existing binding only loads.
The Java connector caches an attachment per `(tenantId, sessionId)`,
so one tenant's cached reference is never handed to another by the connector.
The Harness itself keys its in-memory Session by `sessionId` alone and does
not compare the presented tenant, Store endpoint or workspace on attach; the
only attach-time identity fence is the Harness writer generation, so tenant
isolation on attach is the caller's responsibility in this slice. A presented
Harness writer generation _is_ checked: an attach whose `writerId` is not this
process's boot ID fails closed with `409 hosted_harness_generation_mismatch` —
the restart-generation failure described above. That
`managed_session_store_conflict` fence is target design for the integration
slice, not shipped behavior.

Delete writes a public tombstone: get and list stop returning the Session,
while its operations stay readable. Completed deletion permanently marks an existing
private journal `DELETED`, clears its writer and recovery references, and fences
new writes and recovery. Close and archive keep output pinned. The deletion
request records the tombstone; output collection stays disabled by default
and requires the retention deployment gates. With both
`qwen.managed-agent.tool-publication.enabled` and
`qwen.managed-agent.tool-publication.gc-enabled` true, a typed
`SESSION_RESOURCE_GC` operation in `ma_operation` releases retired journal,
message, record, snapshot and artifact owners and their `ma_resource_ref`
references in bounded transactions after the deletion grace. Unreferenced
`PUBLISHED` or `REFERENCED` immutable `MYSQL_INLINE` bodies in `ma_resource`
are then byte-dropped, keeping their identities with state `COLLECTED`.
Capture objects follow a separate `CAPTURE_GC` operation: it persists deletion
intent before physical deletion and retains its claim generation and cursor
until the outcome is settled. Live readers, recovery protection and unresolved
object writes block collection. Session/head tombstones and event-stream tail
and retention-floor counters remain. Unreferenced bodies of active Sessions
remain retained until Session retirement. Reads of the retired Session stay fenced with
`tool_output_session_retired` exactly as before; a workspace-recovery read
that physically reaches a collected byte copy fails the named check
`resource_collected` instead of the generic `resource_layout_unsupported` or
`resource_corrupt` verdict a pre-V65 broker produces.

This revision starts with a new empty database. Existing development or application databases keep their historical data under the old binary; the new service refuses legacy catalogs before running its baseline. Session identities and public URLs remain stable within their own environment.

The public listener intentionally ignores end-user `Authorization`. The
optional Runtime Broker listener still requires a separate machine bearer and
must remain private.

## Private Managed Session store

The shared fresh baseline creates the private Managed Session head, journal and resource tables. The
internal routes under `/internal/managed-session-store/v1/**` provide
database-time writer leases and generations, head compare-and-set,
idempotent transaction receipts, exact JSONL transaction bytes, paged restore
reads, atomic checkpoint-pointer advancement, and transactional resources up
to 64 KiB. Callers must provide the trusted tenant header and a writer
credential in `X-Qwen-Managed-Writer-Token`; only its SHA-256 is persisted.
Without `QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY` the credential is a
fresh Base64URL secret the caller mints (first writer wins); with a binding
key it must be the broker-issued HMAC over the Session scope and self-minted
secrets are rejected. Restore,
transaction-page, and resource reads require the same current, unexpired
writer secret.

Restore transaction pages are bounded to 8 MiB of unencoded record bytes even
when the requested item limit is larger. Unknown head states, unsafe counters,
or missing transaction revisions fail closed as storage corruption.

The routes are disabled by default. Enable them only on a private service
listener or trusted service network:

```bash
export QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED='true'
export QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL='http://127.0.0.1:8080'
export QWEN_MANAGED_AGENT_SESSION_STORE_WRITER_LEASE_DURATION='60s'
export QWEN_MANAGED_AGENT_WORKSPACE_ID='workspace-demo'
```

`QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL` must be reachable from the Hosted
Harness. When both the Harness and Store are enabled, Java includes a scoped
Store descriptor in each new private Hosted Session request. The ordinary
daemon rejects that descriptor, while the Hosted Harness uses the TypeScript
HTTP adapter with the descriptor's broker-issued writer credential (or a
self-generated secret when no binding key is configured). Workspace-bound Sessions use
their persisted Workspace ID for the Store scope; unbound Sessions use
`QWEN_MANAGED_AGENT_WORKSPACE_ID`. The public Session, private journal and Runtime
binding retain one `(tenantId, workspaceId, sessionId)` identity. The global ID
must still be set explicitly when enabling the Session Store; if the Runtime
Broker also has an explicit ID, startup rejects a mismatch.

This activates the durable create and cold-load paths for newly created Hosted
Sessions. The load path rebuilds the Harness state from the scoped Store and
does not require a Pod-local transcript. The Store boundary has an
independent-JVM crash/takeover proof against real MySQL. A deterministic
multi-process check also kills the real Java and Hosted Harness owners, deletes
their local homes, and proves that replacement owners complete a second Turn
with the first Turn's restored context. A separate recovery slice supports one
known pending tool execution: the replacement Harness starts or polls the
original Broker identity, commits its settled receipt as `results_ready`, and
Java replaces the Harness boot and public event epoch under the Turn dispatch
lease, durably records the replacement attachment watermark before invoking
checkpoint-bound continuation with the original public prompt identity, and
advances the cursor after the response. Unit, contract, and H2 coordinator/store
tests verify that this path does not resubmit the Prompt or replay the tool. Do
not advertise general automatic cross-Pod recovery yet. The SQL scan below
discovers eligible committed wake inputs after writer loss; multi-tool recovery,
recovered cancellation, event/checkpoint reconstruction after a
mid-continuation Harness crash, the full multi-process in-flight failure matrix,
OSS-backed resources, and scheduler recovery are still pending. Resources
larger than 64 KiB fail with
`managed_session_oss_disabled` until the immutable OSS path is implemented.
Production deployments must add mTLS or equivalent service authentication;
the tenant and writer headers are scope and fencing inputs, not a substitute
for transport identity. Responses under the private prefix use
`Cache-Control: no-store`.

### Wake recovery after Harness loss

With the Session Store enabled, an independent control-plane scan discovers
committed Monitor/background Shell, channel, child-result, workflow, Automation and Session
message inputs after their writer lease expires. It runs every two seconds on a
dedicated scheduler, handles up to eight candidate Sessions per pass, and leaves
a durable 30-second retry delay after a claim. EventTransport is optional; an
acknowledged or already-claimed MQ wake cannot suppress this scan.

Only a matching committed `turn.settled` consumes an input. Recovery reattaches
the Session and lets its existing wake pump run unattempted inputs or settle
interrupted attempts honestly. It does not replay tool effects or turn unknown
results into success. Old inputs retain this policy regardless of age. Closing,
retired, private CSI and stopped or terminal child runs are excluded; Workspace grants
and mount checks still apply. A failed recovery logs the tenant and Session and
remains retryable without a permanent attempt limit. Backlog or unavailable
execution/restore evidence can delay recovery beyond the lease and retry time.

Schema V11 adds a revision-stamped wake hint and retry timestamp to the existing
Session head. Unknown or stale hints rebuild from committed journal events;
compacted heads are excluded without marking their inputs consumed, while missing
or corrupt proof is refused. Each proof invocation reads at most 32 transactions
and yields with its complete continuation for a later claim; partial proof never
clears the hint or triggers a load. At most 128 exact-prefix continuations or
positive memos are retained. Live partials keep their slots; new long proofs wait
for completed or ineligible holders to free capacity. A new revision or process
restart begins proof at zero with the durable hint intact.
Upgrade the Server and Broker together; rollback binaries must understand V11.
This scan is locally verified on macOS/MySQL 8.4. Linux/Windows, real MQ-on and
deployed provider acceptance remain unverified; see also [Hosted recovery scope](#hosted-recovery-scope).
The [English design](../../docs/design/2026-10-18-hosted-wake-recovery.md) and
[Chinese design](../../docs/design/2026-10-18-hosted-wake-recovery.zh-CN.md) describe
the recovery boundary and acceptance criteria.

## Managed automation (H6)

The control plane runs the H6 automation runtime for `persistent`
definitions: a definition is created, revised, read and retired under the
Workspace-bound Session its creator owns (`/v1/agent-automations`), a
scanner derives each definition's due slots on this host's tz database,
claims the definition under a lease with a fence, records every occurrence
decision in its own ledger (V57) and fires a run as one idempotent Hosted
Harness operation; a manual run is the same operation keyed by its
`Idempotency-Key`. The Session journal's `schedule` and `automation_run`
chains stay the authority; the ledger locates, leases and indexes. The
`per_run` target and the delivery policy are refused until their slices
land. Design:
[managed automation runtime](../../docs/design/2026-10-07-managed-automation-runtime.md).

All settings below use the `qwen.managed-agent.automation` prefix:

| Setting              | Default | Meaning                                                                                                                                                                                            |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | `false` | Run the scanner and admit the mutation routes (`QWEN_MANAGED_AGENT_AUTOMATION_ENABLED`); the read routes answer either way.                                                                        |
| `scan-delay`         | `10s`   | Fixed delay between scanner ticks.                                                                                                                                                                 |
| `lease`              | `60s`   | How long one scanner holds a definition; a stalled scanner yields it afterwards, and the fence it held no longer writes.                                                                           |
| `late-tolerance`     | `5m`    | A slot older than this when the scanner sees it is late and follows the definition's catch-up policy (`none`, `latest`, `bounded`).                                                                |
| `lookback`           | `24h`   | Slots older than this are neither fired nor recorded; it bounds every catch-up by age.                                                                                                             |
| `max-slots-per-tick` | `1000`  | Slots **returned** per definition per tick: the walk itself follows the lookback window (its minutes are enumerated regardless), and the result set's surplus is cut at the oldest end and logged. |
| `concurrency`        | `4`     | Non-terminal runs an `allow` definition may hold at once; beyond it an occurrence is recorded `skipped` with reason `count_limit`.                                                                 |

## Full WebShell dual-path development entry

The full WebShell can keep an ordinary Qwen daemon for its existing chat,
workspace, settings, and terminal surfaces while routing only the Managed
panel to this Spring service.

The one-shot launcher starts the ordinary daemon and the private Hosted
Harness from TypeScript source, writes the Harness wiring
(`QWEN_MANAGED_AGENT_HARNESS_*`, the rotating capability digest, and the
HTTP Session Store that Hosted Sessions require) to a
`spring.env` under the OS temp directory — kept outside the served
workspace, mode-0600 on POSIX (on Windows NTFS ACLs scope the per-user temp
directory instead, and a PowerShell `spring.env.ps1` sibling is written next
to it) — waits for `/actuator/health` on the Spring service
(`--skip-java-wait` bypasses), then opens the WebShell with the Managed
panel selected:

```bash
npm run dev:managed-agent
# In a second terminal, before the Java health wait expires (10 min).
# Once per clone, and re-run after pulling changes to the Java SDK:
mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
# One-time, on a fresh MySQL 8 (creates the database and user the URL names;
# the performance_schema SELECT covers Flyway's boot probe — without it the
# probe is denied (ERROR 1142) and startup stops at 'foreign_key_checks'):
mysql -u root -e "CREATE DATABASE qwen_managed_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER 'qwen'@'localhost' IDENTIFIED BY 'replace-me'; CREATE USER 'qwen'@'127.0.0.1' IDENTIFIED BY 'replace-me'; GRANT ALL ON qwen_managed_agent.* TO 'qwen'@'localhost'; GRANT ALL ON qwen_managed_agent.* TO 'qwen'@'127.0.0.1'; GRANT SELECT ON performance_schema.user_variables_by_thread TO 'qwen'@'localhost'; GRANT SELECT ON performance_schema.user_variables_by_thread TO 'qwen'@'127.0.0.1';"
# (official MySQL images enable skip-name-resolve, so 'qwen'@'localhost' alone never
#  matches TCP clients; a containerized MySQL sees the gateway address — grant at
#  'qwen'@'%' or the container-visible host instead)
# Every run; the launcher prints this spring.env path at startup (on Windows,
# the printed path is the spring.env.ps1 sibling):
source <printed spring.env path>
export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'
export SPRING_DATASOURCE_USERNAME='qwen'
export SPRING_DATASOURCE_PASSWORD='replace-me'
mvn -f packages/managed-agent-server/pom.xml spring-boot:run
```

The daemon, Harness and Java URLs print at startup with the `spring.env`
path, and the full Managed URL (which carries the daemon token) prints on an
interactive terminal; ports auto-increment when busy. The launcher verifies
only that something Spring-Boot-shaped answers `/actuator/health` — it
cannot prove that Spring loaded this run's `spring.env`, so restart Spring
whenever the launcher (and its rotating token and digest) restarts. If every
Turn then fails with `hosted_harness_rejected` in the panel: a Harness
`400` means the Session Store wiring in `spring.env` did not load
(`invalid_managed_session_store` — an env file from an older run), while a
Harness `401` means a launcher restarted without restarting Spring —
re-source the new `spring.env` and restart Spring.

To wire the pieces by hand instead, keep the ordinary daemon on 4170 (the
vite proxy's default) and start the private Hosted Harness on a distinct
port. The profile refuses to start without credentials, so the launch
reuses the same credential pair the Prerequisites section exports for
Spring — CLI-side the token travels as `QWEN_SERVER_TOKEN` and the
capability digest as `QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST` — plus
`--no-web`, which the profile requires and no environment variable supplies:

```bash
QWEN_SERVER_TOKEN="$QWEN_MANAGED_AGENT_HARNESS_TOKEN" \
QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST="$QWEN_MANAGED_AGENT_CAPABILITY_DIGEST" \
qwen serve --profile hosted-harness --port 4171 --hostname 127.0.0.1 --no-web
```

— and Spring must point at it with the matching base URL. Spring's HTTP
Session Store stays off by default, and the Hosted Harness rejects every
attach without a store descriptor, so Spring also needs the three values
the one-shot launcher writes into `spring.env` — the connector refuses to
start when the store is enabled with a blank base URL or workspace ID.
Export all four together:

```bash
export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4171'
export QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED='true'
export QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL='http://127.0.0.1:8080'
export QWEN_MANAGED_AGENT_WORKSPACE_ID='local-dev-workspace'
```

All four are read once at JVM startup, so if `mvn spring-boot:run` is
already up on the 4170 value exported in Prerequisites, restart it with the
overrides in place.

`--port` is a request, not a guarantee: `qwen serve` moves to the next free
port on a collision, and 4171 is exactly where a daemon displaced from 4170
lands. Confirm each server's bound port in its startup line before exporting
the base URL above.

With both up, run from the repository root:

```bash
QWEN_DAEMON_URL=http://127.0.0.1:4170 \
QWEN_MANAGED_AGENT_JAVA_URL=http://127.0.0.1:8080 \
  npm run dev:managed-agent-web
```

Open
`http://127.0.0.1:5174/?managed=1&managedProvider=java&tenant=local-java-demo`.
The standard WebShell entry proxies its existing routes to the ordinary daemon
and `/api/agent/web-shell/v1/**` to Spring. Use
`managedSession=<sessionId>` to deep-link a Managed Session. If the ordinary
daemon requires authentication, append its token as the usual `#token=...`
fragment.

`managedProvider=java` and `tenant` are local-development conveniences and are
honored only by the Vite development entry. Production hosts should construct
`createJavaManagedAgentProvider(...)` themselves and pass it to
`WebShellWithProviders.managedAgentProvider`; a trusted upstream must derive
the tenant instead of trusting a browser query parameter. Products that do not
have an ordinary daemon can continue to render the exported
`ManagedAgentWebShell` directly. Neither browser mode receives the private
Harness or Runtime Broker credentials.

### Native macOS Workspace development

The Java Broker can run the existing local Node.js tool worker on macOS with verified Workspace registration and durable same-boot worker adoption. Set `QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false`; whole-host reboot recovery remains Linux-only. Keep durable local mode and verified Workspace recovery enabled, register the storage offline using the maintenance command below, and configure the same mount in the Java service. A missing registration still refuses tool execution.

For the Vite entry, set `VITE_MANAGED_AGENT_WORKSPACE_BINDING=true` and `VITE_MANAGED_AGENT_ACTOR_ID` to your development actor. On the loopback Java service, set `QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER=X-Qwen-Actor-Id` and grant that actor access to the registered Workspace. Configure `VITE_MANAGED_AGENT_MODEL_PRESETS` with published AgentDefinition IDs for new-task model choices; the server's `model-catalog` supplies model choices within bound Sessions. These settings supplement the Broker and Hosted Harness wiring below; enabling selectors alone does not enable tools.

macOS storage identity combines `IOPlatformUUID` with the original device, inode and nanosecond birth time from native `stat`, cross-checked against the JDK directory identity. Worker identity also checks `kern.bootsessionuuid` and the exact process start instant before re-attestation. Preserve the SQL database, private Runtime state directory and credential key across Broker restarts. macOS handles use explicit `macos` namespace labels; older Java readers refuse them. A different boot is refused even for operator stop attestation. Background Shell, Monitor, command Hooks and Linux CSI retain their existing platform restrictions. The published reference distribution's Linux qualification is unchanged.

## Embedded Runtime Broker

### Public foreground Shell admission

Stored AgentDefinition Sessions keep their compiled profile and approval mode;
the Shell switch changes only the built-in agent's default profile selection.
Every Shell Session still requires the switch and valid asking approval for
fresh execution. Harness load copies retain the definition identity alongside
`suppressChildAgents`.

`QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED=true` selects the server-owned
`hosted-workspace-shell/1` profile for newly created built-in `qwen-code` Workspace Sessions on both
public REST and WebShell, including empty creation. It defaults to false and
requires Workspace files plus its deployment prerequisites. Set
`QWEN_MANAGED_AGENT_APPROVAL_MODE` to `default` or `auto-edit`; Shell opt-in with
`yolo`, an empty or unknown mode fails startup. Shell always asks permission.
Existing Sessions keep their stored profile and approval mode.

Disabling only the Shell flag refuses fresh Turns on existing Shell Sessions
with `409 workspace_unavailable`; original idempotency keys, accepted approval
responses, cancellation and settlement remain supported while Workspace files
remain enabled and persisted approval remains `default` or `auto-edit`. Files-off
or invalid approval can refuse attachment; neither case is bypassed by a
capability. Files Sessions retain their existing behavior. Shell Session responses
add `foreground_shell` (public) or `foregroundShell` (WebShell); false disables
fresh sending. Files and unbound Sessions omit the field, with no schema default.
`workspaceTurns` expresses creator/grant permission, not sufficient Shell Turn
admission: fresh sending also requires `foregroundShell=true`. Controlled W2 cwd
changes do not execute Shell and retain their own files, actor, path and
context-revision admission; the Shell flag is not a general Session freeze.

Shell close/archive/unarchive/delete remain unavailable, and are refused before
creating a lifecycle operation. Existing G3 recovery refusals remain in force;
no dispatched Shell is automatically replayed. Keep the opt-in off until the
deployment passes #12904, #13010 and public FG6f physical failure gates. See
[the complete design](../../docs/design/public-hosted-shell-admission.md).

### Initial Workspace Turn (G0)

`QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED=true` opts in to an initial
Workspace Turn supplied with public Session creation: Read/Write/Edit under
`hosted-workspace-files/1`, or file tools plus mandatory-approval foreground Shell
under `hosted-workspace-shell/1` when the Shell opt-in above is enabled. The
WebShell creation adapter uses the same admission. This requires the Hosted
Harness and HTTP Session Store, `default` or `auto-edit` approval for Shell
(`yolo` is also valid for files), and a `local-process`, `session`-isolated
Broker with configured `runtime-broker.workspace-mounts`. Registry entries must
use `managed-runtime-tools/1` and `preapproved-workspace-tools/1`, and their
tenant/storage identity must have a deployment mount. Fresh LOCAL databases additionally require `QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED=true` on Linux or macOS and a successful native storage registration before tool or child Git execution. Every logical alias maps to one physical owner; aliases of the same native mount share that owner while retaining independent logical admission fences. Registration preserves the first marker provenance, and an unmapped alias cannot acquire physical execution authority. The trusted ingress must
provide an `AuthenticatedTenantActor` principal with read/create grants; a caller
header alone does not authenticate an actor. For local runs and the
packaged-stack E2E, which have no ingress,
`QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER` names a request header whose value is
then trusted as the actor for the request's tenant. It is disabled by default;
never enable it where untrusted clients can reach the server.

### Create empty Workspaces from WebShell

Set `QWEN_MANAGED_AGENT_WORKSPACE_CREATION_ROOT` to an existing canonical, server-owned directory to enable **New workspace → Start from scratch** in the Managed composer. The default is disabled. The root must be separate from static Workspace mounts, the default Workspace cwd, and private Runtime state. Enable Workspace files, the Session Store, the durable Session-isolated local-process Broker and verified local Workspace recovery first. Enabling this setting authorizes authenticated tenant actors to allocate independent empty roots and receive OWNER access; only enable it for tenants allowed to consume this host's storage.

`POST /api/agent/web-shell/v1/workspaces/create` accepts `displayName` (trimmed, 1–128 characters without controls) and `idempotencyKey`. It returns the regular Workspace summary without host paths. Creation freezes an actor-scoped `WORKSPACE_CREATE` receipt, derives a tenant-separated directory below the configured root, registers its native identity and marker, and atomically publishes the ACTIVE Workspace with its creator grant. The Workspace query advertises `workspaceCreation` when enabled. Existing static mount configuration continues to work.

An uncertain response must be retried with the same key and name. The page preserves that pending operation across refresh and selects the result without clearing the prompt or model. Completed replay never restores revoked access, recreates missing registry rows, or registers held storage again. Pending registration resumes in place after a process restart; failed attempts retain their owned directory for retry. There is no automatic storage deletion or arbitrary host-path import. Workspace persistence does not imply recovery of a resident Harness Session whose writer lease expired during control-plane downtime; that existing Session recovery boundary is separate from creating or reusing a Workspace. Keep the configured root and SQL database durable together. Schema V4 extends the receipt namespace after the published V3 Session-list migration while retaining all published migration resources and existing data.

### Select an existing local project directory

With verified LOCAL storage enabled, **New workspace → Choose existing directory** browses the Linux or macOS execution host through Java. Select an ACTIVE ROOT Workspace you own, then choose an existing project beneath its authorized root. Administrators can register and grant a projects parent directory once; the root must remain outside all Git worktrees. The selected project stays in place and becomes the new Workspace's persistent default working directory. Other Workspaces on that storage retain the same shared file-access scope and physical-owner lease; selecting a subdirectory does not create filesystem isolation.

`POST /api/agent/web-shell/v1/workspaces/directories/query` accepts `workspaceId` and `cwdRelative`, rechecks OWNER access and native storage, and returns at most 100 real immediate child directories (scanning at most 1024 entries). Only this authorized route discloses its execution-host root path. The existing create route accepts `sourceWorkspaceId` and `cwdRelative` together to bind a new logical Workspace to the verified source storage, configuration, and policy. It does not create directories or re-register storage. The creation receipt pins source generation and directory; pending retries refuse source changes or revoked ownership. Completed replay checks the new Workspace's current access. WebShell summaries expose `defaultCwdRelative` and `canSelectDirectory`; missing values mean `.` and unsupported, respectively. The page advertises `workspaceDirectorySelection` separately from empty creation and preserves the selected directory across retries, refresh, and reselect. See the [bilingual design](../../docs/design/2026-10-16-managed-workspace-directory-selection.md).

`QWEN_MANAGED_AGENT_APPROVAL_MODE` defaults to `yolo`. In `default` and
`auto-edit`, any caller with a read grant on the bound Workspace can list and
inspect pending permission Actions through the public API or WebShell;
answering one needs the Session's recorded owner or a caller holding OPERATOR
or above, and that read grant as well. A Shell Session is the exception:
only its recorded owner may answer, because that answer runs a command. Responses are durable, idempotent
operations; their final result follows the committed Harness decision.
`QWEN_MANAGED_AGENT_APPROVAL_TIMEOUT` defaults to `10m` and accepts `1s` to `24h`.
The initial approval mode is pinned at Session creation and must be confirmed by the
Harness on creation and load. Built-in Workspace Sessions can select a different
policy for later Turns while retaining the original definition.

For new Workspace-bound WebShell Sessions, the shared composer queries `POST /api/agent/web-shell/v1/session-options/query` with `agentId` using the authenticated tenant actor. The response contains the effective `approvalMode` and `availableApprovalModes`; Workspace discovery advertises `approvalModeSelection` for this contract. Built-in Sessions allow `default`, `auto-edit`, and `yolo` (Full Access). Shell Full Access additionally requires the Harness feature `approval-selection/1`; without it Shell offers only `default` and `auto-edit`. The Shell deployment opt-in and its deployment default remain unchanged. Hosted execution does not support classifier `auto` or `plan`. An AgentDefinition exposes only its compiled policy, which a creation request cannot override.

The WebShell create request may include `approvalMode` only with a Workspace binding. Omission preserves the existing default and request digest; explicit selection is persisted in the Session and joins its idempotency digest. Retrying the same key reads the original pin even if deployment defaults, the AgentDefinition, or a later Session selection changed. Workspace-bound and definition-pinned Session summaries expose the current `approvalMode`, immutable `initialApprovalMode`, and `approvalRevision`. Legacy unbound built-in Sessions omit this metadata because their execution policy is supplied by the deployment. The public REST create contract is unchanged.

Eligible Workspace Sessions can change their next user-submitted Turn's approval policy. Built-in `qwen-code` Sessions require the Harness feature `approval-selection/1`. Stored AgentDefinition Sessions using exactly `hosted-workspace-files/1`, `hosted-workspace-shell/1`, or `hosted-workspace-shell/2` additionally require `agent-definition-approval-selection/1`; both features must remain available for execution after any override, including a return to the initial mode. `POST /api/agent/web-shell/v1/session-approval/query` returns the current mode, revision, available modes, and support. `POST /api/agent/web-shell/v1/session-approval/change` accepts `sessionId`, `approvalMode`, `expectedRevision`, `idempotencyKey`, and `requestId`. Only the recorded Session owner with current Workspace OPERATOR or OWNER access may change it or replay a receipt. The Session must be idle, with no pending approval, context/lifecycle operation, retained Runtime, or recovery work. Identical retries return the original result without another revision; different content under the same key and stale revisions conflict. The definition pin and initial creation policy remain immutable; later user Turns freeze the selected mode and revision. Creation options still expose only the compiled initial policy. Files/2, MCP, read-only child, team-lead, CSI, unknown profiles, and unbound text Sessions do not gain policy selection. There is no public REST mutation endpoint. See the [stored-definition approval design](../../docs/design/2026-10-17-managed-definition-approval-selection.md) ([简体中文](../../docs/design/2026-10-17-managed-definition-approval-selection.zh-CN.md)).

This extension needs no schema migration, but old Java readers and writers ignore custom overrides. Upgrade Harness first, then stop or fence every old Java/Broker process sharing the catalog and deploy the new control plane everywhere before permitting changes. After a custom override, rollback must use a compatible build or keep affected Sessions blocked while applying a forward fix. Do not mix old Java binaries, clear revisions, or rewrite definition/history to roll back. Custom initial-yolo definitions retain the existing ten-minute approval timeout fallback after an override; custom initial-default/auto-edit definitions retain their stored timeout.

Schema V6 preserves the original policy and adds a current override plus per-Turn approval snapshots. Turn admission and policy changes share the Session row lock, so retries and recovery execute the admitted snapshot. Revision zero and legacy Turns consistently omit the private `approvalSelection` field and execute the confirmed immutable definition, preserving prompt retry identity across Harness capability upgrades; positive revisions always send the saved Turn snapshot. `yolo` skips ordinary file and Shell approvals, while explicit Hook ask/deny decisions retain their existing behavior. The configured approval timeout persists for new selectable Full Access Sessions and survives a later switch back to asking. Legacy Full Access definitions without a timeout keep the existing 10-minute fallback. WebShell retains an uncertain change with its original request and key across refresh, blocks send/model/cwd changes until receipt readback, and ignores older policy revisions. A Session with an override cannot execute through an older Harness. Deploy the updated Harness first, upgrade schema and all Java/Broker readers and writers during a maintenance window, then release WebShell; rollback binaries must understand the saved override and snapshots. See the [approval selection design](../../docs/design/managed-approval-selection.md).

Workspace-bound WebShell Session summaries can include `modelContext` with the actual observed `modelId`, optional latest-request `inputTokens` and resolved `contextWindowSize`, and `observedAt`. The Hosted CLI records capacity beside successful provider usage; the Java Session Store projects only committed main-model attempts into one private latest-resource pointer. Lists read these observations in one batch without scanning journal history. Older or invalid usage advances the pointer but leaves missing values unknown; cumulative billing totals and inferred capacities never substitute for them. The shared usage popover does not offer manual compression. New tasks continue to select published AgentDefinition presets. This observation projection uses existing SQL tables and resource-reference cleanup without changing the recovery format.

To allow an existing Workspace Session to change its next Turn's model, publish an explicit `qwen.managed-agent.model-catalog` list of `{modelId, label}` entries in the server configuration. The default is empty. IDs must identify configured, cached-credential models in the Hosted CLI; the browser supplies neither provider settings nor credentials. The Harness must advertise `model-selection/1`. `POST /api/agent/web-shell/v1/session-models/query` returns the catalog and current selection; `POST /api/agent/web-shell/v1/session-models/change` takes `sessionId`, `modelId`, `expectedRevision` and `idempotencyKey` and synchronously returns the saved selection. The caller needs Workspace OPERATOR or OWNER and the Session must be idle, without pending approval, context/lifecycle work or recovery. Same-key retries return their original result before mutable catalog and role gates, provided the caller still has read access. They never reapply a change.

Schema V5 adds the current selection to the Session and copies it into each newly admitted Turn. Retries and recovery send that Turn's fixed model, never a later Session choice. No explicit selection preserves the original AgentDefinition/deployment behavior. Selection does not change the AgentDefinition identity, instructions, tools or approval policy. Each newly committed selection clears the latest context observation, including A→B→A without a Turn, until a new successful model request supplies usage. `modelSelection` in the summary describes the next-Turn setting; `modelContext` describes an actual successful request. An unavailable selected model fails closed rather than falling back to the deployment model.

Submit `agent_id: "qwen-code"`, the existing `workspace` selection and `input`
through `POST /v1/agents/sessions`. The server persists
`hosted-workspace-shell/1` with the deployment default `default`/`auto-edit` policy when the
Shell deployment opt-in is enabled, otherwise `hosted-workspace-files/1` with the
configured file approval mode. This also applies to empty bound creation. The
Session Store uses the persisted Workspace ID; public callers cannot choose the
profile. W1c offline migration remains files/1-only and refuses persisted Shell
definitions with `migration_profile_unsupported`. Configure the
Harness's deployment-owned `--managed-runtime-broker-url` and
`--managed-runtime-broker-token` options to reach this Broker. A repeated creation key returns
the original Session/Turn; changed input conflicts. Disabling the Workspace files
opt-in refuses creation with input, including replays, while empty bound creation
remains available. The Shell opt-in selects the persisted profile; it does not
independently admit creation input. Upgrade the Harness before enabling the
Shell flag: an older Harness ignores `suppressChildAgents` and would advertise
the child agent tool. The directory mounted for a Workspace is trusted deployment data,
not a filesystem sandbox.

Later Turns may be submitted by any caller holding OPERATOR on the bound
Workspace under the same opt-in while the Session's creator-keyed execution
facts hold (the Workspace registry still backs the binding and stays `ACTIVE`,
and the actor recorded by the Workspace create command keeps OPERATOR or
above; the WebShell adapter's per-caller `workspaceTurns` capability flag
mirrors exactly that rule, though the public surface publishes no such
flag). Shell Sessions also require the Shell opt-in and valid persisted
approval for fresh sending. `workspaceTurns` does not certify Shell admission;
Shell clients also require `foregroundShell=true`. Such a caller may cancel
the Session's running Turns and rename the Session — a readable actor below
OPERATOR gets `403 session_operation_forbidden`, and an admitted OPERATOR
blocked by the shape or fact gates gets `409 workspace_unavailable`.
Workspace close follows its separate close capability and lifecycle admission.
Public Shell close, archive, unarchive and delete stay unavailable, including
protocol-0. Archive, delete and unarchive of non-Shell Sessions follow their
separate retention capabilities after reliable Workspace close. Controlled cwd
changes ship below (W2); broad Workspace capability advertisement remains
gated. Public foreground Shell does not publish the child agent tool, and it
has no Session message funnel because that funnel shares the child
orchestrator's write chain.
Background Shell, Monitor and complete in-flight recovery remain separate slices.
The existing `EmbeddedRuntimeBroker` is used through production configuration;
no direct store admission or test Broker replacement is needed.

Design: [English](../../docs/design/2026-09-29-hosted-public-workspace-admission.md)
| [简体中文](../../docs/design/2026-09-29-hosted-public-workspace-admission.zh-CN.md).

### Broker authentication and writer credentials

`QWEN_MANAGED_AGENT_AUTH_MODE` selects how the public surface
(`/v1/agents/**` — including the bare `POST /v1/agents` collection route —
and the WebShell adapter) authenticates its caller:
`auto` (the default) resolves to `open` when `server.address` is loopback
and refuses to start otherwise, `open` keeps the header-asserted tenant and
the optional trusted-actor stand-in for local runs, and `signed` requires
every public request to carry `X-Qwen-Actor-Id`,
`X-Qwen-Signature-Timestamp` (epoch seconds, within
`QWEN_MANAGED_AGENT_AUTH_ALLOWED_DRIFT`, default `5m`, minimum `1s`) and
`X-Qwen-Signature: v1=<lowercase hex HMAC-SHA256>` over the canonical string
below, keyed by `QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY` (at least 32 bytes):

```text
"qwen-broker-auth-v1\n" + METHOD + "\n" + undecoded request path + "\n"
+ raw query string (empty when absent) + "\n" + tenant + "\n" + actor + "\n"
+ timestamp + "\n" + lowercase hex SHA-256 of the raw request body + "\n"
+ the Idempotency-Key header value (empty when absent)
```

A repeated `Idempotency-Key` header answers 400 invalid_request, and a body
beyond `QWEN_MANAGED_AGENT_AUTH_MAX_SIGNED_BODY_BYTES` (default 10 MiB)
answers 413 payload_too_large. Signed mode cannot be combined with
`QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER`.

`QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY` switches writer tokens from
self-minted to broker-provisioned: the writer credential becomes an HMAC
over `(tenantId, workspaceId, sessionId)` that the Broker hands to the
Harness in the attach payload, and the store rejects any other token,
including during a free lease window. A configured key must be at least 32
bytes. A Broker that intentionally serves the store over plaintext HTTP
inside a trusted network sets
`QWEN_MANAGED_AGENT_SESSION_STORE_ALLOW_INSECURE_HTTP=true`, which the
attach payload forwards to the Harness so its client accepts the URL. The
internal surface
(`/internal/**`) may move to its own listener via
`QWEN_MANAGED_AGENT_INTERNAL_SERVER_PORT` and
`QWEN_MANAGED_AGENT_INTERNAL_SERVER_ADDRESS` (default `127.0.0.1`); either
port then answers 404 for the other surface's routes. Leaving loopback —
public or internal — requires signed mode or a configured binding key
respectively, unless `QWEN_MANAGED_AGENT_AUTH_ALLOW_INSECURE_BIND=true`
explicitly overrides the guard. Loopback is a trust boundary only as strong
as the host: a shared host that runs untrusted workloads (including
model-generated commands) should configure a binding key even on loopback.

Design: [English](../../docs/design/managed-agent-broker-auth.md)
| [简体中文](../../docs/design/managed-agent-broker-auth.zh-CN.md).

### Controlled cwd change (W2)

Under the same `QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED` opt-in, any caller
holding OPERATOR on a bound Session's Workspace moves its relative directory
within the same Workspace:

```bash
curl -sS -X POST \
  http://127.0.0.1:8080/v1/agents/sessions/$SESSION_ID/cwd \
  -H 'Content-Type: application/json' \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: cwd-1' \
  -d '{"cwd_relative":"services/api","expected_context_revision":1}'
```

`202` admits a durable `cwd_change` operation; it does not activate the
directory. The change is same-Workspace only and requires the caller's OPERATOR
role plus the Session's creator-keyed execution facts (the registry still backs
the binding and stays `ACTIVE`, and the recorded create actor keeps OPERATOR or
above; the V56-persisted initiator is re-checked at settlement the same way, so
demoting either actor fails the operation with `workspace_unavailable`), an idle
Session (`409 session_context_busy` while a Turn or another operation is open)
and a matching `expected_context_revision` (`409 context_revision_conflict`
otherwise); a retry with the same key returns the original operation even after
it completes. A background worker verifies the target against the deployment
mounts and commits one transaction that bumps `cwd_relative` and
`context_revision`, marks the operation completed and appends
`session.context.changed`; poll the operation through the existing query route
or await the event. A target the mount cannot verify fails the operation with
`failure_code` and leaves the Session's binding untouched; refused changes
never retry, while a mount fault the probe cannot reach (a stale export)
retries internally up to an 8-attempt budget and then fails the same type,
releasing the Session back to turns and lifecycle operations. Legacy Sessions answer `400 unsupported_feature`, an unreadable
actor `404 session_not_found` and a readable actor below OPERATOR `403
session_operation_forbidden`, matching the sibling lifecycle refusals; a
probe refusal the turn layer would share also uses `409
workspace_unavailable`, and so does an admitted OPERATOR once the
creator-keyed facts moved. The WebShell adapter offers the same flow as
`/api/agent/web-shell/v1/sessions/cwd/change` plus `/operations/query`.
Subsequent turns acquire a fresh Runtime Session and install the new context
before tools run, so an unverifiable change can never redirect tool execution.

Design:
[English](../../docs/design/2026-10-02-managed-workspace-w2-cwd-change.md) |
[简体中文](../../docs/design/2026-10-02-managed-workspace-w2-cwd-change.zh-CN.md).

### Broker deployment

The Broker starts before the first Hosted Harness connection, so the supported
startup order is Spring/Broker first, Hosted Harness second, traffic last. The
Harness SDK handshake is lazy and occurs on the first admitted Turn.

For the single-node local-process provisioner, also set:

```bash
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED='true'
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN='replace-me'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID='local-dev-v1'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY='replace-with-base64-encoded-32-byte-key'
export QWEN_MANAGED_AGENT_WORKSPACE_CWD='/absolute/authorized/workspace'
export QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY='/absolute/private/state'
export QWEN_MANAGED_AGENT_NODE_EXECUTABLE='/absolute/path/to/node'
export QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY='/absolute/path/to/dist/cli.js'
```

After a credential-key rotation, keep each prior key in
`previous-credential-keys` until no persisted Runtime binding references its
key ID. The brackets are not decoration: Spring's relaxed binder strips `/`,
`:` and spaces from plain map keys, so an unbracketed ID binds as a key that
matches no persisted row.

```yaml
qwen:
  managed-agent:
    runtime-broker:
      credential-key-id: local-dev-v2
      credential-key: replace-with-base64-encoded-32-byte-v2-key
      previous-credential-keys:
        '[local-dev-v1]': replace-with-base64-encoded-32-byte-v1-key
```

New credentials use only the active key; reads select the active or previous
key by the ID stored with the ciphertext, and an unavailable ID fails closed.
The YAML-only ring, the retirement query, the operator-recovery ring and the
single-key-pair CSI/migration entries are normative in [Rotate the Runtime credential key](../../docs/users/managed-agent-reference-deployment.md#rotate-the-runtime-credential-key),
with the rationale in the [rotation design](../../docs/design/2026-10-15-runtime-credential-key-rotation.md).

Two optional knobs change how the Broker listens and how long it waits for a
dispatched v3 execution's result:

```bash
# Default false: the Broker refuses to bind a non-loopback address. This face
# is plaintext HTTP with one global bearer token and no per-tenant
# authorization, so set it only behind a layer that terminates TLS and
# authorizes callers — restricting the network alone still puts that token on
# the wire, and whoever reads it owns every execution the Broker admits.
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK='false'
# Default 30m, minimum 1s: how long the Broker keeps polling the worker for
# a dispatched v3 execution's result. When the window lapses the execution
# is marked UNKNOWN instead of polling on, so a value shorter than your
# longest tool call degrades that call to UNKNOWN. A suffix-less number
# binds as seconds: startup refuses a value below the 1s floor but accepts
# a stale milliseconds-style override (1800000 becomes 1800000 seconds),
# so always write the suffix. Raising it above 30m buys nothing on the
# shipped path: the TypeScript client stops observing a v3 execution at
# its own fixed 30-minute deadline.
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_V3_RESULT_WINDOW='30m'
```

The same unit rule applies to every `qwen.managed-agent.*` duration setting: a
suffix-less number binds as seconds except for `runtime-broker.retention.max-age`,
which binds as days, and the millisecond-bound settings below.
Millisecond-bound settings — `auth.allowed-drift` (so
a stale `300000` keeps meaning five minutes instead of widening the
signature-replay window to ~83 hours), the sub-second `events.batch-interval`
and `events.materialize-interval`,
`runtime-broker.child-workspace-git-timeout`, `runtime-broker.retention.scan-delay`,
`automation.scan-delay`,
`automation.lease`, `automation.late-tolerance` and `automation.lookback`
— bind a suffix-less number as milliseconds. Always write the suffix (`90s`,
`500ms`). At startup the server reads each seconds-convention setting's
written value and warns on a bare integer — the shape of a stale
milliseconds-style override — naming what the number binds as now (seconds)
and what it would have bound before (milliseconds); a suffixed value never
warns. Cadences bound through `@Scheduled` placeholders —
`artifacts.projection-interval`, `channels.scan-delay`,
`child-relay.scan-delay`, `child-workspace.scan-delay`,
`dispatch.scan-delay`, `events.replay-floor-interval`,
`message-relay.scan-delay` and `wake-recovery.scan-delay` — also read a bare number as milliseconds,
and the startup warning cannot see them, so always write the suffix
there.

When `QWEN_MANAGED_AGENT_WORKSPACE_ID` is omitted, the server derives the same
16-character SHA-256 workspace ID that Qwen Code uses from the canonical
workspace path. An explicitly configured ID must match that value or startup
fails before traffic is accepted.

The Hosted file profile connects through the private Broker endpoint, which
defaults to `http://127.0.0.1:4182`. When enabled, the embedded
Broker always uses the Spring `DataSource` and Flyway-managed Runtime tables;
it does not fall back to in-memory repositories. The active credential key and
every configured previous key must decode to exactly 32 bytes and protect
persisted Runtime seeds and static Runtime credentials with AES-256-GCM. New
writes use only the active key; reads select the exact key ID stored with the
ciphertext. By default, local worker ownership is durable:
the Broker registers every launch and a restarted Broker adopts the same live
worker. This requires Linux and fails startup elsewhere; on such hosts set
`QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS=false` together with
`QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false` to keep
worker ownership ephemeral (a restarted Broker then cannot adopt it). The state directory
must be persistent local storage, owned by the Broker user with mode `0700`,
without symlinks, outside every configured Workspace root. The expected
owner is resolved from the process UID, so a numeric UID without a passwd
entry is fine. Workers and tools
must be trusted; same-UID hostile tools and multi-host or remote storage are
unsupported. Keep the host machine ID, SQL credential key, placement mapping,
state directory and worker command stable across Broker restarts. Shutdown and
late lease discard detach from registered workers instead of killing them.
`/etc/machine-id` must be nonempty and stable, and Linux must expose the PID
and time namespaces (`/proc/self/ns/pid` and `/proc/self/ns/time`; the latter
requires Linux 5.6 or newer with `CONFIG_TIME_NS`). An empty or malformed
identity fails startup the same way as an absent one, naming both opt-out
switches. The service
manager must let workers survive a Broker exit: systemd's default
`KillMode=control-group` kills them, as does restarting a container whose main
process is the Broker. Configure the service to leave child workers running
(for example, systemd `KillMode=process`) and use an init that reaps orphaned
processes. The Broker recognizes `Z`/`X` workers as exited even before they are
reaped.
Missing or damaged records and worker death do not authorize replacement;
worker death does not prove escaped writers stopped. No host reboot reclamation
is enabled by this option alone. Old v1 handles cannot be upgraded by guessing identity.
This option does not retire idle workers or prune their registration and lock
files. With session isolation, each Hosted Session can retain a separate idle
worker across Broker restarts; budget process, memory and state-directory growth
for it. Physical cleanup needs an evidence-preserving lifecycle;
do not delete records to reclaim capacity.
See the [adoption design](../../docs/design/2026-09-27-local-runtime-adoption.md).

Trusted same-host Linux reboot recovery is also on by default. It requires
durable local mode with the `local-process` provisioner, so a deployment that
opts out of durable local workers or uses another provisioner must set
`QWEN_MANAGED_AGENT_RUNTIME_TRUSTED_LOCAL_REBOOT_RECOVERY=false`. A changed kernel boot ID on the original machine can prove
that original local writers stopped; worker-only death still cannot. The
service scans eight saved bindings every five seconds, independently of current
Session grants, and clears only the original SQL holder after all execution
receipts become terminal. Recovery never starts a replacement worker or replays
an unknown execution. A later authorized request may create a new generation.
Keep the same Broker user, local disks, machine identity and SQL keys; remote
writers, restored/cloned snapshots and external jobs that recreate writers are
outside this contract. Where a matching boot identity cannot be trusted as stop
evidence, set the option to `false`. The
[reboot recovery design](../../docs/design/2026-09-28-local-reboot-recovery.md)
distinguishes portable test evidence from the dedicated Linux reboot acceptance
gate completed at W0e-3 head `8c2b626c`. A systemd soft reboot is not stop
proof because it does not change the kernel boot ID.

The Kubernetes adapter's real-cluster fault matrix remains a production gate. This
standalone reference keeps the one configured directory for legacy unbound
Sessions. Persisted bound Sessions use the private Workspace execution path
below.

Managed Server and Runtime Broker share the single versioned 32-table baseline in
[`src/main/resources/db/managed-schema/V1__managed_schema.sql`](src/main/resources/db/managed-schema/V1__managed_schema.sql).
The Server loads it through Flyway; Broker initialization reads the same resource.
Both refuse a legacy, partial, foreign, or history-only catalog before schema writes.
An already initialized complete baseline is structurally validated; a Broker-created
baseline may be registered by Flyway only after that validation. Schema initialization
does not repair or backfill old data.

Use a new MySQL 8.4/InnoDB database for the new environment. Quiesce old admissions
and settle in-flight work before cutover; retain the old environment/database for
historical reads. New Sessions belong to the new database, which must remain available
if routing is rolled back. The retired SQL/Java migration chain and upgrade tests are
[archived outside the runtime classpath](../../docs/archive/managed-agent-schema/README.md).
The former separate Broker `schema.sql` has been removed.

### Terminal Runtime record retention

Runtime JDBC retention is disabled by default. It removes old terminal
executions, Sessions and bindings in bounded batches on a dedicated scheduler;
it does not stop workers or delete Workspace files. Configure
`qwen.managed-agent.runtime-broker.retention` with these environment variables:

| Variable                                          | Default | Meaning                                                                                                                               |
| ------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `QWEN_MANAGED_AGENT_RUNTIME_RETENTION_ENABLED`    | `false` | Enable cleanup when the Runtime Broker is also enabled                                                                                |
| `QWEN_MANAGED_AGENT_RUNTIME_RETENTION_MAX_AGE`    | `30d`   | Minimum age of eligible terminal records; must be at least 1ms; unit-less values use days; explicit units such as `12h` are preserved |
| `QWEN_MANAGED_AGENT_RUNTIME_RETENTION_BATCH_SIZE` | `100`   | Per-tick bound on scanned bindings, scanned children and total deleted rows; 1–1000                                                   |
| `QWEN_MANAGED_AGENT_RUNTIME_RETENTION_SCAN_DELAY` | `1m`    | Positive delay between ticks, at least 1ms                                                                                            |

Recovery records, Workspace holders and CSI retirement keep their bindings.
Child Session lineage also keeps a binding until its canonical parent child_run
has a committed terminal projection; a missing projection remains protected.
This lets cascade and relay repair a stopped child's original Runtime identity.
Lineage and permanent relay classifications are never collected here.
A `:process` execution also keeps its whole binding family while its owning
Session has an unsettled background Shell child_run, including top-level
Sessions and Workspace isolation. This preserves the process-status evidence
used by Session-open never-started reconciliation until those Shell records
settle; the association conservatively protects the whole owning Session.
The lookup deduplicates owning Sessions by both raw value and binary identity
before checking their records on the sweep connection.
Publication and CSI ACK references keep the original execution and its parents,
including already collected publications; unreferenced siblings may be removed.
Nonterminal children, live operation/dispatch leases and managed bindings without
stop evidence remain retained. Binding slots and generation counters, placement
guards, harness drains and storage fences remain durable. Successful ticks log
scanned, skipped and deleted counts and duration; failures retry on the next tick.

Enabling retention allows eligible, unreferenced historical records to be deleted
once they age past `max-age`; it does not guarantee deletion by that age.
Publication and CSI ACK references retain executions and their parent sessions and
bindings regardless of age, including COLLECTED publications.
After cleanup, existing missing-record responses apply. Callers must not reuse
expired Runtime Session IDs or idempotency keys. Initialize a fresh database with
the single canonical 32-table V1 baseline and keep cleanup disabled. Legacy
catalogs are rejected; no in-place upgrade or old-data migration is provided.
Verify repeated initialization preserves terminal receipts, retain the old
environment for historical reads and settle its in-flight work before cutover.
Shared publication, CSI operation/work and Session record variants are checked
by their typed discriminators; their metadata and physical owner headers are
not collected. Every publication writer must use the locking protocol, and
retention stays disabled until the exact-identity Hosted cleanup
release-proof contract in [#13992](https://github.com/QwenLM/qwen-code/issues/13992)
is delivered and verified. An owed cleanup descriptor can outlive its RELEASED binding;
collection then makes the original release conflict and blocks the Hosted
Session. This PR does not implement that release-proof contract.
Disable retention before reverting to older writers;
disabling prevents future cleanup but cannot restore deleted records. See the
[retention design](../../docs/design/runtime-broker-jdbc-retention.md).

### Private Workspace tool execution (W0c-3)

The worker entry is the built CLI bundle; the server launches it with
`managed-runtime-worker`. Configure canonical existing roots using Spring
configuration (all Brokers sharing the database must use the same mappings):

```yaml
qwen:
  managed-agent:
    runtime-broker:
      workspace-mounts:
        - tenant-id: tenant-a
          storage-id: storage-a
          root: /absolute/canonical/workspace-a
```

An empty mapping list rejects bound Session execution. This path requires
`local-process` provisioning and `session` isolation. The Session must be
created through W0b with a Registry configuration reference of
`managed-runtime-tools/1` and policy reference of
`preapproved-workspace-tools/1`. The original creator must still have read and
create grants. Other frozen configuration pairs are refused.

The private Broker can acquire, execute Read/Write/Edit/foreground Shell, and
release these Sessions. One Runtime Session holds each tenant/storage pair
until the original worker closes its execution gate. Lost or ambiguous
responses retain the SQL holder; there is no timeout-based takeover. The
provider and file tools do not confine access to the mount root: Read/Write/Edit
and Shell can reach other paths allowed by the worker's host permissions.
Foreground Shell may create detached descendants. Use this only with trusted
local workloads. The W0e recovery above handles trusted host reboot; it
does not provide physical isolation or recovery after worker-only death.
Public bound Turn admission is limited to the initial Workspace Turn described
in G0 above (file tools, or mandatory-approval foreground Shell under the Shell
opt-in; the public Shell tool list does not include the child agent tool) and
later Turns submitted by any caller holding OPERATOR on the Workspace under the
same opt-in while the Session's creator-keyed execution facts hold (the WebShell
adapter's per-caller `workspaceTurns` capability flag mirrors that same rule;
the public surface publishes no such flag). Shell Sessions additionally require
the Shell opt-in and valid persisted approval for fresh sending; `workspaceTurns`
does not by itself admit a Shell Turn, which also requires `foregroundShell=true`.
Such a caller may also cancel the Session's running Turns and rename the Session.
Later Turns run under the creator's Workspace grants, so an actor without a read
grant keeps the existing `session_not_found` invisibility, a readable actor below
OPERATOR is refused `session_operation_forbidden`, and an admitted OPERATOR whose
Session lost the creator-keyed facts meets the family's domain
`workspace_unavailable`. Public Shell close, archive, unarchive and delete stay
unavailable, including protocol-0. Public close follows its separate close
capability and lifecycle admission. Archive, delete and unarchive follow their
separate retention capabilities after reliable Workspace close;
the Shell profile reaches public creation only through the deployment Shell
opt-in described above; callers cannot select it.
See the bilingual [execution design](../../docs/design/2026-09-26-managed-workspace-execution.md)
for the exact boundary.

Hosted files/Shell file history additionally requires persistent worker backup
storage. Configure an absolute `QWEN_HOME` in the Broker/worker environment and
mount it as durable storage writable by the worker OS user. Backups are stored
at `$QWEN_HOME/file-history/<Harness Session ID>/`; without the override they
use the worker user's `~/.qwen/file-history/`. Preserve this directory alongside
the Workspace and SQL database. A Workspace mount alone does not preserve these
backup bytes, and referenced backups must survive worker/container restarts.
The stock image runs as UID 10001; derived images must provision appropriate
write access for their worker user.

Roll out the Broker and worker bundle before the Hosted Harness. An older
Broker rejects raw-history control, including the bind before a read-only tool
turn. The Harness releases a definite rejected bind and ends the turn with an
error; it does not run unbacked writes. Missing backups also refuse tool turns
until the original backup data is restored. Unknown or partial effects still
require operator recovery. See the bilingual
[file-history design](../../docs/design/2026-09-30-hosted-file-history.md)
for record capacity and rewind semantics.

### Verified original-mount recovery (W1a)

The current fresh 32-table baseline requires this physical mount guard for LOCAL tool and child Git execution in a trusted, single-host OpenJDK 21 `local-process` deployment on Linux or macOS with a persistent, unambiguous root birth time. Enable `QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED=true` and complete offline registration before admitting that work. Text-only Turns can run without registration; LOCAL tool acquisition fails with `409 workspace_unavailable` when the physical mapping is absent. Taking the next tool Turn after a Broker restart also requires `durable-local-process=true`. macOS requires `trusted-local-reboot-recovery=false` and supports same-boot adoption only. Linux whole-host restart succeeds only while the registered physical identity still matches. The shared V1 baseline stores registration, independent `mount_birth_time` and mount fence in `ma_storage` and `ma_storage_owner`. An unregistered mount is never registered from the directory found at startup.

Marker v2 stores birth time as a canonical `Instant` string. Linux reads creation time, mtime, device and inode in one JDK `unix` attribute snapshot and rejects creation time at/before epoch or equal to mtime, which OpenJDK 21 may return when birth time is unsupported. A real Linux birth time equal to mtime is also conservatively refused; prepare the project layout or update the root's mtime offline before retrying. macOS reads native nanosecond birth time with `stat` and cross-checks its device/inode against the JDK canonical-directory snapshot, because JDK 21 truncates macOS birth time to seconds. A positive native macOS birth time is independent even when it equals mtime; fresh empty roots keep their original birth time. Mtime is not an identity field, and ordinary mtime changes do not invalidate an unchanged birth time. The marker contains an application-specific HMAC-SHA256 host ID with `Qwen-Code/verified-workspace/v2` as input. Its key is the trimmed machine-id UTF-8 bytes on Linux or the original `IOPlatformUUID` UTF-8 bytes on macOS; neither raw identity is stored in the marker.

Keep the storage root outside **every Git worktree**, with Session cwd in a child project directory. `.qwen-managed-storage.json` is an administrator maintenance file: do not read/write it through model tools or subject it to Git cleanup/stash. Tools are not confined by this layout. Missing or conflicting markers close admission; completed registrations never automatically republish them, including on a same-UUID retry. Marker repair needs a separate design.

The retired V1–V68 migration chain and marker v1 are historical formats. This application initializes a new database with the shared V1 baseline and marker v2; it does not upgrade or migrate an existing database. Preserve old deployments and their data for historical access. Do not attach this binary to an old catalog or bypass refusal with Flyway `repair`, `outOfOrder` or manual history edits.

Stop all processes and external jobs that can write the storage, account for
old Runtime holders and verify the original root before registration. Initialize
the new database with the canonical V1 baseline, then run the private maintenance entry from this module on
the same execution host. Give a stable canonical lowercase, hyphenated 36-character UUID to each operation and reuse it after a
crash. Database credentials come from `W1_JDBC_URL`, `W1_JDBC_USER` and
`W1_JDBC_PASSWORD` environment variables:

```bash
mvn -q -DskipTests compile exec:java \
  -Dexec.mainClass=com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageRegistrationMain \
  -Dexec.args='register tenant-a storage-a /absolute/canonical/workspace-a <operation-uuid> --offline-confirmed'
```

The same entry is available from a shipped Spring Boot fat jar, without the source checkout or Maven:

```bash
java -cp /path/to/app.jar \
  -Dloader.main=com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageRegistrationMain \
  org.springframework.boot.loader.launch.PropertiesLauncher \
  register tenant-a storage-a /absolute/canonical/workspace-a '<operation-uuid>' --offline-confirmed
```

`inspect <tenant> <storage> <canonical-root>` is read-only. The same entry also
accepts `fence` or `restore-original` with a mount revision and the exact
operation UUID; both require `--offline-confirmed`. A fence has no timeout and requires every holder field to be clear after exact-owner cleanup. Entering a new fence and restoring both require the intact registered root identity and marker. W1 cannot force-fence, re-register or repair a changed identity or missing marker; admission stays closed until the verified original mapping is re-presented, or a separately designed offline repair is performed. Stop new admissions, settle or cancel original executions, prove writers stopped, release holders and stop service/external writer processes before fencing.
`restore-original` only reopens the still-verified original mapping after its
holder is clear. Both commands accept retries with the same operation UUID;
restoring increments the mount revision, so a delayed old fence cannot reopen
maintenance. Completed registration and restore retries revalidate identity and marker; concurrent same-operation retries do not advance the revision twice. Inspect reports state, revision, active/completed operation, holder and independent identity/marker status, including while fenced. The flag records the operator's offline check; the program
cannot stop arbitrary processes or external writers itself. Do not use it on
a live shared storage.

After registration, enable
`QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED=true` on the
whole new deployment before admission. On each new attachment, model submission, Runtime
claim and execute, the server compares the configured canonical root against
the SQL registration, Linux host/device/inode/birth-time identity and the root marker.
A missing or conflicting marker, replacement root, missing saved cwd or fenced
storage blocks new work; original execution status/cancel and authorized
history remain on their saved identities. The marker is a continuity check,
not a backup or protection against a malicious same-UID writer. See the
[W1 design](../../docs/design/2026-09-29-managed-workspace-w1-recovery.md).
Hosted Workspace cold-load validation is always enabled, independently of the Java mount-guard option. Omitted tool profile and Shell `captureBytes` use the saved definition; supplied values must match exactly. Saved approval settings remain pinned. Integrity checks run before new model work or Broker prepare/execute and cover retained private resources plus complete remote Shell output, including pages, segments and empty-stream seals. Preserve O2 recovery of original `results_ready`, consumed-final and `not_started` receipts. An incomplete receipt may produce a blocked ACK or original-history repair before load is refused, so refusal does not promise zero journal writes or ACKs. Restore validation uses a fixed committed cut, and continuation still requires current writer ownership and authorization. Missing old resources or unsupported recovery domains block loading. Passive Harness loading does not implement unknown-execution cleanup; use original Broker execution identities. Rollback to old binaries requires entry points to remain stopped because those binaries ignore the fence columns. Public
Workspace next-turn admission for any caller holding OPERATOR on the bound
Workspace, while the Session's creator-keyed execution facts hold, under the G0 opt-in
described above has landed; public Workspace resume still requires
product-route integration, and this internal guard is not a public resume
capability yet.

Build the container from the repository root:

```bash
docker build -f packages/managed-agent-server/Dockerfile .
```

The stock image contains the Java control plane only. Use the static Runtime
provisioner, or provide a derived image/mount with Node.js and the Qwen worker
artifacts, before enabling the local-process provisioner in a container.

The image keeps the application's `127.0.0.1` defaults, so a plain
`docker run -p 8080:8080` publishes nothing: `-p` DNATs to the container's
bridge IP, and a loopback listener is unreachable through it. Publishing is
an explicit opt-in, and the server refuses a non-loopback bind under the
shipped `auto` auth mode, so the command must name an authentication
posture — signed mode, as the introduction recommends (see "Broker
authentication and writer credentials" above). The signing key and the
datasource password are passed valueless so Docker forwards them from the
shell environment — the `=` spelling would leave either secret in the
command's argv for the container's whole lifetime. A valueless `-e`
forwards the variable of the same name, so export
`QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY` and `SPRING_DATASOURCE_PASSWORD` before
the run. The datasource must also be
named: the Prerequisites' `127.0.0.1` default is the container itself from
inside, so the image cannot boot against it:

```bash
docker run -p 8080:8080 \
  -e QWEN_MANAGED_AGENT_SERVER_ADDRESS=0.0.0.0 \
  -e QWEN_MANAGED_AGENT_AUTH_MODE=signed \
  -e QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY \
  -e SPRING_DATASOURCE_URL='jdbc:mysql://<db-host>:3306/qwen_managed_agent' \
  -e SPRING_DATASOURCE_USERNAME='qwen' \
  -e SPRING_DATASOURCE_PASSWORD \
  <image>
```

or the deliberately unauthenticated
`-e QWEN_MANAGED_AGENT_AUTH_ALLOW_INSECURE_BIND=true` override.

The `qwen` user the recipe names needs the grants from the Full WebShell
entry's MySQL one-liner — including `SELECT` on
`performance_schema.user_variables_by_thread`, granted at the
container-visible host — or Flyway's boot probe is denied (`ERROR 1142`)
and startup stops.

Publishing the API needs no Runtime Broker face: the broker ships disabled
by default, and a non-loopback broker bind is a separate opt-in — the broker
refuses one unless `QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK=true`
is also set (see Broker deployment above).

The opt-in makes the authentication consequence load-bearing. Under the
shipped default — `auto` resolving to `open` — there is no HTTP
authentication: tenancy is whatever `X-Qwen-Tenant-Id` says. Signed mode
HMAC-authenticates every request's tenant and actor headers; the
insecure-bind override publishes with request authentication off. Either way the tenant-scoped API is
exposed to anything that can route to the listener. That exposure does
not depend on publishing a port: on the default bridge network the API
also answers on the container's own bridge address, so every process on
the Docker host and every peer container on that bridge can reach it
with no `-p` at all. Run a published deployment behind an ingress that
authenticates the tenant before setting `X-Qwen-Tenant-Id`, map ports
only inside your own network policy, and attach the container only to
networks whose peers you trust.

## Managed Session Store verification

Unit and H2 contract tests run with the normal Maven test phase. `mvn verify`
additionally runs the SpotBugs high-confidence gate (Maven 3.8.9+): a new
warning fails the build, and a false positive goes into
`spotbugs-excludes.xml` with a justification in the PR. To run the static
gates without the test suite, use `mvn verify -DskipTests` — it also runs
Checkstyle and the Spring Boot repackage, and the full suite includes
environment-sensitive timing tests that can fail on a local machine, so CI is
the arbiter; for SpotBugs alone, run `mvn compile spotbugs:check`. The
optional real-MySQL profile also verifies schema upgrade,
exact bytes, public Item/Snapshot projection, and the independent-JVM Managed
Session Store crash/takeover path:

```bash
mvn -Pmysql-integration \
  -Dmysql.url='jdbc:mysql://127.0.0.1:3306/managed_agent_test' \
  -Dmysql.user=root \
  -Dmysql.password= \
  verify
```

Use a disposable database: the integration test creates and deletes fixture
rows within the selected schema.

## Linux extension process acceptance

`HostedExtensionsIT` is collected by the existing `hosted-harness-mysql` profile. It uses the public AgentDefinition and Session APIs, real MySQL, the packaged Harness and durable native worker, a stdio MCP process, and command Hooks in a delegated cgroup v2 subtree. It verifies static Skill bytes, extension revision pinning across Harness replacement, Hook allow/deny, cancellation of a Hook and its descendant, safe continuation, and physical close. A separate MCP fault case writes and fsyncs an effect before disconnecting, then verifies that a replacement Harness refuses recovery without replaying the effect or reporting successful close.

After building the root packages and bundle and installing the current Java SDK, run this focused slice from `packages/managed-agent-server` on Linux with JDK 21, Node 22+, disposable MySQL 8.4, and Maven already inside the delegated cgroup ancestor:

```bash
QWEN_MANAGED_HOOK_CGROUP_ROOT=/sys/fs/cgroup/your-delegated-root \
  mvn -Phosted-harness-mysql -Dit.test=HostedExtensionsIT \
  -Dnode.executable=/absolute/path/to/node \
  -Dqwen.cli.entry="$PWD/../../dist/cli.js" \
  -Dmysql.url='jdbc:mysql://127.0.0.1:3306/managed_agent_test' \
  -Dmysql.user=root -Dmysql.password= verify
```

Missing Linux/MySQL/cgroup prerequisites are not acceptance. This selector verifies only the extension class; it does not establish that the complete Hosted profile passed. Evidence is saved before forced fixture teardown under `target/failsafe-reports/hosted-extension-evidence/` and is included in the existing CI report upload. The interrupted MCP case leaves its public Turn `RUNNING`, its ordinary execution `UNKNOWN`, and rejects new input and close with `409 turn_active`; successful cleanup is established by the separate healthy-close case. This gate uses a controlled loopback model and local stdio transport, so it does not establish upstream-model, remote transport, reboot, cross-machine, SSH MCP/Hook, or production acceptance. See the complete [English design](../../docs/design/2026-10-16-managed-extension-acceptance.md) and [Chinese design](../../docs/design/2026-10-16-managed-extension-acceptance.zh-CN.md).

## Real-model end-to-end check

The full-chain script starts Spring with its embedded Runtime Broker and runs
both the Hosted Harness and the worker from the packaged `dist/cli.js`: the
Harness as `node dist/cli.js serve --profile hosted-harness`, and each worker,
launched by the Broker, as `node dist/cli.js managed-runtime-worker`. No
separate worker bundle exists. The G0 integration test
(`HostedPublicWorkspaceIT`) uses the same packaged `dist/cli.js`.

The real-model run below creates its Session through the public route as a
Workspace-bound G0 Session, and proves the physical tool execution through
the durable `ma_tool_execution` record (exactly one `SETTLED` row). Hosted
tool intent and receipt events also expose tool names and lifecycle status
through public `item.tool_call.updated` events without O2 publication. Raw
arguments and output remain behind the existing publication policy. The
Hosted model loop follows `model.maxSessionTurns` (default `-1`); it no
longer imposes a separate 16-round limit. See the
[progress design](../../docs/design/2026-10-16-managed-webshell-progress.md).
The run needs live model credentials,
so no CI job executes it; it has been run locally as evidence (macOS,
qwen3.8-max), and a green CI run therefore says nothing about this mode. The
script also needs `java`, `mysqld`, `mysql` and `mysqladmin` on `PATH`; it
starts its own temporary MySQL server and exits before starting anything else
when a command or a required file is missing.

Build the required artifacts first, then run (the Maven steps need Maven
3.8.9+ — the SpotBugs gate rides the `verify` phase that `install` traverses):

```bash
npm run build && npm run bundle
mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
mvn -f packages/managed-agent-server/pom.xml clean package
npm run test:e2e:managed-agent-server -- --model moonshot/kimi-k3
```

For the deterministic durable-owner failover check, use the same built
artifacts and run:

```bash
npm run test:e2e:managed-session-failover
```

This mode uses a local fake model, completes one Turn, kills the Spring and
Hosted Harness process trees, deletes their old local homes, starts replacement
owners against the same MySQL store, and verifies that the second Turn sees the
first Turn's prompt and answer.

The in-flight and continuation variants run the same replacement-owner proof
through a physical Workspace file tool execution. The runner configures the
G0 public Workspace admission for every mode — it seeds the Workspace
registry and access grant as deployment data, enables the G0 file admission,
and uses `QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER` for its local actor — and
the real-model check and both tool-driven variants create their Sessions
through the public route as Workspace-bound Sessions, while
`--session-failover` deliberately stays unbound to exercise the plain
durable-owner takeover:

```bash
npm run test:e2e:managed-inflight-failover
npm run test:e2e:managed-continuation-failover
```

Both modes require Linux: the replacement owner retires the dead worker's
Runtime binding through the durable local-Worker reclaim (#12380 W0e), which
runs on Linux only. The runner enables `durable-local-process` for these modes
and refuses other platforms with an explicit error; the Hosted failover E2E
CI job runs both.

The in-flight mode holds the first Broker `:start` request after the Harness
has durably committed its `await_runtime` checkpoint, kills the original
Spring and Hosted Harness process trees, deletes their homes, and starts
replacement owners. It requires the replacement Harness to use the original
`executionCallId`, execute the physical tool exactly once, continue the
original Prompt without replay, and commit one public terminal event. The
continuation mode kills the Harness after the first published text chunk and
requires one tool execution, one further continuation, only the replacement's
answer in the public transcript, and one terminal event. Both modes run in the
Hosted failover E2E CI job.

The G3 arms replace owners without an operator choosing the next one. With
`--harness-only`, the Spring control plane stays alive and only the Hosted
Harness is killed, so the live control plane must adopt the next Harness
generation:

```bash
npm run test:e2e:managed-harness-restart-failover
npm run test:e2e:managed-harness-restart-inflight-failover
npm run test:e2e:managed-harness-restart-continuation-failover
npm run test:e2e:managed-harness-restart-model-round-failover
```

The model-round arm creates a Session with no Workspace, publishes a prefix
from its first model round, and kills the Harness twice. Each replacement must
reissue the same saved model request and retract the prefix before its own
text appears. The arm then requires one terminal event, only the final answer
in the public transcript, no tool execution, and a next Turn whose model
history holds one copy of the prompt and answer and none of the prefixes.

The Step 3 packaged gates take over a parked native-file approval or model
continuation through a Harness-only replacement. Each keeps the original
identities (the Action for the approval gates, the Runtime binding and the
prepared or settled execution), confirms the original Runtime cleanup,
completes a next Turn, and closes the Session:

```bash
npm run test:e2e:managed-harness-restart-approval-allow
npm run test:e2e:managed-harness-restart-approval-deny
npm run test:e2e:managed-harness-restart-approval-cancel
npm run test:e2e:managed-harness-restart-approval-expiry
npm run test:e2e:managed-harness-restart-continuation-closeout
```

Four additional arms layer one fault on the Allow path (#14481 step 2). The
first crashes the replacement Harness as soon as the decision is durably
recorded; the second holds the Runtime Broker's execution `:start` so the
crash lands after the `PREPARED` row and before the physical dispatch. Both
leave the original Action, prepare key, digest and Runtime identity in place,
start a third Harness generation, and require exactly one settled execution,
one file effect and one terminal. The other two drop the control plane's
reply after it committed; the retry under the same `Idempotency-Key` must
land on the original record, so a lost decision produces one
`ACTION_RESPONSE` operation and a lost Turn admission produces one Turn row:

```bash
npm run test:e2e:managed-harness-restart-approval-after-decision
npm run test:e2e:managed-harness-restart-approval-after-prepare
npm run test:e2e:managed-harness-restart-approval-decision-reply-lost
npm run test:e2e:managed-harness-restart-approval-admission-reply-lost
```

They write their evidence under `.qwen/investigations/g3-step3-implementation/`;
`G3_VERIFY_REPORT_DIR` overrides the directory. The approval path still has no
packaged arm for a lost load reply, a failed cleanup followed by another
crash, a committed terminal that was not delivered, a payable checkpoint
whose terminal write is missing, or a crash after the approved result
commits; those rows stay focused or integration tested (#14481).

Two arms keep a former owner alive while its replacement finishes the Turn
and then wake it with `SIGCONT`:

```bash
npm run test:e2e:managed-continuation-frozen-owner-failover
npm run test:e2e:managed-frozen-control-plane-failover
```

The first freezes the original Harness, so it covers the journal: the woken
writer commits nothing. The second freezes the original Spring and Harness
together during a no-tool model round. It starts a second Spring and Harness
on the same MySQL, and the new Harness reissues the round to completion.
After the wake, the MySQL general log must show the former Spring's claim
`UPDATE`s carrying its stale owner id, and the former Harness must log the
store's refusal of its stale writer grant. None of these attempts may change
the Session binding, the Turn row, the public events or the journal, as far as
the snapshot listed in D11 of the replaceable-Harness design can see. All of
these arms are steps of the Hosted failover E2E CI job (`hosted-failover-e2e`),
which runs daily or on demand. It builds the CLI and packages the server
itself, so a failing test in the Hosted MySQL job does not skip the arms, and
each arm runs even when an earlier one failed.

### Hosted recovery scope

The [SQL wake scan](#wake-recovery-after-harness-loss) has separate local
macOS/MySQL 8.4 evidence; it does not yet have Linux/Windows, real-MQ or deployed
provider acceptance. The scope below does not extend those claims.

The first Hosted release supports recovery for one Java control-plane instance
on one trusted Linux host. That control plane replaces reachable Hosted Harness
process generations one after another, and a Runtime Session stays exclusive
to its Session. Recovery covers only the profiles and parked states that are
explicitly supported and accepted on the released artifacts. The gates above
accept the in-flight and continuation Runtime takeovers, the native-file
approval waits and the first model round of a no-tool Session, all without
Hooks or MCP. An in-flight Shell call and unknown external effects stay
blocked rather than replayed, and Step 3 neither reissues a model round nor
resumes an approval in a Session with Hooks or MCP. Journal writer fencing,
durable engine ownership, capability and journal-contract checks and
fail-closed recovery apply throughout. A refused recovery is never replayed
through another Runtime or the Legacy engine.

The frozen control-plane arm shows that a woken former control plane's stale
claim is refused and changes nothing, and a store test pins the bind guards
that claim never reaches. Neither makes two live control planes a supported
deployment. Routing between them is out of scope: a new Turn could
be claimed by either one. Cross-host takeover, physical-ownership handoff
between hosts, real providers and mixed-version clusters still need their own
acceptance before they are supported.

The `--big-output` long-answer mode is also Workspace-bound:

```bash
npm run test:e2e:managed-big-output
```

It streams a long answer, verifies the complete public text and stored record,
deletes the original Harness and Runtime homes, and checks the complete answer
in a cold replacement's model context. A short answer remains inline. This
mode executes no tools and has no Runtime binding to reclaim, so it keeps
`durable-local-process` disabled and does not require Linux.

A zero-delay run checks the real-model path as shown above; a controlled
cold-start delay additionally tests output before Runtime readiness:

```bash
npm run test:e2e:managed-agent-server -- \
  --model moonshot/kimi-k3 \
  --runtime-delay-ms 45000
```

That run additionally requires the first model event to precede Runtime
readiness whenever the delay reaches the 15 seconds the acceptance criterion
names. A deterministic controlled-model proof of the same ordering is tracked
in #12941.

The real-model check extracts only the selected model provider, its referenced
environment credential, the selected model, and the authentication policy
from the supplied settings file into a private temporary Qwen home. It does
not copy hooks, MCP servers, extensions, tools, permissions, or other provider
credentials. The runner removes that file, the MySQL data directory,
workspaces, and child processes on exit. Override the source with
`--settings /path/to/settings.json`; credentials are never printed by the
runner.

### W1c offline Workspace migration

See the [English design](../../docs/design/workspace-storage-migration.md) and [Chinese design](../../docs/design/workspace-storage-migration.zh-CN.md). Run only after every service is upgraded, admission/dispatch is disabled, accepted work is settled, Harness writers are stopped, and automatic restart is disabled. The source remains accessible on the same trusted Linux host. Export the original canonical absolute `QWEN_HOME` in the private maintenance and registration commands as well as the Broker/Harness environment, with no symlink components. `fileHistoryRoot` must equal the canonical `$QWEN_HOME/file-history` directory. Preserve that home and its independent history volume; do not move it with the Workspace.

W1c adds Flyway V48–V50 after main's V47 channel-persistence migration, preserving all published migration bytes and applied history. Databases using earlier unpublished W1c migration numbers require fresh disposable fixtures; do not repair production Flyway history to reuse them.

The private artifact is `qwen-managed-agent-server-0.1.0-alpha-workspace-migration.jar`. Set `W1_JDBC_URL`, `W1_JDBC_USER`, `W1_JDBC_PASSWORD`, `W1_RUNTIME_CREDENTIAL_KEY_ID`, and `W1_RUNTIME_CREDENTIAL_KEY` to the original deployment database and Broker credential key. The full request file contains `version` (the JSON integer `1`), `migrationOperationId`, `tenantId`, `storageId`, `fenceOperationId`, `captureOperationId`, `mountRevision`, `sourceRoot`, `targetRoot`, `bundleRoot`, `fileHistoryRoot`, `stateDirectory`, `nodeExecutable`, and `cliEntry`. Fence admission is storage-scoped for bound Sessions; unbound legacy Sessions are outside that ownership. Metadata transactions share the tenant placement lock, so other storages of the same tenant may wait until those transactions finish; file scans and physical retirement hold no such lock. Paths must be canonical absolute deployment paths; roots and the durable Runtime state directory cannot overlap. IDs must be distinct UUIDs. Keep this exact request file for retries.

Before starting a new operation, the original Runtime state directory and retained history directory must exist at canonical paths, and the unchanged Linux identity reader must prove the history volume, including unambiguous birth time. Run maintenance as the original service user; the Runtime state directory must belong to that UID with exact POSIX `0700` permissions, checked by the same durable provider validator without creating or changing it. Failure returns `migration_state_unavailable` or `migration_history_unverified` before creating a migration row/fence or retiring placements. The target copy is still prepared after retirement. Run `java -jar <migration.jar> retire <request.json> --offline-confirmed` first. Then use the existing registration command to fence the original revision with the request's fence ID, and capture the W1b bundle with the request's capture ID. Prepare the target Workspace through the external offline copy procedure, preserving modes and the copied source marker. Run `prepare` and then `promote` with the same arguments. The first `prepare` and every new `promote` attempt verify sealed content, live source, target, retained history and original physical identities. Replaying `prepare` after PREPARED or any completed operation returns the saved receipt without rescanning; use `promote` for fresh transition verification. `inspect <request.json>` reads progress and the original receipt. `abort <request.json> --offline-confirmed` requires all placements retired and W1a still fenced; it does not restart anything or remove target artifacts. After abort or invalidation, prepare a fresh external target copy matching the new capture before starting a new operation; foreign marker or temporary files are rejected.

If the original history root has birth time equal to mtime, including when the first Session backup creates it, preflight conservatively returns `migration_history_unverified`. With all writers stopped, confirm the filesystem exposes a genuine persistent birth time, then update only the original history directory's mtime as the service user and retry `retire` with the same request:

```bash
touch -m -- "$QWEN_HOME/file-history"
```

Do not recreate or move the directory, change `QWEN_HOME`, or modify retained backups. Mtime is not an identity field; the root's device, inode and birth time must remain unchanged. A filesystem without a provable birth time remains unsupported after `touch`.

Promotion increments mount revision once. Successful `prepare` and `promote` commits clear the migration's previous error code. Update the deployment's Workspace root and restart Broker/Harness with the original QWEN_HOME before opening admission. An old deployment mapping fails closed. New file Turns and undo use fresh Runtime identities. Source rows, messages, journal, keys and backup names remain unchanged. Failure preserves the fence; missing stop proof, unsupported profiles or drift require diagnosis. Reverse migration is a new verified operation at a higher revision.

The target marker is the sole manifest exception and must match the copied source marker or the exact operation-pinned target marker. Do not hand-edit it. No online drain, directory copying, public migration route, Shell/MCP/Hook migration or source-lost recovery is provided. Uninitialized retained members without a verifiable frozen private definition are refused. Production Linux/MySQL acceptance evidence must be recorded separately from injected-identity tests.

### Stored agent execution

Sessions pin a stored AgentDefinition revision and digest at admission. `permission_policy` and `tools` select the Session's immutable approval mode and hosted tool profile. `model` accepts `{}` or `{ "id": "configured-model" }`; `instructions` accepts UTF-8 text up to 64 KiB. Static Skills and administrator-provisioned MCP/Hook pins are supported as described below. Environment templates and per-definition approval timeouts remain unsupported and are refused explicitly.

Set `QWEN_MANAGED_AGENT_DEFINITION_MODELS` to comma-separated IDs configured in the Harness's deployment `modelProviders`; it defaults to empty. Each ID must resolve to one configured provider route with deployment credentials. An absent or ambiguous route or unresolved credentials fails the Turn with `model_unavailable` before inference. Credentials never belong in definitions. Enable and configure the Managed Session Store for stored-definition execution; instructions are delivered as digest-addressed resource references and verified on load.

`QWEN_MANAGED_AGENT_DEFINITION_TOOL_PROFILES` defaults to `hosted-workspace-files/1`. Before opting into `hosted-workspace-files/2`, drain old workers and upgrade every provisioner according to #13166. Empty permission policies inherit the deployment approval mode (default `yolo`); use `default` for deployments that require approval.

`skills` accepts up to 16 static `{ "name": "review", "description": "Review changes", "body": "Read the diff and report concrete defects.", "base_directory": ".qwen/skills/review" }` entries for a Workspace-bound tool profile. `base_directory` is optional and defaults to `.`; it is a canonical POSIX path relative to the Session's working directory, matching Runtime `read_file` and `glob`, never the Harness host. Absolute paths, traversal, empty or dot components, colons, backslashes and control characters are rejected. Names are unique and use letters, numbers, `_`, `:`, `.`, or `-` (at most 128 UTF-8 bytes); descriptions are nonblank and at most 4096 UTF-8 bytes, bodies are nonblank and at most 32768 bytes, directories are at most 4096 bytes, and the compact JSON catalog is at most 48 KiB. Invalid Unicode and extra Skill fields are rejected. Bodies grant no tool permissions and cannot register Hooks, override the model, or discover host-installed skills. The connector publishes the catalog as a digest-addressed `managed-agent-skills` resource; a replacement Harness validates and reads the original reference.

`mcp_servers` accepts up to 16 unique `{ "server_id": "docs", "server_revision": 1, "definition_digest": "<64 lowercase hex characters>" }` pins. Select `tools: [{ "type": "hosted_profile", "profile": "hosted-workspace-mcp/1" }]` and explicitly add that profile to `QWEN_MANAGED_AGENT_DEFINITION_TOOL_PROFILES`; an MCP profile without pins or pins with another profile are refused. The Runtime deployment owns the matching server manifest, endpoints, transport and credentials. `hook_catalog` similarly accepts `{ "catalog_id": "review", "catalog_revision": 1, "definition_digest": "<64 lowercase hex characters>" }` for any Workspace-bound tool profile, selecting a Runtime-provisioned Hook catalog. Revisions are positive JavaScript-safe integers. Neither field accepts executable recipes or credentials. Create/update continues to store future configuration shapes without interpreting them; the limits and supported shapes above are enforced at Session admission. An old definition containing an unsupported shape remains rejected there.

Roll out the compatible Runtime manifest, Broker and Hosted Harness before admitting configured Sessions. Set the Harness `QWEN_HOSTED_LIFECYCLE_V2_PROFILES` to include `hosted-workspace-mcp/1` before relying on MCP public close/delete, and preserve reliable Runtime stop support; configuration admission does not bypass these existing lifecycle gates. MCP/Hook load requests carry pins from the original admitted AgentDefinition revision, and Skills use the saved resource reference. Updating a definition affects new Sessions only. Unknown execution outcomes continue to require reconciliation of the original Runtime operation. Missing, corrupt or conflicting resources fail loading explicitly. Existing Sessions without extension fields keep their prior behavior for non-MCP profiles. The MCP profile requires nonempty server pins during create and attach/load validation. Older storage admission could retain an empty-pin MCP profile even though Hosted attachment already rejected it; audit stored definitions and Sessions before rollout rather than assuming none exist. Retain historical access separately and settle or close affected Sessions on the previous deployment before replacement. Publish a corrected definition revision for new Sessions; existing Session pins are not rewritten.
