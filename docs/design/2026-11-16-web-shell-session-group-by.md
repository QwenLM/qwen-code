# Web Shell Sidebar Session Grouping

[English](2026-11-16-web-shell-session-group-by.md) | [简体中文](2026-11-16-web-shell-session-group-by.zh-CN.md)

**Status:** Implemented and verified on 2026-11-16.

## Context

The sidebar display-options menu added by [the workspace-filter design](2026-11-14-web-shell-workspace-filter.md) supports session sorting and workspace filtering. The main session catalog is always grouped by workspace. Users with many workspaces need an alternative chronological view so recently active sessions from different workspaces appear together.

## Goals and scope

- Add a `Group by` submenu with `Workspace` and `Activity date`; `Workspace` remains the default and preserves the existing rendering path.
- In `Activity date`, merge the focused host's workspace-bound active sessions into four exclusive rolling ranges: `Today`, `This week`, `Last 30 days`, and `Older`.
- Keep the existing workspace filter, both session sorts, full session-row actions, loading and retry behavior, and per-host preference persistence.
- Keep Pinned, no-workspace, Recent, Live, archived, other-host, and custom managed surfaces on their existing paths.
- Do not add `Custom group` in this phase or change daemon APIs. The Activity attention view's rendering and data scope stay unchanged, while its shared retry now also refreshes failed or truncated cursor pages.

## Interaction and persistence

`Group by` is the first display-options submenu, followed by `Sort by` and `Workspace`. The trigger row shows the selected grouping label, and the submenu uses radio semantics. `Restore defaults` resets grouping to `Workspace`, sorting to `Recent activity`, and filtering to `All`.

The preference uses `web-shell:session-group-by:<host>` with values `workspace` and `activityDate`. Missing or malformed values fall back to `workspace`. As with sorting and filtering, state is associated with its host so an A → B → A navigation cannot apply B's preference to A.

The grouping submenu is available only for the ordinary non-channel surface (including legacy daemons whose source is `undefined`) with a non-empty project list where every visible project workspace can be read through the existing qualified activity catalog. Unsupported, managed, channel-only, standalone/Live-only, and no-workspace scopes use `Workspace`; their current surfaces are not replaced.

## Data and grouping model

Reuse the existing `useActivityCatalog` instance. Opening either the Activity attention view or the Activity date grouping follows every reachable `nextCursor`, deduplicates by workspace and session ID, and retains partial failures for retry. Root pages keep the existing 30-second polling on daemons without live state; historical cursor pages remain subscribed without their own polling timers. This avoids a second catalog implementation and does not impose the Recent section's twenty-row limit or the Activity view's seven-day cutoff.

Activity time is `max(updatedAt, createdAt)`, matching `activityRecency`. `Today` starts at local midnight and includes any future timestamps. `This week` starts at local Monday 00:00 and ends before today. `Last 30 days` starts 29 local days before today and ends before the current week. `Older` contains everything earlier. The ranges are mutually exclusive, empty ranges are hidden, and the remaining ranges always render in that fixed order. Within each range, rows follow the selected sort: recent activity or last question, with the existing missing-question-time fallback and stable workspace/session-ID tie breaking.

The chronological list is flat, including child sessions, so every loaded session remains visible without constructing parent/child relationships across workspaces. It uses the shared full session-row renderer. Date entries come from the catalog after optimistic pin/unpin merging and apply the Activity eligibility rules with an explicit include-children option; scheduled-task runs, realtime voice, non-matching sources, and archived rows are excluded. Every row whose merged state is pinned stays only in the existing Pinned section. Unread and collapsed-status tracking consumes the same rendered set, while the Activity attention view keeps its existing full set. Existing custom groups and colors do not create additional sections in this mode.

Each range uses the existing group-section presentation, including a count, collapse control, five-row preview, and incremental Show more action. Preview limiting is lifted only when the active rename editor is at or beyond the five-row boundary, using both workspace and session ID. Grouping is memoized by entries, sort mode, and the current local day. Range collapse state is local to the mounted view; only the grouping preference is newly persisted.

## Compatibility and failure behavior

Workspace mode keeps the current workspace sections, drag ordering, custom groups, expansion controls, and data queries unchanged. Activity date mode replaces only the focused host's `orderedProjectWorkspaces` list. In that mode the section header becomes static `Recent conversations` text and keeps display options, while workspace-only count, drag, and collapse-all controls are hidden. A previously collapsed Workspaces section does not hide the date groups, and its stored expansion preference is preserved for Workspace mode.

Standalone sessions stay in their dedicated section because the activity catalog is workspace-qualified. Other-host projects also remain unchanged because the preference and catalog are focused-host scoped. Live, archived, Recent, and Pinned sections keep their current behavior.

If any visible project workspace is untrusted, lacks an absolute qualified path, or the organized catalog / `workspace_qualified_rest_core` capability is unavailable, the UI does not offer Activity date and the effective mode falls back to Workspace rather than silently dropping rows. Loaded date rows remain visible on partial catalog errors, with the existing retry action. Retry refreshes root queries and any failed cursor query immediately instead of waiting for the store's retry timer. Additional pages show loading progress while they are fetched automatically.

## Accessibility and presentation

Use the existing Radix nested-menu and portal primitives, with keyboard navigation, `menuitemradio`, and `aria-checked`. Reuse existing section headers and session rows rather than adding a new visual language. Add matching English and Chinese strings for `Group by`, `Workspace`, `Activity date`, and the date-mode `Recent conversations` header.

## Validation

- Twelve affected Vitest files: 339 tests passed, including 41 locale contract tests. Coverage includes the four rolling ranges, Monday/30-day boundaries, DST rollover, both sorts, visible-only row construction, rename protection, original and optimistic pin states, source/eligibility filtering, qualified REST fallback, search selection, root-only polling, and all three unavailable cursor states.
- `npm run build`: passed.
- `npm run typecheck`: passed.
- ESLint and Prettier checks for every changed implementation, test, localization, and documentation file: passed.
- Chromium Playwright workspace-sidebar suite: six scenarios passed, including Activity date grouping, workspace filtering, reload persistence, Restore defaults, and the existing workspace-order regressions.
- Menu and Activity date screenshots inspected for clipping, selected-state alignment, group counts, row layout, and stale/loading frames.

## Acceptance criteria

- [x] `Workspace` is the default and retains the existing sidebar behavior.
- [x] `Activity date` merges workspace sessions into exclusive `Today`, `This week`, `Last 30 days`, and `Older` ranges without the Recent twenty-row or Activity seven-day limits.
- [x] Workspace filtering, both sort modes, full row actions, and cursor pagination work in date mode.
- [x] Pinned, no-workspace, Recent, Live, archived, other-host, and managed surfaces are not replaced.
- [x] Grouping persists per host, malformed values and unsupported scopes fall back safely, and Restore defaults resets all display options.
- [x] English, Chinese, keyboard interaction, loading, empty, and partial-failure states are verified.
