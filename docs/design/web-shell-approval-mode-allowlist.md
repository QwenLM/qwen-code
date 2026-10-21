# Web Shell approval mode allowlist

[English](web-shell-approval-mode-allowlist.md) | [简体中文](web-shell-approval-mode-allowlist.zh-CN.md)

## Problem and scope

Web Shell always offers default, auto-edit, auto and yolo. Hosts and settings.json cannot filter individual choices. Add presentation filtering without changing daemon permissions, CLI/TUI behavior, Plan behavior or the current session mode.

## Design

Register `ui.allowedApprovalModes` as an optional string array in the settings schema, with replacement semantics across settings scopes. The key narrows which approval modes the shell offers, so it is honored from operator scopes only (User, System, SystemDefaults): a value in a repository's workspace settings is stripped with a warning and workspace-scope writes are refused, because a cloned repository must not remove a restriction the operator set. Serve it through the existing workspace-scoped settings response; keep it out of the Settings editor. This reuses the existing runtime, trust and reload behavior without adding a route.

Expose `allowedApprovalModes` on WebShellProps (also inherited by WebShellWithProviders). An explicitly supplied Prop overrides settings, including an empty array. Omission defaults to all four execution modes. Filter unknown values, duplicates and Plan, preserving the built-in ordering. A malformed non-array setting falls back to all modes; an array with no supported modes offers none.

Use the shared `useApprovalModes` hook in App and ChatPane to read the explicitly selected workspace through its qualified settings endpoint. The main view uses `activeWorkspaceCwd`; it must not derive this list from the legacy-primary Settings editor data. Pass the resolved main list to the composer dropdown, approval dialog and custom footer. Share the host Prop through the existing customization context so split and side-task ChatPane composers inherit it. Without a host override, each pane reads its own workspace-qualified settings and refreshes on settings events; standalone and failed reads never fall back to primary settings. The read happens only when the daemon advertises the workspace-qualified settings features; a daemon without them keeps the default list, and a reconnect retries the read. A failed first read against a capable daemon offers no modes rather than the default list — resolving a rejection to the defaults would silently drop the operator's restriction — and a failed reload keeps the last-known-good list; the next settings event retries. Ignore stale responses and cached values after workspace or daemon-client changes. Keyboard cycling uses the same list, wraps, and starts at its first item if the current mode is hidden. An empty list makes cycling a no-op and disables the dropdown trigger. Selecting the already-current mode through cycling is a no-op. Direct Web Shell mode selection also rejects hidden choices; Plan toggling remains independent, including when the execution mode is hidden.

Filtering never automatically changes a restored or externally changed current mode. The trigger still displays the actual mode. This is UI customization, not a security boundary; other clients and daemon APIs may change modes.

## Affected files

CLI settings schema, generated editor schema and workspace settings route; Web Shell App and ChatPane, customization context, shared plan-mode utilities, composer, approval dialog, settings presentation, public exports and README; focused unit and browser tests.

## Validation and acceptance

- Unconfigured dropdown and dialog offer exactly all four modes.
- Settings and Props each filter choices; Props override settings.
- Dropdown, dialog, custom footer and keyboard cycling use the same list.
- Verify wraparound, hidden current mode, empty/single/invalid lists and live Prop changes.
- Verify scoped settings exposure, replacement merging across operator scopes, and that workspace-scope values are stripped. Hosts set per-shell lists — including different lists for different embeds — through the `allowedApprovalModes` Prop, without changing approval enforcement or Plan toggling.
- Build, typecheck, bundle, focused unit tests, browser checks using a clearly identified mock daemon, and two clean self-audit passes.

## Risks and open questions

No open design questions. Settings may not be available for standalone contexts; Props continue to work there. Before settings finish loading, the UI uses the default list. Existing backend permission rules remain authoritative.
