# Qwen Managed Agent Server

Standalone Spring Boot control plane for the Qwen Code Hosted Harness. It has
no DataWorks dependency and no end-user authentication layer. A trusted
upstream must send `X-Qwen-Tenant-Id`; the server uses that value on every
database read and write. The HTTP server listens on `127.0.0.1` by default;
set `QWEN_MANAGED_AGENT_SERVER_ADDRESS` when a trusted ingress needs to reach
it. That ingress must authenticate the tenant before setting the header.

设计说明：[English](../../../docs/design/2026-09-19-managed-agent-spring-server.md) |
[简体中文](../../../docs/design/2026-09-19-managed-agent-spring-server.zh-CN.md)

## Prerequisites

- Java 21
- MySQL 8
- a running `qwen serve --profile hosted-harness`

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
  -d '{"agent_id":"qwen-code","input":[{"type":"text","text":"hello"}]}'
```

The returned `id` is an RFC UUID and is the canonical identity used by
the public API, Hosted Harness transcript, and Runtime Broker. The server does
not maintain a separate public-to-Harness Session mapping.

## Public Session lifecycle

Flyway V5 adds durable lifecycle commands and soft-deletion timestamps. The
public control plane owns lifecycle state and tenant/idempotency checks, while
the Hosted Harness remains the private title authority and the Runtime Broker
owns execution bindings.

```bash
curl -sS -X PATCH \
  http://127.0.0.1:8080/v1/agents/sessions/$SESSION_ID \
  -H 'Content-Type: application/json' \
  -H 'X-Qwen-Tenant-Id: demo' \
  -H 'Idempotency-Key: rename-1' \
  -d '{"title":"investigate checkout failure"}'

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

Archive and delete reject an active Turn. Rename waits for the Harness to
durably commit `session_metadata`; archive closes the Harness attachment and
drains the Runtime binding; delete closes it only when the Session was active
and always drains the binding; unarchive clears the Runtime retirement fence
and loads the Harness lazily on the next Turn. A failed external action leaves
a `PENDING` command that the same idempotency key can safely resume. The
command retains the pre-mutation state, so deleting an archived Session does
not require the already-closed Harness. A different lifecycle command is
blocked until it completes.

Harness attachment uses strict create/load semantics: create returns `409` for
an existing private Session authority, while load returns `404` for a missing
authority and never initializes one. The Java connector attempts strict
create for a new binding and loads on conflict or an uncertain creation
outcome. A known existing binding only loads.
An in-memory Hosted attachment is bound to one normalized Store endpoint,
tenant, workspace, and Harness writer generation; an attach or cold-load race
with a different identity fails closed.

Delete currently writes a public tombstone and hides the Session from get/list
responses. It does not physically erase the private journal or resources;
retention, writer sealing, and garbage collection remain future work.

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
to 64 KiB. Callers must provide the trusted tenant header and a fresh Base64URL secret in
`X-Qwen-Managed-Writer-Token`; only its SHA-256 is persisted. Restore,
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
HTTP adapter and generates its own writer secret. The Store scope reuses
`QWEN_MANAGED_AGENT_WORKSPACE_ID`, so the public Session, private journal, and
Runtime binding have one `(tenantId, workspaceId, sessionId)` identity. Set
that ID explicitly when enabling the Session Store; if the Runtime Broker also
has an explicit ID, startup rejects a mismatch.

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
panel to this Spring service. Start an ordinary `qwen serve` on port 4170 in
addition to the private Hosted Harness used by Spring, then run from the
repository root:

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
export QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY='/absolute/path/to/dist/managed-runtime-worker.js'
export QWEN_MANAGED_AGENT_CLI_ENTRY='/absolute/path/to/dist/cli.js'
```

When `QWEN_MANAGED_AGENT_WORKSPACE_ID` is omitted, the server derives the same
16-character SHA-256 workspace ID that Qwen Code uses from the canonical
workspace path. An explicitly configured ID must match that value or startup
fails before traffic is accepted.

Point `qwen serve --profile hosted-harness` at
`http://127.0.0.1:4182` with the same Broker bearer. When enabled, the embedded
Broker always uses the Spring `DataSource` and Flyway-managed Runtime tables;
it does not fall back to in-memory repositories. The credential key must decode
to exactly 32 bytes and protects persisted Runtime seeds and static Runtime
credentials with AES-256-GCM. The local-process adapter can recover the same
worker after a Java restart on the same host; multi-host scheduling and the
Kubernetes adapter's real-cluster fault matrix remain production gates. This
standalone reference resolves every accepted tenant to the one configured
workspace; a trusted tenant-authorized environment registry is still required
before using it as a multi-tenant production service.

Build the container from the repository root:

```bash
docker build -f packages/sdk-java/managed-agent-server/Dockerfile .
```

The stock image contains the Java control plane only. Use the static Runtime
provisioner, or provide a derived image/mount with Node.js and the Qwen worker
artifacts, before enabling the local-process provisioner in a container.

## Managed Session Store verification

Unit and H2 contract tests run with the normal Maven test phase. The optional
real-MySQL profile also verifies schema upgrade, exact bytes, public
Item/Snapshot projection, and the independent-JVM Managed Session Store
crash/takeover path:

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

The repository includes a local full-chain check that starts an isolated
MySQL instance, this Spring application, the Hosted Harness, and a local Tool
Runtime. It uses the selected model from an existing Qwen settings file, then
verifies that the same Turn completes a real `write_file` call, idempotent
Session replay, tenant isolation, and durable Event storage.

Build the required artifacts first, then run:

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

To exercise an admitted in-flight Turn at the tool-intent boundary, run:

```bash
npm run test:e2e:managed-inflight-failover
```

This mode holds the first Broker `:start` request after the Harness has durably
committed its `await_runtime` checkpoint, kills the original Spring and Hosted
Harness process trees, deletes their homes, and starts replacement owners. It
requires the replacement Harness to use the original `executionCallId`, execute
the physical tool exactly once, continue the original Prompt without replay,
and commit one public terminal event.

The default zero-delay run is the stable real-model integration gate. To also
observe resident model output while the Tool Runtime is unavailable, add a
controlled cold-start delay:

```bash
npm run test:e2e:managed-agent-server -- \
  --model moonshot/kimi-k3 \
  --runtime-delay-ms 45000
```

That run additionally requires the first model event to precede Runtime
readiness. Real provider TTFT varies, so the deterministic CI proof of the same
ordering remains `npx tsx scripts/run-managed-hosted-runtime-e2e.ts`, which
uses a controlled model server and a 15-second Runtime delay.

The real-model check extracts only the selected model provider, its referenced
environment credential, the selected model, and the authentication policy
from the supplied settings file into a private temporary Qwen home. It does
not copy hooks, MCP servers, extensions, tools, permissions, or other provider
credentials. The runner removes that file, the MySQL data directory,
workspaces, and child processes on exit. Override the source with
`--settings /path/to/settings.json`; credentials are never printed by the
runner.
