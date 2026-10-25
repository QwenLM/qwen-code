# Archived conversations in Settings

[English](archived-conversations-settings.md) | [简体中文](archived-conversations-settings.zh-CN.md)

## Problem and scope

Issue #15549 compares three destinations for the low-frequency Archived section. This change implements option 3: a dedicated Settings category whose content area directly displays archive management. Remove the persistent sidebar section, preserve existing workspace groups, session-source filtering, standalone sessions and managed sessions, and retain existing actions and restrictions. Read-only archived transcript viewing and completion toasts remain separate work.

## Design

Add an optional archive content slot to `SettingsMessage`, following the existing Connections category pattern. Add `builtin:archived-sessions` to the host presentation identifiers. The category is titled Archived conversations / 归档会话, has an archive icon and its own heading, and hides configuration scope tabs and the synthetic setting-item count. It remains available when the archive is empty. Settings inclusion/exclusion options apply normally.

`App` provides a DOM target only while this category is selected. `WebShellSidebar` portals its existing archive list into that target, keeping the established workspace routing, action handlers, confirmations and shared row rendering. The list is rendered outside the sidebar navigation surface so collapsed, hidden, mobile and Live navigation do not hide the Settings content. It does not depend on the sidebar search text. Retain the existing session-source selection and workspace grouping.

Target presence replaces the old expanded state as the archive catalog activation signal. On each opening, refresh the primary and qualified secondary archive queries, and mount standalone and managed archives lazily. Closing or changing category removes the target and stops the corresponding archive subscriptions. Managed sessions retain their existing nested portal and lifecycle owner in `ManagedSessionsPage`.

The optional slot is supplied where the existing sidebar archive feature is available. Embedded hosts that disable the sidebar retain their existing lack of archive management; this change does not introduce a second legacy lifecycle owner. Settings availability includes archive management even when no ordinary workspace exists, so standalone and managed archives keep a reachable destination. No storage, daemon route, SDK or lifecycle changes are needed.

## Affected areas and rationale

- `SettingsMessage.tsx`, settings presentation aliases and English/Chinese messages: category, heading and visibility.
- `App.tsx`: connect the selected category's target with the existing archive owner.
- `WebShellSidebar.tsx` and CSS: relocate the list, remove the obsolete section header, preserve action behavior and lazy refresh.
- Settings, sidebar and browser tests: validate the destination, lazy loading, lifecycle actions and layout.

Reusing the existing owner avoids duplicating workspace resolution or rewriting stable session-management behavior for a navigation change.

## Interface preview

Actual browser captures with deterministic archive fixtures: [desktop](images/archived-settings-desktop.png) and [mobile](images/archived-settings-mobile.png).

## Validation and acceptance

1. No persistent Archived header exists in either sidebar layout. Settings shows Archived conversations when archive management is available and permitted by host presentation.
2. Selecting the category shows the existing workspace groups and standalone/managed archive content directly in Settings, without a dialog or User/Workspace tabs. Other Settings categories still work.
3. Archive queries stay lazy before opening and refresh on reopening. A sidebar search does not hide archive content.
4. Existing restore, rename, export and delete restrictions and owning-workspace routing remain intact. Empty, loading and retry behavior remain available.
5. Check desktop/mobile layout, light/dark themes and English/Chinese labels. Run repository build, typecheck, bundle, focused unit tests, lint/format checks and browser E2E. Record actual results separately from this design.

## Risks and open questions

The legacy archive owner remains inside the sidebar component; tests must cover portals when that sidebar's visual surface is hidden. Managed archives already use a nested portal, so target mounting and cleanup must avoid eager fetching and stale content. There are no unresolved product decisions for this first implementation; community feedback can inform later refinements.
