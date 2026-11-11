# Web Shell Sidebar: Incremental Session List Expansion

[English](2026-11-10-web-shell-sidebar-incremental-session-expansion.md) | [简体中文](2026-11-10-web-shell-sidebar-incremental-session-expansion.zh-CN.md)

Status: implemented in this change.

## Problem

The Web Shell left sidebar previews five sessions per list and offers a
one-shot "Show all" button. With large session catalogs, one click mounts
every row at once, pushing the rest of the sidebar far below the fold and
making the list hard to scan. Users want a bounded expansion step instead.

## Current State

Five sidebar renderers share the same pattern: a boolean `showAll` state,
`SIDEBAR_SESSION_PREVIEW_LIMIT = 5` preview rows, and a button labeled
`sidebar.showAllSessions` ("Show all" / "展开显示") that reveals everything:

- `WebShellSidebar.tsx` — the primary workspace flat session list.
- `WorkspaceSection.tsx` — secondary workspace flat session lists.
- `SessionGroupSection.tsx` — Pinned-group, custom-group, Ungrouped,
  scheduled-task, and channel sections.
- `RecentSessions.tsx` — the Recent section (catalog already capped at 20).
- `StandaloneRecents.tsx` — standalone active/archived lists.

`ActivityView.tsx` already expands incrementally (`budget + 10` per click),
which is the precedent for this change.

## Goals

- Expand session lists in bounded steps of 10 instead of all at once.
- Keep the behavior consistent across all five renderers.
- Preserve existing reset semantics (collapse, source switch, sort switch).

## Non-Goals

- No change to the five-row preview limit.
- No new "collapse back to five" affordance; collapsing the section already
  resets the preview.
- No change to the Pinned section, which intentionally renders all pinned
  rows without a preview limit.
- No change to the standalone server-side load-more button's label
  (`sidebar.showAllSessions`); its gating does change, as described below.

## Proposed Solution

Replace each boolean show-all state with a numeric visible count initialized
to `SIDEBAR_SESSION_PREVIEW_LIMIT`. Each click adds
`SIDEBAR_SESSION_EXPAND_STEP = 10` (new shared constant in
`client/constants/sessions.ts`). The button label is a new i18n key
`sidebar.showMoreSessions` that reports how many rows the next click reveals:
`min(10, remaining)` — "Show 10 more" / "再显示 10 个", or the exact remainder
when fewer than 10 rows are left ("Show 3 more" / "再显示 3 个"). The button
disappears once every row is visible.

An active search and `limitSessions={false}` still reveal all rows. The
rename escape hatch keeps the edited row mounted, but the two flat lists now
measure the edited row's position in the rendered tree-row sequence (the one
actually sliced) against their live visible count, instead of a raw-catalog
index against the fixed five. Row space matters because a collapsed parent
hides its children, so a raw index diverges from the rendered row count.
Renaming an already-visible row therefore no longer mounts the whole catalog;
group sections keep the fixed preview bound because their expansion count
lives inside `SessionGroupSection`. Every renderer restores the count to 5 on
the resets it already had — section collapse, workspace/source change, sort
change (standalone), and bulk collapse/expand — and `RecentSessions` gains the
collapse and source/sort resets its four siblings already had.

Two details keep the numeric promise honest. The `RecentSessions` label and
button gate count renderable rows (after `renderSession` returns null for
entries this list does not draw), not raw catalog entries. The standalone
server-side load-more button is decoupled from the preview gate (rendered on
`cursor` alone), and `loadMore` reveals the already-loaded catalog plus the
appended page (`max(count, loadedLength) + appendedLength`), so a fetched page
stays rendered in full even when clicked from the five-row preview, instead of
re-arming the preview and hiding most of the rows the user just asked for.

## Design Decisions

- **Step of 10, additive.** 5 → 15 → 25 … matches the ActivityView precedent
  and keeps one mental model ("each click adds ten"). A first-click-to-10
  variant would mix two step sizes and complicate the label.
- **Label reports the increment, not the total.** "Show N more" is
  unambiguous about what the click does; the count shrinks to the remainder
  on the last step so the label never over-promises.
- **One shared constant, five call sites.** The step lives in
  `constants/sessions.ts` next to the preview limit so the surfaces cannot
  drift; no new abstraction beyond the constant.
- **Keep `sidebar.showAllSessions`.** The standalone server-side load-more
  button still uses it; removing the key would change an unrelated control.

## Constraints and Risks

- The visible count is component state, not persisted; a remount starts from
  the five-row preview, exactly as the old boolean did.
- `RecentSessions` still caps its catalog at 20, so its expansion terminates
  after at most two clicks (5 → 15 → 20); its resets key on collapse and on
  source/sort change, never on the 10-second refresh, so polling does not
  collapse the user's expansion.
- Tree rows count as one row per collapsed parent, unchanged; the step
  applies to rendered rows, not raw session records.
- Group-section rename reveal still uses the fixed preview bound; making it
  live would require passing the editing identity into `SessionGroupSection`
  and is left as a follow-up to avoid a rename-visibility regression.

## Validation Plan

- Unit tests (vitest, jsdom) in each renderer's collocated test file:
  five-row preview, "Show 10 more" → 15 rows, remainder label, button
  removal at full expansion, and reset on collapse.
- Regression tests pinned by deletion mutations: the standalone fetched-page
  render (both from preview and from full expansion), the standalone
  sort-change reset, the `WebShellSidebar` collapse reset, the
  `WorkspaceSection` source-type reset, the flat-list rename bound, and the
  `RecentSessions` collapse reset and renderable-row label.
- `i18n.test.ts` pins the new key's English and Chinese copy with counts.
- Playwright e2e (`web-shell.session-preview-expansion.spec.ts`) against the
  mock daemon: 16-session workspace expands 5 → 15 → 16, resets on collapse,
  and renders the Chinese labels under `?language=zh-CN`. The existing
  `web-shell.workspace-sidebar.spec.ts` drag-sort spec is updated to the new
  button name.

## Acceptance Criteria

- The local "Show N more" control expands a list by at most 10 rows per click.
- The button label always equals the number of renderable rows the next click
  reveals.
- No button remains once all renderable rows are visible.
- Collapse/source/sort resets return every list (including Recent) to five
  rows.
- Search and rename-reveal keep the edited row mounted without mounting the
  whole catalog for an already-visible row, measured in rendered-row space.
- A standalone server page, once fetched, stays rendered in full (even from
  the five-row preview); the load-more control is available whenever a cursor
  exists.
