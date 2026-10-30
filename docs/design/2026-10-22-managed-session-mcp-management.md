# Managed Session MCP management

[English](2026-10-22-managed-session-mcp-management.md) | [简体中文](2026-10-22-managed-session-mcp-management.zh-CN.md)

Status: design and implementation in progress. Completes the runtime-management scope of [#15079](https://github.com/QwenLM/qwen-code/issues/15079), together with [ordinary Workspace tools and MCP](2026-10-21-managed-mcp-management-reuse.md).

## Problem

Managed exposes a committed MCP catalog but no public management commands. Daemon management operates its own ACP process; calling those routes from Managed would change the wrong execution environment. Hosted already persists configuration and operation receipts, reconfigures connections, and drains them on close. Its private configure route is insufficient as a public API: it lacks full idle gating, only authorizes admission-time server identifiers, and does not expose a user-visible settings revision.

## Version and authorization policy

Keep the Session's original AgentDefinition revision and digest immutable, including Skills and approval policy. An explicit MCP command creates a new Session-local settings revision. Two Sessions in one Workspace may therefore have different MCP selections. No command follows a latest AgentDefinition or a latest recipe automatically.

Only an actor with the existing Workspace execution permission may manage a visible, active public Session. Preserve creator execution grants, migration/admission checks, lifecycle exclusion, Plan refusal, snapshot-read-only emptiness and original Runtime ownership. Reading a committed catalog retains its existing read authorization. Management never falls back to a daemon primary or a local Runtime.

Add and edit select an exact published server revision and digest from the selected Runtime's tenant-and-Workspace-scoped private manifest. Return only identifier, revision, digest and transport, never commands, arguments, environment, URLs, headers or credentials. Unpublished executable recipes cannot be submitted through this API. Publishing new private recipes remains deployment administration; it is not implied by Workspace permission. A fresh Session without initial MCP pins may explicitly select published servers when its ordinary shell/1 lifecycle and Harness capabilities support this feature.

## Durable settings and commands

Store a bounded Session-local settings snapshot in the existing registered configuration-installation journal domain. Its envelope supplies revision, operation identity and predecessor reference. The closed MCP content contains exact pins and enabled/removed state; removed entries remain tombstones so restoration can authorize historical configuration records. The bound is 32 distinct historical server identities, including removed entries, and 16 enabled servers. A server identity cannot move to a lower definition revision after removal; deployments publish a new identity when resetting a definition lineage. Admission pins are revision zero. Preserve old logs without a settings snapshot.

Every command carries an actor-scoped stable operation identity and expected settings revision. A retry queries the same original command; different content under the same identity conflicts. Concurrent revisions conflict before execution. Persist requested settings before changing physical connections, then record completion with existing MCP configuration/release receipts. An uncertain original effect blocks new work and is reconciled on its original owner; it is never replayed on another Runtime. Restart recovery retains command identity across interruption between release and configure. Historical drain status examines only configurations that existed before that command's durable intent, so a later enable cannot undo a completed disable receipt. The settings append transaction rechecks Plan, Turn and lifecycle admission under the same Session lock those mutations take.

The public and WebShell APIs expose a management snapshot, available published pins, management commands and command status. The management snapshot distinguishes requested settings, completed physical configuration and stale catalog metadata. It must not pick an older successful catalog's revision as the command concurrency token. Advertise capabilities so an older Harness cannot appear to support commands it does not implement.

Management attaches only to a Session already resident in the current Harness. Reattaching validates its identity and returns the existing reference without cleanup, recovery or wake dispatch. After a Harness restart, continue or recover the Session through its normal execution flow before opening management; otherwise return `hosted_mcp_session_load_required`. A new Session admitted without input may create its first journal through management without submitting a Turn. Creation conflicts and unknown creation outcomes may only reattach to that same resident Session, never implicitly load a cold journal. Command status never creates a Session. A cleanup-only recovery attachment also refuses management attachment, queries and commands until an explicit ordinary execution load upgrades it; management must not initialize extensions or commit settings through that restricted attachment. The control plane caches management-only references separately from ordinary attachments; a management read cannot certify a Turn takeover or cancellation recovery. The first ordinary Turn after management initializes an empty Session performs a normal passive attachment to that resident Session before publishing its ordinary reference. Generation changes and final detach/close evict both kinds of reference.

Ordinary rewind acquires a shared MCP broker through the MCP owner so that its mount bookkeeping and ordered release remain consistent. Historical Hook receipts select the original owner for cleanup, but do not alone prove a current mount hold. Pending MCP directory lookups fence only the matching Runtime Session; Workspace drain inspection retains the aggregate count. Atomic MCP settings refusals remain definite non-commits after a transport retry because the store replays an already committed command before evaluating the admission guards.

## Operations

| Operation | Behavior                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------- |
| Add       | Select an exact published pin and connect it without recreating the Session.                      |
| Edit      | Explicitly replace a selected server's published revision; preserve all unrelated selections.     |
| Remove    | Drain that server and retain a removed tombstone; leave other servers and ordinary tools running. |
| Disable   | Drain the server and persist its selected pin as disabled.                                        |
| Enable    | Reconnect the exact selected pin, preserving the Session and conversation.                        |
| Reload    | Reconfigure an enabled selected server and publish its current catalog.                           |
| Restart   | Prove the selected old connection drained before configuring its replacement.                     |

All operations refuse an active Turn, Hook, rewind, lifecycle phase, concurrent MCP command or unsettled original effect. Disabled or removed servers are absent from model declarations and resource/prompt execution. Close drains every retained physical configuration, including configurations superseded by a settings change, then releases the original shared owner once. Ordinary Shell/file history retains the established owner and backup semantics. Do not close or restart a shared worker to restart one server.

## Runtime and UI reuse

Reuse the existing MCP configure/release protocol and operation grants. Add only a bounded, scoped inventory read for published pin metadata. Inventory is not connection health. A successful restart requires an observed release receipt and a subsequent configuration receipt; a catalog refresh alone is insufficient.

Extract small server-card, tool-schema and resource-metadata display components from the daemon manager. The daemon retains its ACP lifecycle, epochs, discovery polling and OAuth controller. A Managed manager uses its own provider commands and Session settings; do not fabricate daemon epochs, connected state or tool validation. Offer published definitions rather than a raw executable-recipe form.

Use the MCP tab in Plugin management as the visible Managed MCP management entry. It receives the selected Managed Session and Workspace through the existing application state. Remove duplicate Manage MCP entries from conversation headers and Session row menus, including the standalone conversation view. The composer catalog remains bound to the selected conversation, and the existing view-visibility scope change refreshes it when returning from Plugin management. Key request scopes by provider, client, Workspace and Session. Abort requests and discard late results on a target change; preserve operation identity for a retry on the original target. An explicit retry first queries the original operation, then resubmits the saved original command with the same identity only if it remains pending or requires recovery. Query failures never trigger a mutation, and refresh never resubmits automatically. When the provider has an explicit tenant-and-actor storage namespace, retain only the unconfirmed command's public pin metadata and request identity in tab session storage; clear it after terminal confirmation. Providers without that namespace retain commands only in memory. No executable recipes or credentials enter browser storage. Use shared WebShell primitives and the scoped portal root. Resource bodies and prompt expansion are not part of this management change.

## API ownership

| Surface                        | Owner                                                                      |
| ------------------------------ | -------------------------------------------------------------------------- |
| Committed catalog              | Persisted Session and Workspace read grant                                 |
| Management commands and status | Authorized public Session, its journal writer and original Runtime owner   |
| Published inventory            | Selected Runtime, exact tenant and Workspace; private recipes remain there |
| Daemon manager                 | Existing selected ACP Workspace, unchanged                                 |

Advance OpenAPI, regenerate WebShell types, update mapped surfaces and contract gates. No new daemon route or mutable AgentDefinition default is introduced.

## Verification

Dry-run the baseline using global `qwen`; record the absence of management separately from existing composition evidence. Verify the built CLI, Java service and WebShell together using disposable MySQL, two real stdio servers and a deterministic model. Exercise all operations in one Session, stable conversation identity, unchanged original definition pins, no credentials in responses, model declaration changes, disabled-state persistence after a Harness restart and cold load, idempotent retries, stale-revision refusal, isolation between Sessions and final close.

Verify failed and unknown releases cannot claim restart success or start a replacement; active Turns and unauthorized actors cannot mutate. Verify empty and read-only Sessions, unsupported profiles, old logs, provider/Session switches, responsive manager controls and the existing daemon manager. Run affected package tests, root build/typecheck/bundle, Java API/surface gates, Maven verify and applicable MySQL/Hosted profiles. Inspect the complete diff twice and obtain independent review. Local process and browser evidence does not establish Linux cgroup, SSH/CSI, Windows or real upstream-provider qualification.

The Plugin-only entry adjustment has a focused UI plan at `.qwen/e2e-tests/managed-mcp-plugin-only/plan.md`: use the running main-based service for baseline, verify selected-Session queries through Plugin management and preserved conversation drafts, and publish the separately built static frontend without restarting the services. This UI adjustment does not change management commands, authorization, Runtime ownership or the broader acceptance matrix.
