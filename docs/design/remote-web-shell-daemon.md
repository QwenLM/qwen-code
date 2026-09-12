# Remote Daemon Connections from Web Shell

[English](remote-web-shell-daemon.md) | [简体中文](remote-web-shell-daemon.zh-CN.md)

Status: Implemented for [#11475](https://github.com/QwenLM/qwen-code/issues/11475)

## Problem

Web Shell already sends workspace, session, file, SSE, and WebSocket requests through one daemon `baseUrl`, but its standalone entry point rejects an explicitly selected daemon on another origin. A Web Shell page therefore cannot connect directly to an already-running remote daemon.

## Goals

- Let a Web Shell URL select one remote daemon with `?daemon=<origin>`.
- Let users enter or replace the daemon address and optional bearer token in Web Shell.
- Keep the remote daemon as the sole owner of workspaces, sessions, files, terminals, and execution.
- Preserve reconnect and session navigation on the selected daemon.
- Keep bearer credentials isolated by daemon origin.

## Non-goals

- Desktop integration, managed SSH, daemon installation, discovery, relay, federation, or virtual filesystems.
- Simultaneous session streams or execution across multiple daemons.
- Starting or stopping an externally managed daemon.

## Design

The connection address is an HTTP origin such as `https://daemon.example.com`, an internal-network endpoint such as `http://10.0.0.8:4170`, or, for a user-managed SSH tunnel, `http://127.0.0.1:4170`. Credentials, paths, query strings, and fragments are rejected so one address always identifies one daemon origin. HTTPS should be used outside trusted networks because HTTP exposes daemon traffic and bearer tokens in transit.

The standalone Web Shell reads the `daemon` query parameter and passes that origin to the existing `DaemonWorkspaceProvider`. Its existing SDK clients then send REST, SSE, file, session, and terminal WebSocket traffic directly to that daemon. Session navigation preserves the `daemon` parameter.

The pre-connection gate always exposes a daemon address and optional token form, including when the URL contains an invalid target. Once connected, the existing Daemon Status overview shows the current target and connection state and provides the same switch controls. Switching performs a full page navigation, clears the selected session, workspace, and context from the URL, and creates a fresh SDK client for the new daemon. It does not probe or fall back to another runtime.

The standalone sidebar keeps a browser-local catalog of local and remote projects, keyed by daemon origin and workspace ID. Only project identity and display names are stored in localStorage, never tokens. Choosing a project navigates to its daemon and workspace; only the active daemon supplies live sessions. Unreachable hosts do not remove the saved projects, and the connection gate offers a return to local or another saved host. Embedded consumers retain their existing single-provider interface.

Adding a workspace starts with a local/remote choice. Local means the daemon serving the page (the local Vite proxy in development), not browser filesystem access. Remote accepts an HTTP(S) origin and an optional origin-scoped token. Changing hosts navigates first, so the new document receives the selected daemon's CSP; an `addWorkspace` continuation flag reopens the directory step after authentication and is then removed. Adding a folder on the daemon the page is already connected to registers it in place through the app's existing workspace flow. Directory suggestions and registration use that daemon. Already-registered directories are selected without duplication; requesting persistence first promotes a temporary registration and verifies that it was saved. Native folder selection is available only for the local target when advertised by its capabilities. Sessions, files, terminals and execution continue through the selected SDK client.

Bearer tokens remain in per-tab `sessionStorage`, but are keyed by daemon origin. The legacy unqualified key is used only for same-origin connections. Selecting a remote daemon never reuses a token stored for the page's own daemon or another remote daemon.

When the HTML shell is served by `qwen serve`, its CSP adds only the validated selected daemon origin and the corresponding `ws:` or `wss:` origin to `connect-src`. The remote daemon must independently allow the Web Shell page origin with `--allow-origin`; existing Origin, Host, and bearer checks remain authoritative.

Disconnecting or closing the browser only disposes the client connection. It does not stop the externally managed daemon; existing daemon-side client-detach and session-retention policies remain unchanged.

## Failure and Security Boundaries

- Browser-local directory grants are stored per daemon origin. A remote daemon never restores a grant saved for the page’s own daemon or another remote host; users must select a directory for that daemon explicitly.
- Successful connection confirmation is recorded independently of sidebar visibility; project metadata is synchronized by the app lifecycle.
- Invalid remote addresses are reported by the connection gate and are not contacted.
- Authentication, Origin, Host, and network failures stay explicit in the existing connection gate; there is no fallback from a valid selected remote daemon to a local runtime.
- A URL selecting an attacker-controlled daemon cannot cause a token for another daemon to be sent to it.
- A page load whose `?daemon=` names an origin that is not the page's own daemon, not a host already in the catalog, and not one just chosen in this tab is not probed. The connection gate shows the origin and waits for the user to connect; a token typed there goes only to that origin.
- A loopback URL selected through `?daemon=` may be an SSH tunnel and is not treated as proof that the daemon host is the browser host.
- HTTP and HTTPS targets are accepted. HTTPS is recommended outside trusted networks. SSH transport, if desired, is supplied by the user as a loopback tunnel outside Qwen Code.

## Validation

- Unit-test address validation, token isolation, query preservation, and CSP sources.
- Start local Web Shell and a token-configured daemon on a remote host, then connect by entering the address and token in the browser.
- Verify the local page lists the remote workspace, obtains remote directory suggestions, lists and references remote files, and loads a remote session transcript.
- Verify the target and selected session remain selected after refresh without re-entering the token.

## Acceptance Criteria

The standalone add flow shows a persistent directory list and a parent-folder action. Clicking a folder opens it, Enter in the path field never adds, and only the add button registers the folder shown in the path field. The folder basename is suggested as the display-name placeholder. Supplying a name for an already-registered folder updates its display name before opening it. Cancellation after changing hosts returns to the original same-origin page, including its session and workspace; successful addition does not trigger this cancellation navigation. The sidebar groups projects by host, with the connected host's live list first and saved projects on other hosts below it; remote projects use server icons, project action menus stay discoverable, and the chat header labels the active host, with the working directory in the label's tooltip. Existing removal confirmation continues to explain that files and session history are not deleted.

- A Web Shell page can connect directly to a configured remote daemon origin.
- An invalid or unavailable target can be replaced from the connection gate, and a connected target can be switched from Daemon Status.
- Workspace and session discovery and file/terminal operations use the selected daemon through the existing SDK.
- Credentials are never reused across daemon origins.
- Remote selection survives navigation and refresh.
- Adding a remote project keeps local projects available, and both can be selected from the same sidebar.
- Invalid addresses and daemon policy/authentication failures are explicit and do not fall back to another runtime.
