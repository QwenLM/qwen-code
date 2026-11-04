# E2B Cloud Runtime provider

This standalone service keeps Managed Agent Server, Hosted Harness, model access, approvals and journals in the central deployment. Qwen execution workers run in E2B Cloud and mount an existing E2B Volume. The service owns E2B credentials; it is not imported by Core or the Harness.

The `external-workspace-files` profile provides Read, Write, Edit and managed public WebFetch. The `external-workspace-tools` profile adds foreground Shell and contained Glob, with output published to the central HTTPS publication service. Both profiles verify worker drain and physical retirement. The existing `external-scratch` and `external-workspace` provisioning contracts remain unchanged. All Cloud and public Hosted acceptance gates are still pending.

## Prerequisites

This provider targets E2B Cloud. Alibaba Cloud AgentSandbox does not support the E2B Volume API used by `Volume.connect` and the Volume-ID file challenge; changing the endpoint alone is insufficient. See the [AgentSandbox qualification](../../docs/design/2026-10-28-e2b-managed-runtime.md#agentsandbox-compatibility-qualification) for the storage compatibility boundary.

- Node.js 22.19 or newer on the adapter host.
- E2B Cloud access with Volumes enabled and an API key supplied as `E2B_API_KEY` on that host.
- An existing Volume ID, one unique Volume per registered physical Workspace. `physicalKey` must equal that immutable ID. A Volume name or sandbox ID is insufficient.
- A Linux worker image built from the same Qwen revision as the central Harness and Broker. The local macOS bundle does not establish Linux compatibility.
- HTTPS reverse proxying for one management origin and `*.workers.example.com`. Preserve each original Host header and forward to the adapter's loopback listener. Disable request/response body and Authorization logging. Route only the adapter paths; do not expose E2B envd.
- A durable, canonical adapter state directory owned by its Unix user with mode 0700. Its SQLite journal contains boot and sandbox access credentials. Preserve it across restarts and keep backups private. Run one logical adapter against that journal. The journal binds the provider ID and a hash of the original API key; changing that key is refused. Automatic key rotation is outside this implementation.

## Build the worker template

From the repository root, use `docker build --pull -f integrations/e2b-runtime-provider/Dockerfile.worker .` to build on Linux, then publish that image. The image includes matching built workspace packages and native Linux dependencies. Exclude `.git`, `.qwen`, local credentials, `node_modules` and build output from the uploaded build context; use an isolated clean source export. The build intentionally does not embed provider, model or Session Store credentials.

Set `QWEN_E2B_WORKER_IMAGE` to the published image's digest reference, `QWEN_E2B_TEMPLATE_ALIAS` to its chosen alias, and run `node integrations/e2b-runtime-provider/build-template.mjs`. This command creates an E2B template and needs the API key. Record the returned immutable template ID in the adapter configuration. The adapter starts each worker with its private boot document; the template must not start a pre-booted worker.

## Configure and run

Copy [config.example.json](config.example.json), replace every placeholder, and bind each tenant Workspace to its registered Volume ID, paths and revision. Duplicate Volume IDs and aliases are refused. The service verifies the mounted filesystem with a fresh challenge written through the Volume-ID API and read through the sandbox mount before writing the private worker boot.

From the repository root:

```bash
corepack pnpm install --frozen-lockfile
npm run build --workspace=@qwen-code/e2b-runtime-provider
```

Provide `QWEN_E2B_CONFIG` (absolute configuration path), `E2B_API_KEY` and `QWEN_E2B_PROVIDER_TOKEN` through the service manager's protected environment, then run `npm start --workspace=@qwen-code/e2b-runtime-provider`. Use a random provider token of at least 16 safe characters. Keep it distinct from the Broker token and the E2B API key. The listener binds only to `127.0.0.1`.

The provider API uses authenticated, no-store JSON POSTs to `/provider/provision`, `/provider/observe` and `/provider/retire`. Configure the Broker's provider URL with the trailing `/provider/` path. Worker endpoints have the form `https://<opaque-id>.workers.example.com`; their Qwen bearer and lease are checked before forwarding. The adapter injects the E2B traffic token and never accepts a caller-selected upstream URL.

## Register and publish the Workspace

Use the Managed Agent Server's existing loopback operator listener and Broker operator credential. First POST `/internal/managed-workspaces/v1/storage:register-external` with `X-Qwen-Tenant-Id`, a stable idempotency key, and this registration:

```json
{
  "identity": {
    "providerId": "e2b-cloud",
    "physicalKey": "VOLUME_ID",
    "registrationRevision": 1
  },
  "alias": {
    "tenantWorkspaceId": "workspace-a",
    "aliasPath": "/external/workspace-a",
    "mountRoot": "/workspace"
  },
  "idempotencyKey": "register-workspace-a"
}
```

Then POST `/internal/managed-workspaces/v1/workspaces:publish-external` on that same operator listener:

```json
{
  "storageId": "workspace-a",
  "providerId": "e2b-cloud",
  "registrationRevision": 1,
  "actorId": "the-actual-session-owner",
  "displayName": "E2B Workspace",
  "idempotencyKey": "publish-workspace-a"
}
```

Publication atomically creates the active Workspace and its actor's OWNER grant. It does not create a sandbox. Public clients must select this registered Workspace through the existing Session API, with `cwd_relative` equal to `.`. Unbound and local-storage Session creation is refused in these external profiles. No manual SQL insertion is needed.

Configure the central deployment with `QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=external-workspace-files`, Workspace files enabled, Shell disabled, Session isolation for both scratch and bound Sessions, and the matching external provider ID/URL/token. Enable the existing Harness, Session Store, Runtime Broker and SQL credential protection. Retain the central deployment's normal global capability digest and explicit Broker Workspace ID/cwd configuration; do not set the global digest to the reserved managed-Workspace digest. Per-Workspace scopes come from the registration. For foreground Shell, select `QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=external-workspace-tools`, enable Workspace Shell, the existing Tool Publication service with a worker-reachable HTTPS origin, and central Artifact reads. Use default or auto-edit approval mode. No additional output pull protocol is required.

Disable trusted local reboot recovery, local/CSI/SSH mounts, child Workspaces, operator recovery, Session-create warm and managed extensions. Use the existing Managed Agent Server README for its model/Harness credentials and HTTPS authentication setup.

## Recovery and retirement

The journal commits creation intent and its identity before calling E2B. Concurrent duplicates and restarts reuse the same record. SDK create retries are disabled; the E2B idempotency key is an additional safeguard, not an assumption about account feature flags.

If a create response is lost before sandbox traffic credentials are saved, the service only lists original matching metadata and reports UNKNOWN. It cannot obtain those credentials through a read-only SDK lookup. It does not create again or call `Sandbox.connect`, which could resume a paused VM. An ambiguous worker launch likewise remains inspectable without a second launch. Operator investigation is required for these uncertain placements; preserving identity takes priority over replacement availability.

Session close releases the original worker Session, acknowledges durable results and verifies the exact retirement bytes, digest, boot identity, lease and storage revision. A TTL expiry, paused or missing sandbox is not a successful close. Legacy release remains a no-op. The separate authenticated retire operation first stores the complete qualified worker proof under the original binding/generation key, then kills that immutable sandbox ID and verifies absence through the Cloud API. It retains the Volume. A read-only confirmation replays this original proof and physical stop after a lost reply, even when the worker is gone. If the sandbox remains present, it reports RETIRING with that proof so the Broker can validate it and retry the same stop without the worker. GONE without that prior retirement intent cannot qualify close.

## Verification status

Local fixture tests cover durable request replay, unknown creates, storage isolation, protected HTTP forwarding and retirement after a lost kill response. Real worker HTTP tests exercise raw/prepared files, foreground Shell publication, committed ACK and durable proof bytes. These results do not establish E2B Cloud, Linux image, real Volume, central publication ingress or failure-recovery acceptance. Run the public Hosted files/Shell/close path with a matching Linux image, real Volume and configured ingress, plus Cloud loss cases, before production use.

The Hosted surface is foreground only. Rewind is refused before journal mutation; background Shell, PTY, Monitor, MCP, Hooks, child Workspaces, context mutation, mount transfer and Workspace filesystem browsing/query/read remain unsupported. Shell artifacts are read from the central publication store after the sandbox is gone.

The affected Java/SDK contracts, Checkstyle, real MySQL transactions and recovery, public Hosted integration and full CI remain acceptance requirements. Selected local fixture or worker checks do not qualify the complete deployment.
