# Managed Personal HTTP MCP OAuth

[English](2026-11-08-managed-personal-mcp-oauth.md) | [简体中文](2026-11-08-managed-personal-mcp-oauth.zh-CN.md)

## Status and dependency

Implementation split from `4736349cbe5d60f39251a148ef17df5f764a03bb`, 2026-11-08. This delivery depends on the archive/form installation in PR #16500 and is independent of Runtime Skill discovery. Keep authorization storage, protocol, execution identity and token delivery together. Default-off implementation and focused tests do not establish deployment isolation or real-provider acceptance.

Reuse the [English installation design](2026-11-07-managed-skills-mcp-self-service.md) and [Chinese installation design](2026-11-07-managed-skills-mcp-self-service.zh-CN.md). This PR introduces no Runtime candidate/snapshot endpoints, Git/npm acquisition or new isolation platform.

## Personal authorization model

A user signs into a third-party provider and authorizes Managed to access the HTTP MCP resource as that user. Grants are actor-owned, not Workspace service settings. Do not import daemon tokens or personal stdio credentials. Existing Workspace read permissions continue to govern Session history and results; authorization UI must state this visibility explicitly.

One Session's personal bindings belong to one execution actor. Other authorized members can read history, cancel work or explicitly remove personal bindings, but cannot borrow the actor's credentials through prompt, approval or execution recovery. Child, channel, automation and unattended wake execution refuse inherited personal bindings until an identity delegation protocol exists.

## Storage and versioned configuration

Add encrypted `ma_mcp_credential` and expiring single-use `ma_mcp_oauth_attempt` records to the shared V1 schema baseline and all schema/projection/CSI consumers. Grants bind tenant, Workspace, actor, server, provider, resource, scopes, generation and revocation state. Attempts bind the initiating actor/server, hashed state/browser nonce, encrypted PKCE verifier/code, expiry and exchange state. Reuse `SecretProtector`; recreate disposable development catalogs rather than adding V2 migrations.

Packages contain only non-secret OAuth declarations. OAuth packages explicitly require schema/compiler version 2; ordinary packages remain version 1. Session apply uses `selectionVersion: 2` and `mcpAuthBindings`, and the effective bundle records its execution actor with format version 2. Binding references are not stored in shared archives or Workspace settings. Legacy apply cannot silently erase personal bindings.

A package/settings pin change requires explicit validation of personal bindings against the replacement server. Do not blindly carry grants to changed pins or silently discard authoritative revoked bindings. Removing authorization applies a new v2 configuration revision while retaining unrelated pins. AgentDefinition/new-Session package selection cannot bootstrap personal OAuth; first create the Session, then explicitly install and authorize.

## Browser authorization

Use deployment-pre-registered provider/client configuration, fixed redirect URI, PKCE S256 and resource/scope validation. Dynamic client registration is outside this version. Expose authenticated query/start/status/complete/revoke operations under `/v1/agents/sessions/{sessionId}/mcp-oauth` and corresponding WebShell/SDK contracts.

1. An authenticated user starts an attempt with a browser nonce; the attempt expires within ten minutes.
2. Open the provider's authorization page.
3. The fixed `/oauth/mcp/callback` validates state/issuer and temporarily stores the encrypted code. It relies on neither tenant nor actor headers supplied by the provider redirect.
4. The original page uses its authenticated host identity and browser nonce to complete the attempt.
5. Validate actor/attempt ownership, exchange the code once and return a non-secret credential reference.
6. Explicitly bind that reference through normal Session configuration apply.

Keep the validated provider link in memory across pending status polls for the same attempt so a blocked or closed popup retains an explicit recovery route. A different attempt or terminal state does not inherit that link.

Keep callback pages and logs free of code/token values. Preserve no-store, no-referrer and restrictive CSP headers. Provider metadata, token endpoints and redirects obey deployment network policy; private destinations require explicit allowance. Preflight address checks are not connection-time DNS pinning, so DNS-rebinding/network enforcement still needs deployment evidence.

## Execution and token boundary

Establish the execution actor inside the durable configuration commit barrier. Recheck command admission, actual queued dispatch, approval/resume and token issuance, including commands queued before bindings were enabled. Keep SQL actor checks inside existing locked admission helpers without changing lock order.

The Managed HTTP adapter obtains a current access token for each Streamable HTTP or SSE request. Delivery is bound to Session, exact server/configuration revision, credential generation and current Runtime lease/owner, with checks before and after issuance. Refresh tokens stay in the control plane. The Runtime never opens an interactive login flow and fails explicitly when authorization is unavailable.

Use database refresh leases/CAS without holding a long transaction across provider network calls. Late exchanges cannot overwrite a revoked generation. An unknown authorization-code exchange or rotating-refresh outcome requires reauthorization; do not retry blindly. A proven refusal before sending a tool request can settle normally, while unknown effects after sending remain unknown. Authentication recovery never replays an uncertain MCP tool call.

Revocation blocks subsequent issuance immediately and attempts provider grant revocation and connection retirement. Already issued bearer tokens/open streams remain subject to provider expiry/revocation. Keep the active configuration authoritative until explicit removal, and retain query/revoke/repair operations when new authorization and token delivery are disabled.

## Capability and deployment gating

Advertise `managed-mcp-oauth/1` only with the matching protocol and implementation. Configure default-off `qwen.managed-agent.mcp-oauth`, fixed callback, private Runtime token proxy and an explicit allowlist of qualified isolated tool profiles. Pool capabilities must be homogeneous.

Configure the standalone `qwen.managed-agent.mcp-oauth` bean in deployment configuration:

| Property                       | Type and default       | Meaning                                                                       |
| ------------------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| `enabled`                      | boolean, `false`       | Allow new personal authorizations and token issuance only after qualification |
| `callback-uri`                 | string, unset          | Fixed external URI ending in `/oauth/mcp/callback`                            |
| `runtime-token-proxy-base-url` | string, unset          | Private Broker token-delivery origin, using HTTPS or allowed loopback HTTP    |
| `isolated-tool-profiles`       | list of strings, empty | Explicit allowlist of independently qualified execution profiles              |
| `providers`                    | YAML map, empty        | Pre-registered providers keyed by the public provider ID                      |

A provider entry declares `issuer`, `resource-uri`, `resource-metadata-uri`, `authorization-metadata-uri`, `authorization-endpoint`, `token-endpoint`, `client-id` and `scopes`. The metadata must match the configured issuer/resource/endpoints and advertise S256. If it declares supported token-endpoint authentication methods, they must include the configured client authentication method. `revocation-endpoint` and `client-secret` are optional; a secret uses `client_secret_post`, while a public client uses `none`. `allow-private-network` and `allow-insecure-loopback` default to false and require an explicit deployment decision. Client secrets stay in deployment configuration and never enter a package or browser journal.

The existing generated configuration reference processes only `ManagedAgentProperties`; these standalone-bean settings are documented here and in the server README. This split does not expand the Maven metadata processor's source selection or claim validation against newly compiled metadata.

Enable only after proving that other actors' execution processes cannot read the Hosted process holding tokens, its service identity or its delivery channel. Directory isolation, owner fencing, cgroups or same-UID separation alone do not prove that property. Unsupported profiles fail closed; this PR does not build a new isolation platform.

## Verification and review carryover

Run affected compiler/protocol, Hosted selection/recovery, HTTP token and WebShell authorization/install tests and TypeScript builds/typechecks. Verify callback replay, browser nonce, cross-actor prompt/approval/resume, old-client writes, token changes on surviving connections, refresh/revoke races, worker replacement and unknown tool outcomes. Public API/SurfaceRegistry gates, real MySQL, a controllable OAuth provider and real process/isolation acceptance require matching CI/deployment evidence. The shared local Java budget remains exhausted across the split.

Keep original #16500 review links and prior deferrals visible. Review carryover includes changed-pin binding reuse policy, abandoned refresh leases requiring explicit reauthorization, revoked bindings requiring explicit removal, complete error-response documentation and provider/network qualification. Moving code does not resolve those discussions or assert full audit convergence. Logs and metrics contain only operation/phase/outcome identifiers, never grants, codes or tokens.
