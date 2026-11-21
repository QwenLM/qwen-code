# Managed Workspace tools and MCP composition

[English](2026-10-21-managed-mcp-management-reuse.md) | [简体中文](2026-10-21-managed-mcp-management-reuse.zh-CN.md)

Status: implemented with local process validation, based on `e63a0bfc23d2b97eddae7fefd02ab1c13552f30c`.

## Problem and chosen scope

Daemon MCP management configures its ACP process, not the selected Managed Runtime. Its manager shows resource metadata; ordinary ACP chat has separate resource-reading and prompt-expansion paths. Managed-only deployments need not have a daemon.

Managed pins private MCP recipes through an immutable AgentDefinition and the `hosted-workspace-mcp/1` profile. That profile provides Read/Write/Edit and MCP, but no Shell, backups/undo or Plan. Generic local Workspace-isolated workers already support persistent MCP connections; the dedicated CSI resident file-only contract is separate. Reusing a visual manager alone does not connect ordinary files/Shell Sessions to MCP.

The user selected ordinary Managed files/Shell plus MCP as the first delivery. Allow optional MCP pins on the ordinary public shell/1 profile, which already includes Read/Write/Edit and Shell, while preserving approvals, backups and lifecycle. The files-only/1 profile keeps rejecting pins. The unshipped Shell variants are now consolidated under shell/1, including native glob; removed Shell identifiers cannot be enabled by the deployment allowlist. Keep legacy MCP Sessions compatible. The same PR also adds Session management of published MCP definitions and reuses daemon display components, specified in [Session MCP management](2026-10-22-managed-session-mcp-management.md). Executable-recipe authoring and resource/prompt expansion remain separate.

## Admission and immutable configuration

Accept the existing AgentDefinition `mcp_servers` pins on `hosted-workspace-shell/1` and the legacy MCP profile. Other profiles keep rejecting nonempty pins. Legacy MCP still requires at least one server. Shell composition requires the Harness workspace-shell-mcp/1 feature and lifecycle v2 for shell/1; direct Hosted DELETE is refused in favor of that ordered close path. Preserve count, identity, revision, digest and deployment-capacity checks.

Reuse Session pinning of the exact AgentDefinition revision/digest and the connector's existing pin propagation. No new Session extension envelope, mutable defaults table or recipe-bearing public request is needed. Missing/corrupt definitions fail explicitly, with no latest-definition or host-settings fallback. Recipes and credentials remain in the deployment-owned Runtime manifest.

Snapshot-read-only children retain empty MCP capabilities. Foreground-only and dedicated CSI resident file profiles do not gain MCP. The ordinary profile names continue to describe their ordinary tools; admitted pins determine whether the Session owns MCP.

## Runtime ownership and ordinary tools

Use the Session-level MCP broker for both MCP and ordinary tools. Hooks share that broker as before. All calls retain original runtimeSessionId, binding, generation and durable execution identities. Unknown effects are queried on the original owner, never replayed on a replacement Runtime.

Ordinary profiles with MCP bind and persist file history through that shared owner. Write/Edit retain preimage backups and conflict checks; history and rewind remain available. Tool descriptions must reflect those semantics. Only legacy MCP keeps its no-backup/no-undo behavior. Preserve restrictions on saved native approval continuations rather than fabricating recovery support for an unrecognized owner.

Turn completion keeps the Session owner booked while MCP connections or uncertain operations remain. Close drains ordinary executions, background Shell work, Hooks and MCP through the ordered lifecycle protocol. Closing one logical Session must not stop a shared Workspace worker or another Session's connection. Preserve shell/1 lifecycle v2. For Sessions with MCP pins, separate stopping ordinary background work from releasing the Session owner: stop and persist outputs first, drain MCP, then release once. Shell Sessions without MCP keep their existing drain path, including original-worker stop-proof recovery. Verify ordinary results and MCP owner receipts together.

## Plan and context changes

The first delivery explicitly rejects Plan when an Agent has MCP pins, matching the existing MCP safety boundary. Session options, creation, Plan changes and Hosted admission must agree. It must never silently drop the configuration or initialize MCP after accepting a supposedly read-only Plan. MCP annotations do not grant read-only authority.

Ordinary file/Shell tools retain their selected approval mode. Existing native-approval takeover restrictions for Session-scoped owners remain fail-closed. Context changes respect the Session owner and live MCP holds: refuse unsupported changes rather than creating another owner or reporting success with stale context. A future Plan implementation needs durable ownership before MCP initialization, readonly declarations and resumable Plan approval; skipping ensureReady alone leaks an owner.

## Daemon reuse after composition

Keep daemon runtime polling, epochs, ACP reconciliation and OAuth inside its controller. Reuse its small configuration form and metadata/detail components with a separate Managed provider/controller. A committed Managed catalog must not be presented as a live daemon connection or assigned a fabricated epoch.

The smallest publication follow-up persists Runtime-private immutable recipes, then patches only the selected stored AgentDefinition's MCP pins using expected revision and stable idempotency identity. Reuse definition receipts and Session pinning. Workspace OWNER is not tenant-global Agent-edit permission: local management needs explicit single-user opt-in and loopback/actor checks; remote deployments need an Agent editing policy. Never persist executable recipes/secrets in AgentDefinition, Session records or browser caches.

The Runtime transport already supports resources/read and prompts/get, but normal Hosted declarations/execution only admit tools/call. A follow-up must extend that durable tool lane while preserving raw control's operation-grant requirement. Deterministic UI loading should be an initial typed tool batch, like selected Skills. Inserting ordinary @server:uri, /name or natural language in Managed text does not implement deterministic loading.

## API ownership and failures

| Surface                        | Ownership and behavior                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Admission                      | Persisted Workspace and actor authorization, then immutable definition pins                    |
| MCP catalog                    | Persisted Workspace read authorization; committed sanitized snapshot                           |
| Ordinary tools, MCP and rewind | Live Session owner; exact Runtime/binding/generation; no primary fallback                      |
| Close, cancel and recovery     | Original durable owner/effect; unknown remains unknown until original evidence settles         |
| Future configuration           | Persisted Workspace plus explicit Agent-edit permission; publication is not connection success |

No daemon route is added. Unknown, untrusted, unavailable, draining and removed Runtime targets retain existing explicit failure semantics.

## Affected components

- Java definition extension validation, admission/Plan capability checks and connector pin propagation.
- Hosted Session create/load and Plan validation, lifecycle/rewind owner selection and ordinary tool-turn backups.
- MCP Session warmup and broker use; Runtime transport and credential manifest remain compatible.
- Admission, lifecycle, Plan, backup and process tests. If public contract descriptions change, advance their numeric version and regenerate consumers.

## Validation

Record the global installed CLI baseline, then verify the source-matched bundle. Use isolated local stdio MCP, a deterministic model and disposable database. Do not touch user preview services, real Sessions or credentials.

Prove an ordinary Shell Session performs Read/Write/Edit, foreground Shell and a real MCP call, then reuses the same MCP process on another Turn. Verify durable results, backup/undo, Plan capability/admission/change refusal without transport effects, close/drain, retained old definition revisions and empty snapshot-child capabilities. Verify files-only/1 and removed Shell profile rejection separately and retain original-owner/no-replay regressions.

Run focused package tests, root build/typecheck/bundle, affected Java tests then Maven verify and applicable disposable MySQL/Hosted profiles. Distinguish selected tests from full-suite results and record skipped matrix cells. Local fixtures do not establish SSH, CSI, real upstream-model, Windows or production acceptance. Finish with two consecutive clean self-audit passes and independent review.

Local process validation on macOS with JDK 21 and disposable MySQL 8.4 passed Read/Write/Edit, foreground Shell, two-Turn stdio MCP reuse, backup conflict/rewind, explicit Plan refusal, public lifecycle v2 close and legacy MCP regression. Background Shell with MCP still needs a delegated Linux cgroup v2 acceptance run. The test report records exact artifact hashes, selected regression results and fixture failures separately; no full platform or upstream-provider acceptance is claimed.
