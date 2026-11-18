# Web Shell Session Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persisted Workspace/Activity date grouping to the Web Shell sidebar without changing the existing Workspace mode or dropping sessions from the chronological mode.

**Architecture:** Extend the existing display-options menu and reuse `useActivityCatalog` for complete workspace-qualified cursor loading. Add a presentational date-group component that sorts and buckets the shared activity entries, then conditionally replace only the focused host's workspace sections. Keep standalone, pinned, Recent, Live, archived, other-host, and managed surfaces unchanged.

**Tech Stack:** React 18/19, TypeScript, Radix DropdownMenu, Vitest/jsdom, Playwright, existing session-catalog store and Activity hooks.

**Specification:** `docs/design/2026-11-16-web-shell-session-group-by.md` and `docs/design/2026-11-16-web-shell-session-group-by.zh-CN.md`.

---

### Task 1: Persist and expose Group by

**Files:**

- Modify: `packages/web-shell/client/components/sidebar/SessionSortMenu.tsx`
- Test: `packages/web-shell/client/components/sidebar/SessionSortMenu.test.tsx`
- Modify: `packages/web-shell/client/i18n.tsx`

- [x] **Step 1: Write failing menu and persistence tests**

Add coverage for this API before implementing it:

```ts
expect(readSessionGroupBy('a')).toBe('workspace');
writeSessionGroupBy('a', 'activityDate');
expect(readSessionGroupBy('a')).toBe('activityDate');
expect(readSessionGroupBy('b')).toBe('workspace');
```

Render the menu, open `Group by`, assert radio items `Workspace` and `Activity date`, select `activityDate`, and assert the callback. Extend both Restore defaults tests to expect `onGroupChange('workspace')`, including when `groupEnabled=false`, and assert malformed storage falls back.

- [x] **Step 2: Run the tests and verify RED**

Run from `packages/web-shell`:

```bash
NODE_OPTIONS=--no-experimental-webstorage npx vitest run client/components/sidebar/SessionSortMenu.test.tsx --api.host 127.0.0.1
```

Expected: FAIL because `readSessionGroupBy` is not exported and the Group by submenu is absent.

- [x] **Step 3: Implement the minimum menu and storage changes**

Add:

```ts
export type SessionGroupBy = 'workspace' | 'activityDate';

export function readSessionGroupBy(host: string): SessionGroupBy {
  try {
    return localStorage.getItem(`web-shell:session-group-by:${host}`) ===
      'activityDate'
      ? 'activityDate'
      : 'workspace';
  } catch {
    return 'workspace';
  }
}
```

Add the matching writer, required controlled props, the first nested radio submenu, and Restore defaults reset. Add `sidebar.groupBy`, `sidebar.groupWorkspace`, and `sidebar.groupActivityDate` in both locales. Hide only the grouping submenu when `groupEnabled` is false; Restore defaults still resets grouping.

- [x] **Step 4: Run the same tests and verify GREEN**

Expected: all `SessionSortMenu.test.tsx` tests pass.

### Task 2: Build chronological date sections

**Files:**

- Create: `packages/web-shell/client/components/sidebar/ActivityDateSessions.tsx`
- Test: `packages/web-shell/client/components/sidebar/ActivityDateSessions.test.tsx`

- [x] **Step 1: Write failing grouping and rendering tests**

Use two workspaces with sessions on the same local day, a previous day, and an older day. Assert one merged section per day, newest day first, and `activityRecency` as the bucket timestamp. Cover both sort callbacks and stable `entry.key` tie breaking. Render through a callback that records each entry and assert all loaded parent/child sessions reach the full renderer, including more than 20 rows and entries older than seven days. Include loading, empty, retry, collapse, and five-row preview behavior.

Add a rename regression: pass an editing workspace/session identity, insert enough newer rows to move it beyond the five-row preview, and assert its section disables preview limiting so the editor does not unmount. Identity comparison uses the parent-provided workspace/session identity callback, not a bare session ID.

Desired pure interface:

```ts
export function groupActivityDateSessions(
  entries: readonly ActivityEntry[],
  sortBy: SessionSort,
): Array<{ dayStart: number; entries: ActivityEntry[] }>;
```

- [x] **Step 2: Run the new test and verify RED**

```bash
NODE_OPTIONS=--no-experimental-webstorage npx vitest run client/components/sidebar/ActivityDateSessions.test.tsx --api.host 127.0.0.1
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement the minimal component**

Bucket by local midnight, sort day sections descending, and sort entries within each bucket by the selected timestamp and key. Render `SessionGroupSection` with local collapsed IDs, the shared group count/preview behavior, localized Today/Yesterday/date labels, and `renderSession(entry)` for every row. Pass `editingSessionIdentity` and `sessionIdentity`; set `limitSessions={false}` for a section containing the editing row. Show loaded rows alongside retry/progress states.

- [x] **Step 4: Run the new test and verify GREEN**

Expected: all date-group tests pass; no global row-limit or seven-day filtering exists.

### Task 3: Retry failed cursor pages

**Files:**

- Modify: `packages/web-shell/client/components/sidebar/use-activity-catalog.ts`
- Test: `packages/web-shell/client/components/sidebar/use-activity-catalog.test.tsx`

- [x] **Step 1: Write a failing second-page retry test**

Arrange a successful root page with `nextCursor='a'` and a failed cursor-`a` page. Call `retry()` and assert the cursor-`a` query is refreshed with `{interactive:true}` in addition to the root query. Retain the existing root-only failure test.

- [x] **Step 2: Run the hook test and verify RED**

Expected: only the root query is refreshed.

- [x] **Step 3: Refresh failed extra queries**

Change `retry()` to iterate the current query chain, refreshing root queries and any extra query whose matching snapshot has an error. Preserve the existing reset of obsolete cursor chains. Do not refresh every successful historical page.

- [x] **Step 4: Run hook tests and verify GREEN**

Expected: root and extra-page failures retry immediately without waiting for the store's retry timer.

### Task 4: Wire Activity date into the sidebar

**Files:**

- Modify: `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`
- Test: `packages/web-shell/client/components/sidebar/WebShellSidebar.session-group-by.test.tsx`

- [x] **Step 1: Write failing integration tests**

Persist `activityDate`, render the sidebar with qualified workspaces and activity entries, and assert date sections replace only `[data-sidebar-workspace]` rows. Assert full row behavior remains reachable, Pinned/Standalone/Recent/Live/archived/other-host/managed test doubles remain on their existing paths, and Workspace mode restores the original workspace sections. Verify overall Workspaces expansion, hidden workspace-only count/collapse-all/drag controls, and an enabled search dialog/result selection.

Cover capability fallback with empty project scope, standalone/Live scope, `selectedSessionSource === 'channel'`, managed content, missing organization support, and an untrusted workspace. Each must use Workspace rather than silently dropping rows. Verify both legacy `undefined` and explicit `default` sources are accepted, and that a single workspace with no other display options still shows Group by because grouping is supported.

Cover pin transitions: an originally pinned row, an optimistic pin, and an optimistic unpin must follow the merged `activityEntries` state; date sections exclude every row whose merged `session.isPinned` is true, not only optimistic pins.

- [x] **Step 2: Run integration tests and verify RED**

Expected: no date sections appear and the grouping props are absent.

- [x] **Step 3: Implement controlled preference and capability gating before the Activity hook**

Read/write `SessionGroupBy` beside the existing sort and workspace preferences. Immediately after `displayedWorkspaces` supplies the current scope, derive the non-empty non-Live project list from it; do not reference the later `projectWorkspaces` declaration. Before `useActivityCatalog`, compute support from: normal organized session surface, `selectedSessionSource !== 'channel'` (so legacy `undefined` remains eligible), no managed content, non-empty project list, and every entry trusted/absolute/covered by `liveStateWorkspaceCwds`. Keep all hooks unconditional. `displayMenuEnabled` uses this support condition, not merely the active mode.

Pass `open: activityOpen || activityDateMode` to the existing activity catalog. Keep `topRowSearchVisible` tied to `activityOpen`, not this combined open flag. Build date entries from the already merged `activityEntries`, filter to the selected source, and exclude all `session.isPinned` rows.

- [x] **Step 4: Replace only the focused-host workspace list**

Render `ActivityDateSessions` in place of `orderedProjectWorkspaces.map(...)` when active, using the existing full `renderSessionRow`, `editingSessionIdentity`, and `getIdentityForSession`. Pass `activity.loading`, `activity.unavailable`, `activity.hasMore`, and `activity.retry`. Hide workspace count and collapse-all/drag controls only in date mode. Keep OtherHostProjects and every outer section in place. Pass grouping props at both `SessionSortMenu` call sites.

- [x] **Step 5: Run integration and regression tests and verify GREEN**

Run the new integration test plus Task 1/2/3 tests, `ActivityView.test.tsx`, `RecentSessions.test.tsx`, `WebShellSidebar.workspace-order.test.tsx`, and `WebShellSidebar.workspace-removal.test.tsx`. Assert date mode opens the cursor chain, later pages append, and failed pages leave loaded rows rendered.

### Task 5: Verify the user flow and prepare the PR

**Files:**

- Modify: `packages/web-shell/client/e2e/web-shell.workspace-sidebar.spec.ts`
- Create: `.qwen/e2e-tests/2026-11-16-web-shell-session-group-by.md`
- Update: both design documents with implemented verification results

- [x] **Step 1: Add the Chromium E2E scenario**

Add the repository's session-organization capability to the mock scenario so Group by is reachable; retain the existing specs as regression coverage under organized queries. Give workspaces deterministic overlapping activity days so at least one date section merges two workspaces. Open Group by, choose Activity date, assert cross-workspace date sections and no workspace rows, apply a specific Workspace filter, reload and complete SSE replay, verify persistence, then Restore defaults and assert all original workspace rows return. Automatic pagination is covered by hook/integration tests because this generic mock does not emit catalog cursors. Capture menu and date-list screenshots after connections and loading settle.

- [x] **Step 2: Run the real browser flow**

Use the Playwright runner with the repository mock daemon; do not use a standalone `tsx` browser script. Inspect both screenshots for clipping, radio alignment, group counts, row actions, and stale/loading frames. Verify search-dialog selection, Chinese labels, and keyboard navigation.

- [x] **Step 3: Run final verification**

```bash
npm run build
npm run typecheck
```

Run affected Vitest files, the targeted Playwright spec, ESLint, and Prettier checks. Read the complete diff and newly created files in two open-ended audit passes; reproduce any suspected issue before changing code.

- [x] **Step 4: Commit, push, and create the PR**

Stage only the intended implementation, tests, E2E plan, and synchronized design/plan documents. Use `feat(web-shell): add activity date session grouping`. Create the PR with the repository template, actual local verification, scope/fallback tradeoffs, both design links, synchronized Chinese description, and current UI screenshots.

## Follow-up: rolling ranges and review hardening

The product follow-up replaces natural-day buckets with four exclusive rolling ranges. `Today` starts at local midnight, `This week` starts at local Monday 00:00, `Last 30 days` starts 29 local days before today and ends before this week, and `Older` contains everything earlier. Empty ranges are hidden and order is fixed regardless of the selected row sort.

- [x] Rewrite grouping tests with a fixed clock, Monday and 30-day boundaries, divergent activity/prompt order, reversed tie fixtures, a configurable sort prop, and preview lengths derived from `SIDEBAR_SESSION_PREVIEW_LIMIT`.
- [x] Implement the rolling buckets with memoized grouping and lift preview limiting only when the editing row is at or beyond the preview boundary.
- [x] Keep date groups visible when Workspaces was collapsed, make the Workspaces heading static in date mode, and preserve the stored expansion preference for Workspace mode.
- [x] Apply Activity eligibility with an explicit include-children option, source filtering, and the same rendered set for unread/status tracking.
- [x] Poll only root catalog queries while keeping historical cursor pages subscribed without polling timers; verify healthy pages are not refreshed by retry.
- [x] Update Chromium fixtures to cover all four ranges, capture the new screenshots, and synchronize both design documents and the PR evidence.
- [ ] Commit and push the follow-up to PR #17447 after final verification.
