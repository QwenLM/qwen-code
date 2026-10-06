# Qwen Managed Agent Server

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

设计说明：[English](../../../docs/design/2026-09-19-managed-agent-spring-server.md) |
[简体中文](../../../docs/design/2026-09-19-managed-agent-spring-server.zh-CN.md)

## Integration status

The Hosted path supports durable no-tool Sessions and private Workspace tool
profiles. G0 adds opt-in public creation with an initial file-tool Turn through
the production Broker. This is not complete Workspace lifecycle, in-flight
recovery or distributed provisioning support. See the G0 section below for its
exact deployment and admission boundary, and the historical
[review corrections](../../../docs/design/2026-09-25-managed-agent-review-corrections.md)
for the original split's merge gates; earlier preview timing and recovery
results below do not establish completion of later slices.

## API contract

`src/main/resources/openapi/managed-agent-public-api.openapi.json` is the
single source for the public and WebShell routes. `ManagedAgentApiContractTest`
compares the mapped routes, the `ApiModels` records and real responses with it;
`src/test/resources/openapi/contract-known-gaps.txt` lists the differences that
a later slice still has to close; none remain after D4. The WebShell client types are generated from the
same file by `npm run generate:managed-agent-api` in `packages/web-shell`.
Sessions record the agent revision from `QWEN_MANAGED_AGENT_REVISION` (default
`1`) when they are created. `POST /v1/agents`, `GET /v1/agents/{id}` and
`POST /v1/agents/{id}` store tenant-scoped, immutable AgentDefinition
revisions; Sessions do not use them yet. Every response carries `X-Request-Id`, which error
envelopes repeat as `request_id` and the logs print. Events keep the schema and
projection versions they were accepted with. They keep their Item and Part
identity too, except after Harness recovery retracts output: the retracted
deltas lose their text and identity, later deltas may name other Parts, and a
`stream.reconciled` event announces it. A client that sees one reloads the
Items and resumes after their `snapshot_through_sequence`. A
cursor below a Session's replay floor gets `409 cursor_expired` from the JSON
event query and one `agent.session.resync_required` frame from either stream.
`GET /v1/agents/sessions/{id}/turns` lists a Session's Turns newest first with
an opaque cursor, and `GET /v1/agents/sessions/{id}/turns/{turnId}` reads one.
Design: [English](../../../docs/design/2026-09-27-managed-agent-api-contract.md) |
[简体中文](../../../docs/design/2026-09-27-managed-agent-api-contract.zh-CN.md);
Session query: [English](../../../docs/design/2026-09-27-managed-agent-session-query.md) |
[简体中文](../../../docs/design/2026-09-27-managed-agent-session-query.zh-CN.md);
Event replay: [English](../../../docs/design/2026-09-27-managed-agent-event-replay.md) |
[简体中文](../../../docs/design/2026-09-27-managed-agent-event-replay.zh-CN.md);
Durable lifecycle: [English](../../../docs/design/2026-09-28-managed-agent-durable-lifecycle.md) |
[简体中文](../../../docs/design/2026-09-28-managed-agent-durable-lifecycle.zh-CN.md);
Turn queries: [English](../../../docs/design/2026-09-28-managed-agent-turn-queries.md) |
[简体中文](../../../docs/design/2026-09-28-managed-agent-turn-queries.zh-CN.md);
Actions (Hosted permission approvals): [English](../../../docs/design/2026-09-30-managed-agent-actions.md) |
[简体中文](../../../docs/design/2026-09-30-managed-agent-actions.zh-CN.md);
AgentDefinition revisions: [English](../../../docs/design/2026-10-01-managed-agent-definitions.md) |
[简体中文](../../../docs/design/2026-10-01-managed-agent-definitions.zh-CN.md)

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
[query-amplification design](../../../docs/design/2026-10-02-managed-agent-query-amplification.md)
§9).
Original reads are capped at 1 MiB per Range request; full downloads use
bounded segment buffers and stream with backpressure. Deployments must retain
O2 roots and validate real OSS and slow-reader limits before enabling this
feature. O3 does not enable public Shell execution or garbage collection.

Design: [English](../../../docs/design/2026-09-29-managed-tool-result-public-projection.md) |
[简体中文](../../../docs/design/2026-09-29-managed-tool-result-public-projection.zh-CN.md);
revalidation window: [English](../../../docs/design/2026-10-02-managed-agent-query-amplification.md) |
[简体中文](../../../docs/design/2026-10-02-managed-agent-query-amplification.zh-CN.md).

## Prerequisites

- Java 21
- Maven 3.8.9+ (the SpotBugs gate's plugin declares that floor)
- MySQL 8

Run the packaged CLI with `qwen serve --profile hosted-harness` as a separate
process. It supports durable no-tool Sessions and the opt-in Workspace file
Turns described in the G0 section below.

Install the two sibling libraries once when building this module outside a
Maven reactor:

```bash
mvn -f ../qwencode/pom.xml -DskipTests -Dgpg.skip=true install
mvn -f ../runtime-broker/pom.xml -DskipTests install
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

Close, archive and delete are durable operations (Flyway V17). Each answers
`202` with a command operation that
`GET /v1/agents/sessions/{id}/operations/{operationId}` reads back, also after a
delete; the WebShell adapter offers the same routes. The public control plane
owns lifecycle state and tenant/idempotency checks, while the Hosted Harness
remains the private title authority and the Runtime Broker owns execution
bindings.

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
holding Harness seals it when closing), drains the Runtime binding (currently
only an in-process retirement flag) and completes the operation; a failed
attempt is retried with the dispatch backoff until it succeeds, so a `202`
never means that tools stopped. After the Hosted Harness restarts, its calls fail with a
generation error until Java restarts too, as Turns do, and the operation waits. A Harness whose journal writes stopped after a failed commit answers every close with `503` until it restarts. A delete of a closed or archived Session
needs no Harness. Archive accepts only a closed Session and completes at once;
unarchive restores it to closed. Rename waits for the Harness to durably commit
`session_metadata`. When a rename failure is recorded, its `PENDING` command becomes `FAILED`
while retaining its receipt and request digest. The same
key retries the same content with the replay flag set; changed content or a
different Session conflicts. A successful concurrent request can still complete
the receipt, and a failing sibling cannot overwrite that completed outcome.
Retries do not re-append the original `requested` event. If the command store
is unavailable during cleanup, the original API failure is preserved and the
same key can resume its receipt when storage returns. Only an in-flight
lifecycle change blocks another one. A retry with the same key from the same
actor returns the original operation once it has completed.

Harness attachment uses strict create/load semantics: create returns `409` for
an existing private Session authority, while load returns `404` for a missing
authority and never initializes one. The Java connector attempts strict create for a new binding and loads on
conflict or uncertain creation outcome. A known existing binding only loads.
An in-memory Hosted attachment is bound to one normalized Store endpoint,
tenant, workspace, and Harness writer generation; an attach or cold-load race
with a different identity fails closed.

Delete writes a public tombstone: get and list stop returning the Session,
while its operations stay readable. Completed deletion permanently marks an existing
private journal `DELETED`, clears its writer and recovery references, and fences
new writes and recovery. Close and archive keep output pinned. Deletion does
not physically erase the journal, events or resources; output collection stays
disabled by default and requires the retention deployment gates.

The Phase 1 schema has not been released. A development database created by an
older revision with `harness_session_id` must be recreated before running this
revision; the service fails Flyway validation instead of silently rewriting
existing public Session URLs.

The public listener intentionally ignores end-user `Authorization`. The
optional Runtime Broker listener still requires a separate machine bearer and
must remain private.

## Private Managed Session store

Flyway V4 creates the private Managed Session journal and resource tables. The
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
not advertise general automatic cross-Pod recovery yet: multi-tool recovery,
recovered cancellation, event/checkpoint reconstruction after a
mid-continuation Harness crash, the full multi-process in-flight failure matrix,
OSS-backed resources, and scheduler recovery are still pending. Resources
larger than 64 KiB fail with
`managed_session_oss_disabled` until the immutable OSS path is implemented.
Production deployments must add mTLS or equivalent service authentication;
the tenant and writer headers are scope and fencing inputs, not a substitute
for transport identity. Responses under the private prefix use
`Cache-Control: no-store`.

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
# Once per clone, and re-run after pulling changes to qwencode/runtime-broker (~12 s):
mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
mvn -f packages/sdk-java/runtime-broker/pom.xml -DskipTests install
# One-time, on a fresh MySQL 8 (creates the database and user the URL names):
mysql -u root -e "CREATE DATABASE qwen_managed_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER 'qwen'@'localhost' IDENTIFIED BY 'replace-me'; CREATE USER 'qwen'@'127.0.0.1' IDENTIFIED BY 'replace-me'; GRANT ALL ON qwen_managed_agent.* TO 'qwen'@'localhost'; GRANT ALL ON qwen_managed_agent.* TO 'qwen'@'127.0.0.1';"
# (official MySQL images enable skip-name-resolve, so 'qwen'@'localhost' alone never
#  matches TCP clients; a containerized MySQL sees the gateway address — grant at
#  'qwen'@'%' or the container-visible host instead)
# Every run; the launcher prints this spring.env path at startup (on Windows,
# the printed path is the spring.env.ps1 sibling):
source <printed spring.env path>
export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'
export SPRING_DATASOURCE_USERNAME='qwen'
export SPRING_DATASOURCE_PASSWORD='replace-me'
mvn -f packages/sdk-java/managed-agent-server/pom.xml spring-boot:run
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
re-source the new `spring.env` and restart Spring. To wire the pieces by
hand instead, start an ordinary `qwen serve` on port 4170 in addition to the
private Hosted Harness used by Spring, then run from the repository root:

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

## Embedded Runtime Broker

### Initial Workspace file Turn (G0)

`QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED=true` opts in to an initial
Read/Write/Edit Turn supplied with public Session creation. The WebShell creation
adapter uses the same admission. This requires the Hosted Harness and HTTP
Session Store, a `yolo`, `default` or `auto-edit` approval mode, and a `local-process`, `session`-isolated
Broker with configured `runtime-broker.workspace-mounts`. Registry entries must
use `managed-runtime-tools/1` and `preapproved-workspace-tools/1`, and their
tenant/storage identity must have a deployment mount. The trusted ingress must
provide an `AuthenticatedTenantActor` principal with read/create grants; a caller
header alone does not authenticate an actor. For local runs and the
packaged-stack E2E, which have no ingress,
`QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER` names a request header whose value is
then trusted as the actor for the request's tenant. It is disabled by default;
never enable it where untrusted clients can reach the server.

`QWEN_MANAGED_AGENT_APPROVAL_MODE` defaults to `yolo`. In `default` and
`auto-edit`, the Session creator can list, inspect and answer pending permission
Actions through the public API or WebShell. Responses are durable, idempotent
operations; their final result follows the committed Harness decision.
`QWEN_MANAGED_AGENT_APPROVAL_TIMEOUT` defaults to `10m` and accepts `1s` to `24h`.
The approval mode is pinned at Session creation and must be confirmed by the
Harness on creation and load.

Submit `agent_id: "qwen-code"`, the existing `workspace` selection and `input`
through `POST /v1/agents/sessions`. The server chooses the fixed
`hosted-workspace-files/1` private profile and uses the persisted Workspace ID
for the Session Store. Public callers cannot choose the profile. Configure the
Harness's deployment-owned `--managed-runtime-broker-url` and
`--managed-runtime-broker-token` options to reach this Broker. A repeated creation key returns
the original Session/Turn; changed input conflicts. Disabling the opt-in refuses
creation with input, including replays, while empty bound creation remains
available. The directory mounted for a Workspace is trusted deployment data,
not a filesystem sandbox.

Later Turns may be submitted by the Session's creator under the
same opt-in while they can still read and create in the Workspace (the
per-caller `workspaceTurns` capability flag reflects the caller's current
grants and the Workspace registry's `ACTIVE` state), and the creator may cancel
the Session's running Turns and rename the Session. Workspace close follows
its separate close capability and lifecycle admission. Archive, delete and
unarchive follow their separate retention capabilities after reliable Workspace
close. Cwd operations and broad Workspace capability advertisement remain gated. Shell and in-flight recovery are separate slices.
The existing `EmbeddedRuntimeBroker` is used through production configuration;
no direct store admission or test Broker replacement is needed.

Design: [English](../../../docs/design/2026-09-29-hosted-public-workspace-admission.md)
| [简体中文](../../../docs/design/2026-09-29-hosted-public-workspace-admission.zh-CN.md).

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

Design: [English](../../../docs/design/managed-agent-broker-auth.md)
| [简体中文](../../../docs/design/managed-agent-broker-auth.zh-CN.md).

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
export QWEN_MANAGED_AGENT_CLI_ENTRY='/absolute/path/to/dist/cli.js'
```

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
# binds as milliseconds, which startup refuses. Raising it above 30m buys
# nothing on the shipped path: the TypeScript client stops observing a v3
# execution at its own fixed 30-minute deadline.
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_V3_RESULT_WINDOW='30m'
```

When `QWEN_MANAGED_AGENT_WORKSPACE_ID` is omitted, the server derives the same
16-character SHA-256 workspace ID that Qwen Code uses from the canonical
workspace path. An explicitly configured ID must match that value or startup
fails before traffic is accepted.

The Hosted file profile connects through the private Broker endpoint, which
defaults to `http://127.0.0.1:4182`. When enabled, the embedded
Broker always uses the Spring `DataSource` and Flyway-managed Runtime tables;
it does not fall back to in-memory repositories. The credential key must decode
to exactly 32 bytes and protects persisted Runtime seeds and static Runtime
credentials with AES-256-GCM. By default, local worker ownership is durable:
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
See the [adoption design](../../../docs/design/2026-09-27-local-runtime-adoption.md).

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
[reboot recovery design](../../../docs/design/2026-09-28-local-reboot-recovery.md)
distinguishes portable test evidence from the dedicated Linux reboot acceptance
gate completed at W0e-3 head `8c2b626c`. A systemd soft reboot is not stop
proof because it does not change the kernel boot ID.

The Kubernetes adapter's real-cluster fault matrix remains a production gate. This
standalone reference keeps the one configured directory for legacy unbound
Sessions. Persisted bound Sessions use the private Workspace execution path
below.

Flyway V12 aligns the Runtime tables with the Broker's own `schema.sql`, which
its JDBC repositories are written against. `RuntimeBrokerFlywaySchemaTest`
fails when the two definitions differ, so a change to either one needs a
matching change to the other. V12 replaces two primary keys. MySQL rejects this
when `sql_require_primary_key` is set: V12 fails before it changes anything, and
Flyway records the failure. Unset the variable, run Flyway `repair`, and start
the server again.

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
Public bound Turn admission is limited to the opt-in initial file Turn described
in G0 above and to later Turns submitted by the Session's creator under the same
opt-in while they can still read and create in the Workspace (the per-caller
`workspaceTurns` capability flag reflects the caller's current grants and the
registry's `ACTIVE` state); the creator may also cancel the Session's running
Turns and rename the Session. Later Turns run
under the creator's Workspace grants, so any other actor keeps the existing
refusal: `workspace_unavailable` when the actor can read the Workspace,
`session_not_found` when they cannot. Public close follows its separate close
capability and lifecycle admission. Archive, delete and unarchive follow their
separate retention capabilities after reliable Workspace close;
the private Shell profile is not enabled through public creation.
See the bilingual [execution design](../../../docs/design/2026-09-26-managed-workspace-execution.md)
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
[file-history design](../../../docs/design/2026-09-30-hosted-file-history.md)
for record capacity and rewind semantics.

### Verified original-mount recovery (W1a)

W1a's physical mount guard is opt-in for process restart in a trusted, single-host OpenJDK 21/Linux `local-process` deployment with a persistent, unambiguous root birth time. Taking the next tool Turn after a Broker restart requires `durable-local-process=true`. Whole-host restart succeeds only while the registered physical identity still matches. Flyway
V25 adds a persistent storage registration, independent `mount_birth_time` and mount fence. Leave
`QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED=false` while
upgrading every Broker and Harness instance. An unregistered mount is refused
once the option is enabled; it is never registered from the directory found at
startup.

Marker v2 stores birth time as a canonical `Instant` string preserving nanoseconds. The guard reads creation time, mtime, device and inode in one `unix` attribute snapshot and rejects creation time at/before epoch or equal to mtime, which OpenJDK 21 may return when birth time is unsupported. A real birth time equal to mtime is also conservatively refused; prepare the project layout or update the root's mtime offline before retrying. Mtime is not an identity field, and ordinary mtime changes do not invalidate an unchanged birth time. The marker contains an application-specific HMAC-SHA256 host ID, keyed by the trimmed machine-id UTF-8 bytes with `Qwen-Code/verified-workspace/v2` as input, rather than the raw machine ID.

Keep the storage root outside **every Git worktree**, with Session cwd in a child project directory. `.qwen-managed-storage.json` is an administrator maintenance file: do not read/write it through model tools or subject it to Git cleanup/stash. Tools are not confined by this layout. Missing or conflicting markers close admission; completed registrations never automatically republish them, including on a same-UUID retry. Marker repair needs a separate design.

Prerelease W1 V21/V24 databases and marker v1 cannot be directly upgraded to V25/v2. Experimental W1 V24 conflicts with main’s Actions V24; renaming the migration does not upgrade an existing database. Do not bypass the mismatch with Flyway `repair`, `outOfOrder` or manual history edits. Preserve backups and design an explicit offline migration for deployments with retained data; only disposable test deployments may be rebuilt.

Stop all processes and external jobs that can write the storage, account for
old Runtime holders and verify the original root before registration. Apply
Flyway migrations, then run the private maintenance entry from this module on
the same Linux host. Give a stable canonical lowercase, hyphenated 36-character UUID to each operation and reuse it after a
crash. Database credentials come from `W1_JDBC_URL`, `W1_JDBC_USER` and
`W1_JDBC_PASSWORD` environment variables:

```bash
mvn -q -DskipTests compile exec:java \
  -Dexec.mainClass=com.alibaba.qwen.code.managedagent.store.WorkspaceStorageRegistrationMain \
  -Dexec.args='register tenant-a storage-a /absolute/canonical/workspace-a <operation-uuid> --offline-confirmed'
```

The same entry is available from a shipped Spring Boot fat jar, without the source checkout or Maven:

```bash
java -cp /path/to/app.jar \
  -Dloader.main=com.alibaba.qwen.code.managedagent.store.WorkspaceStorageRegistrationMain \
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
whole upgraded deployment. On each new attachment, model submission, Runtime
claim and execute, the server compares the configured canonical root against
the SQL registration, Linux host/device/inode/birth-time identity and the root marker.
A missing or conflicting marker, replacement root, missing saved cwd or fenced
storage blocks new work; original execution status/cancel and authorized
history remain on their saved identities. The marker is a continuity check,
not a backup or protection against a malicious same-UID writer. See the
[W1 design](../../../docs/design/2026-09-29-managed-workspace-w1-recovery.md).
Hosted Workspace cold-load validation is always enabled, independently of the Java mount-guard option. Omitted tool profile and Shell `captureBytes` use the saved definition; supplied values must match exactly. Saved approval settings remain pinned. Integrity checks run before new model work or Broker prepare/execute and cover retained private resources plus complete remote Shell output, including pages, segments and empty-stream seals. Preserve O2 recovery of original `results_ready`, consumed-final and `not_started` receipts. An incomplete receipt may produce a blocked ACK or original-history repair before load is refused, so refusal does not promise zero journal writes or ACKs. Restore validation uses a fixed committed cut, and continuation still requires current writer ownership and authorization. Missing old resources or unsupported recovery domains block loading. Passive Harness loading does not implement unknown-execution cleanup; use original Broker execution identities. Rollback to old binaries requires entry points to remain stopped because those binaries ignore the fence columns. Public
Workspace next-turn admission for the Session's creator under the G0 opt-in
described above has landed; public Workspace resume still requires product-route
integration, and this internal guard is not a public resume capability yet.

Build the container from the repository root:

```bash
docker build -f packages/sdk-java/managed-agent-server/Dockerfile .
```

The stock image contains the Java control plane only. Use the static Runtime
provisioner, or provide a derived image/mount with Node.js and the Qwen worker
artifacts, before enabling the local-process provisioner in a container.

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

## Real-model end-to-end check

The full-chain script starts Spring with its embedded Runtime Broker and runs
both the Hosted Harness and the worker from the packaged `dist/cli.js`: the
Harness as `node dist/cli.js serve --profile hosted-harness`, and each worker,
launched by the Broker, as `node dist/cli.js managed-runtime-worker`. No
separate worker bundle exists. The G0 integration test
(`HostedPublicWorkspaceIT`) uses the same packaged `dist/cli.js`.

The real-model run below creates its Session through the public route as a
Workspace-bound G0 Session, and proves the physical tool execution through
the durable `qwen_tool_execution` record (exactly one `SETTLED` row) rather
than a public `item.tool_call.*` event — Broker-worker tool calls are not
published without O2 tool publication. The run needs live model credentials,
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
mvn -f packages/sdk-java/runtime-broker/pom.xml -DskipTests install
mvn -f packages/sdk-java/managed-agent-server/pom.xml clean package
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
and refuses other platforms with an explicit error; the Hosted MySQL CI job
runs both.

The in-flight mode holds the first Broker `:start` request after the Harness
has durably committed its `await_runtime` checkpoint, kills the original
Spring and Hosted Harness process trees, deletes their homes, and starts
replacement owners. It requires the replacement Harness to use the original
`executionCallId`, execute the physical tool exactly once, continue the
original Prompt without replay, and commit one public terminal event. The
continuation mode kills the Harness after the first published text chunk and
requires one tool execution, one further continuation, only the replacement's
answer in the public transcript, and one terminal event. Both modes run in the
Hosted MySQL CI job.

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
