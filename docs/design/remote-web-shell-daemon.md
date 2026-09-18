# Remote Daemon Connections from Web Shell

[English](remote-web-shell-daemon.md) | [简体中文](remote-web-shell-daemon.zh-CN.md)

Status: Web Shell milestone for [#11475](https://github.com/QwenLM/qwen-code/issues/11475)

## Problem

Web Shell already sends workspace, session, file, SSE, and WebSocket requests through one daemon `baseUrl`, but its standalone entry point rejects an explicitly selected daemon on another origin. A Web Shell page therefore cannot connect directly to an already-running remote daemon.

## Goals

- Let a Web Shell URL select one remote daemon with `?daemon=<origin>`.
- Let users enter or replace the daemon address and optional bearer token in Web Shell.
- Remember successfully verified remote computers so workspace creation can reuse them.
- Keep the remote daemon as the sole owner of workspaces, sessions, files, terminals, and execution.
- Preserve reconnect and session navigation on the selected daemon.
- Keep bearer credentials isolated by daemon origin.

## Non-goals

- Desktop integration, managed SSH, daemon installation, discovery, relay, federation, or virtual filesystems.
- Aggregating more than one daemon in a single Web Shell instance.
- Starting or stopping an externally managed daemon.

## Design

The connection address is an HTTP origin such as `https://daemon.example.com`, an internal-network endpoint such as `http://10.0.0.8:4170`, or, for a user-managed SSH tunnel, `http://127.0.0.1:4170`. Credentials, paths, query strings, and fragments are rejected so one address always identifies one daemon origin. HTTPS should be used outside trusted networks because HTTP exposes daemon traffic and bearer tokens in transit.

The standalone Web Shell reads the `daemon` query parameter and passes that origin to the existing `DaemonWorkspaceProvider`. Its existing SDK clients then send REST, SSE, file, session, and terminal WebSocket traffic directly to that daemon. Session navigation preserves the `daemon` parameter.

The pre-connection gate always exposes a daemon address and optional token form, including when the URL contains an invalid target. Once connected, the existing Daemon Status overview shows the current target and connection state and provides the same switch controls. Switching performs a full page navigation, clears the selected session, workspace, and context from the URL, and creates a fresh SDK client for the new daemon. Reconnecting to the target already in use reloads in place instead, so the selected session, workspace, and context survive it exactly as they survive a plain refresh. It does not probe or fall back to another runtime.

The existing sidebar remains the workspace and session management UI. Settings includes a **Connections** category where remote computers are added, reviewed, forgotten, or selected. A successful remote connection records only its validated origin in a browser-local connection catalog; bearer tokens remain tab-scoped. The normal **Add workspace** action opens the directory browser directly. Its **Folder source** selector lists this computer and the connected remote computers, matching the source-selection pattern used by Codex project creation without adding a separate Local/Remote step. Selecting a computer this tab is not already connected to navigates to that daemon and resumes the same directory browser; selecting the daemon already in use keeps it open in place without reloading the shell. The browser uses daemon-provided directory suggestions, supports parent-directory navigation and manual absolute paths, and registers the selected directory through the existing workspace mutation. Native folder selection remains hidden for remote daemons. A cross-origin daemon is named once as a host chip beside the sidebar's Project heading, and each remote workspace row uses a folder icon with a small blue globe so local and remote folders remain visually distinct. Session discovery, transcript loading, file references, terminal traffic, and execution require no parallel remote-specific implementations because they already use the selected SDK client.

The add operation remains a one-shot flow. The source URL is kept only in the current tab while navigation is in progress. Cancel returns to that URL, changing **Folder source** continues the same browser on the selected computer, and a successful registration stays on the selected daemon and clears the continuation state. The connection catalog stores origins only; it does not cache remote workspaces or aggregate projects from multiple daemons. Ordinary daemon switches do not resume the flow.

Bearer tokens remain in per-tab `sessionStorage`, but are keyed by daemon origin. The legacy unqualified key is used only for same-origin connections. Selecting a remote daemon never reuses a token stored for the page's own daemon or another remote daemon.

When the HTML shell is served by `qwen serve`, its CSP adds only the validated selected daemon origin and the corresponding `ws:` or `wss:` origin to `connect-src`. The remote daemon must independently allow the Web Shell page origin with `--allow-origin`; existing Origin, Host, and bearer checks remain authoritative.

Disconnecting or closing the browser only disposes the client connection. It does not stop the externally managed daemon; existing daemon-side client-detach and session-retention policies remain unchanged.

## Failure and Security Boundaries

- An unfamiliar `?daemon=` target waits for explicit confirmation before any probe. A target is added to the persistent connection catalog only after its capabilities probe succeeds.
- The browser-local file bridge is offered only when the connected daemon is the page's own origin, in the standalone and embedded shells alike: a cross-origin target never mounts it, so a client directory cannot be handed to a remote daemon whose panel copy promises files stay on the computer. Remote workspace files remain available through the selected daemon. The same-origin SSH-tunnel deployment keeps its behavior and origin-scoped grants.
- The remote-add continuation is explicit, tab-scoped, and one-shot. It reuses the origin-only connection catalog but does not persist a project catalog, aggregate workspaces from multiple daemons, or alter ordinary daemon switching.

- Invalid remote addresses are reported by the connection gate and are not contacted.
- Authentication, Origin, Host, and network failures stay explicit in the existing connection gate; there is no fallback from a valid selected remote daemon to a local runtime.
- A URL selecting an attacker-controlled daemon cannot cause a token for another daemon to be sent to it.
- A loopback URL selected through `?daemon=` may be an SSH tunnel and is not treated as proof that the daemon host is the browser host.
- HTTP and HTTPS targets are accepted. HTTPS is recommended outside trusted networks. SSH transport, if desired, is supplied by the user as a loopback tunnel outside Qwen Code.

## Validation

- Unit-test address validation, token isolation, query preservation, and CSP sources.
- Start local Web Shell and a token-configured daemon on a remote host, then connect by entering the address and token in the browser.
- Add a remote computer in **Settings > Connections**, choose the normal **Add workspace** action, select that computer from **Folder source**, browse its directories, register one, and verify that the new workspace becomes active on that daemon.
- Verify that changing **Folder source** keeps the directory browser open, Cancel returns to the exact source page without a token or continuation marker, and an ordinary daemon switch never opens the directory browser.
- Verify the local page lists the remote workspace, obtains remote directory suggestions, lists and references remote files, and loads a remote session transcript.
- Verify the target and selected session remain selected after refresh without re-entering the token.

## Acceptance Criteria

- A Web Shell page can connect directly to a configured remote daemon origin.
- An invalid or unavailable target can be replaced from the connection gate, and a connected target can be switched from Daemon Status.
- The standalone Settings panel exposes a Connections category for managing verified remote computer origins.
- The sidebar exposes one Add workspace action that opens the directory browser directly; its Folder source selector can switch between this computer and a verified remote connection, continue after navigation, browse daemon directories, and register the selected absolute path.
- Cancel returns to the source shell predictably, while changing Folder source keeps the browser flow active and a completed add stays on the selected daemon; the persistent catalog contains connection origins, never remote project data or bearer tokens.
- Workspace and session discovery and file/terminal operations use the selected daemon through the existing SDK.
- Credentials are never reused across daemon origins.
- Remote selection survives navigation and refresh.
- Invalid addresses and daemon policy/authentication failures are explicit and do not fall back to another runtime.
