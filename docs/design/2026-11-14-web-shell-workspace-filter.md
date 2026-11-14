# Web Shell Sidebar Workspace Filter

[English](2026-11-14-web-shell-workspace-filter.md) | [简体中文](2026-11-14-web-shell-workspace-filter.zh-CN.md)

**Status:** Implemented and verified on 2026-11-14.

## Context

[#17142](https://github.com/QwenLM/qwen-code/issues/17142) asks for a way to find workspaces in a long Web Shell sidebar. This change deliberately uses an explicit workspace selector rather than changing session-search semantics. A query that happens to match both a workspace and a session therefore cannot silently switch the search mode.

The sidebar already had a persisted session-sort menu. The new control extends that entry into a display-options menu with nested `Sort by` and `Workspace` selectors and a `Restore defaults` action. Its ListFilter trigger sits in the Workspaces title row alongside the existing workspace actions; layouts that hide that title retain the original-row fallback, and the collapsed session popover keeps the control reachable.

## Goals and scope

- List `All`, `No workspace`, and every workspace on the focused host, using the existing workspace display label.
- Filter project, live, pinned, archived, recent, and standalone surfaces to the selected scope.
- Preserve the selected workspace and session sort independently for each host.
- Restore `All` and `Recent activity` through one action.
- Support keyboard navigation, radio semantics, long labels, English, and Chinese.

The composer workspace picker is unchanged. Session search does not infer a workspace filter from its query, and no new grouping or activity filter is introduced.

## Interaction and persistence

`Workspace` is a single-choice submenu. `All` is the default, `No workspace` selects standalone sessions, and each remaining radio item encodes one workspace as `workspace:<cwd>`. The trigger shows the current label and the submenu marks the selected item with a check.

The existing sort choices move under `Sort by` without changing their values. `Restore defaults` always writes both defaults, even when the host does not support question-time sorting.

Preferences use `web-shell:workspace-filter:<host>` and the existing `web-shell:session-sort:<host>` key. Missing, malformed, and empty workspace values fall back to `all`. State is associated with its host so an A → B → A navigation cannot apply B's filter to A.

## Filtering model

The unfiltered `sidebarWorkspaces` collection supplies menu options. `displayedWorkspaces` derives the selected scope and feeds the existing project/live catalogs and their dependent queries. `All` preserves the previous primary-session enablement rule; a specific selection enables primary sessions only when the primary workspace remains visible.

Standalone sections render only for `all` or `standalone`. Other-host project sections render only for `all`. Pending live rows render in the standalone pending surface only for `all`; workspace-owned live sections continue to handle their own pending rows.

Pinned candidates, including in-flight optimistic pins, use the same workspace predicate. Recent sessions synchronously filter previously loaded entries during render, so rows from the old scope cannot appear for one commit while a passive effect clears state. Changing the filter exits bulk-selection mode and clears selected sessions, preventing mutations of newly hidden rows.

## Accessibility and presentation

The implementation uses the existing Radix dropdown primitives and portal integration. Nested menus retain keyboard focus management and expose `menuitemradio`/`aria-checked`. Workspace rows truncate long labels, expose the full label through `title`, and scroll when the submenu exceeds its maximum height. The internal live workspace is labeled `Live sessions` instead of exposing its Conversations directory name. New strings have matching English and Chinese entries.

## Validation

- Seven affected Vitest files: 321 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- ESLint and Prettier checks for every changed implementation, test, and localization file: passed.
- Chromium Playwright scenario covering selection, reload persistence, `No workspace`, and `Restore defaults`: passed.
- Menu screenshot inspected for clipping, selected-state alignment, and submenu layout.

## Acceptance criteria

- [x] A workspace can be selected explicitly without using session search.
- [x] `No workspace` keeps standalone sessions and hides workspace sections.
- [x] A specific workspace hides other workspaces, other-host projects, standalone rows, stale recent rows, and in-flight optimistic pins from other scopes.
- [x] Reloading preserves the filter on the same host and does not share it with another host.
- [x] `Restore defaults` restores both `All` and `Recent activity`.
- [x] Existing sorting and default `All` behavior remain intact.
