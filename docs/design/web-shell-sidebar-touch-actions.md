# Touch-Friendly Sidebar Session & Workspace Actions in Web Shell

[English](web-shell-sidebar-touch-actions.md) | [简体中文](web-shell-sidebar-touch-actions.zh-CN.md)

- **Status:** Implemented
- **Date:** 2026-11-28
- **Baseline commit:** `72e8eb4290`
- **Scope:** P0 (touch reachability & hover dead-end fixes) + P1 (mobile bottom Action Sheet, embedded details, in-sheet group picker, long-press entry, dialog rename)

---

## 1. Problem & Current State

Web Shell's left sidebar relies heavily on pointer hover (`:hover`, `onPointerEnter`, `onMouseEnter`) to expose session actions, session details, workspace header actions, and group header actions. On touch-first devices without a persistent hover pointer — iPhone, iPad, and Android phones/tablets — these interactions are either cramped and error-prone or completely unreachable. (Archived sessions live in the dedicated wide Settings panel `ArchivedSessionsPanel` with always-visible actions and are intentionally kept unchanged.)

| Surface                             | Current implementation                                                                                                                                             | Touch UX problem                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session row action bar              | `WebShellSidebar.tsx` (`renderSessionRow`), `WebShellSidebar.module.css` (`.sessionActions`, `.sessionActionButton`, `@media (hover: none) and (pointer: coarse)`) | Inline `Pin` collapses only under strict `(hover: none) and (pointer: coarse)` (missing hybrid-pointer iPads and desktop-mode mobile drawers). Each `.sessionActionButton` stays `26px × 26px` inside a `30px` row, far below 44 pt / 48 dp touch targets, and taps easily fall through to `openRow`.                                              |
| Touch media query coverage          | `WebShellSidebar.module.css` (`@media (hover: none) and (pointer: coarse)`), `ManagedWorkspaceNavigation.tsx` (`[@media(hover:none)]:visible`)                     | The strict `and` condition misses iPads with Apple Pencil hover, iPads paired with trackpads/keyboards where users still tap by hand, and Android tablet browsers reporting `hover: hover` or `pointer: fine`.                                                                                                                                     |
| Session action menu & group submenu | `WebShellSidebar.tsx` (`DropdownMenuContent`, `openGroupMenuFromAnchor`), `WebShellSidebar.module.css` (`.groupMenu`, `.groupMenuItem`)                            | `DropdownMenuItem` uses compact desktop density (`py-1`). Choosing **Group** opens a second manually positioned `position: fixed; width: 240px` overlay (`.groupMenu`), which clips or crowds narrow phone screens and uses `34px` rows.                                                                                                           |
| Session hover details popover       | `SessionDetailsTooltip.tsx`, `WebShellSidebar.tsx` (`withDetails`), `ManagedSessionNavigationRow.tsx`                                                              | Opens only via 300 ms `onPointerEnter` and closes on `onPointerDownCapture` / `onClick`. Touch users cannot inspect full wrapped titles, workspace path, Git branch, PR/Issue links, connection state, or copy the Session ID. (The component already has an `openOnClick` prop used by `SessionOverviewPanel.tsx`, but not wired in the sidebar.) |
| Workspace header actions            | `WorkspaceSection.tsx` (`actionsVisible`, `onMouseEnter` / `onMouseLeave`), `WebShellSidebar.tsx` (`workspaceHeaderActions` inline `style={{ visibility }}`)       | Visibility is gated by JS mouse-enter state (`visibility: hidden`), with no touch fallback. On iPhone/iPad/Android, the workspace **New task** button and `WorkspaceMenu` (rename, copy path, new worktree task, create group, MCP/Skills/Extensions/Channels/Settings, reload, remove) are practically unreachable.                               |
| Workspace hover details popover     | `WorkspaceDetailsTooltip.tsx`, `WorkspaceSection.tsx`                                                                                                              | Pure hover popover; touch users cannot view full workspace path, Git status summary, or overview counts without opening the menu.                                                                                                                                                                                                                  |
| Session group header actions        | `SessionGroupSection.tsx`, `WebShellSidebar.module.css` (`.sessionGroupHeaderActions`)                                                                             | `opacity: 0` by default and revealed only on `:hover` / `:focus-within`, with no touch fallback. Rename Group and Delete Group are unreachable on touch devices.                                                                                                                                                                                   |
| Session rename flow                 | `WebShellSidebar.tsx` (`SessionRenameEditor`), `StandaloneRecents.tsx` (`SessionRenameDialog`)                                                                     | Workspace rows rename inline inside the narrow sidebar row; on phones, the virtual keyboard shrinks the viewport and easily pushes or blurs the inline input, whereas `StandaloneRecents.tsx` already uses `SessionRenameDialog`.                                                                                                                  |

---

## 2. Goals & Non-Goals

### Goals

1. **Zero hover dead ends in the sidebar (P0):** Every session action, session metadata/details view, workspace menu action, and group header action reachable by mouse hover becomes reliably reachable via touch on iPhone, iPad (with or without Pencil/trackpad), and Android devices.
2. **Preserve title readability and touch ergonomics (P0):** Collapse multi-button row toolbars into a single always-visible trailing `⋮` trigger (`EllipsisVerticalIcon`) with an enlarged touch target on touch/compact surfaces, avoiding accidental session switches.
3. **Native-feeling mobile action experience (P1):** Present session actions on touch/compact surfaces in a bottom Action Sheet built on the existing `ui/drawer` (`vaul`), embedding the session details summary at the top and replacing the manually positioned `.groupMenu` with an in-sheet secondary view.
4. **Long-press shortcut (P1):** Support pressing and holding a session row (~450 ms) to open the same Action Sheet without interfering with vertical scrolling or triggering accidental session navigation.
5. **Reliable touch rename (P1):** Route touch-initiated session renames through the existing `SessionRenameDialog` modal instead of inline editing inside the sidebar drawer.
6. **Zero desktop regression:** Mouse-driven desktop users keep the existing hover reveal, inline `inlineItems` buttons, hover `SessionDetailsTooltip` / `WorkspaceDetailsTooltip`, `DropdownMenu`, and inline `SessionRenameEditor` unchanged.

### Non-Goals

- **No daemon, protocol, or public package API changes:** All changes stay within `packages/web-shell/client`. The existing `WebShellSidebarSessionActionsOptions` (`items` and `inlineItems`) policy remains honored; `items` continues to gate which actions exist in every presentation, while `inlineItems` applies to desktop hover rows.
- **No swipe-to-reveal row gestures:** Horizontal row swiping conflicts with OS edge-back gestures and the left sidebar drawer's own touch dismissal, and cannot cleanly fit 6–8 session actions.
- **P2 deferred items:** Click-to-open details/actions on the `ChatPane` header title (outside the sidebar) and managed-mode Action Sheet conversion beyond the shared CSS/touch trigger fixes are tracked as follow-ups in Section 8.

---

## 3. Architecture & UX Design

### 3.1 Touch & Compact Detection Strategy

Two distinct decisions must be separated rather than conflated into a single media query:

1. **Coarse-pointer affordance visibility (CSS & JS):** Whether hover-only controls must be persistently discoverable and given touch-sized hit areas.
   - **CSS query:** Broaden from `@media (hover: none) and (pointer: coarse)` to `@media (pointer: coarse)` AND also apply the single-trigger touch layout when the sidebar is presented in the mobile overlay drawer (`.sidebar.mobileOpen`).
   - **Why `(pointer: coarse)` rather than `(hover: none), (pointer: coarse)`:**
     - `(pointer: coarse)` covers iPhone, Android phones/tablets, pure-touch iPads, **and** iPads with Apple Pencil hover (`hover: hover` + `pointer: coarse`), while avoiding false positives on headless Linux desktop Chromium environments that report `hover: none` alongside `pointer: fine`.
     - `.sidebar.mobileOpen` guarantees a usable touch-friendly layout even when a tablet/mobile browser runs in "Request Desktop Site" mode or inside a narrow embedded Web Shell host.
     - For hybrid-pointer iPads whose primary pointer is an attached trackpad (`pointer: fine` + `hover: hover`) in the persistent wide layout (`mobileOpen = false`), **event-level `pointerType === 'touch'` handling** enables finger long-press on any actionable row and finger taps on the `⋮` button to open the bottom Action Sheet directly without polluting mouse/trackpad interactions.
   - **Desktop hover-only guard preserved:** Existing hover-only rules that hide actions while hovering the background running dot (`.sessionRow:has(.sessionBackgroundRunning:hover) .sessionActions`) stay gated behind `@media (hover: hover) and (pointer: fine)` so sticky tap-hover on touch devices can never hide the row trigger.
2. **Menu presentation mode (Action Sheet vs. `DropdownMenu`):**
   - Introduce a small shared helper hook, `useTouchSidebarActions(mobileOpen: boolean)` (placed in `packages/web-shell/client/components/sidebar/use-touch-sidebar-actions.ts`), returning `{ isTouchActions: boolean; useActionSheet: boolean }`:
     - `isTouchActions`: `true` when `mobileOpen` is `true` OR `window.matchMedia('(pointer: coarse)').matches` (or legacy `TOUCH_COMPOSER_QUERY`, listening to `MediaQueryList` `change` events so attaching/detaching an iPad Magic Keyboard updates cleanly).
     - `useActionSheet`: `true` when `isTouchActions` is `true`. On narrow viewports (phones), the sheet spans full width at the bottom (`inset-x-0 bottom-0`). On wide touch viewports (landscape iPad / `sm:` and above), the same bottom sheet constrains width and centers horizontally (`sm:mx-auto sm:max-w-md sm:rounded-t-2xl`) so items stay comfortable to read and tap without stretching across a 1024 px screen.
   - **No breaking change in jsdom/SSR:** When `window.matchMedia` is unavailable or returns `false` (default jsdom tests), both flags default to `false`, keeping existing desktop unit tests deterministic while dedicated touch tests stub `matchMedia` or pass `mobileOpen`.

### 3.2 Session Row Entry: Single More Button + Long Press

#### Trigger Convergence & Visual Hierarchy

When `isTouchActions` is `true` (and mirrored in CSS for `@media (pointer: coarse)` and `.sidebar.mobileOpen`):

- **Row action slot collapses to a single `⋮` (`EllipsisVerticalIcon`) button** across all actionable row variants:
  - **Standard workspace rows:** Inline `Pin` (and any `inlineItems` buttons) are folded into the Action Sheet; only `⋮` renders in `.sessionActions`. If an item is pinned, the existing leading pin status icon / Pinned section already communicates pinned state without needing a row-tail toggle button.
  - **Archived rows in Settings (`ArchivedSessionsPanel`):** Archived conversations live in the wide Settings panel with always-visible `Export`, `More`, and `Restore` buttons and remain untouched by sidebar touch collapsing.
  - **Standalone rows (`StandaloneRecents`):** Inline `Pin` and `Archive` fold into the Action Sheet alongside `Rename`, `Export`, `Delete`, and details; only `⋮` renders.
  - **Recent rows (`RecentSessions`):** Replace the custom `recent.actions` buttons/dropdown with the same single `⋮` trigger when `isTouchActions` is `true`, opening the Action Sheet populated with the actions permitted for that recent entry (`Pin`/`Unpin`, `Archive`, and session details).
  - **Managed rows (`ManagedSessionNavigationRow` + `ManagedSessionActions`):** Already render a single `⋮` button using `sidebarStyles.sessionActions` / `sidebarStyles.sessionActionButton`, so they automatically inherit the broadened media query and enlarged touch target.
  - **Non-actionable rows:**
    - Multi-select mode (`SelectableSessionRow`, `selectionMode === true`): No action trigger and no long-press handling.
    - Read-only untrusted workspace rows (`.sessionItemReadOnly`): No action menu trigger (no mutations are allowed); details remain optional/read-only and no fake actions are shown.
    - Hosts configuring `sessionActions.items` to empty `[]` (no actions and no `details`): Render no `⋮` trigger and disable long press.
- **Visual restraint:** Non-active sidebar rows render the `⋮` button at muted opacity (`0.55`) so a long list does not feel cluttered; the currently active row renders at full opacity (`1`).
- **Touch hit target & spacing:**
  - Increase non-archived sidebar `.sessionRow` minimum height in touch/mobile-drawer mode (`:not([data-narrow])`) from `30px` to `40px` (compact enough to keep 10+ sessions visible while preventing mistaps), while preserving the existing `[data-narrow]` (`<= 280px`) wrapping rules intact.
  - Enlarge `.sessionActionButton` on `:not([data-narrow])` touch/mobile-drawer rows to `36px × 36px` while keeping the icon glyph at `16px`.
  - Keep `.sessionMetaSlot` right padding / flex gap cleanly separated from `.sessionActions` so status chips and PR badges never touch the `⋮` button.
  - Clicking/tapping `⋮` calls `event.stopPropagation()` and opens the session Action Sheet (or `DropdownMenu` in desktop fallback), never firing `openRow`.

#### Long-Press Gesture Contract

Extract a small reusable hook `useLongPress` (`packages/web-shell/client/components/sidebar/use-long-press.ts`) attached to actionable session rows when `isTouchActions` is `true` and not in `selectionMode` / inline rename:

| Event / State                                  | Behavior                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onPointerDown`                                | Ignore non-primary buttons or `pointerType === 'mouse'`. Ignore events originating inside `.sessionActions`, buttons, links, or inputs (`target.closest('button, a, input')`). Record `(pointerId, clientX, clientY)` and start a `450 ms` timer. Apply a subtle `data-pressing="true"` attribute for visual press feedback (slight background/scale transition). |
| `onPointerMove`                                | If Euclidean distance from start exceeds `10 px`, cancel the timer and clear `data-pressing` immediately so vertical list scrolling is never hindered.                                                                                                                                                                                                            |
| `onPointerUp` / `onPointerCancel` / `onScroll` | Cancel pending timer and clear `data-pressing`.                                                                                                                                                                                                                                                                                                                   |
| Timer fires (`450 ms`)                         | Clear `data-pressing`, mark `suppressNextClickRef` for that pointer sequence, trigger optional light haptics (`navigator.vibrate?.(10)` inside a feature check — no-op on iOS Safari), and open the Action Sheet for that session.                                                                                                                                |
| Subsequent `onClick` / `onContextMenu`         | If long press fired for this interaction, call `event.preventDefault(); event.stopPropagation();` and clear the suppression flag so releasing the finger never switches the active session or triggers browser context menus.                                                                                                                                     |

> Note: `packages/web-shell/client/styles/standalone.css` already applies `-webkit-touch-callout: none` and `user-select: none` under touch media queries, preventing the iOS Safari copy/lookup callout from racing with long press. We also apply `-webkit-touch-callout: none; user-select: none;` directly on `.sessionRow` under `@media (pointer: coarse)` and `.sidebar.mobileOpen` so embedded hosts that do not load `standalone.css` get the same clean long-press behavior. `useLongPress` additionally cancels active timers on `window` `blur` and capture-phase `scroll`.

### 3.3 Mobile Action Sheet (`ui/drawer`) & Embedded Session Details

Following the established pattern in `packages/web-shell/client/components/composer/AddMenu.tsx`, introduce `SessionActionSheet` (`packages/web-shell/client/components/sidebar/SessionActionSheet.tsx`) backed by `Drawer`, `DrawerContent`, and `DrawerTitle` from `packages/web-shell/client/components/ui/drawer.tsx`.

A **single** `SessionActionSheet` instance is mounted at the `WebShellSidebar` root (driven by `actionSheetSession` state) rather than mounting one `Drawer` per session row, keeping sidebar list rendering lightweight even with hundreds of sessions.

#### Root Page Layout (`page === 'root'`)

```text
┌─────────────────────────────────────────────┐
│  ──── (drag handle)                         │
│  [Full wrapped session title]          [×]  │  ← DrawerTitle + Close button (44×44)
├─────────────────────────────────────────────┤
│  Session Details Summary (embedded, when    │  ← Reuses extracted SessionDetailsContent
│  'details' is in sessionActionItems):       │    (compact mode: workspace, branch, time,
│  • Workspace · Git branch · Updated time    │     status, PR/Issue links, Copy Session ID)
│  • Running / Waiting / Clients badge        │
│  • Linked PR / Issue chips (tappable links) │
│  • Session ID  [Copy]                       │
├─────────────────────────────────────────────┤
│  [Pin / Unpin]                         48px │
│  [Rename]                              48px │
│  [Group ...]  (current group badge)  › 48px │  ← Pushes to page === 'group' in same Drawer
│  [Archive / Restore]                   48px │
│  [Export]                              48px │
│  [Add to Split View] (only if supported)    │  ← Hidden on narrow phones where split unavailable
├─────────────────────────────────────────────┤
│  [Delete]  (destructive red)           48px │
└─────────────────────────────────────────────┘
```

Key behavioral rules:

- **Action gating parity:** Every item obeys the exact same availability & `sessionActionItems` (`WebShellSidebarSessionActionsOptions.items`) rules as desktop `renderSessionRow` (including `canOrganizeSession`, `canMutateSessionMetadata` for `bindPr`, `sessionBlocksDelete`, `canMutateSessionArchive`, `getActiveExportScope`, `showSplit` / `canOpenSplitView`, `busy`, `standalone`, and `recent`).
- **Embedded Session Details (`SessionDetailsContent` extraction):** Extract the pure metadata presentation from `SessionDetailsTooltip.tsx` (workspace label, branch, timestamps, work status, PR/Issue links, and copyable Session ID with copy confirmation) into a shared internal component `SessionDetailsContent` (`variant="popover" | "sheet"`).
  - Rendered at the top of `SessionActionSheet` whenever `sessionActionItems.has('details')`.
  - Eliminates code duplication between desktop hover tooltips and the mobile Action Sheet, and ensures PR/Issue links and Session ID copying stay identical across platforms.
  - Because `SessionActionSheet` is scrollable (`overflow-y-auto` inside a `data-vaul-no-drag` container with `max-h-[85dvh]` and bottom safe-area padding `pb-[max(1rem,env(safe-area-inset-bottom))]`), long titles or multiple PR badges never clip.
- **In-Sheet Group & Color Picker (`page === 'group'`):**
  - Tapping **Group** in the root page switches `page` to `'group'` inside the same `Drawer` (with a `44×44` Back button in the header), reusing `listSessionGroups` / `assignSessionGroup` / `assignSessionColor` / `handleCreateGroupForSession`.
  - Replaces `openGroupMenuFromAnchor` + `.groupMenu` (`position: fixed; width: 240px`) on touch devices so there is no viewport-edge clipping or double floating menu.
  - Each group/color row is `min-h-[44px]` with clear checkmark state. Tapping **New group** closes the sheet via `closeAndRun` and opens the existing group creation dialog.
- **Modal handoff (`closeAndRun` pattern from `AddMenu.tsx`):**
  - Immediate non-modal actions (`Pin`, `Archive`/`Restore`, `Export`, `Add to Split View`) execute directly and close the sheet.
  - Dialog-opening actions (`Rename`, `Delete`, `New group`) store the callback in a `pendingCloseActionRef`, close the `Drawer`, and invoke the callback once `DrawerContent` closes (with a fallback guard if the animation completes synchronously in tests/reduced-motion), preventing stacked Radix/vaul modal overlays and focus-trap fights.

### 3.4 Touch Rename via `SessionRenameDialog`

When rename is triggered from `SessionActionSheet` (or when `isTouchActions` is `true`):

- Open the existing `SessionRenameDialog` (`packages/web-shell/client/components/dialogs/SessionRenameDialog.tsx`) instead of activating inline `SessionRenameEditor` inside the sidebar row.
- Submitting calls the same underlying rename handler (`saveRename` / `StandaloneSessionRowAdapter.onRename`) and keeps `onSessionRenameConfirmed` and error handling identical.
- Desktop mouse users triggering Rename from the dropdown or double-clicking a row continue to use inline `SessionRenameEditor`.
- `onDoubleClick` rename on `.sessionRow` is suppressed when `isTouchActions` is `true` so rapid taps never accidentally enter inline rename mode.

### 3.5 Closing Remaining Pure-Hover Dead Ends

1. **Workspace Header Actions (`WorkspaceSection.tsx` + `WebShellSidebar.tsx` + `WorkspaceMenu.tsx`):**
   - **Remove inline JS visibility lock:** Replace `style={{ visibility: visible || openWorkspaceMenuId === ws.id ? 'visible' : 'hidden' }}` in `WebShellSidebar.tsx` and the hover-only `actionsVisible` gating in `WorkspaceSection.tsx` with CSS classes (`.workspaceHeaderActions` + `data-menu-open="true"`), matching the pattern already used in `ManagedWorkspaceNavigation.tsx` and `.sessionActions`:
     - Desktop hover/focus: revealed on `.headerRow:hover`, `.headerRow:focus-within`, or `[data-menu-open="true"]` (in `WorkspaceSection.module.css` / `WebShellSidebar.module.css`).
     - Touch / mobile drawer (`@media (pointer: coarse)` and `.sidebar.mobileOpen`): always visible (`opacity: 1; visibility: visible; pointer-events: auto;`), showing a single enlarged `⋮` (`WorkspaceMenu`) trigger (`36px × 36px`), while folding the separate hover-only `+ New task` button into `WorkspaceMenu` (which already contains `actions.newSession`!). This keeps workspace names readable on narrow phones while keeping every workspace action one tap away.
   - **Surface workspace details inside `WorkspaceMenu`:** Add an optional compact read-only header block (full workspace path, active Git branch + status summary) at the top of `WorkspaceMenu` when `isTouchActions` is `true` (or always as a compact header label when provided), making the information from `WorkspaceDetailsTooltip` accessible without hover. Note: `WorkspaceMenu` already renders the management facet counts (MCP / Skills / Extensions / Channels).
   - **Align `ManagedWorkspaceNavigation.tsx`:** Switch `[@media(hover:none)]:visible` to `[@media(pointer:coarse)]:visible` so Apple Pencil hover iPads match coarse-pointer visibility without tripping on headless fine-pointer Linux Chromium.

2. **Session Group Header Actions (`SessionGroupSection.tsx` + `WebShellSidebar.module.css`):**
   - Currently `.sessionGroupHeaderActions` renders two separate icon buttons (`Rename group` + `Delete group`) that stay `opacity: 0` without hover.
   - When `isTouchActions` is `true` (and at least one of `onRename` / `onDelete` is provided), render a single compact always-visible `⋮` `DropdownMenu` trigger (with touch-friendly `44px` menu items for Rename Group and Delete Group) instead of two hidden hover buttons.
   - Desktop keeps the existing two inline hover buttons unchanged.

3. **Suppress Touch Sticky-Hover Flash on Tooltips (`SessionDetailsTooltip.tsx`, `WorkspaceDetailsTooltip.tsx`):**
   - In both components' hover entry handlers (`onPointerEnter`), ignore non-mouse pointers (`if (event.pointerType && event.pointerType !== 'mouse') return;`) when `openOnClick` is `false`.
   - In `WorkspaceDetailsTooltip.tsx`, also guard the `onFocus` hover-parity path so touch-initiated focus (non-`:focus-visible` focus after a touch pointer down) does not schedule `openAfterDelay()`.
   - This prevents iOS/Android browsers from firing synthetic hover or tap-focus events and flashing a floating tooltip over the sidebar drawer or action sheet.

### 3.6 Shell Integration Constraints (Touch Scroll, Escape, Z-Index, React 18 & Portal)

Code inspection of `packages/web-shell/client/App.tsx` and `packages/web-shell/client/App.module.css` reveals four concrete invariants that the implementation **must** uphold:

1. **`App.tsx` document-level `touchmove` scroll lock (`preventScroll`):**
   - While `mobileDrawerOpen` is `true`, `App.tsx` registers a non-passive `document` `touchmove` listener that calls `e.preventDefault()` for anything outside `[data-sidebar-shell]` (excluding backdrop) and an explicit overlay allowlist (`[data-web-shell-dialog], [data-web-shell-sidebar-more], ...`).
   - Because `SessionActionSheet` portals via `useWebShellPortalRoot()` **outside** `[data-sidebar-shell]`, we add `[data-web-shell-session-action-sheet]` to the `preventScroll` allowlist in `App.tsx`, and pass inline `style={{ touchAction: 'pan-y' }}` on `DrawerContent` to override `vaul`'s runtime-injected unlayered `[data-vaul-drawer]{touch-action:none}` rule so vertical scrolling inside the sheet works natively on iOS/Android.
2. **`App.tsx` capture-phase `Escape` handler (`onKey`) & focus restoration:**
   - While `mobileDrawerOpen` is `true`, `App.tsx` captures `Escape` on `window` and closes the entire left sidebar drawer unless the target matches its allowlist (`[data-web-shell-sidebar-more], ...`).
   - Add `[data-web-shell-session-action-sheet]` (and check open `[data-web-shell-session-action-sheet][data-state="open"], [data-slot="dropdown-menu-content"][data-state="open"]`) to the `onKey` exemption so pressing `Escape` on an iPad hardware keyboard closes only the top overlay first, leaving the sidebar drawer open; `SessionActionSheet` caches `returnFocusEl` across close and restores focus to the triggering `⋮` button on `Escape`/Close while leaving focus untouched on outside-pointer dismissal.
3. **Z-index stacking & portal isolation:**
   - `.mobileDrawer` / `.mobileDrawerForced` in `App.module.css` sits at `z-index: 50`, which collides with `ui/drawer.tsx`'s default `z-[var(--web-shell-dialog-backdrop-z-index,50)]`.
   - `SessionActionSheet` passes explicit overlay/content stacking classes `z-[calc(var(--web-shell-dialog-backdrop-z-index,50)+2)]` (above `.mobileDrawer` at `50`, below `ToastHost` at `+10` and `SESSION_MENU_PORTAL_STYLE` popovers at `1001`).
   - All portals (`DrawerPortal`, `DropdownMenuPortal`, `DialogShell`) continue using `useWebShellPortalRoot()` so theme tokens, scoped CSS, and Shadow DOM embeddings remain intact.
4. **React 18 & 19 ref compatibility:**
   - Any new trigger wrappers interacting with Radix `asChild` or `DrawerTrigger` must use `React.forwardRef` and forward refs cleanly, per Web Shell's React 18/19 compatibility rule (covered by `react18-ref-compat.test.tsx`).

---

## 4. Design Decisions & Trade-offs

| Decision                | Chosen option                                                                       | Alternative considered                                      | Rationale                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary touch trigger   | Single visible `⋮` button + 450 ms long press                                       | Long press only (no button)                                 | Long press alone has poor discoverability for first-time mobile users and assistive tech; `⋮` guarantees discoverability while long press provides effortless thumb access anywhere on the row.                                                                                                                                 |
| Row gesture             | Long press                                                                          | Swipe-to-reveal                                             | Swipe conflicts with iOS/Android back navigation and the sidebar drawer's left-edge mental model, and cannot hold 6–8 actions + details cleanly.                                                                                                                                                                                |
| Touch menu container    | Bottom `ui/drawer` Action Sheet (centered `max-w-md` on iPad/wide touch)            | Enlarged Radix `DropdownMenu` everywhere                    | Bottom sheets put actions in the thumb zone, naturally host embedded `SessionDetailsContent`, and eliminate the manually positioned `.groupMenu` secondary overlay via an in-sheet subpage (matching `AddMenu.tsx`).                                                                                                            |
| Inline buttons on touch | Fold all inline buttons (`Pin`, `Export`, `Restore`, `Archive`) into `⋮`            | Keep `Pin` + `⋮` visible on touch                           | Mobile drawer width is ~273 px on a 390 px phone; every extra 26–36 px button noticeably truncates session titles and increases mistap risk.                                                                                                                                                                                    |
| Touch detection         | `(pointer: coarse)` + `.sidebar.mobileOpen` + event-level `pointerType === 'touch'` | `(hover: none), (pointer: coarse)` or `any-pointer: coarse` | Bare `(hover: none)` misfires on headless fine-pointer Linux Chromium; `any-pointer: coarse` alters touchscreen desktops. `(pointer: coarse)` covers phones, tablets, and Apple Pencil iPads, while event-level `pointerType === 'touch'` covers hybrid trackpad iPads on finger taps/long-press without affecting mouse users. |
| Session rename on touch | Reuse `SessionRenameDialog`                                                         | Keep inline `SessionRenameEditor`                           | Soft keyboard resize inside a sliding drawer obscures inline inputs and causes accidental blur-cancel; modal dialog already exists and is proven in `StandaloneRecents`.                                                                                                                                                        |

---

## 5. Implementation Plan (Phased P0 -> P1)

The work can be delivered either in two sequential PRs (P0 then P1) or as one cohesive PR with clean commit boundaries:

### Phase P0 — Touch Reachability & Hover Dead-End Fixes

1. Add `useTouchSidebarActions` hook (`packages/web-shell/client/components/sidebar/use-touch-sidebar-actions.ts`).
2. Broaden touch media queries in `WebShellSidebar.module.css` (and `ManagedWorkspaceNavigation.tsx`) to `@media (pointer: coarse)` plus `.sidebar.mobileOpen`; enlarge `.sessionRow:not(.archivedRow)` (`min-height: 40px`) and `.sessionActionButton` (`36px × 36px`) outside `[data-narrow]`; keep `.sessionBackgroundRunning:hover` rule scoped to `@media (hover: hover) and (pointer: fine)`.
3. Collapse session row actions to a single `⋮` trigger under `isTouchActions` across standard, archived, standalone, and recent rows; move folded actions (`Pin`, `Export`, `Restore`, `Archive`) into the menu; add muted opacity for non-active rows.
4. Fix `WorkspaceSection.tsx` + `WebShellSidebar.tsx` workspace header actions: replace inline JS `visibility` toggle with CSS-driven reveal (`hover` / `focus-within` / `data-menu-open` on desktop, always-visible `⋮` on touch/mobile drawer) and show workspace path/branch summary inside `WorkspaceMenu` on touch.
5. Fix `SessionGroupSection.tsx`: expose touch-accessible `⋮` menu for Rename Group / Delete Group under `isTouchActions`.
6. Update `SessionDetailsTooltip.tsx` and `WorkspaceDetailsTooltip.tsx` to ignore non-mouse `pointerType` on hover entry; in P0-only mode (before P1 lands), add a **Details** entry to the dropdown if P0 ships separately.

### Phase P1 — Bottom Action Sheet, Long Press, In-Sheet Group Picker & Dialog Rename

1. Extract `SessionDetailsContent` from `SessionDetailsTooltip.tsx` for shared rendering in both desktop popovers and the Action Sheet header.
2. Implement `SessionActionSheet.tsx` using `ui/drawer` with root page (details + actions), in-sheet `'group'` subpage (colors, named groups, create group), `data-web-shell-session-action-sheet` marker, `closeAndRun` handoff, and `z-[calc(var(--web-shell-dialog-backdrop-z-index,50)+2)]` stacking.
3. Implement `useLongPress` hook (`packages/web-shell/client/components/sidebar/use-long-press.ts`) and wire it to actionable session rows when `isTouchActions && !selectionMode`.
4. Route touch-initiated rename through `SessionRenameDialog` in `WebShellSidebar.tsx` and disable `onDoubleClick` inline rename when `isTouchActions` is `true`.
5. Update `packages/web-shell/client/App.tsx` (`preventScroll` `touchmove` allowlist and capture-phase `Escape` handler) to exempt `[data-web-shell-session-action-sheet]`.
6. Add any missing i18n keys (e.g., sheet accessibility title / back / copy feedback if not already present in existing `sidebar.*` and `common.*` keys) across all locale bundles.

---

## 6. Risks & Edge Cases

- **iPad with external keyboard + mouse/trackpad:** Under `(hover: none), (pointer: coarse)`, an iPad with an attached trackpad may still report `pointer: coarse` for its primary touchscreen (depending on iPadOS version) and therefore keep the single `⋮` trigger and centered Action Sheet. This is intentional: iPad users frequently switch between finger and trackpad within the same session, and a centered Action Sheet remains fully usable with both pointer and keyboard (`Escape` / `Tab`).
- **Existing stylesheet & visual contract tests:**
  - `packages/web-shell/client/components/sidebar/WebShellSidebar.css.test.ts` pins `.sessionActions` and `[data-narrow]` wrapping rules under the touch media query.
  - `packages/web-shell/client/visual-capture-contracts.test.ts` asserts the `@media (hover: hover)` regex around `.sessionRow:has(.sessionBackgroundRunning:hover) .sessionActions`.
  - Both suites are updated to assert the `@media (pointer: coarse)` query (and absence of bare `(hover: none),` false positives), enlarged touch targets on `:not([data-narrow])`, and preserved desktop hover rules while keeping Settings `ArchivedSessionsPanel` tests intact.
- **Session deleted or updated while Action Sheet is open:** Store `{ sessionId, workspaceCwd, scope }` (or reconcile against live catalog state) rather than relying solely on a stale snapshot; if the target session disappears (e.g., deleted from another client or workspace removed), close the Action Sheet cleanly and reset `page` to `'root'`.
- **Long press vs. list scroll / drag-to-reorder:** Ensure `10 px` move threshold cancels long press immediately, and never attach long press to workspace drag handles or `SelectableSessionRow`.
- **Embedded hosts & Shadow DOM:** Keep `useWebShellPortalRoot()`, avoid querying `document.body` directly for focus or containment checks, and include `-webkit-touch-callout: none` in `WebShellSidebar.module.css` (not only `standalone.css`).
- **iOS soft keyboard zoom on rename input:** `SessionRenameDialog` renders `ui/input`; verify font size in touch mode stays `>= 16px` (or relies on existing `standalone.css` rule) so iOS Safari does not auto-zoom when focusing the rename input.

---

## 7. Validation Plan & Acceptance Criteria

### Automated Verification

1. **Unit & contract tests (Vitest, run inside `packages/web-shell`):**
   - `use-touch-sidebar-actions.test.tsx` & `use-long-press.test.tsx`: verify touch/mobile media query reactivity, 450 ms trigger, cancellation on `>10 px` move / pointer up / cancel, mouse pointer ignore, nested button ignore, and suppression of the trailing `click`.
   - `SessionActionSheet.test.tsx` & `WebShellSidebar.touch-actions.test.tsx`: verify root action gating (`sessionActions.items`, `bindPr`, `sessionBlocksDelete`, busy disabled states), embedded `SessionDetailsContent` (title, workspace, branch, PR link, copy Session ID), `'group'` subpage navigation and assignment, long-press entry, `closeAndRun` handoff to `SessionRenameDialog`, and workspace header convergence on `mobileOpen`.
   - `WorkspaceSection` / `WorkspaceMenu.test.tsx` & `SessionGroupSection.test.tsx`: verify workspace `⋮` menu (including path/branch summary) and group `⋮` menu are rendered and actionable without hover under touch mode.
   - `SessionDetailsTooltip.test.tsx` & `WorkspaceDetailsTooltip.test.tsx`: verify `pointerType: 'touch'` on pointer-enter (and touch-initiated focus) does not open hover tooltips, while `pointerType: 'mouse'` and keyboard focus continue to open them.
   - `App.test.tsx`: verify `touchmove` inside `[data-web-shell-session-action-sheet]` and `[data-slot="dropdown-menu-content"]` is **not** `defaultPrevented` while `mobileDrawerOpen` is `true`, and `Escape` closes only the overlay without closing the sidebar drawer.
   - `WebShellSidebar.css.test.ts` & `visual-capture-contracts.test.ts`: updated to assert the broadened touch media query, single-trigger layout, enlarged touch targets, preserved `[data-narrow]` rules, and preserved desktop hover rules.
   - `react18-ref-compat.test.tsx` & `chat-core/boundary.test.ts`: verify `forwardRef` compatibility and bundle isolation invariants.
2. **Browser E2E tests (Playwright):**
   - `web-shell.sidebar-touch.mobile.spec.ts` (`mobile-chromium` touch profile) verifies:
     - Session row and Recent row show only a single `⋮` button with hit area `>= 36×36 px` and row height `>= 40 px`.
     - Tapping `⋮` opens the bottom Action Sheet without switching the active session; embedded session details (including Copy Session ID) are visible and functional.
     - Long-pressing a session row opens the same Action Sheet without switching the active session.
     - Tapping **Group** navigates to the in-sheet group picker and updates the session's group cleanly; tapping **Rename** opens `SessionRenameDialog` and updates the title.
     - Workspace header `⋮` menu is visible without hover and exposes the workspace summary.
   - `web-shell.archived-settings.spec.ts` (`chromium` desktop & touch) confirms Settings archived rows remain regression-free.
3. **Repository gates:** `npm run build`, `npm run typecheck`, `npm run lint`, and focused package unit + Playwright tests.

### Acceptance Criteria

- [ ] On iPhone, iPad (including hybrid hover/coarse profiles), and Android viewports, every session row displays a single `⋮` button (`>= 36×36 px` target) and does not expose multi-button hover clusters that crush the title.
- [ ] Tapping `⋮` or long-pressing (`~450 ms`) a session row opens the bottom `SessionActionSheet` without switching the active session; scrolling cancels long press cleanly.
- [ ] `SessionActionSheet` embeds session details (title, workspace, branch, status, PR/Issue links, copyable Session ID) and an in-sheet Group/Color picker with `>= 44 px` touch rows.
- [ ] Renaming a session on touch opens `SessionRenameDialog` rather than an inline sidebar input.
- [ ] Workspace header actions (`WorkspaceMenu` + workspace summary) and session group header actions (rename/delete group) are reachable by tap without hover.
- [ ] `SessionDetailsTooltip` and `WorkspaceDetailsTooltip` do not flash open on touch taps.
- [ ] Scrolling inside the Action Sheet and pressing `Escape` work properly while the mobile sidebar drawer is open.
- [ ] Desktop mouse behavior (hover reveal, inline actions, hover details popovers, dropdown menu, inline rename) remains unchanged.

---

## 8. Follow-ups (Out of Scope / P2)

- **Chat header tap-to-inspect & quick actions (`ChatPane.tsx`):** Enable `openOnClick` on the `ChatPane` header's `SessionDetailsTooltip` on touch devices (and optionally expose rename/pin/archive for the active conversation directly from the chat header so mobile users do not have to reopen the sidebar for current-session actions).
- **Managed session Action Sheet parity:** Convert `ManagedSessionActions` from `DropdownMenu` to the same bottom Action Sheet pattern on mobile if user feedback requests parity beyond P0's trigger/target improvements.
