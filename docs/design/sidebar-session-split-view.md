# Add a sidebar session to Split View

[English](sidebar-session-split-view.md) | [简体中文](sidebar-session-split-view.zh-CN.md)

## Problem and current behavior

Issue #14775 requests an “Add to Split View” action in a sidebar session's
context menu. Today users must open Split View from the footer, then use its
session picker. App owns the pane list; SplitView already supports adding
sessions, deduplication, and a six-pane limit.

## Proposed changes

- Sidebar adds a dropdown-only `split` action to its default action list,
  with English and Simplified Chinese labels. It follows the existing action
  allowlist, screen-size capability, busy state, and workspace eligibility
  checks. Only default workspace sessions (including legacy sessions without
  source metadata) offer the action, matching the split session directory.
  Archived, channel, standalone, Live, unknown, and untrusted sessions do not
  offer this action.
- App appends the selected session when Split View is open. When it is
  closed, the menu opens the selected session alongside the current workspace
  session when available, without restoring the old pane list. The footer
  retains its existing behavior of restoring that list.
  Opening reuses the existing split opener and classification. Additions made
  while opening is pending are combined within the current classification
  generation; navigation cancels that pending selection. Appending
  uses the same synchronous pane update as the existing picker: Sidebar
  already limits targets to eligible active workspace sessions. This
  preserves existing panes and unsent attachments. Embedded hosts
  controlling the pane list receive the existing change callback and retain
  ownership of applying the change. Pending additions include only IDs the host
  has already accepted through its controlled props.
- Repeated sessions are not duplicated. At six panes, adding another session
  is disabled with the existing limit explanation; existing panes are kept.
- SplitView reveals a newly added external pane by clearing maximization
  and making that pane active, matching its existing session picker.

## Design decisions and scope

Keep Sidebar → App → SplitView ownership intact. The menu emits an intent;
App combines IDs; SplitView renders and manages pane focus. Reuse the
existing workspace classification, providers, Radix menu, and portal.
No daemon, SDK, desktop Rust, CSS, keyboard shortcut, transport, or archive
lifecycle changes are required. The desktop app loads the same Web Shell.
Existing split transport limitations are outside this feature.

## Affected files

- `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`
- `packages/web-shell/client/App.tsx`
- `packages/web-shell/client/components/SplitView.tsx`
- `packages/web-shell/client/i18n.tsx`
- Adjacent component tests and Web Shell browser tests.

## Validation and acceptance criteria

Verify the real menu opens current + selected sessions, appends without
replacing panes, ignores duplicates, and respects the six-pane limit.
After leaving a full split, the menu must still open current + selected.
Verify the new pane is visible after another pane was maximized. Check
delayed standalone classification, pane identity, and consecutive additions,
including the first opening, deduplication, capacity, and navigation cancellation.
Check English/Chinese labels, action allowlists, archived and ineligible sessions,
trusted secondary workspaces, small screens, controlled embedding, and the
existing footer/picker behavior.

Run focused unit and browser tests, build, typecheck, bundle, and repeat the
relevant tests in local Docker Linux. Record baseline and verification
evidence in `.qwen/e2e-tests/14775/`.

## Open questions

None. Duplicate selection is a no-op; capacity does not evict existing panes.
