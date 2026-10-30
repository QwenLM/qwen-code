# E2B Cloud execution for Managed Agent

[English](2026-10-28-e2b-managed-runtime.md) | [简体中文](2026-10-28-e2b-managed-runtime.zh-CN.md)

## Status and goal

Local implementation under verification, based on `main@6ef3eaa2`. Managed Agent Server, Hosted Harness, model access, approvals and journals stay in the central deployment. Qwen execution workers run in E2B Cloud and mount persistent Volumes. This is not a Cloud deployment or production acceptance report.

The implementation targets E2B Cloud with existing persistent Volumes and an explicitly registered Workspace. Compatible Sandbox APIs on another backend do not by themselves qualify its storage, worker or public Hosted behavior.

## Current behavior and gap

The existing `external-scratch` and `external-workspace` profiles provide authenticated provisioning, immutable placement identity, observation and worker attestation. The latter binds registered EXTERNAL storage but deliberately disables Hosted tools and Session close. Storage registration alone creates neither a Workspace nor access grants.

Those profiles retain their meanings. New profiles connect registered remote storage to the existing Hosted tool protocols and add verifiable retirement:

| Provisioner                | Tools                                                    | Close                                                      |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `external-scratch`         | Existing private scratch contract                        | No new close capability                                    |
| `external-workspace`       | Existing storage provisioning prerequisite               | No new close capability                                    |
| `external-workspace-files` | Read/Write/Edit and the existing managed public WebFetch | Verified worker drain and original sandbox retirement      |
| `external-workspace-tools` | Files profile plus foreground Shell and contained Glob   | Same retirement, with committed Shell publication required |

The existing Hosted files profile actually dispatches raw Tool v2 and raw file-history bind/prepare/snapshot. Its prepared provider is a separate consumer. Both paths must work; a prepared-provider unit test alone does not prove the public Hosted path.

## Ownership and architecture

| Component                   | Responsibility                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Managed Agent Server        | Tenant/actor authorization, Workspace grants, Session lifecycle and durable public events                          |
| Hosted Harness              | Agent loop, model calls, approval decisions and journal commit                                                     |
| Runtime Broker              | Runtime identity, original binding generation, leases, storage claims, result ACK and stop verification            |
| E2B adapter                 | E2B credentials, durable placement/retirement journal, sandbox creation, Volume verification and protected ingress |
| Qwen worker                 | Context/mount checks, tool execution, file history, process ledger and durable drain evidence                      |
| Central publication service | Shell segments, seals, manifests and artifacts that survive sandbox retirement                                     |

The standalone adapter is under `integrations/e2b-runtime-provider/`. Its SDK and API key do not enter Core or the Harness. The Broker uses Qwen worker protocols, rather than replacing them with envd commands. A protected wildcard origin routes each worker's declared endpoints to ports 43190/43191 and injects E2B traffic authentication. The Broker's origin-only endpoint contract is preserved.

## Persistent storage and admission

The operator registers the stable E2B Volume ID as the physical key. The adapter configuration binds one Volume to one provider/tenant alias/revision; names and sandbox IDs are not storage identities. Because the SDK creates mounts by Volume name, the adapter writes a fresh challenge through the Volume-ID API and reads it through the sandbox mount before installing any boot identity.

The existing loopback operator registration API remains unchanged. The new `workspaces:publish-external` operator route selects a registered provider/alias/revision and atomically creates the ACTIVE Workspace and actor OWNER grant, with a durable idempotency receipt. Public clients use the existing Workspace selection and Session APIs with root cwd `.`.

Session admission and Runtime resolution use the registration, never the Broker host filesystem. Physical execution claims require the existing EXTERNAL owner row with matching tenant, storage, physical key, mount root and registration revision. No LOCAL owner is fabricated. Claims, held-owner checks, generation-fenced release and drain eligibility use that same key. External claims serialize writers across Runtime Sessions.

The original worker re-attests its mount before a storage claim; uncertain context installation retains the claim. Registration/owner disagreement, foreign tenants, missing evidence and stale generations fail closed. Provider RUNNING requires matching storage continuity evidence.

## Worker and Harness profiles

New boot documents explicitly carry `externalFiles: external-files/1`; tools mode also carries `externalShell: true`. Unmarked legacy boots keep their old behavior. The prepared provider exposes only Read/Write/Edit and rechecks canonical Workspace containment before preparation, confirmation, preflight and execution. It rejects input replacement that could change the checked path.

The raw worker tool set matches the existing Hosted profile: files include managed public WebFetch; tools add foreground Shell and Glob confined to the Session directory. WebFetch runs from E2B with Core's existing public-network policy and no additional model call.

The central connector sends and persists `foregroundOnly` and `fileRewindEnabled=false` on external Session create/load/recovery. This prevents unsupported background/orchestration advertising and rejects rewind before writing a pending undo. Existing SSH rewind behavior is preserved. MCP, Hooks, native extensions, child Workspaces, PTY, Monitor, background Shell, context mutation and mount transfer remain unavailable. Workspace file browsing/query/read remains unsupported for EXTERNAL storage.

## Foreground Shell publication

Tools mode reuses the existing `/v3/publications:install` protocol and `RemoteShellResultPublisher`. The worker receives only the selected execution's publication authorization and uploads bounded segments, seals and manifests to the central HTTPS publication service. It receives neither the Session Store writer token nor model credentials.

This avoids a second begin/read output consumer. The pre-existing external begin/read protocol remains available to its original private callers; it does not qualify a new external tools retirement. Tools mode requires the central publication service and central Artifact reads to be enabled. Committed execution ACKs and the process ledger gate retirement; a Shell result merely reaching the worker's settled state is insufficient.

## Durable lifecycle and retirement

The adapter commits creation intent, request digest, immutable boot and E2B idempotency key before its first create call. SDK create retries are disabled because Cloud idempotency availability is account dependent. Concurrent duplicates and restarts reuse the same journal record. Different contents under the same request ID conflict.

The journal binds the provider ID and a hash of its original API key. It refuses a changed key, including a key from another E2B team whose resource lookups could otherwise return 404. Automatic credential rotation is outside scope.

A lost create response without saved traffic credentials remains UNKNOWN. Read-only metadata lookup never authorizes a second sandbox, a worker relaunch or `Sandbox.connect`, which could resume a paused VM. Ambiguous launches also retain the original intent. These cases require operator investigation and do not claim automatic availability recovery.

Close follows this sequence:

1. The Broker drains original Runtime Sessions and replays durable raw result ACKs. The worker seals admission and requires released prepared Sessions, settled/acknowledged raw calls, drained file history, no active extensions/background work and a clean process ledger. Cleanup failures remain blockers.
2. The worker durably publishes exact files/tools drain bytes. The Broker verifies reference kind/schema/length/hash and the full tenant, Workspace, storage revision, runtime, lease and provision identity.
3. An authenticated provider `retire` operation stores that complete original proof and a binding/generation retirement key before stopping the original immutable sandbox ID. It confirms absence through the Cloud API and retains the Volume.
4. The provider persists and replays the original proof and physical stop receipt. A lost kill/SQL response is recoverable through read-only confirmation even after the worker is gone. If the sandbox remains present, RETIRING returns the saved proof for Broker validation and another stop of that same resource without contacting the worker. Concurrent confirmations preserve one receipt.
5. The Broker revalidates that proof and only then persists its original-generation drain receipt and releases storage ownership.

Legacy release remains a no-op. TTL expiry or GONE without an earlier qualified retirement intent is not a clean close. Pause, restore or fork does not authorize reuse of a Qwen lease or duplicate worker identity.

## Affected code

| Area                                | Change                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| Standalone E2B integration          | SDK client, private SQLite journal, gateway, template build and runbook                            |
| Java registration/persistence       | Operator publication, Session admission and exact EXTERNAL owner claims                            |
| Java resolver/transport/provisioner | Registry-backed scope, mount attestation, tool gates, durable ACK and verified physical retirement |
| Java Hosted connector and SDK       | Foreground profile and immutable rewind restriction through attachment copies                      |
| CLI worker/provider/executor        | Explicit profiles, path checks, strict drain and central Shell publication                         |
| Hosted Harness                      | Persisted rewind restriction before undo admission                                                 |

## Validation and acceptance

Validation is layered: focused worker/adapter tests; real worker HTTP tests for prepared and raw files plus Shell publication/ACK/drain; selected Java tests; selected real MySQL cases; then the public Hosted and real Cloud path.

Local fixture and worker HTTP evidence covers durable request replay, guarded file execution, central Shell publication, committed ACKs and durable drain proofs. Acceptance still requires the affected Java/SDK contracts, real MySQL transactions and recovery, the public Hosted process path, a matching Linux image, real E2B Volume identity/mount verification and Cloud loss/retirement cases. Local macOS or injected Cloud-client results do not substitute for those checks.

## AgentSandbox compatibility qualification

The explicit `external-files/1` worker profile admits up to 64 request headers on both worker listeners so Cloud proxy forwarding headers fit before application authentication. Other profiles retain their 32-header limit. The existing header byte limit and bearer, lease, incarnation and storage revision checks still apply.

This provider targets E2B Cloud with its Volume-ID APIs. Alibaba Cloud's [compatibility list](https://help.aliyun.com/zh/agent-sandbox/e2b-sdk-compatible-api-list) supports Sandbox and template operations but marks the E2B Volume API as incompatible. Changing only `E2B_API_URL` and `E2B_DOMAIN` does not adapt `Volume.connect` or the Volume-ID file challenge used here.

AgentSandbox [AgenticFS Volumes](https://help.aliyun.com/zh/agent-sandbox/create-an-agenticfs-volume) are native control-plane records for an existing Access Point. Its [mount API](https://help.aliyun.com/zh/agent-sandbox/mount-agenticfs-volume-1) uses a same-Team Volume name, mount role and complete reachable VPC configuration. A future backend must preserve immutable physical-storage identity and continuity proof; a successful sandbox file round trip or a mutable mount name alone is insufficient. Native storage management, a compatible worker image and end-to-end AgentSandbox qualification are outside this implementation.

## Open deployment inputs

- E2B Cloud API credentials with Volumes enabled and existing Volume IDs for registered Workspaces.
- A matching Linux worker image/template and protected wildcard worker ingress.
- A worker-reachable central HTTPS publication service and Artifact configuration for tools mode.
- Durable private adapter state and credentials, plus completion of the Java, MySQL, public Hosted, CI and real Cloud create/mount/restart/loss/close gates before production acceptance.
