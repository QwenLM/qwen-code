# Web Shell workspace pinning

[English](2026-09-28-web-shell-workspace-pinning.md) | [简体中文](2026-09-28-web-shell-workspace-pinning.zh-CN.md)

## Goal

Let Web Shell users pin important workspaces to the top of the sidebar so they are always visible and easy to find, even when many other workspaces are present. Pin state is persisted across daemon restarts and survives session deletion.

## Contract

- `PATCH /workspace-registrations/:id/pin` sets or clears pin state for a persisted registration.
- `/capabilities` workspaces entries include `registrationIds`, `isPinned` (boolean, always present when feature is advertised), and `pinnedAt` (ISO-8601, present only when pinned) when `workspace_pinning` is advertised; when the tag is absent, those fields are omitted entirely.
- `workspace_pinning` capability tag advertises support; clients preflight-check this before showing UI.
- Web Shell sidebar shows a "Pin" menu item only on rows that have persistent registration records AND the daemon advertises `workspace_pinning`.
- Pinned workspaces sort above all unpinned workspaces in the sidebar; within the pinned group, sort by pin time descending (most recently pinned first). The unpinned group preserves the daemon catalog order.
- Pin state is stored in the existing workspace registration store snapshot under a new `pinnedAts: Record<string, string>` field keyed by stable registration id.
- Schema version remains 1; older daemons silently drop the additive `pinnedAts` field (data loss risk documented below).

## REST API

### `PATCH /workspace-registrations/:id/pin`

Set or clear pin state for one persisted registration. The route requires a JSON body `{ "isPinned": boolean }`; omitting the body or passing a non-boolean returns `400 invalid_body`. Success returns `{ id, isPinned, pinnedAt? }` — `pinnedAt` is present only when `isPinned` is true.

```json
// Request (pin)
{ "isPinned": true }

// Response (now pinned)
{
  "id": "abc123",
  "isPinned": true,
  "pinnedAt": "2026-09-28T10:30:00.000Z"
}

// Response (now unpinned)
{
  "id": "abc123",
  "isPinned": false
}
```

Returns `404 workspace_registration_not_found`, `500 workspace_registration_store_error`, or `501 persistence_not_available`. Requires mutation authentication when daemon auth is enabled.

### `/capabilities` workspace entry shape extension

When `workspace_pinning` is advertised, each workspace entry includes:

```ts
interface WorkspaceEntry {
  // ...existing fields...
  registrationIds?: readonly string[]; // stable registration IDs (may contain multiple for alias paths)
  isPinned: boolean; // always present when feature is advertised (false when not pinned)
  pinnedAt?: string; // ISO-8601 timestamp, present only when pinned
}
```

When the tag is absent, all three fields are omitted entirely. `isPinned` is always `false` for unpinned entries (not omitted), matching the pattern of always-present booleans like `primary` and `trusted`.

## Capability negotiation

New capability tag: `workspace_pinning` (since v1).

Conditionally enabled when `persistentWorkspaceRegistrationAvailable` is true (i.e., `deps.workspaceRegistrationStore !== undefined`). Clients check `features.includes('workspace_pinning')` before rendering pin UI.

## Persistence and schema compatibility

Pin state lives in the same JSON file as workspace registrations (`~/.qwen/daemon/workspaces/<primary-hash>.json`) under the additive `pinnedAts` object. The file schema version stays at 1 because:

- Older daemons (pre-pinning) ignore unknown top-level fields during deserialization.
- However, older daemons **do not preserve** unknown fields when writing back — they serialize only known keys. This means an older daemon started after a newer one will silently drop all `pinnedAts` data on its next write.

**Mitigation:** Users must avoid downgrading to a pre-pinning daemon once pin state exists. The design doc records this risk explicitly so future maintainers understand why schema version was not bumped (to avoid forcing migration on every minor release) and what the failure mode looks like.

## Alias path handling (macOS /var → /private/var)

On macOS, paths under `/var` are symlinks to `/private/var`. A single workspace registered via both paths produces two distinct registration ids sharing the same canonical cwd. The pin route resolves the target entry by scanning `workspaceRegistry.listAllEntries()` for an entry whose `registrationIds` array contains the requested id, then calls `setPinned(regId, isPinned)` for **every** registration id of that entry. Read-back logic scans all `registrationIds` to find `pinnedAt` when the requested id is an alias.

This ensures pinning either alias affects the underlying workspace regardless of which path the client used.

## Frontend behavior

Web Shell sidebar (`WebShellSidebar.tsx`) renders the Pin menu item under these conditions:

```ts
const canPin =
  !ws.primary &&
  ws.registrationIds !== undefined &&
  ws.registrationIds.length > 0 &&
  workspace.capabilities?.features.includes('workspace_pinning') === true;
```

This prevents the menu from appearing on:

- Primary workspace (cannot be pinned)
- Temporary workspaces without persistent registration
- Daemons that do not advertise `workspace_pinning` (older versions)

Pinned rows display a 📌 icon and sort above all others. The pin action calls `PATCH /workspace-registrations/:id/pin` with `{ isPinned: <target state> }`.

## Testing strategy

- Unit tests verify `/capabilities` emits `isPinned: false` for unpinned entries and omits the fields when the feature tag is absent.
- Unit tests verify pin route returns correct error codes for missing registrations.
- Integration tests (manual) verify pin persists across daemon restart and sorts correctly.

## Risks and open questions

- **Schema downgrade risk**: As noted, older daemons drop `pinnedAts`. No automatic migration or warning exists. Future work could bump schema version or add a compatibility flag.
- **No cross-daemon sync**: Pin state is local to the daemon's primary workspace hash. Running multiple daemons with different primaries creates independent pin states.
- **No bulk operations**: Users must pin/unpin one workspace at a time. Bulk "pin all favorites" is out of scope.
