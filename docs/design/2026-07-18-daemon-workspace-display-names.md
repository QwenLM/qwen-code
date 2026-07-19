# Daemon workspace display names

## Goal

Let daemon and TypeScript SDK clients attach an optional human-readable display
name to a registered workspace without changing workspace identity or routing.
Let Web Shell users set that name while adding a workspace and see it in the
workspace list.

## Contract

- `workspaces[]` entries add optional `displayName` metadata.
- `POST /workspaces` accepts optional `displayName` when registering or
  persistently promoting a secondary workspace.
- `POST /workspaces` responses and persistent-registration listings return the
  effective display name when one exists.
- `workspace_display_name` advertises the contract. The TypeScript SDK exposes
  the registration option.
- When the capability is advertised, the Web Shell add-workspace dialog accepts
  an optional display name and uses it for workspace labels.

`id` and `cwd` remain the only workspace selectors. A display name is never
used for lookup and does not need to be unique.

## Runtime and persistence

The runtime keeps the display name supplied when the workspace is registered.
Process-local workspaces lose both the runtime and its name when the daemon
stops. Persistent registrations retain their name across restarts.

The existing schema-v1 registration file keeps its `workspaces: string[]`
shape and adds an optional `displayNames` object keyed by the existing stable
registration id. Older daemons ignore the additive field, and newer daemons
continue to read files that do not contain it. Removing a registration also
removes its display-name entry.

## Validation and failures

Workspace display names are limited to 256 characters and cannot contain C0 or
DEL control characters. Surrounding whitespace is trimmed, and an empty result
is treated as no name. Invalid input returns `400 invalid_display_name` before
filesystem or runtime work begins. Duplicate display names are allowed.

When a process-local workspace is first persisted, the registration-store write
completes before the persisted display name is exposed on the runtime.
Process-local workspaces do not gain a persistence dependency.

## Compatibility

Every wire change is additive to protocol v1. Older SDKs ignore
`displayName`; newer SDKs type it as optional and continue to work with older
daemons that omit both the field and capability tag.
Web Shell hides the display-name input when the capability tag is absent.

## Verification

- Registration-store tests cover legacy files, initial names, validation,
  restart restoration, and cleanup on removal.
- Workspace-management tests cover process-local and persistent creation,
  persistence errors, and idempotent promotion.
- Capability/status and SDK tests cover the additive field, request shapes,
  and `workspace_display_name` advertisement.
- Web Shell tests cover the optional input, SDK option forwarding, and label
  fallback. Browser screenshots verify the real add-workspace form and its
  resulting sidebar label.
- Manual end-to-end verification covers process-local registration and
  persistent restart restoration.

Filled add-workspace form:

![Workspace display-name form](../assets/workspace-display-name-web-shell.jpg)

Created workspace shown by display name:

![Workspace display-name result](../assets/workspace-display-name-web-shell-result.jpg)
