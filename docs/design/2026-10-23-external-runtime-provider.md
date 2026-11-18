# External Runtime provider

[简体中文](2026-10-23-external-runtime-provider.zh-CN.md)

Issue: https://github.com/QwenLM/qwen-code/issues/15247

## Status and goal

Work in progress; not an accepted or deployed feature. The intended deployment is a central Managed Agent Server and Hosted Harness with tool workers allocated in remote sandboxes. Vendor SDKs and infrastructure credentials belong in an operator-run adapter, outside qwen-code.

The current implementation is explicitly `external-scratch`: Session-isolated boot-v1 workers behind an HTTP provisioner. It does **not** enable Hosted Workspace tools. Configuration rejects managed Workspace features rather than bypassing their storage and ownership checks. The following Workspace extension is a design, not implemented functionality.

In the Spring server this increment allocates, attests and recovers workers but has no tool consumer. A Session without a Workspace binding has no Hosted tool profile, so the Hosted Harness gives the model no tool declarations, while each admitted Turn still warms the Session's Runtime. Each such Session therefore holds a remote worker that receives no tool calls until the provider's own TTL ends it. Remote tool execution requires the Workspace extension below; do not enable `external-scratch` in production for tool use.

Runtime Session liveness is process-local in `RuntimeBrokerService`, separate from persisted Session identity. After Broker recreation, `warm()` can adopt and attest the original worker binding, but does not restore the process-local Session. Before creating new executions, callers must `acquire()` that Session again; otherwise `requireSession()` returns `runtime_session_not_found`. Re-acquisition reuses a repository record without calling `transport.acquire` only when the full Session identity (Harness/Runtime Session IDs, turn kind, scope, binding ID and generation) matches and the stored record is `READY`. It is not permission to revive released or failed Sessions. Replaying an already-terminal execution receipt is a separate durable lookup, not proof of Session liveness.

## Scratch HTTP contract

The Broker POSTs `provision` or `observe` relative to the configured provider base URL. Requests use a provider Bearer credential, JSON content type and accept headers, and `Cache-Control: no-store`. Redirects are disabled; request and response bodies are limited to 64 KiB. Require HTTP 200 with `protocolVersion: 1`. Network errors, timeouts, 408, 429 and 5xx are retryable; they do not establish absence or authorize replacement. Provider response bodies must not leak through public error messages. Use HTTPS for remote services and restrict access to the trusted control plane.

Provision request:

```json
{
  "protocolVersion": 1,
  "provisionRequestId": "broker-minted-request",
  "identity": "sha256-of-canonical-placement-identity",
  "scope": {
    "tenantId": "tenant",
    "workspaceId": "workspace",
    "workspaceGeneration": "1",
    "workspaceCwd": "/workspace",
    "isolationClass": "session",
    "isolationKey": "broker-isolation-key"
  },
  "boot": { "type": "boot", "version": 1 },
  "handle": { "requestId": "broker-minted-request" }
}
```

The example abbreviates `boot`: production sends the existing closed boot-v1 document with runtime identity, incarnation, lease, epoch, token, capability digest, tenant, Workspace identity/generation and cwd. The Broker persists the deterministic logical `handle` before sending the first provision request. `ensureResource` performs no remote I/O; `provision` performs the idempotent POST. Never log boot credentials. The provider must durably deduplicate `provisionRequestId`, bind it to `identity`, and reject a conflicting request. It must not replace an existing physical resource after a lost response or worker loss.

Provision response is `{protocolVersion:1, handle:{requestId:provisionRequestId}, endpoint?:"https://worker.example/"}`. The provider privately binds that logical handle to the immutable physical resource ID; physical IDs and credentials are not returned as the handle. The Broker persists an envelope binding it to provider ID, provision request and token-free identity digest. A response with another handle is rejected. The identity digest covers provider ID, isolation key and canonical boot without the token. This ordering lets a retry reach provider deduplication after the first HTTP response is lost, without leaving the Broker with a null resource handle.

Observe request is `{protocolVersion:1, provisionRequestId, identity, handle}`. Response states are `RUNNING` (requires worker HTTP(S) origin), `STARTING`, or `UNKNOWN`. `GONE` blocks adoption and never triggers replacement. Observe must be read-only and must check the exact original physical handle. The Broker independently attests a returned endpoint; provider `RUNNING` is not proof of worker identity.

There is deliberately **no release endpoint**. Broker `release` can run after losing ownership or failing attestation, so it cannot authorize killing a worker another owner uses. Shutdown/recovery needs a separately fenced protocol and durable stopped-writer evidence. TTL expiration is loss, not a graceful stopped-writer receipt.

## Configuration

Set Runtime provisioner to `external-scratch`, session isolation, an explicit remote Workspace cwd and Workspace ID, and disable trusted local reboot recovery. The provider settings are:

- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_URL`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_TOKEN`
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_PROVIDER_ID` (stable identity; default `external`)
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_REQUEST_TIMEOUT` (default `30s`)
- `QWEN_MANAGED_AGENT_EXTERNAL_RUNTIME_STARTUP_TIMEOUT` (default `2m`; the Broker's first-attempt operation window is bounded by the current four-operation-lease deadline, and values above that fence can require a retry before the original worker is adopted)

Preflight validates configuration only. It does not establish reachability, worker attestation, or Hosted tool support. The provider must retain idempotency records across adapter restarts. The current bounded in-memory placement cache follows the scratch provisioner model and is not a complete retirement/garbage-collection implementation.

## Required Hosted Workspace extension

Introduce an explicit `external-workspace` profile rather than changing the meaning of persisted scratch handles. Reuse `managed-context/1`, boot-v2, and the existing install/activate/tool transport. Do not put provider-specific fields into the closed worker boot document.

1. Register remote storage independently of worker placement: provider ID, stable physical storage identity, registration revision, tenant/storage alias and worker mount root. Add read-only continuity/canonical-cwd probes. Disposable sandbox IDs alone are not durable storage identities.
2. Extend `WorkspaceStorageGuard`, `WorkspaceExecutionStore` and `WorkspaceRuntimeResolver` with external storage ownership and physical-key mapping. Preserve SQL writer/generation fences, cross-tenant authorization and alias collision protection. Never run central `Files` checks against a worker-local path.
3. Extend `WorkspaceRuntimeTransport` to verify external storage before claim, install context, then activate. Unknown outcomes retain ownership. Existing local/SSH/CSI branches must not be broadly bypassed.
4. Add an explicit managed container boot path in the CLI worker. Today ordinary boot-v2 is refused in container mode. Verify expected storage identity in the worker as well as the control plane, retaining path containment and process ownership.
5. For foreground shell, implement reachable publication/capture endpoints and the relevant control restrictions. Public file browsing, MCP, directory import, child workspaces, snapshots and migration remain unsupported unless separately implemented.
6. Define exact-worker `stopDrained` proof before claiming automatic close/recovery. A generic `release`, failed probe, `GONE`, or expired sandbox is insufficient to release storage ownership.
7. Fully dynamic Workspace creation additionally needs a durable idempotent storage-allocation/registration operation followed by Workspace and grant creation. Creating a worker during `provision` does not implement that operation.

Aone allocation, SDK authentication, ingress, mounts and process supervision live in the separate operator adapter. The upstream API remains vendor-neutral and requires neither Kubernetes nor SSH.

## Verification matrix and current evidence

Caller inspection establishes a narrower boundary: Spring's `HarnessCoordinator.warmRuntime` delegates through `EmbeddedRuntimeBroker.warm` to binding warm-up only. `RuntimeBrokerHttpServer` forwards explicit acquire/create requests to `RuntimeBrokerService`; it does not insert a re-acquire. Existing Hosted Workspace callers explicitly acquire through `HostedWorkspaceBroker.acquire` in `HostedWorkspaceToolTurn` and `hosted-runtime-recovery.ts`, and use the prepare/start execution path. Those source-inspected paths do not establish automatic restart adaptation for every caller or for `external-scratch`, which has no Spring tool consumer. `ExternalRuntimeWorkerFaultGateTest` explicitly re-acquires after warm adoption and shares in-memory repositories across Broker instances; it covers that Broker/worker sequence, not a Spring/Hosted restart E2E or durable database restart. Caller restart adaptation for remote tools remains part of the unimplemented Workspace extension's integration work.

| Layer                    | Required witness                                                                               | What it can establish                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Provider unit            | Original handle retained after restart; replacement/scope drift rejected; timeout unknown      | Broker placement transformation and recovery classification |
| HTTP integration         | Authenticated JSON with prefix; redirect refusal; sanitized errors; bounded responses          | Actual Java HTTP wire behavior                              |
| Broker + real worker     | Attestation and real file tools, duplicate/lost provision response and restart adoption        | Original process identity and tool dispatch                 |
| Public Hosted remote E2E | Workspace read/write/edit, foreground shell/approval/capture, tenant/storage mismatch and loss | User-visible central service to remote tools                |

The matrix distinguishes implemented behavior from executed acceptance evidence. Unit and HTTP suites cover allocation, classification and wire bounds; the repository's full-tier workflow owns MySQL, Hosted and process fault gates. `ExternalRuntimeWorkerFaultGateTest` exercises the actual Broker, HTTP client and CLI worker with a controlled operator fixture; it does not establish vendor sandbox or Hosted Workspace integration. Current-revision CI remains the acceptance gate, and historical local or private adapter runs are not exact-head acceptance evidence.
