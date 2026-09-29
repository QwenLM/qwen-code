# Managed Agent Remote Runtime P8

## Status

Implemented experimental split of the resident Managed Gateway from the
Tool-only Runtime process. P8 keeps the P7 user API and eager model start
behavior behind `qwen serve --experimental-managed-agents`.

P8 is deliberately a process-boundary proof, not a production scheduler or a
Kubernetes controller. The remote Runtime can be another local process, a VM,
or a Pod because the Gateway depends only on the versioned Runtime protocol.

## Goal

Run the authoritative model loop in a long-lived Gateway while local tools run
in a separately started `qwen serve` Runtime worker. The first model request
must start without waiting for the Runtime worker. If the model requests a
local tool, that same logical turn waits for Runtime readiness, executes the
tool remotely, appends its result, and resumes the Gateway-owned model loop.

## Process shape

```text
client
  -> resident Gateway /managed/sessions
       -> durable admission and Gateway-owned model/history
       -> RuntimeProvider.prepare() starts concurrently
       -> no Tool Call: complete without waiting for Runtime
       -> Tool Call: await prepared Runtime handle
            -> private authenticated HTTP v1
                 -> Runtime worker
                      -> source-bound ACP Tool-only Session
                      -> manifest / execute / cancel
```

The Gateway and Runtime worker are ordinary long-lived services. A local
deployment may run both on one machine. A production deployment may keep a
warm Gateway/Harness floor and provision Runtime workers independently. No
Harness activation is mapped one-to-one to a process, thread, or Pod.

## Ownership

| Concern                                                                                           | Owner                               |
| ------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Admission, tenant/session identity, model request, model credentials, model history, final answer | Gateway                             |
| Runtime placement selection                                                                       | operator or later placement adapter |
| Workspace files, compatible read-only Tool registry, Tool execution                               | Runtime worker                      |
| Source-bound ACP Session and opaque ACP client id                                                 | Runtime worker only                 |
| Capability schema compatibility and Tool result validation                                        | both Gateway and Runtime worker     |

The Runtime protocol never contains the user Prompt, model conversation,
provider configuration, or model credential. The ACP client id is not returned
to the Gateway and never crosses the process boundary. The P8 worker still
boots the existing ACP runtime rather than a credential-minimal Tool-only
binary, so an independently configured provider credential may still be
visible to that process even though it makes no model request.

## Provider contract

The Gateway depends on a transport-neutral provider:

```ts
interface ManagedRuntimeProvider {
  prepare(request: ManagedRuntimePrepareRequest): ManagedRuntimeHandle;
  cancel(
    sessionId: string,
    executionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean>;
  release(
    sessionId: string,
    expected?: ManagedRuntimePrepareRequest,
  ): Promise<boolean>;
  dispose(): void;
}

interface ManagedRuntimeHandle {
  ready: Promise<void>;
  getManifest(signal: AbortSignal): Promise<BridgeManagedRuntimeToolManifest>;
  execute(
    request: BridgeManagedRuntimeToolExecuteRequest,
    signal: AbortSignal,
  ): Promise<BridgeManagedRuntimeToolExecuteResult>;
}
```

`prepare` is single-flight per Session and is owned by the Gateway service
lifetime, not by one Prompt deadline. Its `ready` Promise starts before
`ManagedGatewayModelRunner.runTurn`. The model runner only awaits the handle
after the model emits a declared Tool Call. Local and HTTP implementations
must have the same identity, idempotency, and cancellation behavior.

To preserve first-round independence from Runtime readiness, P8 gives the
model a fixed, Gateway-known read-only Agent Definition. The Runtime manifest
proves that the selected worker has compatible implementations before each
Tool executes; it does not add Runtime-discovered tools to a model request that
has already started. Runtime-discovered MCP tools and workspace Skills require
a later control-plane capability catalog or cached Agent Definition and are not
part of P8.

The HTTP provider treats connection refusal, connection reset, HTTP 429, and
HTTP 503 as “Runtime not ready” and retries prepare with capped, abortable
backoff for at most five minutes. A failed warmup is removed from the
single-flight map so a later turn can start a fresh attempt. Authentication,
other 4xx responses, malformed payloads, and protocol version errors are
permanent failures. A session release aborts its pending prepare loop before
asking the worker to release any established binding. The bounded window
prevents an unavailable endpoint from retaining one timer and request record
for every historical no-tool Session indefinitely.

## Private HTTP v1

The Runtime worker exposes these operator-only routes after the daemon's
Bearer authentication middleware:

```text
POST /internal/managed-runtime/v1/prepare
POST /internal/managed-runtime/v1/manifest
POST /internal/managed-runtime/v1/execute
POST /internal/managed-runtime/v1/cancel
POST /internal/managed-runtime/v1/release
```

Every request carries `protocolVersion: 1`, `tenantId`, `workspaceId`,
`workspaceCwd`, `sessionId`, and `turnKind`. Execute additionally carries the
P7 `executionId`, `turnId`, `toolCallId`, `capabilityDigest`, `toolName`, and
JSON input. Cancel carries the matching `executionId`.

The worker validates bounded JSON shapes, requires the selected workspace to
be registered and trusted, recomputes the workspace id mapping, and binds the
ACP Session to `sourceType: managed-gateway` and `sourceId: sessionId`. It
rejects identity changes, attached bootstrap collisions, active Prompts,
capability drift, unsafe tools, and mismatched execution cancellation.
Tenant identity is enforced by the live provider binding in P8; restart-safe
tenant fencing requires the later placement/lease control plane.

The experimental worker requires a configured daemon Bearer token even on
loopback. A remote Gateway uses an explicit Runtime token, falling back to its
own daemon token only when the operator chose to share credentials. Plain HTTP
Runtime URLs are accepted only for loopback hosts; non-loopback endpoints must
use HTTPS so the bearer is not sent in cleartext. Tokens are never logged,
persisted in Managed Session state, or included in errors.

## Cancellation and retries

Runtime preparation is not directly owned by one Prompt signal. A failed
bootstrap releases it because the Gateway has no committed conversation to
continue; a failed continuation retains it for a later retry. A Prompt abort
cancels an in-flight HTTP request and sends a best-effort explicit cancel for
its execution id. The worker also aborts bridge execution when the HTTP client
disconnects.

Prepare is retried only for the explicit not-ready conditions above. Manifest
is read-only and receives one automatic retry after a network failure or HTTP
503, which also clears a stale keep-alive connection after worker restart.
Execute is not automatically retried after dispatch. The existing Runtime
execution id is the idempotency key, and the worker preserves the ACP Tool-only
duplicate/collision checks. Release is idempotent and is used when a bootstrap
turn fails or an owning control plane explicitly removes the Session; ordinary
Gateway shutdown does not release remote Runtime state needed for restart
recovery.

## Failure behavior

| Failure                                            | Behavior                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime absent while model answers without tools   | Gateway turn completes; preparation may finish later                                                                                                                               |
| Runtime absent when a Tool Call is reached         | same logical turn waits on the service-owned prepare Promise until Prompt deadline or cancellation; a failed bootstrap releases it, while a failed continuation may reuse it later |
| HTTP authentication or protocol mismatch           | fail closed without Tool dispatch                                                                                                                                                  |
| Workspace identity mismatch or untrusted workspace | fail closed on worker                                                                                                                                                              |
| Client disconnect during execute                   | cancel bridge execution best-effort; never replay automatically                                                                                                                    |
| Gateway restart                                    | a continuation prepares again and worker resumes the source-bound Session                                                                                                          |
| Runtime worker restart                             | prepare resumes persisted ACP state or creates it when absent                                                                                                                      |
| Capability digest drift                            | fail closed before Tool execution                                                                                                                                                  |

P8 uses one configured Runtime endpoint. Placement, health-aware endpoint
selection, fenced Runtime leases, shared durable execution ledgers,
Runtime-discovered MCP/Skill capability publication, permission round-trips,
progress streaming, Runtime-binding idle eviction, a credential-minimal
Runtime executable, and mutating tools remain later work.

The experimental worker flag also reuses the normal `qwen serve` listener, so
its generic APIs remain mounted for non-Managed Sessions. Source-bound Managed
Runtime Sessions are hidden from those APIs, but a bearer holder could still
create a separate ordinary Session. A production worker needs a dedicated
Tool-only listener or executable that does not mount model/session surfaces.

## Operator experience

```bash
# Runtime worker
QWEN_SERVER_TOKEN=runtime-secret qwen serve --no-web --port 4181 \
  --experimental-managed-runtime-worker --workspace /workspace

# Resident Gateway
QWEN_SERVER_TOKEN=gateway-secret \
QWEN_MANAGED_RUNTIME_TOKEN=runtime-secret \
qwen serve --no-web --port 4170 \
  --experimental-managed-agents \
  --experimental-managed-runtime-url http://127.0.0.1:4181 \
  --workspace /workspace
```

Without `--experimental-managed-runtime-url`, P8 preserves the P7 local
in-process provider. The original P8 Prompt API remains compatible. The
[Managed session surfaces](managed-agent-session-surfaces.md) follow-up adds
Gateway-owned catalog/history reads, recoverable display streaming, exact-Prompt
cancellation, and capability-gated Web Shell navigation. These reads do not
prepare or attach a Runtime, including when that worker is absent.

When a remote Runtime URL is configured, the Gateway skips the ordinary
boot-time ACP child preheat. Non-Managed compatibility routes remain mounted
and may still start that local bridge lazily if an operator invokes them; the
Managed Session path never does so.

## Verification

1. Contract tests run the local and HTTP providers against the same fake
   Runtime service and compare prepare, manifest, execute, cancel, and release.
2. Route tests prove authentication, version/shape bounds, identity isolation,
   disconnect cancellation, and sanitized failures.
3. Orchestration tests delay Runtime prepare beyond the first model delta and
   prove `agent_started` precedes `runtime_ready`.
4. A two-process E2E starts the Gateway before the Runtime worker, submits a
   prompt immediately, then starts the worker and verifies a read-only Tool
   result returns through the same logical turn.
5. Existing generic HTTP and ACP surfaces remain unable to Prompt, restore, or
   mutate a `managed-gateway` Runtime Session.

## Exit criteria

- The Gateway can start and admit a Managed Prompt while the Runtime endpoint
  is unavailable.
- Useful model generation starts before Runtime readiness.
- A remotely executed read-only Tool result resumes the same Gateway model
  turn and produces the final answer.
- The Runtime receives no Prompt and performs no model generation.
- Local mode remains behaviorally compatible with P7.
- Remote transport failures, cancellation, and identity mismatches fail closed
  without leaking secrets or retrying Tool execution after dispatch.

## Local Runtime activation (P9a)

The [P9a local Runtime activation design](managed-agent-local-runtime-activation-p9a.md)
implements opt-in automatic worker startup, workspace reuse, owned-worker fencing,
cancellation, and awaited cleanup. Its validation section records the macOS
process checks and remaining platform/E2E limits. Fixed-URL and in-process
providers remain available without the auto-local flag.
