# WebShell Sidebar — Customization Guide

The `WebShellSidebar` is the session list and navigation panel rendered inside
the web-shell `App` component. This document maps each visual area to its
current customization capability and identifies areas with no external injection
point.

## Enabling the sidebar

The sidebar defaults to **Home only**: a 300px session column with a bottom collapse control. Omitting `sidebar`, passing `true`, or passing `{}` uses this default. Pass `sidebar={false}` or `{ enabled: false }` to hide it.

```tsx
import { WebShellWithProviders } from '@qwen-code/web-shell';

<WebShellWithProviders
  baseUrl="http://localhost:4170"
  sidebar={true} // Home-only default
  // or with fine-grained options:
  // sidebar={{ enabled: true, defaultCollapsed: false, ... }}
/>;
```

## Layout overview

Home-only hosts show branding, New task, projects, archived sessions and the collapse control in one column. Configuring another available primary entry or footer action adds a 56px icon rail beside the default 300px secondary column. Primary entries live in the rail; footer actions and version live in More. Custom renderers remain in the wide Home column. There is no public layout option.

**Breaking change:** previously an omitted `sidebar` hid the sidebar, and omitted navigation/footer item lists exposed all built-ins when the sidebar was enabled. Hosts must now pass `sidebar={false}` to retain the former hidden default, or explicitly list the entries they need. Standalone Web Shell explicitly configures its full menu. `branding.hideWhenCompact` now defaults to `false`; set it to `true` to preserve a hidden brand in the compact drawer.

## Customizable areas

### ① Branding — `branding`

```ts
interface WebShellSidebarBranding {
  render?: () => ReactNode; // replace the entire branding row
  hideWhenCompact?: boolean; // hide branding in the compact drawer (default: false)
}
```

| Value                            | Effect                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `undefined` (default)            | Resolved brand: `brand` prop → daemon `GET /brand` → built-in Qwen logo + "Qwen Code" text |
| `false`                          | Branding row hidden entirely                                                               |
| `{ render: () => <MyHeader /> }` | Full replacement with custom content                                                       |
| `{ hideWhenCompact: false }`     | Keep branding visible in the compact drawer (the default)                                  |

The default row is data-driven, not fixed: a daemon that serves a `ui.brand`
configuration renames the text and swaps the mark, and an embedding host can
override both with the shell component's `brand` prop (`onBrandResolved` reports
the outcome for the host's own chrome). `branding.render` stays the
highest-precedence override — it wins over the prop and the daemon-resolved
value, exactly as before.

```tsx
sidebar={{
  branding: {
    render: () => (
      <div style={{ display: 'flex', gap: 8 }}>
        <img src="/my-logo.svg" alt="" width={24} />
        <span>My App</span>
      </div>
    ),
  },
}}
```

### ② Primary Navigation — `primaryNav`

```ts
type WebShellSidebarPrimaryNavItem =
  | 'newTask' // ✏️ New Task button
  | 'plugins' // 🧩 Plugins button
  | 'channels' // Channel sessions and settings
  | 'live' // Live sessions and settings; requires showLive
  | 'workflows' // Requires workflow support
  | 'managed' // Requires a managed-agent provider
  | 'scheduledTasks' // 📅 Scheduled Tasks button
  | 'goals'; // 🎯 Goals button

interface WebShellSidebarPrimaryNavOptions {
  items?: readonly WebShellSidebarPrimaryNavItem[]; // which built-in buttons to show (default: ['newTask'])
  render?: () => ReactNode; // additional custom content after built-in buttons
}
```

The primary navigation area contains built-in buttons controlled by `items`:

- Only New task is shown when `items` is not specified; Home always exists
- Only the listed buttons are shown when `items` is provided
- Custom content can be added via `render()` after the built-in buttons

| Value                                      | Effect                                                |
| ------------------------------------------ | ----------------------------------------------------- |
| `undefined` (default)                      | Home with New task                                    |
| `{ items: ['plugins'] }`                   | Home and Plugins; no New task button                  |
| `{ items: ['plugins', 'scheduledTasks'] }` | Home + Plugins + Scheduled Tasks                      |
| `{ items: [], render: () => ... }`         | Home with custom content; no built-in primary buttons |

```tsx
sidebar={{
  primaryNav: {
    items: ['plugins', 'scheduledTasks'],  // hide newTask and goals
    render: () => (
      <button onClick={() => console.log('custom action')}>
        🔗 Data Sync
      </button>
    ),
  },
}}
```

### ④ Footer — `footer`

```ts
type WebShellSidebarFooterItem =
  | 'settings' // ⚙ Settings panel
  | 'update' // Update action when supported
  | 'localFiles' // Local-files bridge when available
  | 'desktopRelay' // Use this computer through the existing desktop relay
  | 'workspacesOverview' // Workspace management when unlocked
  | 'version' // version label (e.g. "v0.19.10")
  | 'theme' // ☀/🌙 light/dark toggle
  | 'sessionsOverview' // ▦ session overview panel
  | 'splitView' // ◧ split view (shell containers at least 1024px wide)
  | 'daemonStatus' // 📊 daemon status panel
  | 'collapse'; // ◁/▷ collapse/expand toggle

interface WebShellSidebarFooterOptions {
  items?: readonly WebShellSidebarFooterItem[]; // which built-in items to show (default: ['collapse'])
  render?: () => ReactNode; // custom content in the Home footer
}
```

| Value                                          | Effect                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `undefined` (default)                          | Only collapse/expand                                                      |
| `false`                                        | Footer hidden; the mobile drawer keeps only its close control             |
| `{ items: ['settings', 'theme', 'collapse'] }` | Only listed items shown; the mobile drawer always keeps its close control |

In rail layout, footer actions and version appear in More; only the collapse/expand control stays at the rail bottom. Home-only mode retains the existing compact footer behavior.

```tsx
sidebar={{
  footer: { items: ['theme', 'collapse'] },  // minimal footer
}}
```

Custom content via `render()` appears in the wide Home footer:

```tsx
sidebar={{
  footer: {
    items: ['collapse'],
    render: () => (
      <button onClick={() => openHelpCenter()}>
        ❓ Help
      </button>
    ),
  },
}}
```

**Note:** `'scheduledTasks'` and `'goals'` have been moved to the primary
navigation area (②) and require explicit configuration in embedded hosts. They are controlled by `primaryNav.items` instead of
`footer.items`.

### Other top-level options

```ts
interface WebShellSidebarOptions {
  enabled?: boolean; // show/hide sidebar (default: true, including when sidebar is omitted)
  defaultCollapsed?: boolean; // initial collapsed state (persisted in localStorage)
  showCompactToggle?: boolean; // show the collapse button in the chat area (default: true)
  showSessionSourceSwitch?: boolean; // show the Tasks/Channels switch (default: true)
  showLive?: boolean; // show daemon-owned Live conversations (default: false)
  branding?: false | WebShellSidebarBranding;
  primaryNav?: WebShellSidebarPrimaryNavOptions;
  hideProjectHeader?: boolean; // hide "Projects" header row (default: false = shown)
  sessionActions?: WebShellSidebarSessionActionsOptions;
  footer?: false | WebShellSidebarFooterOptions;
}
```

### Session source switch — `showSessionSourceSwitch`

Set `showSessionSourceSwitch` to `false` when an embedded host should show only
ordinary task sessions:

```tsx
sidebar={{
  showSessionSourceSwitch: false,
}}
```

This removes the Tasks/Channels switch and fixes every active, archived, primary,
and secondary session query to `sourceType: "default"`. Omitting the option keeps
channel-session access. When a dedicated Channels rail entry is available, it replaces the source tabs; otherwise the tabs remain.

### Live conversations — `showLive`

Live conversations are hidden from embedded hosts by default. Opt in when the
host should expose daemon-owned Live conversations:

Previous releases displayed this group without an explicit option, so hosts
that rely on it must set `showLive: true` when upgrading.

```tsx
sidebar={{
  showLive: true,
  primaryNav: { items: ['newTask', 'live'] },
}}
```

Without the `live` primary entry, `showLive: true` retains the existing Live group in Home and settings under Experimental. With the entry, Live opens its own session column and settings page.

### ③ Project Header — `hideProjectHeader`

Controls visibility of the "Projects" header row (the row with the collapse
toggle, search icon, and add workspace button). Defaults to `false` (shown).

```tsx
sidebar={{
  hideProjectHeader: true,  // hide the "项目 ▼ [🔍] [＋]" row
}}
```

When hidden, the session list entries and archived sessions are still shown —
the header row with its action buttons and the session search bar are removed.

### Session Row Actions — `sessionActions`

```ts
type WebShellSidebarSessionActionItem =
  | 'details' // 📝 Details (dropdown sub-menu)
  | 'rename' // ✏️ Rename (dropdown menu)
  | 'group' // 📁 Group/Move to folder (dropdown menu)
  | 'export' // 📤 Export chat history (dropdown menu)
  | 'delete' // 🗑 Delete session (dropdown menu)
  | 'pin' // 📌 Pin/Unpin (inline button)
  | 'archive'; // 📦 Archive (dropdown menu)

/** Subset with working inline (hover-button) handlers. */
type WebShellSidebarSessionInlineActionItem =
  | 'pin'
  | 'rename'
  | 'export'
  | 'delete';

interface WebShellSidebarSessionActionsOptions {
  items?: readonly WebShellSidebarSessionActionItem[]; // which actions to show (default: all)
  inlineItems?: readonly WebShellSidebarSessionInlineActionItem[]; // which items appear as inline buttons (default: ['pin'])
}
```

Controls which action buttons appear on session rows:

- **`items`**: Master control for all actions (both inline and dropdown). If an item is not in `items`, it's hidden everywhere.
- **`inlineItems`**: Controls which items appear as **inline buttons** (on hover). Defaults to `['pin']`. Only items with working inline handlers can be used: `'pin'`, `'rename'`, `'export'`, `'delete'`. `'details'`, `'group'`, and `'archive'` are dropdown-only.

**Visibility priority**: Both `items` AND the item's built-in condition AND `inlineItems` must all pass for the inline button to show. For example, `delete` as inline requires `items` to include `'delete'` AND `inlineItems` to include `'delete'`.

| Value                                   | Effect                            |
| --------------------------------------- | --------------------------------- |
| `undefined` (default)                   | All actions shown, pin as inline  |
| `{ inlineItems: ['pin', 'delete'] }`    | Pin + delete as inline buttons    |
| `{ inlineItems: [] }`                   | No inline buttons at all          |
| `{ inlineItems: ['rename', 'export'] }` | Rename + export as inline buttons |

The dropdown trigger (⋮) is automatically hidden when no dropdown items
are enabled. Inline buttons are only shown when both
their capability condition and `items` include them. Archive is disabled on
the current session and on any session with a running turn, because the daemon
closes the live session when it archives.

```tsx
sidebar={{
  sessionActions: {
    items: ['details', 'rename', 'export', 'delete', 'pin'],  // which actions to show (master control)
    inlineItems: ['pin', 'delete'],  // pin + delete as inline buttons
  },
}}
```

## Non-customizable areas

### Projects / Workspaces (inside session list)

When the session list is visible, the following sub-areas are rendered but
**not individually customizable**:

| Aspect                | Detail                                                            |
| --------------------- | ----------------------------------------------------------------- |
| Data source           | `useSessions()` hook → daemon API (`/sessions` endpoint)          |
| Session list sorting  | By creation time, descending                                      |
| Session row rendering | Internal `renderSessionRow` `useCallback` — not injectable        |
| Search / filter       | Built-in search bar with client-side text matching                |
| Session groups        | `SessionGroupSection` component with 6 preset colors + custom hex |
| Workspace sections    | `WorkspaceSection` per daemon workspace, not replaceable          |
| Add workspace dialog  | Built-in `AddWorkspaceDialog`                                     |

### ⑤ Resize handle

- Drag handle on the right edge for resizing sidebar width
- Width is persisted in localStorage as the total sidebar width. Defaults are 300px Home-only and 356px with the rail. Restored widths are clamped to at least 220px Home-only or 276px with the rail; old values are not blindly increased by 56px. Dragging below the collapse threshold still folds the sidebar.
- The environment panel's dock breakpoint ignores the rail's 56px (the message area yields them), so the panel keeps docking at the same window widths as a Home-only sidebar — e.g. a 1440px window.
- Not configurable

## Runtime behavior props

These `WebShellProps` affect sidebar behavior indirectly:

| Prop                            | Effect                                 |
| ------------------------------- | -------------------------------------- |
| `onNewSession`                  | Override the new-session handler       |
| `onLoadSession`                 | Override session loading logic         |
| `onSessionIdChange`             | React to session switches              |
| `splitSessionIds`               | Control split-view sessions externally |
| `theme` / `onThemeChange`       | Control / observe theme                |
| `language` / `onLanguageChange` | Control / observe UI language          |

## Collapsed and mobile states

| State     | Behavior                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| Expanded  | Full sidebar with text labels                                                                                        |
| Collapsed | Home-only: existing 56px strip and hover sessions; with rail: only the 56px primary rail                             |
| Mobile    | Drawer uses 70% of its container, within width limits, with backdrop and a close control at the owning column bottom |

Collapse state is persisted in `localStorage` under the key
`qwen-code-web-shell-sidebar-collapsed`.

The sidebar, its compact drawer, and the empty-chat welcome chrome follow the shell container width (compact at 760px); chat message content keeps viewport-based breakpoints. Split availability uses 1024px and split-sidebar room uses 1200px. Keyboard collapse moves focus out of the hidden secondary column to the rail control.

The resized desktop width is restored only in expanded layouts. Opening or
closing the mobile drawer does not overwrite that width or the persisted
desktop collapse preference.

## Source locations

| Component           | File                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| WebShellSidebar     | `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`            |
| SessionGroupSection | `packages/web-shell/client/components/sidebar/SessionGroupSection.tsx`        |
| WorkspaceSection    | `packages/web-shell/client/components/sidebar/WorkspaceSection.tsx`           |
| Sidebar styles      | `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css`     |
| App integration     | `packages/web-shell/client/App.tsx` (search `WebShellSidebar`)                |
| Entry point (dev)   | `packages/web-shell/client/main.tsx` (explicit primary and footer item lists) |
