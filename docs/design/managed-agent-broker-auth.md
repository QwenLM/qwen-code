# Managed Agent Broker: authenticated principals and broker-provisioned credentials

[English](managed-agent-broker-auth.md) | [简体中文](managed-agent-broker-auth.zh-CN.md)

Status: implemented locally, 2026-10-02; verification results are tracked
in `.qwen/issues/issue-13180.md`. Source baseline: `de2612434a`.
Tracks [#13180](https://github.com/QwenLM/qwen-code/issues/13180).

## 1. Problem statement

The Managed Agent Runtime Broker (`packages/sdk-java/managed-agent-server`)
currently trusts client-asserted identity and client-minted credentials.
Five gaps combine into cross-tenant read/write of any hosted Session's
durable transcript when the broker is reachable without a gateway:

1. **Tenant/actor identity is header-asserted.** `TenantContextFilter`
   accepts `X-Qwen-Tenant-Id` as-is and only cross-checks an actor when a
   principal already exists. The trusted-actor scheme in the OpenAPI
   contract is marked `x-qwen-implementation-status: planned` — the gateway
   it assumes is not shipped, while every shipped dev/E2E topology
   (`?tenant=` in the Web Shell, the vite dev proxy, the
   `trusted-actor-header` setting) runs in exactly the no-gateway form.
2. **Writer credentials are self-minted.** The harness generates its own
   writer token (`randomBytes(32)` in
   `packages/core/src/managed-runtime/http-managed-session-store.ts`) and the
   broker registers its hash on first acquire
   (`ManagedSessionStore.acquireWriter`, first-writer-wins TOFU). During any
   free lease window (up to 300 s), anyone who can reach the port and knows
   `(tenantId, workspaceId, sessionId)` can acquire the writer role and
   rewrite a Session's durable history.
3. **The internal surface shares the public port.** `/internal/**` (the
   Managed Session store and tool publications) is served by the same
   connector as `/v1/agents/**`; there is no separate listener and no
   deployment guard on the listen address.
4. **Approval ownership excludes hosted Sessions.**
   `ManagedActionService.respond` → `ManagedActionStore.requireOwner` only
   matches a `managed_workspace_create_command` row, so hosted (non-
   workspace) Sessions have no durable owner and never accept an HTTP
   answer, and the workspace check compares a guessable actor-id value
   against a header-asserted identity.
5. **The TypeScript client allows plaintext transport silently.**
   `createHttpManagedSessionStores` accepts an `http://` base URL for any
   host, so writer tokens cross the wire unencrypted on non-loopback
   deployments with no warning.

## 2. Goals and non-goals

Goals:

- G1. Tenant/actor identity on the public surface comes from an
  authenticated principal verifiable by the broker alone (no external
  gateway required).
- G2. Writer credentials are provisioned by the broker at Session/Runtime
  creation and bound to `(tenantId, workspaceId, sessionId)`; self-minted
  tokens stop working when the binding key is configured.
- G3. `/internal/**` can be bound to its own loopback-only listener, and
  the broker refuses unsafe listen-address combinations at startup.
- G4. Every Session has a durable creator record; approval responses check
  it, and hosted Sessions can be answered over HTTP.
- G5. The TypeScript client refuses plaintext `http://` broker URLs on
  non-loopback hosts unless explicitly opted in.

Non-goals:

- The runtime-broker's own single-token HTTP server (tracked separately).
- A real OIDC/SSO gateway, mTLS, key rotation tooling, or multi-tenant ACL
  modeling beyond the existing actor checks.
- Changing the shipped loopback dev/E2E topologies: they keep working
  without new configuration.

## 3. Trust model

Two HTTP surfaces with different callers and different protection:

| Surface  | Routes                                                                               | Callers                             | Protection after this change                                           |
| -------- | ------------------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------- |
| Public   | `/v1/agents/**`, `/api/agent/web-shell/v1/**`                                        | Browsers, operator tooling, proxies | Signed principal (G1) or loopback-only open mode                       |
| Internal | `/internal/managed-session-store/v1/**`, `/internal/managed-tool-publications/v1/**` | Hosted harnesses (the Qwen CLI)     | Writer binding credential (G2); loopback-only listener by default (G3) |

The internal surface does not need request signatures: the writer binding
credential already binds `(tenantId, workspaceId, sessionId)`, so a forged
tenant header on an internal call just derives a different expected
credential and fails. The signing key is therefore never distributed to
harnesses.

## 4. Design

### 4.1 Authentication modes and the signed principal (G1)

New configuration group `qwen.managed-agent.auth`:

| Key                   | Env                                           | Default | Meaning                                 |
| --------------------- | --------------------------------------------- | ------- | --------------------------------------- |
| `mode`                | `QWEN_MANAGED_AGENT_AUTH_MODE`                | `auto`  | `auto`, `open`, or `signed`             |
| `signing-key`         | `QWEN_MANAGED_AGENT_AUTH_SIGNING_KEY`         | empty   | HMAC key for `signed` mode, >= 32 bytes |
| `allowed-drift`       | `QWEN_MANAGED_AGENT_AUTH_ALLOWED_DRIFT`       | `5m`    | signature timestamp tolerance           |
| `allow-insecure-bind` | `QWEN_MANAGED_AGENT_AUTH_ALLOW_INSECURE_BIND` | `false` | escape hatch documented as dangerous    |

Mode resolution at startup:

- `open`: today's behavior — `X-Qwen-Tenant-Id` is accepted as asserted and
  the optional `trusted-actor-header` stand-in supplies the actor.
- `signed`: a new `SignatureAuthFilter` (ordered before
  `TrustedActorHeaderFilter`) requires three headers on every
  public-surface request: `X-Qwen-Actor-Id` (the actor identity,
  mandatory), `X-Qwen-Signature-Timestamp` (epoch seconds, within
  `allowed-drift`), and `X-Qwen-Signature`, computed as:

  ```
  X-Qwen-Signature: v1=<lowercase hex HMAC-SHA256>(
      "qwen-broker-auth-v1\n" + METHOD + "\n" + requestURI + "\n"
      + queryString + "\n" + tenantId + "\n" + actorId + "\n" + timestamp
      + "\n" + lowercase hex SHA-256(raw body) + "\n" + idempotencyKey)
  ```

  `requestURI` is the undecoded path without the query string;
  `queryString` is the raw query (empty when absent); `idempotencyKey` is
  the `Idempotency-Key` header value (empty when absent). Signing the body
  and idempotency key means a captured signature cannot be transferred to
  a different method, path, query, tenant, actor or body; headers outside
  the recipe (for example `Last-Event-ID` or `Accept`) stay variable
  inside the drift window, so a captured read signature replays across
  the cursor values those headers select.

  On success the filter installs the `AuthenticatedTenantActor` principal
  (tenant and actor from the now-authenticated headers); on failure it
  answers `401 authentication_required` or `401 invalid_signature` in the
  standard error envelope. `TenantContextFilter` then cross-checks the
  principal exactly as it does today, so no controller changes.

  Two fail-closed details: the coverage decision uses the routed path
  (`UrlPathHelper.getPathWithinApplication`, shared with the tenant filter
  via `PublicSurface`), so the bare `POST /v1/agents` collection route and
  normalized spellings (percent-encoding, path parameters) cannot slip past
  while the canonical string keeps signing the raw request URI; and a
  repeated `Idempotency-Key` header is refused with `400 invalid_request`
  because the servlet contract would sign the first value while the
  controllers bind the comma-joined pair. The buffered body is bounded per
  request by `qwen.managed-agent.auth.max-signed-body-bytes` (default
  10 MiB) — an over-limit request answers `413 payload_too_large` before
  the signature comparison. Aggregate pre-authentication buffering is
  bounded by that limit times the servlet worker-thread count
  (`server.tomcat.threads.max`, 200 by default), times the per-request
  buffer-growth factor (up to roughly 2× for a declared-length body and
  3× for a chunked one while the buffer grows); lower either knob on
  memory-tight deployments. Finally, the request the filter forwards pins
  JSON media types to UTF-8: the `Content-Type` charset parameter is not
  signed, and a non-Unicode charset would otherwise steer the JSON decoder
  into persisting content that differs from the signed bytes (JSON is
  UTF-8 by definition, RFC 8259), so the chain observes
  `application/json;charset=UTF-8` regardless of the declared charset.

- `auto`: resolves to `open` when `server.address` is loopback (the
  shipped default `127.0.0.1`), otherwise startup fails and names
  `signed` mode. This keeps every shipped dev/E2E topology working while a
  production listen address cannot come up unauthenticated.

Startup guards (all fail fast with a named property):

- `mode=auto` or `mode=open` + non-loopback `server.address` + not
  `allow-insecure-bind`.
- `mode=signed` + missing/short `signing-key`.
- `trusted-actor-header` set while the resolved mode is `signed`
  (contradictory: the header stand-in must not be able to inject a
  principal behind the signature filter).
- a non-empty `server.servlet.context-path` or non-root
  `spring.mvc.servlet.path` (the path-prefix filters assume a root mount
  and would be silently bypassed).
- an `allowed-drift` below one second (truncates to a zero window).
- with `internal-server.port` set, a loopback `session-store.base-url`
  naming a different port (the harness's store calls would 404).
- `harness.enabled` with a plaintext non-loopback `harness.base-url` (the
  attach payload carries the provisioned writer credential).
- `tool-publication.enabled` with a plaintext non-loopback
  `service-base-url` (runtimes reach the publication surface with the
  writer credential).
- `session-store.enabled` with a plaintext `session-store.base-url` whose
  host is outside the client's literal-only loopback set (`localhost`,
  `*.localhost`, `127.0.0.0/8`, `[::1]`) and no
  `session-store.allow-insecure-http` — every harness would refuse the
  advertised URL at attach time, so the broker refuses at startup instead.

`allow-insecure-bind` disables four of these guards (public bind, internal
binding key, harness transport, publication transport); the startup posture
line enumerates the guards it skipped as `skipped=...` so the blast radius
is visible in the log.

The OpenAPI contract gains a `qwenSignature` apiKey scheme
(`X-Qwen-Signature`) whose description pins the canonical string and the
`401` codes; the `trustedActor` scheme keeps `planned` status for the
external-gateway form, with a note that `signed` mode authenticates the
same header pair.

### 4.2 Broker-provisioned writer binding credential (G2)

New configuration `qwen.managed-agent.session-store.binding-key` (env
`QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY`), default empty; when set it
must be at least 32 bytes (a weaker key can be brute-forced from one
observed token).

When set, the writer token for a Session is derived, not chosen:

```
writerToken = "qwt1_" + base64url-nopad(HMAC-SHA256(bindingKey,
    "qwen-managed-writer/v1\0" + tenantId + "\0" + workspaceId
    + "\0" + sessionId))
```

48 characters, inside the existing `^[A-Za-z0-9_-]{32,512}$` contract on
both sides. The token deliberately excludes the writer id: a harness that
reboots with a new boot id re-acquires with the same credential after the
old lease expires, so recovery keeps working.

- A new `WriterCredentialPolicy` bean owns `issue(tenant, workspace,
session)` and `require(tenant, workspace, session, token)`. `require`
  throws `403 writer_credential_invalid` when the binding key is set and
  the presented token differs (constant-time compare). When the key is
  empty the legacy TOFU behavior is unchanged.
- Every `ManagedSessionStore` entry point that takes a writer token
  (`acquireWriter`, `renewWriter`, `sealWriter`, `blockRecovery`, `commit`,
  `restore`, `transactions`, `readResource`, `publishToolResult`, and the
  publication-writer path in `ToolPublicationStore`) routes token
  validation through the policy. Each call site already carries the
  workspace id, so no API shape changes.
- Provisioning flows through the existing attach payload:
  `QwenHostedHarnessConnector.managedSessionStore(...)` adds the issued
  token to `ManagedSessionStoreConnection` (new optional `writerToken`
  field, serialized as `managedSessionStore.writerToken`), the TS bridge
  parser `parseBridgeManagedSessionStore` accepts the optional field, and
  `hosted-harness-session.ts` passes it to
  `createHttpManagedSessionStores({ writerToken })`, which already accepts
  an explicit token. A client that never receives a provisioned token keeps
  self-minting; the broker rejects it whenever the binding key is set, so
  the two sides cannot silently disagree.

The stored `lease_token_hash` column keeps its role (renew/seal
consistency); binding only decides which token may be presented at all.

### 4.3 Separate internal listener and listen-address guards (G3)

New configuration `qwen.managed-agent.internal-server`:

| Key       | Env                                          | Default        | Meaning                 |
| --------- | -------------------------------------------- | -------------- | ----------------------- |
| `port`    | `QWEN_MANAGED_AGENT_INTERNAL_SERVER_PORT`    | `0` (disabled) | dedicated listener port |
| `address` | `QWEN_MANAGED_AGENT_INTERNAL_SERVER_ADDRESS` | `127.0.0.1`    | listener bind address   |

- When `port > 0`, a `WebServerFactoryCustomizer` adds a second Tomcat
  connector and an `InternalSurfaceConfiguration.RoutingFilter` (highest
  precedence) routes by `request.getLocalPort()`: `/internal/**` on the
  public connector answers `404`, and anything outside `/internal/**` on
  the internal connector answers `404`. The surface check classifies on
  the routed path (`PublicSurface.pathWithinApplication`, the router's
  own parsed segments), so spellings like `/%69nternal/...` or
  `/internal;/...` that Spring maps to the internal handlers cannot cross
  the listener boundary — and a `Content-Type` charset cannot skew the
  classification, because the segments come from the router's fixed UTF-8
  decoding.
- When `port = 0`, today's single-port shape is preserved.
- Startup guard: any non-loopback listen address (public or internal)
  requires the matching protection — `signed` mode for the public surface,
  a configured `binding-key` for the internal surface — unless
  `allow-insecure-bind` is set. The internal surface with no binding key
  is therefore loopback-only by construction.
- Two more fail-fast guards: `internal-server.port` must differ from
  `server.port` (the routing filter classifies by local port, and equal
  port numbers on different addresses would serve `/internal/**` on the
  public address), and the signing key must differ from the binding key
  (a signing-key holder must not be able to mint journal writer
  credentials).

### 4.4 Durable Session ownership for approvals (G4)

- Flyway `V40__managed_session_creator.sql`:
  `ALTER TABLE managed_agent_session ADD COLUMN creator_actor_key
VARBINARY(2048) NULL;` (same type as
  `managed_workspace_create_command.actor_id`).
- `ManagedAgentStore.insertSession` already receives `actorId` and takes a
  single insert path for hosted and workspace Sessions; it now also writes
  `creator_actor_key` when the actor is present. The hosted `createSession`
  service method and its controllers gain the nullable `actorId` from
  `TenantContext` so hosted Sessions record their creator too.
- `ManagedActionStore.requireOwner` resolves ownership in order:
  1. `creator_actor_key` on the Session row — must match the caller's
     actor key when present;
  2. the legacy `managed_workspace_create_command` row (the fallback for
     pre-migration Sessions, whose creator column is NULL);
  3. neither recorded (anonymous open-mode creation, or a pre-migration
     hosted Session) — allow any caller in the tenant, matching the
     tenant-scoped read semantics non-workspace Sessions already have.

  This makes hosted approval answers work over HTTP and ties workspace
  approvals to the authenticated actor instead of a header-asserted one
  (G1), closing the "guessable actor" hole.

### 4.5 TypeScript client transport guard (G5)

`ManagedSessionStoreHttpClient` rejects a base URL whose protocol is
`http:` and whose hostname is not loopback (`localhost`, `*.localhost`,
`127.0.0.0/8`, `[::1]`) unless the new option `allowInsecureHttp: true` is
passed. `BridgeManagedSessionStore` gains the matching optional
`allowInsecureHttp` boolean, produced by the broker's
`qwen.managed-agent.session-store.allow-insecure-http` setting (env
`QWEN_MANAGED_AGENT_SESSION_STORE_ALLOW_INSECURE_HTTP`) and serialized into
the attach payload by `ManagedSessionStoreConnection`, so a broker that
intentionally serves plaintext inside a trusted network can say so; the
field defaults to absent/false. The error names the option, so the remedy
is discoverable. The client-side `writerToken` self-mint path is retained
for loopback deployments without a binding key.

### 4.6 Hardened dev stand-ins

- `TrustedActorHeaderFilter` only activates when the resolved auth mode is
  `open` (in `signed` mode an unsigned request never reaches it, and the
  startup guard forbids configuring it). Its javadoc warning becomes an
  enforced rule.
- Anonymous idempotency folding: in `signed` mode the actor is always
  authenticated because `SignatureAuthFilter` requires the
  `X-Qwen-Actor-Id` header on every public request
  (`401 authentication_required` otherwise), so the anonymous folding that
  `SessionLifecycleService.actorDigest` and `ManagedActionService.respond`
  apply today can only occur in `open` mode — the local-only deployments it
  serves.

## 5. Compatibility and rollout

- Zero-config compatibility for the shipped loopback topologies: `auto`
  resolves to `open`, binding key empty keeps TOFU, internal port disabled,
  anonymous creation still records no owner.
- Enabling `binding-key` is flag-day per deployment: harnesses must attach
  through the broker (which provisions tokens); direct store clients must
  be handed the derived token. The server logs at startup which mode and
  guards resolved.
- Rolling out `signed` mode on the public surface requires a proxy or
  sidecar that holds the signing key in front of browser traffic; the
  signature recipe is the three-header form pinned in §4.1.
- Existing databases migrate with V40; pre-migration Sessions keep working
  through the legacy ownership fallback.

## 6. Risks and mitigations

- **Replay within the timestamp window.** The HMAC covers method, path,
  query string, tenant, actor, timestamp, a body digest and the
  idempotency key, so a captured signature cannot be moved to another
  method, path, query, tenant, actor or body. The residual risk is replay
  inside the 5-minute window, including with unsigned headers that select
  a different page of the same route (`Last-Event-ID`, `Accept`,
  `Range`): a captured read signature can walk the cursor space of that
  one route until it expires. Internal mutations are additionally
  idempotency-keyed. Accepted for a gateway-free deployment; a nonce
  cache and signing the cursor-bearing headers are listed as future work.
- **Binding credential is static per Session.** Compromise of one token
  affects one Session only; rotation = rotate `binding-key` (flag day).
  Per-Session random secrets stored at creation are the listed alternative
  and rejected for the extra table and recovery complexity.
- **Guard false positives on exotic but legitimate binds** (pod networks).
  `allow-insecure-bind` is the documented escape hatch; it is named in the
  startup error.
- **Second connector drift** (a new internal route added later must land
  under `/internal/`). The routing filter matches the `/internal/` prefix
  only, and a contract test asserts both directions.

## 7. Validation plan

- Java unit/integration tests per item: signature filter accept/reject and
  ordering; mode resolution and every startup guard; binding credential
  issue/verify including reboot re-acquire and cross-scope rejection;
  internal listener routing in both directions; ownership fallback chain
  (migrated, legacy, anonymous) and hosted `respond` succeeding; anonymous
  folding rejection under `signed`.
- TypeScript tests: loopback classification table, refusal without opt-in,
  acceptance with opt-in, bridge payload round-trip with `writerToken`.
- The OpenAPI contract records the new `qwenSignature` scheme and the 401
  codes in prose (scheme + shared `Unauthorized` descriptions); the
  web-shell generated client is regenerated against it, and its sync test
  (`managed-agent-api.test.ts`) fails on drift.
- E2E: existing dev topology (`qwen` CLI + Web Shell on loopback) works
  with zero new configuration; a signed-mode smoke run against a
  non-loopback address.

## 8. Acceptance criteria

1. With `mode=signed`, a public request without a valid signature is
   answered `401`; with one, the actor principal drives ACL and approval
   checks.
2. With `binding-key` set, a self-minted writer token cannot acquire any
   Session's writer — including during a free lease window — and the
   broker-provisioned token can.
3. With `internal-server.port` set, `/internal/**` is unreachable on the
   public port; with a non-loopback public address and open mode the
   broker refuses to start.
4. A hosted Session's approval can be answered over HTTP by its creator
   and by no other actor; a Session with no recorded creator (anonymous
   open-mode creation, or created before V40) answers to any caller in its
   tenant, matching its read ACL; pre-migration workspace Sessions keep
   their current behavior.
5. `createHttpManagedSessionStores({ baseUrl: 'http://<non-loopback>' })`
   throws unless `allowInsecureHttp: true`.

## 9. Open questions

- Nonce cache for signed requests (defense beyond the 5-minute window)?
- `binding-key` rotation with a previous-key verify window, or flag day?
- Should `signed` mode also cover the internal surface once harnesses can
  hold the key, or is the binding credential sufficient long-term?
