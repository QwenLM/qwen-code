# Remote Daemon Connections from Web Shell

[English](remote-web-shell-daemon.md) | [简体中文](remote-web-shell-daemon.zh-CN.md)

Status: Web Shell milestone for [#11475](https://github.com/QwenLM/qwen-code/issues/11475)

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
- Aggregating more than one daemon in a single Web Shell instance.
- Starting or stopping an externally managed daemon.

## Design

The connection address is an HTTP origin such as `https://daemon.example.com`, an internal-network endpoint such as `http://10.0.0.8:4170`, or, for a user-managed SSH tunnel, `http://127.0.0.1:4170`. Credentials, paths, query strings, and fragments are rejected so one address always identifies one daemon origin. HTTPS should be used outside trusted networks because HTTP exposes daemon traffic and bearer tokens in transit.

The standalone Web Shell reads the `daemon` query parameter and passes that origin to the existing `DaemonWorkspaceProvider`. Its existing SDK clients then send REST, SSE, file, session, and terminal WebSocket traffic directly to that daemon. Session navigation preserves the `daemon` parameter.

The pre-connection gate always exposes a daemon address and optional token form, including when the URL contains an invalid target. Once connected, the existing Daemon Status overview shows the current target and connection state and provides the same switch controls. Switching performs a full page navigation, clears the selected session, workspace, and context from the URL, and creates a fresh SDK client for the new daemon. It does not probe or fall back to another runtime.

The existing sidebar remains the workspace and session management UI. Workspace registration uses typed absolute paths and daemon-provided directory suggestions; native folder selection remains hidden for remote daemons. Session discovery, transcript loading, file references, terminal traffic, and execution require no parallel remote-specific implementations because they already use the selected SDK client.

Bearer tokens remain in per-tab `sessionStorage`, but are keyed by daemon origin. The legacy unqualified key is used only for same-origin connections. Selecting a remote daemon never reuses a token stored for the page's own daemon or another remote daemon.

When the HTML shell is served by `qwen serve`, its CSP adds only the validated selected daemon origin and the corresponding `ws:` or `wss:` origin to `connect-src`. The remote daemon must independently allow the Web Shell page origin with `--allow-origin`; existing Origin, Host, and bearer checks remain authoritative.

Disconnecting or closing the browser only disposes the client connection. It does not stop the externally managed daemon; existing daemon-side client-detach and session-retention policies remain unchanged.

## Failure and Security Boundaries

- An unfamiliar `?daemon=` target waits for explicit confirmation before any probe. Only the last confirmed origin in the current tab is remembered; there is no persistent host or project catalog.
- Standalone cross-origin connections do not mount the browser-local file bridge. Remote workspace files remain available through the selected daemon. Existing embedded bridge consumers retain their behavior and origin-scoped grants.
- Switching hosts happens only through the connection gate or Daemon Status, before using the existing add-workspace form. There is no cross-host add continuation or duplicate directory browser.

- Invalid remote addresses are reported by the connection gate and are not contacted.
- Authentication, Origin, Host, and network failures stay explicit in the existing connection gate; there is no fallback from a valid selected remote daemon to a local runtime.
- A URL selecting an attacker-controlled daemon cannot cause a token for another daemon to be sent to it.
- A loopback URL selected through `?daemon=` may be an SSH tunnel and is not treated as proof that the daemon host is the browser host.
- HTTP and HTTPS targets are accepted. HTTPS is recommended outside trusted networks. SSH transport, if desired, is supplied by the user as a loopback tunnel outside Qwen Code.

## Validation

- Unit-test address validation, token isolation, query preservation, and CSP sources.
- Start local Web Shell and a token-configured daemon on a remote host, then connect by entering the address and token in the browser.
- Verify the local page lists the remote workspace, obtains remote directory suggestions, lists and references remote files, and loads a remote session transcript.
- Verify the target and selected session remain selected after refresh without re-entering the token.

## Acceptance Criteria

- A Web Shell page can connect directly to a configured remote daemon origin.
- An invalid or unavailable target can be replaced from the connection gate, and a connected target can be switched from Daemon Status.
- Workspace and session discovery and file/terminal operations use the selected daemon through the existing SDK.
- Credentials are never reused across daemon origins.
- Remote selection survives navigation and refresh.
- Invalid addresses and daemon policy/authentication failures are explicit and do not fall back to another runtime.
