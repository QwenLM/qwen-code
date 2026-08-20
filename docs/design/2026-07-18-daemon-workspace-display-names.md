# Daemon workspace display names

## Goal

Let daemon and TypeScript SDK clients attach an optional human-readable display
name to a registered workspace without changing workspace identity or routing.
Let Web Shell users set that name while adding a workspace and see it in the
workspace list. Let API clients update or clear the presentation metadata of an
active workspace.

## Contract

- `workspaces[]` entries add optional `displayName` metadata.
- `POST /workspaces` accepts optional `displayName` when registering or
  persistently promoting a secondary workspace.
- `PATCH /workspaces/:workspace` is the workspace update endpoint. Its current
  request shape is `{ displayName: string | null }`; `null` clears the name.
- `POST /workspaces`, `PATCH /workspaces/:workspace`, and
  persistent-registration listings return the effective display name when one
  exists.
- `workspace_display_name` advertises the contract. The TypeScript SDK exposes
  the registration option and `updateWorkspace()`.
- When the capability is advertised, the Web Shell add-workspace dialog accepts
  an optional display name and uses it for workspace labels.

`id` and `cwd` remain the only workspace selectors. A display name is never
used for lookup and does not need to be unique.

## Runtime and persistence

The runtime owns the effective display name. Updating any active workspace
changes that runtime metadata. When the runtime has matching persistent
registration identities, the same update is written atomically to all of them;
otherwise the update remains process-local. Process-local workspaces lose both
the runtime and its name when the daemon stops and never depend on the
registration store for display-name updates.

The existing schema-v1 registration file keeps its `workspaces: string[]`
shape and adds an optional `displayNames` object keyed by the existing stable
registration id. Updates reuse the store's existing lock, locked re-read, and
atomic write. Older daemons ignore the additive field, and newer daemons
continue to read files that do not contain it. Removing a registration also
removes its display-name entry.

## Validation and failures

Workspace display names are limited to 256 characters after surrounding
whitespace is trimmed. Internal C0 and DEL control characters are rejected;
an empty result is treated as no name. Invalid input returns
`400 invalid_display_name` before filesystem or runtime work begins. Duplicate
display names are allowed.

When a process-local workspace is first persisted, the registration-store write
completes before the persisted display name is exposed on the runtime.
Likewise, a PATCH updates matching persistent records before exposing the new
runtime value, so an ordinary store failure leaves the runtime unchanged.

## Compatibility

Every wire change is additive to protocol v1. Older SDKs ignore
`displayName`; newer SDKs type it as optional and continue to work with older
daemons that omit both the field and capability tag.
Web Shell hides display-name controls when the capability tag is absent.

## Verification

- Registration-store tests cover legacy files, initial names, validation,
  atomic alias updates, restart restoration, and cleanup on removal.
- Workspace-management tests cover process-local and persistent creation,
  update/clear, persistence errors, and idempotent promotion.
- Capability/status and SDK tests cover the additive field, request shapes,
  `updateWorkspace()`, and `workspace_display_name` advertisement.
- Web Shell tests cover the optional input, SDK option forwarding, and label
  fallback. Browser screenshots verify the real add-workspace form and its
  resulting sidebar label.
- Manual end-to-end verification covers process-local registration and
  persistent restart restoration.

Filled add-workspace form:

![Workspace display-name form](../assets/workspace-display-name-web-shell.jpg)

Created workspace shown by display name:

![Workspace display-name result](../assets/workspace-display-name-web-shell-result.jpg)
