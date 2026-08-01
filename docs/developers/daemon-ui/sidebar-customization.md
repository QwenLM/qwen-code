# WebShell Sidebar — Customization Guide

The `WebShellSidebar` is the session list and navigation panel rendered inside
the web-shell `App` component. This document maps each visual area to its
current customization capability and identifies areas with no external injection
point.

## Enabling the sidebar

The sidebar is **disabled by default**. Pass the `sidebar` prop to enable:

```tsx
import { WebShellWithProviders } from '@qwen-code/web-shell';

<WebShellWithProviders
  baseUrl="http://localhost:4170"
  sidebar={true} // simple enable
  // or with fine-grained options:
  // sidebar={{ enabled: true, defaultCollapsed: false, ... }}
/>;
```

## Layout overview

```
┌─────────────────────────────────────┐
│ ① Branding (topRow)                 │  ✅ customizable
├─────────────────────────────────────┤
│ ② Primary navigation                │  ✅ customizable
│    [＋ New task]  [🧩 Plugins]      │
│    [📅 Scheduled] [🎯 Goals]        │
│    [custom render...]               │
├─────────────────────────────────────┤
│ ③ Project header                    │  ✅ show/hide
│    📁 Projects ▼ [🔍] [＋]          │
│    Session list entries...          │
│    📦 Archived sessions             │
├─────────────────────────────────────┤
│ ④ Footer action bar                 │  ✅ customizable
│    [⚙ Settings] v0.19 [☀] [▦] [◧] │
├─────────────────────────────────────┤
│ ⑤ Resize handle                     │  ❌ not customizable
└─────────────────────────────────────┘
```

## Customizable areas

### ① Branding — `branding`

```ts
interface WebShellSidebarBranding {
  render?: () => ReactNode; // replace the entire branding row
  hideWhenCompact?: boolean; // hide when sidebar is collapsed (default: true)
}
```

| Value                            | Effect                                            |
| -------------------------------- | ------------------------------------------------- |
| `undefined` (default)            | Qwen logo + "Qwen Code" text                      |
| `false`                          | Branding row hidden entirely                      |
| `{ render: () => <MyHeader /> }` | Full replacement with custom content              |
| `{ hideWhenCompact: false }`     | Keep branding visible in collapsed icon-rail mode |

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
  | 'scheduledTasks' // 📅 Scheduled Tasks button
  | 'goals'; // 🎯 Goals button

interface WebShellSidebarPrimaryNavOptions {
  items?: readonly WebShellSidebarPrimaryNavItem[]; // which built-in buttons to show (default: all)
  render?: () => ReactNode; // additional custom content after built-in buttons
}
```

The primary navigation area contains built-in buttons controlled by `items`:

- All buttons are shown by default when `items` is not specified
- Only the listed buttons are shown when `items` is provided
- Custom content can be added via `render()` after the built-in buttons

| Value                                      | Effect                                 |
| ------------------------------------------ | -------------------------------------- |
| `undefined` (default)                      | All built-in buttons shown             |
| `{ items: ['plugins'] }`                   | Only Plugins button                    |
| `{ items: ['plugins', 'scheduledTasks'] }` | Plugins + Scheduled Tasks              |
| `{ items: [], render: () => ... }`         | Hide all built-in, only custom content |

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
  | 'version' // version label (e.g. "v0.19.10")
  | 'theme' // ☀/🌙 light/dark toggle
  | 'sessionsOverview' // ▦ session overview panel (large screens only)
  | 'splitView' // ◧ split view (large screens only)
  | 'daemonStatus' // 📊 daemon status panel
  | 'collapse'; // ◁/▷ collapse/expand toggle

interface WebShellSidebarFooterOptions {
  items?: readonly WebShellSidebarFooterItem[]; // which built-in items to show (default: all)
  render?: () => ReactNode; // custom content rendered on the left side, before built-in items
}
```

| Value                                          | Effect                  |
| ---------------------------------------------- | ----------------------- |
| `undefined` (default)                          | All items shown         |
| `false`                                        | Footer hidden entirely  |
| `{ items: ['settings', 'theme', 'collapse'] }` | Only listed items shown |

The footer auto-adapts to narrow widths: labels are hidden and version is
dropped below certain thresholds.

```tsx
sidebar={{
  footer: { items: ['theme', 'collapse'] },  // minimal footer
}}
```

Custom content via `render()` appears on the left side of the footer, before
the built-in items:

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
navigation area (②) and are shown by default. They are controlled by `primaryNav.items` instead of
`footer.items`.

### Other top-level options

```ts
interface WebShellSidebarOptions {
  enabled?: boolean; // show/hide sidebar (default: true when passed)
  defaultCollapsed?: boolean; // initial collapsed state (persisted in localStorage)
  showCompactToggle?: boolean; // show the collapse button in the chat area (default: true)
  branding?: false | WebShellSidebarBranding;
  primaryNav?: WebShellSidebarPrimaryNavOptions;
  hideProjectHeader?: boolean; // hide "Projects" header row (default: false = shown)
  sessionActions?: WebShellSidebarSessionActionsOptions;
  footer?: false | WebShellSidebarFooterOptions;
}
```

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
  | 'archive'; // 📦 Archive (inline button)

/** Subset with working inline (hover-button) handlers. */
type WebShellSidebarSessionInlineActionItem =
  | 'pin'
  | 'archive'
  | 'rename'
  | 'export'
  | 'delete';

interface WebShellSidebarSessionActionsOptions {
  items?: readonly WebShellSidebarSessionActionItem[]; // which actions to show (default: all)
  inlineItems?: readonly WebShellSidebarSessionInlineActionItem[]; // which items appear as inline buttons (default: ['pin', 'archive'])
}
```

Controls which action buttons appear on session rows:

- **`items`**: Master control for all actions (both inline and dropdown). If an item is not in `items`, it's hidden everywhere.
- **`inlineItems`**: Controls which items appear as **inline buttons** (on hover). Defaults to `['pin', 'archive']`. Only items with working inline handlers can be used: `'pin'`, `'archive'`, `'rename'`, `'export'`, `'delete'`. `'details'` and `'group'` are dropdown-only.

**Visibility priority**: Both `items` AND the item's built-in condition AND `inlineItems` must all pass for the inline button to show. For example, `delete` as inline requires `items` to include `'delete'` AND `inlineItems` to include `'delete'`.

| Value                                    | Effect                                     |
| ---------------------------------------- | ------------------------------------------ |
| `undefined` (default)                    | All actions shown, pin + archive as inline |
| `{ inlineItems: ['pin', 'delete'] }`     | Pin + delete as inline buttons             |
| `{ inlineItems: [] }`                    | No inline buttons at all                   |
| `{ inlineItems: ['archive', 'export'] }` | Archive + export as inline buttons         |

The dropdown trigger (⋮) is automatically hidden when no dropdown items
are enabled. Inline buttons (`pin`, `archive`) are only shown when both
their capability condition and `items` include them.

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
- Width is persisted in localStorage
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

| State     | Behavior                                           |
| --------- | -------------------------------------------------- |
| Expanded  | Full sidebar with text labels                      |
| Collapsed | Icon-rail mode (logo, pen icon, action icons only) |
| Mobile    | Drawer slides from left with backdrop overlay      |

Collapse state is persisted in `localStorage` under the key
`qwen-code-web-shell-sidebar-collapsed`.

## Source locations

| Component           | File                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| WebShellSidebar     | `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`        |
| SessionGroupSection | `packages/web-shell/client/components/sidebar/SessionGroupSection.tsx`    |
| WorkspaceSection    | `packages/web-shell/client/components/sidebar/WorkspaceSection.tsx`       |
| Sidebar styles      | `packages/web-shell/client/components/sidebar/WebShellSidebar.module.css` |
| App integration     | `packages/web-shell/client/App.tsx` (search `WebShellSidebar`)            |
| Entry point (dev)   | `packages/web-shell/client/main.tsx` (`sidebar: true`)                    |
