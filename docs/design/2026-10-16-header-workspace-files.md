# Open workspace files from the chat header

[English](2026-10-16-header-workspace-files.md) | [简体中文](2026-10-16-header-workspace-files.zh-CN.md)

## Problem and current behavior

The folder beside the chat title identifies the current workspace through a
hover tooltip, but cannot be clicked. Opening the existing Files tree requires
opening the right panel and choosing Files.

## Proposed behavior

Clicking the leading folder opens the right panel and selects the current
workspace's Files tab. Repeated activation keeps that tab open without creating
duplicates. Hovering still shows the workspace name and full path.

## Implementation and decisions

`ChatContextHeader` accepts an optional `onOpenFiles` callback. When supplied,
the existing folder is a native button with keyboard activation and a visible
focus state; otherwise it remains an informational icon. The accessible name
combines the existing localized file-browsing action and workspace label.

`App` supplies its existing `openFilesPanel` callback only in chat view when
`filesAvailable` is true. That path already resolves the panel workspace owner,
checks trust and configuration, deduplicates tabs, selects Files, sizes the
panel and opens it. Reusing it preserves selected-workspace ownership and avoids
new filesystem or daemon behavior.

A floating Files drawer closed by Reference must return focus to the composer,
rather than its header trigger. Record that close intent and handle it in the
drawer close autofocus callback; ordinary dismissal still restores the trigger.

## Scope and constraints

The new entry is limited to the built-in header. Its drawer close path also
preserves composer focus after referencing a file. Custom headers, composer
workspace indicators, backend routes, file operations and public host APIs
remain outside this change.
The existing empty-state rule still hides the folder when the composer names the
workspace. Disabled Files and unresolved or untrusted owners retain the
informational tooltip without an action.

Affected implementation: `ChatContextHeader.tsx`, its CSS module, and `App.tsx`.
Validation covers their collocated tests and the existing Files browser E2E
suite. No new dependency is required.

## Risks and validation

The main risks are opening a different workspace, toggling the panel closed on
repeated activation, or losing the tooltip and keyboard access. Focused tests
cover action availability, correct ownership, selecting Files over another tab,
repeated activation, and tooltip retention. Browser E2E uses the existing
simulated daemon to inspect the actual tree and qualified content requests; it
does not claim real filesystem or Git backend validation. Run the repository
build, typecheck and bundle, plus focused Web Shell tests and browser checks.

## Acceptance criteria

- Clicking the header folder opens the right-side Files tree for its workspace.
- Clicking again keeps one Files tab open and active.
- Activating the folder while another tab is active selects Files.
- Keyboard users can focus and activate the button; the name and path tooltip
  remains available.
- Unavailable workspaces and disabled Files expose no file-opening action.
- Referencing a file from a drawer returns focus to the composer for typing.
- Existing hidden-folder and custom-header behavior is preserved.

## Open questions

None.
