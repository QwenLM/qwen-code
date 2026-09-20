# Standalone Managed Agent Spring Server

[English](2026-09-19-managed-agent-spring-server.md) | [简体中文](2026-09-19-managed-agent-spring-server.zh-CN.md)

Status: Phase 1 implemented; production gates remain open
Date: 2026-09-19

## 1. Problem

Qwen Code already has a Hosted Harness profile and Java libraries for its
private HTTP/SSE protocol and Runtime Broker. It does not yet have a runnable,
product-neutral Java control plane in this repository. The existing product
integration depends on DataWorks identity, storage, and deployment code and
cannot be used as a standalone Qwen Code service.

The new server must provide a low-latency, multi-tenant Session API while the
TypeScript Hosted Harness continues to own the model loop. It must run without
DataWorks, accept an upstream-provided tenant identity, persist authoritative
public state in MySQL, and keep Harness and Tool Runtime credentials private.

## 2. Goals

- Add an independently runnable Spring Boot application under
  `packages/sdk-java/managed-agent-server`.
- Require `X-Qwen-Tenant-Id` on Agent API requests and use it as the database
  ownership boundary.
- Do not implement end-user authentication or interpret `Authorization` on the
  public API.
- Persist Session, Turn, command-idempotency, Harness generation fencing, and
  public Event state in MySQL.
- Submit model work to the existing Hosted Harness without waiting for Tool
  Runtime readiness.
- Expose durable SSE replay from Java-owned events rather than proxying the
  Harness stream directly to clients.
- Expose both `/v1/agents/sessions/**` and the current WebShell
  `/api/agent/web-shell/v1/**` adapter over one application core.
- Allow the existing Java Runtime Broker to run inside the same control-plane
  process on a separate private listener.

## 3. Non-goals

- Copying DataWorks controllers, authentication, deployment, or persistence
  classes.
- Rewriting the TypeScript Agent loop, MCP, Skills, or tool implementations in
  Java.
- Passing `tenantId`, Runtime endpoints, credentials, or leases into model
  Prompt content.
- Full OpenAI Managed Agents API compatibility in Phase 1. Unsupported fields
  and routes return explicit errors rather than being silently ignored.
- Kubernetes-specific provisioning. The first embedded Broker integration is a
  single-node development path; durable multi-replica Broker repositories are a
  separate production gate.
- Automatic Legacy-to-Managed Session conversion.

## 4. Architecture

```text
Client / WebShell
       |
       | X-Qwen-Tenant-Id
       v
Spring Managed Agent Server (one logical multi-tenant service)
  |-- Tenant boundary + public/WebShell adapters
  |-- command ledger + Session/Turn/Event store ----> MySQL
  |-- asynchronous Harness coordinator
  |-- private Runtime Broker listener (optional)
  |
  +---- HTTP/SSE ----> qwen serve --profile hosted-harness
  |                         |-- model loop and context
  |                         `-- BrokerManagedRuntimeProvider
  |                                      |
  +<--- private HTTP ---------------------+
  |
  `---- HTTP ----------> Tool Runtime
                              `-- workspace side effects and tools
```

Spring replicas are logically stateless apart from process-local live
attachments and SSE subscribers. MySQL owns recoverable public state. Hosted Harness
processes are long-lived, multi-Session execution shards; a Session binding
must remain fenced to one Harness boot generation.

## 5. Trust and tenant boundary

The service intentionally has no public authentication dependency. It assumes
that a trusted upstream or private network has authenticated the caller. Every
Agent API request must nevertheless carry `X-Qwen-Tenant-Id` matching
`[A-Za-z0-9._:-]{1,128}`.

The header is not a security credential by itself. It is an infrastructure
scope that is propagated into command, query, event, and Runtime placement
operations. Every resource query includes `tenant_id`; random identifiers are
never the only isolation control. The value is not appended to Prompt content
and is not sent to Hosted Harness as a caller-controlled claim.

The private Runtime Broker listener retains a distinct bearer token. This is
machine-to-machine fencing for Harness-to-Broker traffic, not end-user
authentication, and therefore does not conflict with the no-auth public API.

## 6. Durable data model

Phase 1 owns these tables:

| Table                   | Purpose                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `managed_agent_session` | Tenant-owned Session UUID, Harness generation fence, status, and public sequence                    |
| `managed_agent_turn`    | One admitted user input, stable Harness prompt identity, digest, dispatch lease, and terminal state |
| `managed_agent_command` | `(tenant, operation, idempotency key)` claim and semantic request digest                            |
| `managed_agent_event`   | Per-Session public sequence, source-event deduplication, replay payload, and terminal marker        |

One RFC UUID `sessionId` identifies the Session across the public API, Java
store, Hosted Harness, JSONL transcript, and Runtime Broker. The internal
`harnessSessionId` wire field is a compatibility alias carrying this same
value, not a second identity or database mapping. `turnId` remains the public
Turn identity and `promptId` remains the private idempotent Harness submission
identity. No Harness endpoint, boot ID, client ID, Runtime token, or local path
appears in public responses.

The Session row owns `last_sequence`. Event insertion locks that row, allocates
the next value, and inserts the Event in the same transaction. A unique source
key prevents a Harness reconnect from creating duplicate public events.

## 7. Command and recovery semantics

Mutating calls require `Idempotency-Key` (or the equivalent WebShell request
field), limited to 1--128 visible characters. The server canonicalizes the
semantic request and stores its SHA-256 digest before dispatch.

- The same tenant, operation, key, and digest returns the original IDs with
  `replayed=true`.
- The same key with different content returns HTTP 409.
- Admission commits Session, Turn, command, and initial public events before
  any Harness call.
- Client disconnect never cancels a Turn.
- Harness submission reuses the persisted `promptId` and payload digest after
  an uncertain response.
- A persisted submission-attempt marker distinguishes a safely cancellable
  pre-dispatch Turn from an uncertain submission. The latter is reconciled
  idempotently before cancellation so it cannot leave an orphan model run.
- A dispatch lease prevents two Spring replicas from actively coordinating the
  same Turn. An expired lease permits recovery by another replica.
- Harness source cursor and epoch are persisted after every accepted event.

The coordinator attaches or loads the same Session UUID in the Harness,
submits the original prompt, consumes its fenced SSE stream, and projects
events into the public store. `turn_complete` and `turn_error` settle the Turn
durably. A scheduled recovery scan reclaims admitted or running Turns whose
dispatch lease expired.

## 8. API slice

Phase 1 implements:

```text
POST /v1/agents/sessions
GET  /v1/agents/sessions
GET  /v1/agents/sessions/{sessionId}
POST /v1/agents/sessions/{sessionId}/events
GET  /v1/agents/sessions/{sessionId}/events
```

The event write route accepts an input message or cancellation. Session create
may include initial text input. Public SSE uses Java `publicSequence` in the
`id` field and honors `Last-Event-ID`; it never exposes the Harness event epoch
or source sequence.

The WebShell adapter implements the existing seven routes:

```text
POST /api/agent/web-shell/v1/sessions/query
POST /api/agent/web-shell/v1/sessions/get
POST /api/agent/web-shell/v1/transcript/query
POST /api/agent/web-shell/v1/events/stream
POST /api/agent/web-shell/v1/sessions/create
POST /api/agent/web-shell/v1/turns/submit
POST /api/agent/web-shell/v1/turns/cancel
```

Both adapters call the same command/query/event services. The WebShell adapter
is not a second execution path. Transcript snapshots return the newest bounded
page in ascending order; `olderCursor` paginates backward without changing the
live `lastSequence` cursor.

## 9. Hosted Harness and Runtime timing

Creating the durable Turn and beginning model inference do not depend on Tool
Runtime readiness. When the embedded Runtime Broker is enabled, the server
starts `warm(sessionId)` asynchronously after admission and submits the Prompt
independently. A no-tool Turn can complete without waiting for warmup; a Tool
Call waits at `BrokerManagedRuntimeProvider` for the original Runtime binding.

The Hosted Harness client validates capability digest, protocol version, boot
ID, SSE epoch, and source sequence. A fence mismatch fails the Turn; it never
falls back to Legacy or a different Runtime.

## 10. Configuration

Required production configuration:

```text
SPRING_DATASOURCE_URL
SPRING_DATASOURCE_USERNAME
SPRING_DATASOURCE_PASSWORD
QWEN_MANAGED_AGENT_HARNESS_ENABLED=true
QWEN_MANAGED_AGENT_HARNESS_BASE_URL
QWEN_MANAGED_AGENT_HARNESS_TOKEN
QWEN_MANAGED_AGENT_CAPABILITY_DIGEST
```

Runtime Broker configuration is separate and disabled unless its private
listener, bearer token, and provisioner inputs are explicitly supplied. The
public HTTP server and private Broker listener must not share exposure rules.
For the local-process provisioner, the server derives the Qwen workspace ID
from the canonical workspace path when it is omitted. An explicitly configured
ID must equal that 16-character SHA-256 prefix or application startup fails.

Flyway applies versioned migrations at application startup. Production uses
MySQL; H2 in MySQL mode is test-only.

## 11. Failure behavior

| Failure                                       | Behavior                                                              |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Missing or invalid tenant header              | HTTP 400 before controller dispatch                                   |
| Cross-tenant resource ID                      | HTTP 404                                                              |
| Reused idempotency key with changed body      | HTTP 409                                                              |
| Harness disabled before admission             | Reject with HTTP 503; no command is admitted                          |
| Harness transport unavailable after admission | Durable Turn remains admitted and is retried by recovery              |
| Harness capability or generation mismatch     | Durable Turn fails closed                                             |
| Client SSE disconnect                         | Subscription ends; Turn continues                                     |
| Spring process exit                           | Another replica can reclaim an expired dispatch lease                 |
| Local Runtime workspace ID mismatch           | Application startup fails before traffic is accepted                  |
| Runtime warm failure before any Tool Call     | Public environment failure; model flow is not synchronously blocked   |
| Unknown Tool execution outcome                | Broker reports recovery-blocked/unknown; no replay on another Runtime |

## 12. Validation plan

- Unit-test tenant parsing, canonical digesting, event projection, and errors.
- Start a real Spring context with Flyway and H2 MySQL mode.
- Verify that the public Session UUID is the exact ID passed to the Harness and
  Runtime Broker and that no second Session ID is persisted.
- Verify same-key replay, changed-body conflict, and cross-tenant 404.
- Verify durable Event ordering and `Last-Event-ID` replay.
- Run against a deterministic Hosted Harness fixture and prove that create,
  Prompt admission, SSE projection, terminal settlement, and retry use stable
  identities.
- Run module tests and Checkstyle on Java 21.
- Build the executable jar and start it with MySQL plus a real
  `qwen serve --profile hosted-harness` before declaring the production gate
  complete.

The repository test fixture now covers thirteen tests for tenant enforcement,
cross-tenant 404s, sequential and concurrent command replay (including replay
while the original Turn is active), event resume, asynchronous Harness
projection, cancellation after an uncertain submission result, error-detail
redaction, Runtime Broker conditional wiring, tenant resolution, private Broker
authentication, derived workspace identity, and explicit workspace-ID
mismatch rejection. Checkstyle and executable-jar packaging are part of the
Java SDK workflow.

The local real-process gate now starts isolated MySQL, the executable Spring
jar, a real Hosted Harness, the embedded Broker, a separate Runtime worker, and
`moonshot/kimi-k3`. In the final controlled 30-second cold-Runtime run, public
admission completed in 114 ms, the first real model event arrived at 6,629 ms,
Runtime became ready at 31,141 ms, and the Turn completed at 39,237 ms. The
same run verified the exact `write_file` side effect, same-Session idempotent
replay, cross-tenant 404, unique durable Event sequences, and one terminal
Event. These timings are one local observation, not an SLO. The deterministic
model fixture remains the CI ordering proof and most recently emitted its
first model event at 300 ms before Runtime readiness at 15,565 ms.

Production ACS/Pod provisioning, multi-node durable Broker repositories,
process-loss recovery, real load balancing, and full tenant-isolation matrices
remain production gates rather than Phase 1 claims.

## 13. Acceptance criteria

Phase 1 is complete when:

1. The application starts without any DataWorks artifact or classpath.
2. All public and WebShell queries are tenant-scoped and cross-tenant IDs
   return 404.
3. A repeated create/submit command returns the original IDs and never creates
   a second Turn.
4. A client can reconnect from a public Event sequence without duplicates.
5. A deterministic Harness fixture completes an actual asynchronous Turn.
6. No public response or log contains a Harness, Broker, or Runtime secret.
7. The existing TypeScript Hosted Harness and legacy `qwen serve` routes remain
   unchanged.

The production multi-replica gate additionally requires real MySQL concurrency,
an embedded Broker backed by durable repositories, production Hosted Harness
and ACS/Pod Runtime deployments, process-loss recovery, and load-balanced
tenant-isolation tests. It also requires an idle attachment eviction/capacity
policy so a long-lived Java process does not retain heartbeats for every
historical Session.
