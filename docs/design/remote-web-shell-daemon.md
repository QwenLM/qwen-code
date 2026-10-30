# Remote Daemon Connections from Web Shell

[English](remote-web-shell-daemon.md) | [简体中文](remote-web-shell-daemon.zh-CN.md)

Status: Web Shell milestone for [#11475](https://github.com/QwenLM/qwen-code/issues/11475). Revised 2026-10-09: simultaneous live fan-out of every saved host, in-app focused switching, and the `?fanout=` CSP contract land with [#13727](https://github.com/QwenLM/qwen-code/issues/13727); supersedes the "one live host, navigation on selection" wording kept until then. Revised 2026-10-08: restores the aggregated workspace sidebar and supersedes the 2026-09-12 narrowing (`e879557a`), which had removed the multi-host project catalog and declared aggregation a non-goal.

## Problem

Web Shell already sends workspace, session, file, SSE, and WebSocket requests through one daemon `baseUrl`, but its standalone entry point rejects an explicitly selected daemon on another origin. A Web Shell page therefore cannot connect directly to an already-running remote daemon.

Connecting to a remote daemon also hides every local project today: the sidebar lists only the connected daemon's workspaces, each row carries the same "remote" badge keyed on the connection, and nothing names the host. Users who added a remote directory expect the sidebar to keep their local folders visible next to it; instead every visible row reads "remote" and the way back to the local daemon is undiscoverable.

## Goals

- Let a Web Shell URL select one remote daemon with `?daemon=<origin>`.
- Let users enter or replace the daemon address and optional bearer token in Web Shell.
- Remember successfully verified remote computers so workspace creation can reuse them.
- Keep the remote daemon as the sole owner of its workspaces, sessions, files, terminals, and execution.
- Preserve reconnect and session navigation on the selected daemon.
- Keep bearer credentials isolated by daemon origin.
- Keep local and remote project identities together in one sidebar: entries are keyed by daemon origin + workspace ID, the connected host's live project list comes first, and saved projects of other hosts are grouped underneath by host. Selecting a saved project navigates the page to its host and workspace.
- Mark locality per row and per host: the connected host is named above the live list when any other host is known, saved remote entries use a server icon, local entries use a laptop icon, and the chat header chip names the host the conversation runs on.

## Non-goals

- Desktop integration, managed SSH, daemon installation, discovery, relay, federation, or virtual filesystems.
- Live session streaming or execution from more than one daemon at once in a single Web Shell instance. Every saved host is live in the sidebar (workspaces and session catalogs poll each daemon), but chat streaming, terminals, and execution stay bound to the one focused daemon.
- Starting or stopping an externally managed daemon.

## Design

The connection address is an HTTP origin such as `https://daemon.example.com`, an internal-network endpoint such as `http://10.0.0.8:4170`, or, for a user-managed SSH tunnel, `http://127.0.0.1:4170`. Credentials, paths, query strings, and fragments are rejected so one address always identifies one daemon origin. HTTPS should be used outside trusted networks because HTTP exposes daemon traffic and bearer tokens in transit.

The standalone Web Shell reads the `daemon` query parameter and passes that origin to the existing `DaemonWorkspaceProvider`. Its existing SDK clients then send REST, SSE, file, session, and terminal WebSocket traffic directly to that daemon. Session navigation preserves the `daemon` parameter.

The pre-connection gate always exposes a daemon address and optional token form, including when the URL contains an invalid target. Once connected, the existing Daemon Status overview shows the current target and connection state and provides the same switch controls. Switching between hosts the current document already covers is in-app: the focused host is controller state, the interactive provider remounts on the new origin without reloading the document, and `?daemon=` is rewritten in place. Connecting a host outside the covered set still performs one full page navigation, because only a freshly served document can widen its own CSP. Reconnecting to the target already in use reloads in place instead, so the selected session, workspace, and context survive it exactly as they survive a plain refresh. It does not probe or fall back to another runtime. The connection gate lists saved hosts so a user stranded on an unreachable or wrong daemon always has a way back to a known one.

The existing sidebar remains the workspace and session management UI, and it keeps project identities from the page's own daemon together with the remote hosts this browser has used. Identities are keyed by daemon origin + workspace ID. `localStorage` persists only identity fields — origin, workspace `id`, `cwd`, and `displayName` — never tokens or project contents. While more than one host is known, a heading above the live project list names the focused host: a laptop icon for the page's own daemon, a server icon plus hostname for a remote one. Every other known host renders below as its own live group, polled from that host's daemon with its own per-origin credential; a host that drops offline or rejects its credential keeps its last known rows behind a muted badge instead of falling back to its saved snapshot, and an unreachable host never deletes its saved projects. The page's own daemon group is always synthesized while focused cross-origin, so the local projects stay visible and selectable. Selecting any row on a covered host focuses that host in place; a host the document cannot reach still navigates once. Remote workspace rows in the live list keep the folder icon with the small blue globe when the host is cross-origin, and saved remote entries use the plain server icon, so local and remote folders stay visually distinct in both sections.

Every capabilities refresh of the connected daemon re-records that host's project identities into the saved-host catalog. While connected cross-origin, the shell additionally probes the page's own daemon with its origin-scoped token and refreshes its saved project list, so the local group is populated on first use and kept current thereafter; a failed probe keeps the previously saved list.

Settings includes a **Connections** category where remote computers are added, reviewed, forgotten, or selected. Adding a cross-origin computer temporarily navigates to that daemon so the existing connection gate can verify its capabilities and credential without weakening CSP; success or cancellation returns to the source shell with **Settings > Connections** reopened. Submitting an explicit connection form, from either **Settings > Connections** or Daemon Status, records the validated origin in a browser-local connection catalog; bearer tokens remain tab-scoped, and forgetting a connection removes its tab-scoped credential too. The normal **Add workspace** action opens the directory browser directly. Its **Folder source** selector lists this computer and the connected remote computers, matching the source-selection pattern used by Codex project creation without adding a separate Local/Remote step. Selecting a computer this tab is not already connected to navigates to that daemon and resumes the same directory browser; selecting the daemon already in use keeps it open in place without reloading the shell. The browser uses daemon-provided directory suggestions, supports parent-directory navigation and manual absolute paths, and registers the selected directory through the existing workspace mutation. Native folder selection remains hidden for remote daemons. Session discovery, transcript loading, file references, terminal traffic, and execution require no parallel remote-specific implementations because they already use the selected SDK client.

The chat header names the host the conversation runs on with a compact chip — laptop icon plus "Local", or server icon plus "Remote · hostname" — with the working directory in its tooltip. The chip appears once at least one other host is known; a purely local shell stays unlabeled.

The add operation remains a one-shot flow. The source URL is kept only in the current tab while navigation is in progress. Cancel returns to that URL, changing **Folder source** continues the same browser on the selected computer, and a successful registration stays on the selected daemon and clears the continuation state. The connection catalog stores origins only; the saved-host project catalog stores identity fields only, never tokens, and never merges one daemon's workspaces into another daemon's live list. Ordinary daemon switches do not resume the flow.

Bearer tokens remain in per-tab `sessionStorage`, but are keyed by daemon origin. The legacy unqualified key is used only for same-origin connections. Selecting a remote daemon never reuses a token stored for the page's own daemon or another remote daemon.

When the HTML shell is served by `qwen serve`, its CSP adds the validated selected daemon origin — plus every validated `?fanout=<origin>` parameter — and the corresponding `ws:` or `wss:` origins to `connect-src`. Fanout origins go through the same strict validator as `?daemon=` (credentials, paths, query strings, and fragments rejected), may be repeated, and are dropped when they equal the page origin. The shell keeps the `fanout` parameters in sync with the saved-host set through `history.replaceState`, which cannot widen the current document's policy; a host newly saved outside the covered set still needs its one navigation before it can be focused in place. The remote daemon must independently allow the Web Shell page origin with `--allow-origin`; existing Origin, Host, and bearer checks remain authoritative. Probing the page's own daemon for the saved-project refresh stays same-origin and needs no CSP change.

Disconnecting or closing the browser only disposes the client connection. It does not stop the externally managed daemon; existing daemon-side client-detach and session-retention policies remain unchanged.

## Failure and Security Boundaries

- An unfamiliar `?daemon=` target waits for explicit confirmation before any probe. Explicit connection forms write the target to the persistent catalog only after its capabilities probe succeeds; opening an ordinary daemon URL remains tab-scoped.
- The browser-local file bridge is offered only when the connected daemon is the page's own origin, in the standalone and embedded shells alike: a cross-origin target never mounts it, so a client directory cannot be handed to a remote daemon whose panel copy promises files stay on the computer. Remote workspace files remain available through the selected daemon. The same-origin SSH-tunnel deployment keeps its behavior and origin-scoped grants.
- The remote-add continuation is explicit, tab-scoped, and one-shot. It reuses the origin-only connection catalog and does not alter ordinary daemon switching.
- The saved-host project catalog persists project identities (origin, id, cwd, displayName) only. It never stores bearer tokens, file contents, or session data, and a host removed from the connection catalog keeps its saved projects only until its next successful capabilities refresh.
- Invalid remote addresses are reported by the connection gate and are not contacted.
- Authentication, Origin, Host, and network failures stay explicit in the existing connection gate; there is no fallback from a valid selected remote daemon to a local runtime.
- A URL selecting an attacker-controlled daemon cannot cause a token for another daemon to be sent to it.
- A loopback URL selected through `?daemon=` may be an SSH tunnel and is not treated as proof that the daemon host is the browser host.
- HTTP and HTTPS targets are accepted. HTTPS is recommended outside trusted networks. SSH transport, if desired, is supplied by the user as a loopback tunnel outside Qwen Code.

## Validation

- Unit-test address validation, token isolation, query preservation, and CSP sources.
- Unit-test the saved-host catalog: identity-only persistence, update-on-refresh, page-origin synthesis while cross-origin, and unreadable-storage degradation.
- Start local Web Shell and a token-configured daemon on a remote host, then connect by entering the address and token in the browser.
- Add a remote computer in **Settings > Connections**, verify that the flow returns to the same settings category, choose the normal **Add workspace** action, select that computer from **Folder source**, browse its directories, register one, and verify that the new workspace becomes active on that daemon.
- With the shell connected to a remote daemon, verify the sidebar names the connected host above the live list, lists the page's own projects in a local group underneath, marks the live rows with the globe badge only as long as the host is cross-origin, and shows the header chip; then select a saved local project and verify the page navigates to the page's own daemon with that workspace active.
- Verify that changing **Folder source** keeps the directory browser open, Cancel returns to the exact source page without a token or continuation marker, and an ordinary daemon switch never opens the directory browser.
- Verify the local page lists the remote workspace, obtains remote directory suggestions, lists and references remote files, and loads a remote session transcript.
- Verify the target, saved host groups, and selected session remain after refresh without re-entering the token, including while a saved host is unreachable.

## Acceptance Criteria

- A Web Shell page can connect directly to a configured remote daemon origin.
- An invalid or unavailable target can be replaced from the connection gate, and a connected target can be switched from Daemon Status.
- The standalone Settings panel exposes a Connections category for managing verified remote computer origins.
- The sidebar exposes one Add workspace action that opens the directory browser directly; its Folder source selector can switch between this computer and a verified remote connection, continue after navigation, browse daemon directories, and register the selected absolute path.
- After adding a remote directory the local projects stay listed: the connected host's live projects and the page's own saved projects are both selectable from the same sidebar, grouped and labeled by host.
- Locality is marked per row and per host: server icons for remote entries, a laptop icon for the local group, the globe badge on live rows only while the connected host is cross-origin, and the chat header chip names the current host.
- Cancel returns to the source shell predictably, while changing Folder source keeps the browser flow active and a completed add stays on the selected daemon; persistent catalogs contain connection origins and project identity fields, never tokens or project contents.
- Workspace and session discovery and file/terminal operations use the selected daemon through the existing SDK.
- Credentials are never reused across daemon origins.
- Remote selection survives navigation and refresh.
- Invalid addresses and daemon policy/authentication failures are explicit and do not fall back to another runtime.
