# Desktop shell state for saved connections and workspace hosts

[English](2026-10-25-desktop-shell-state.md) | [简体中文](2026-10-25-desktop-shell-state.zh-CN.md)

- Status: implemented in this change
- Related issue: [#14947](https://github.com/QwenLM/qwen-code/issues/14947), Part 1
- Part 2 (remembered daemon credentials) is separate and is not implemented here

## Goal

Keep the Web Shell's saved daemon connections and workspace-host catalog across desktop-client restarts, without persisting credentials.

## Current behavior

The desktop shell starts a bundled `qwen serve` on an ephemeral loopback port (`serve --port 0 --hostname 127.0.0.1 --require-auth`) and navigates the window to `http://127.0.0.1:<port>/#token=<per-launch token>`.

WebView2 scopes `localStorage` and `sessionStorage` by origin, so each launch is a new storage area. `qwen-remote-connections` and `qwen-workspace-hosts`, both kept in `localStorage`, were written during a session but unreachable on the next launch. `desktop-state.json` persisted only the workspace, window geometry, and zoom.

A second problem appears once the catalogs start persisting. `rememberWorkspaceHost` is called for the currently connected host, including the page's own origin. In the desktop client that origin is the ephemeral runtime origin, so a naive persistence layer would append one stale host per launch and feed those stale origins into the fan-out set.

## Decision

Persist the two catalogs in `desktop-state.json` through a small, allowlisted Tauri IPC surface. Do not make the desktop page origin stable and do not store credentials. The browser Web Shell keeps using `localStorage` unchanged.

## Design

### Persisted settings

`DesktopSettings` gains `shell_state: BTreeMap<String, String>` (`shellState` in JSON). Each value is the exact JSON string the Web Shell already writes:

- `qwen-remote-connections`: an array of normalized daemon origins.
- `qwen-workspace-hosts`: an array of `{ origin, workspaces }`, where each workspace keeps `id`, `cwd`, and an optional `displayName`.

`SHELL_STATE_KEYS` is the allowlist. `validate_shell_state` rejects any other key and any value over 256 KiB. Writes go through the existing `SettingsStore::update` and `write_atomic`, so a catalog update is serialized with window and zoom writes and cannot interleave with them.

### IPC boundary

Two commands are added: `shell_state_read(key)` and `shell_state_write(key, value)`.

Both call `require_runtime_origin`, which compares the calling webview's URL origin with the runtime origin recorded for this launch. The bootstrap page and any other origin are rejected. The commands are registered in `build.rs` and granted only to the daemon-served capability `web-shell-external-url`, whose `remote.urls` is already `http://127.0.0.1:*`.

`shell_state_read` returns `null` for a missing key. `shell_state_write` returns no payload.

### Web Shell adapter

`packages/web-shell/client/config/shell-state.ts` owns the desktop branch:

- `hydrateShellState()` runs before the first render. It reads both keys over IPC and caches them in memory. A `localStorage` copy that matches the native value is dropped; one that differs is newer — within one launch `writeShellState` mirrors every change while hydration clears the copy — so it is re-pushed rather than deleted, otherwise a reload would resurrect a stale catalog and destroy the only surviving copy of the newer one.
- Migration takes only the current origin's `localStorage` entries. Older launches wrote under ports that no longer resolve and are not recoverable.
- `readShellState` prefers the hydrated cache in the desktop shell and falls back to `localStorage` elsewhere.
- `writeShellState` writes through to `localStorage` (the browser path and an in-session fallback) and to IPC. The IPC write is fire-and-forget: a failure leaves the session working, the mirror survives a same-origin reload, and only a launch on a fresh origin loses the value.
- `remote-connections.ts` and `workspace-hosts.ts` call the adapter; their readers' validation is unchanged. `rememberWorkspaceHost` adds a desktop-only write-path rejection that also skips its change-event dispatch; see the workspace-host catalog rule below.

### Boot navigation

`start_runtime` reads both catalogs before navigating and appends one `fanout=<origin>` per saved host the daemon accepts (http/https, no host that is a bracketed IPv6 literal, no credentials, root path, no query or fragment), skipping the page origin and capping the list at thirty-two origins. The daemon derives `connect-src` from the request URL alone, so without those parameters a saved host would stay blocked for the whole first document of a launch; hydration necessarily runs after that document is served. The cap keeps the URL far below the daemon's header limit, past which the document is refused before the shell can load at all; hosts beyond it keep the older reload path.

### Workspace-host catalog rule

`rememberWorkspaceHost` does not persist the page's own origin **in the desktop shell**. There the origin is the ephemeral runtime origin, so persisting it would add a stale host on every launch. The browser keeps saving it: the saved entry is the offline snapshot for the local group when the page daemon cannot be reached. `useOtherOrigins` keeps the group itself in-session, but each group's project list comes from that saved entry.

## Security and trust boundaries

- Persisted values are addresses and workspace identities, never tokens or other secrets.
- The allowlist and the 256 KiB cap keep the surface from becoming a general-purpose file store.
- The runtime-origin gate keeps the bootstrap page and any other origin out; the capability is scoped to the daemon-served page.
- A malicious script inside the Web Shell could alter the catalogs, for example by pointing a saved connection at an attacker host, but cannot read credentials from this store because none are stored there. Credential persistence is Part 2 and needs a separate decision.
- `desktop-state.json` remains plaintext; it now contains no secrets.

## Failure modes

- `QWEN_DESKTOP_DISABLE_SETTINGS_PERSISTENCE=1` makes `update()` a no-op, so a re-push reports success without landing. Hydration then consumes the mirror and deletes it: one same-origin reload still reads the catalog, a second reload without an intervening write loses it, and a restart loses it as well.
- A hydration failure leaves the key uncached, so reads fall back to the current origin's `localStorage`.
- A native write failure leaves the in-memory copy and the `localStorage` mirror; the next same-origin hydration re-pushes the mirror, and only a launch on a fresh origin loses the change.
- Malformed catalog JSON is filtered by the existing catalog readers. A corrupt settings file still falls back to defaults as before.

## Acceptance criteria

1. A saved connection and its workspace-host entry survive a desktop-client restart, including the page origin changing to a new port.
2. Settings → Connections lists the saved host after restart, and deleting it removes the entry from `desktop-state.json`.
3. Repeated restarts do not add per-launch `127.0.0.1:<port>` entries to `qwen-workspace-hosts`.
4. The browser Web Shell keeps its existing `localStorage` behavior.
5. Unknown keys, values over the cap, and calls from the bootstrap or a foreign origin are rejected.
6. No token or other secret appears in `desktop-state.json`.

## Verification

- `cargo test` in `packages/desktop/src-tauri`: the crate's unit tests, including a settings reload test that writes a catalog, drops the store, reloads it, and reads the value back, plus allowlist and size-cap tests. How many run depends on the platform, because some are gated on `windows`/`unix`.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `npm run typecheck --workspace=@qwen-code/web-shell`: clean.
- ESLint and Prettier on the touched files: clean.
- `vitest run client/config client/components/workspaces client/main-boot.test.tsx --no-file-parallelism`: covers desktop hydration, mirror re-push, migration, write-through, the hydrate-before-render boot ordering, the desktop-only page-origin rule, the catalog-named host skipping the confirmation gate, and the browser offline snapshot.
- `node packages/desktop/scripts/test-release.js`: passes, including the pins that the capability grants both shell-state commands and that each command body calls `require_runtime_origin` before touching the store.
- Manual live run on Windows with an isolated app identifier: wrote a catalog over IPC, restarted the process, confirmed the page origin changed, read the catalog back, opened Settings → Connections, and saw the saved host. The same run reproduced, and then verified the fix for, the per-launch workspace-host accumulation.

## Limitations and follow-ups

- Credentials are not persisted. A saved connection still needs its bearer token in each new session until Part 2 lands.
- The catalogs are not synchronized between desktop instances; the shell is single-instance.
- Migration covers only the current origin. Catalogs written by launches before this change cannot be recovered.
- The restart check is manual; there is no automated desktop end-to-end test for it yet.
- Part 2 should base "Remember token" on a daemon-issued device credential rather than on `QWEN_SERVER_TOKEN`.

## References

- [#14947](https://github.com/QwenLM/qwen-code/issues/14947)
- [Desktop Web Shell release](./2026-07-31-desktop-web-shell-release.md)
