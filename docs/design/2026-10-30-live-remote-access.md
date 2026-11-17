# Enable remote access from Settings without restarting

[English](2026-10-30-live-remote-access.md) | [简体中文](2026-10-30-live-remote-access.zh-CN.md)

## Status and decision

Implemented design, 2026-10-30. The behavior is **remote access off by default, enabled from the UI while the daemon keeps running**. No additional terminal command, restart, second Qwen instance, or mandatory startup flag is part of the normal flow.

Older running versions and compatibility gateways are explicitly out of scope. Local runtime acceptance used isolated daemons, a browser, and controlled model providers. No existing remote service was modified.

## User experience

Start an ordinary daemon normally. Its primary listener remains local by default. At any later time, open that daemon's Settings → Connections → Allow remote connections and turn the switch on. After successful activation, the card shows the actual remote address and a masked bearer token with reveal/copy/reset actions. Another machine's Add remote connection form requires only that address and token.

Keep these two cards distinct:

- **Allow remote connections** controls access to the daemon serving this settings page. Show the daemon host explicitly. This card is available only to an authorized local operator.
- **Add remote connection** connects this client to another daemon. Adding a saved connection cannot change the target server's exposure policy.

While off, show “Remote access is off” and no usable credential. While enabling/disabling/resetting, show pending state and prevent duplicate operations. Report enabled only after listener and authentication are ready. On failure, retain the actual server state and show the reason. Read the state from the daemon on mount/reconnect; browser storage is not the source of truth.

Turn the switch off to revoke the remote credential and disconnect remote clients. Keep the primary local listener, workspace, sessions, and daemon-owned tasks running. Re-enabling issues a fresh token. Resetting a token also disconnects clients using the old token, with an inline explanation before the action. The token is masked until revealed and never included in ordinary URLs or diagnostics.

The toggle is a runtime setting: after a daemon restart, the default is off. Do not silently persist exposure. This implementation does not carry the earlier `--remote` startup-flag patch; UI activation does not require it. Preserve explicit legacy `--hostname` deployments. A pre-existing externally bound primary listener must not be represented as “remote access off” or falsely controlled by this toggle: show that it is externally configured and that this toggle manages a separate entrance.

## Architecture and ownership

Reuse the existing LocalControlService approach: create a new HTTP(S) listener in the same process over the existing application and attach its existing upgrade handlers. Local and remote entrances dispatch into the same workspace registry and session owners. Do not launch another agent, clone a workspace, or migrate sessions.

Separate remote-access policy from Local Control's private-LAN selection, pairing, and sleep policy. Reuse only suitable lifecycle/authentication primitives. Identify each entrance by listener identity, with its own Host authorities, origin matcher, token generation, and owned sockets. Do not add remote permissions to unrelated listeners or replace the primary operator token.

Remote-access state, enable/disable/reset operations, and address enumeration are **process-global**, even when opened from a workspace settings page. Workspace data remains selected-runtime scoped; sessions remain live-session-owner scoped. Unknown, removed, untrusted, or ambiguous runtimes must not fall back to the primary runtime.

Use local management HTTP routes behind the existing operator authority, Host, and request-origin guards. Only an authorized primary local context can enable access, reveal/reset the token, or change configuration. Remote credentials do not authorize these management routes. Do not treat CORS, a caller-supplied Host/forwarded header, or browser-local storage as authorization. Preserve a no-extra-terminal-command experience by integrating with existing local operator credential handoff where required; do not expose secrets to an unauthenticated browser merely to simplify the UI.

This is not a sandbox against a user already allowed to execute shell commands as the daemon OS user. Embedded/managed deployments retain their existing operator policy; unsupported management contexts show an explicit reason instead of granting additional privileges.

## Addresses and ports

Prefer the primary numeric port on one explicitly selected non-loopback interface. With a primary at `127.0.0.1:4173`, try the selected interface at port 4173 without changing the original socket. Actual bind success is authoritative; wildcard listeners and platform behavior can cause conflicts.

If there is one eligible interface, activation can select it automatically. With multiple candidates, the UI asks which interface to expose. Allow explicit selection of assigned corporate/VPN IPv4 addresses, including `11.*`; do not misclassify them as private or apply Local Control's private-address-only filter. Never silently expose all interfaces.

On collision or permission failure, keep the toggle off and show the attempted endpoint and reason. Offer an explicit alternate port in advanced settings. Do not silently allocate 4174/4175, kill another service, or rebind the primary. A changed entrance port still routes to the original sessions. Advertise the actual bound endpoint, not `0.0.0.0`. IPv6 requires complete client CSP, URL validation, Host, and upgrade support before it can be offered.

Listener activation does not prove reachability through a firewall or NAT. Do not alter firewall, router, DNS, or proxy configuration automatically. Use existing TLS configuration when applicable and explain HTTPS-page/HTTP-target restrictions. The UI must distinguish “enabled/listening” from “client verified”.

## Authentication and browser behavior

Create a separate high-entropy remote token and install its policy before accepting traffic. All protected HTTP, SSE, and WebSocket requests require that token even when the primary local service permits tokenless access. Use the supported browser WebSocket credential mechanism; do not put tokens in query strings. Ordinary status responses redact tokens; authorized reveal/activation/reset responses are non-cacheable.

Default browser origins cover `http://localhost:*`, `http://127.0.0.1:*`, and the remote entrance's canonical origin. Advanced settings can add exact custom origins at runtime. Do not allow arbitrary origins or `null`. Apply the same decision to HTTP and all upgrade handlers. Preflight for an allowed origin does not require a bearer, but actual protected operations do. Include appropriate CORS headers on auth errors so clients can read 401/403.

Keep origin-scoped client credential storage and browser-local file isolation. Save a candidate token only after successful authentication; failed attempts do not erase a working saved connection. Keep accurate 401, readable 403, mixed-content, and inconclusive network/CORS/certificate diagnostics. Connection setup copy points to the server's Settings toggle, not a mandatory command.

The focused host's sidebar badge follows the existing daemon availability state: connected, offline, or unauthorized. Selecting a host alone must not claim that it remains connected after remote access is revoked.

## Lifecycle and continuity

Serialize `disabled -> enabling -> enabled -> disabling -> disabled` transitions. Repeated enable must be idempotent and must not rotate the token. Read actual state after a lost response. Opening a listener must be transactional: prepare credentials and handlers first, commit enabled state only once listening, and roll back only the newly allocated resources on failure.

Disable closes admission and revokes the token before tearing down the entrance. Track and close entrance-owned keep-alive, SSE, and upgraded WebSocket connections with bounded cleanup. Do not use daemon-wide shutdown or dispose shared session/ACP resources. HTTP `closeAllConnections()` alone does not close upgraded WebSockets.

Token reset invalidates the old generation and its active remote connections while preserving tasks. Re-enable after disable starts a fresh generation. Daemon shutdown disposes its remote entrance; restart defaults to off without restoring the UI runtime grant. UI reload alone does not disable access.

Audit disconnect cancellation semantics. Detaching a remote transport must not implicitly cancel daemon-owned jobs or terminate unrelated local clients. Reconnect targets the same session ID and uses existing event cursors where supported. Never replay prompts/tool mutations or create a substitute session automatically. Client-owned transient media streams may end; do not promise replay of unbuffered data.

## Implementation and acceptance

1. Add daemon-owned remote-access lifecycle and listener-specific policy using existing primitives; retain Local Control behavior.
2. Add process-global, locally authorized status/enable/disable/reveal/reset and origin configuration operations, including safe token presentation.
3. Build the Settings toggle and address/token card, pending/error states, optional interface/port/origin controls, and clear separation from Add remote connection.
4. Leave out the earlier `--remote` patch. Preserve ordinary loopback defaults and internal/embedded launch contracts across both CLI parsers.
5. Complete one consolidated isolated verification pass when authorized; never use the active remote 4173 service as a fixture.

Acceptance requires:

- Ordinary startup has no new remote listener; the settings toggle is off.
- Start a task, enable from the UI, and connect from another machine using only address/token. No terminal command, restart, or second runtime is involved; original PID, workspace, session ID, and task progress remain continuous.
- HTTP, SSE, and every advertised WebSocket feature work from a local page on an arbitrary port. Direct remote Web Shell use follows the same auth/origin policy.
- Disable/reset revokes established remote connections and old credentials while local clients and daemon-owned tasks continue. Re-enable and reconnect return to the original sessions without mutation replay.
- Failed binding, duplicate clicks, concurrent tabs, lost management responses, daemon drain, and browser refresh display the actual committed state without leaks or false success.
- Bad tokens, unrelated origins, forged Host/forwarded headers, and remote management attempts fail across HTTP and upgrades; token values do not appear in normal logs, URLs, or status responses.
- Multi-interface selection and port conflicts are explicit. Existing externally configured primary listeners are never falsely shown as disabled by this switch.
- Local Control, explicit binds, managed/Desktop/IDE deployments, and programmatic users keep their declared behavior.

Local acceptance covered the Settings flow, cross-origin address/token connection, four HTTP/SSE and WebSocket task-continuity scenarios across disable/reset, token/Host/origin enforcement, port collisions, restart defaults, and explicit external-primary compatibility. Two independently configured daemons also verified that messages submitted from one daemon's page are processed and persisted only by the selected remote daemon, with unchanged process IDs and the same session after reconnecting. Targeted tests, affected-package typechecks, and the Web Shell application build passed. These checks used the local machine’s assigned interface and controlled providers; they do not establish reachability from another machine through its firewall or NAT. No remote deployment was performed.

## References

- [Existing Local Control design](local-control-cli.md).
- [Existing remote Web Shell design](remote-web-shell-daemon.md).
- [Node.js HTTP shutdown](https://nodejs.org/api/http.html#servercloseallconnections): upgraded sockets need explicit teardown.
- [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) and [mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content).
