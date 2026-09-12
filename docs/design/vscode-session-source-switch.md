# VS Code session source switch

[中文版](./vscode-session-source-switch.zh-CN.md)

## Context

The daemon stores VS Code, terminal, and browser sessions for the same workspace. VS Code deliberately defaults to its own sessions, while the pre-cutover recovery path added in #11495 also restores only legacy session ids recorded by the extension. Removing the source filter would mix unrelated sessions and broaden rename and delete operations beyond VS Code ownership.

## Decision

The history dialog keeps **VS Code** as its default source and adds an explicit **Terminal / Web** source. Each view uses the daemon's existing source-scoped query; there is no unfiltered catalog request and no change to the daemon or core pagination protocol.

The VS Code view keeps the #11495 legacy allowlist scan. Allowlisted unattributed sessions are excluded from the Terminal / Web view so they appear once. Terminal / Web rows can be opened but are read-only in this surface: rename and delete remain limited to the VS Code view. For the sidebar host, the companion persists a session-id-bound ownership record beside the existing string session-id state, so reloads and interrupted writes preserve the foreign-session boundary without breaking downgrade compatibility. When a Terminal / Web row is opened, the companion omits VS Code restore attribution so the session's persisted source is not rewritten.

Each source change replaces the visible page, cursor, search state, and error. A request generation prevents a slower response from the previous source from overwriting the selected view.

## Scope

This is a VS Code companion UI change. It does not change daemon session ownership, core catalog pagination, Live session attribution, or the default Web Shell and terminal experiences.

## Verification

- The dialog opens on VS Code sessions and still includes allowlisted pre-cutover sessions.
- Switching to Terminal / Web issues a `sourceType: default` query and excludes the legacy allowlist.
- A late VS Code response cannot replace an already selected Terminal / Web page.
- Terminal / Web rows have no rename or delete actions and opening one does not stamp it as VS Code.
