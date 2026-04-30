/**
 * Shared Menu Schema
 *
 * Defines menu structure consumed by both:
 * - Main process: transforms to Electron MenuItemConstructorOptions
 * - Renderer: transforms to React dropdown components
 *
 * Single source of truth for labels, shortcuts, icons, and IPC channels.
 *
 * NOTE: All labels are i18n keys (e.g., "menu.edit"), NOT resolved strings.
 * Consumers must call t(item.labelKey) or i18n.t(item.labelKey) at render/build time.
 * This avoids stale translations from module-level i18n.t() calls.
 */

import { RPC_CHANNELS } from './types'
import { FEATURE_FLAGS } from '@craft-agent/shared/feature-flags'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MenuItemAction {
  type: 'action'
  id: string
  labelKey: string              // i18n key — resolve with t() at render time
  /** Link to the action registry (e.g., 'view.toggleSidebar').
   *  Enables future: derive display shortcuts from registry + propagate user overrides. */
  actionId?: string
  shortcut: string              // Electron accelerator: 'CmdOrCtrl+B'
  shortcutDisplayMac: string    // Display on macOS: '⌘B'
  shortcutDisplayOther: string  // Display on Windows/Linux: 'Ctrl+B'
  ipcChannel: string
  icon: string                  // Lucide icon name
}

export interface MenuItemRole {
  type: 'role'
  role: string                  // Electron role: 'undo', 'copy', etc.
  labelKey: string              // i18n key — resolve with t() at render time
  shortcutDisplayMac?: string
  shortcutDisplayOther?: string
  icon: string
  ipcChannel?: string           // Optional IPC for renderer to call
}

export interface MenuItemSeparator {
  type: 'separator'
}

export type MenuItem = MenuItemAction | MenuItemRole | MenuItemSeparator

export interface MenuSection {
  id: string
  labelKey: string              // i18n key — resolve with t() at render time
  icon: string
  items: MenuItem[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu Definitions
// ─────────────────────────────────────────────────────────────────────────────

export const EDIT_MENU: MenuSection = {
  id: 'edit',
  labelKey: 'menu.edit',
  icon: 'Pencil',
  items: [
    {
      type: 'role',
      role: 'undo',
      labelKey: 'menu.undo',
      icon: 'Undo2',
      shortcutDisplayMac: '⌘Z',
      shortcutDisplayOther: 'Ctrl+Z',
      ipcChannel: RPC_CHANNELS.menu.UNDO,
    },
    {
      type: 'role',
      role: 'redo',
      labelKey: 'menu.redo',
      icon: 'Redo2',
      shortcutDisplayMac: '⌘⇧Z',
      shortcutDisplayOther: 'Ctrl+Shift+Z',
      ipcChannel: RPC_CHANNELS.menu.REDO,
    },
    { type: 'separator' },
    {
      type: 'role',
      role: 'cut',
      labelKey: 'menu.cut',
      icon: 'Scissors',
      shortcutDisplayMac: '⌘X',
      shortcutDisplayOther: 'Ctrl+X',
      ipcChannel: RPC_CHANNELS.menu.CUT,
    },
    {
      type: 'role',
      role: 'copy',
      labelKey: 'menu.copy',
      icon: 'Copy',
      shortcutDisplayMac: '⌘C',
      shortcutDisplayOther: 'Ctrl+C',
      ipcChannel: RPC_CHANNELS.menu.COPY,
    },
    {
      type: 'role',
      role: 'paste',
      labelKey: 'menu.paste',
      icon: 'ClipboardPaste',
      shortcutDisplayMac: '⌘V',
      shortcutDisplayOther: 'Ctrl+V',
      ipcChannel: RPC_CHANNELS.menu.PASTE,
    },
    { type: 'separator' },
    {
      type: 'role',
      role: 'selectAll',
      labelKey: 'menu.selectAll',
      icon: 'TextSelect',
      shortcutDisplayMac: '⌘A',
      shortcutDisplayOther: 'Ctrl+A',
      ipcChannel: RPC_CHANNELS.menu.SELECT_ALL,
    },
  ],
}

export const VIEW_MENU: MenuSection = {
  id: 'view',
  labelKey: 'menu.view',
  icon: 'Eye',
  items: [
    {
      type: 'role',
      role: 'zoomIn',
      labelKey: 'menu.zoomIn',
      icon: 'ZoomIn',
      shortcutDisplayMac: '⌘+',
      shortcutDisplayOther: 'Ctrl++',
      ipcChannel: RPC_CHANNELS.menu.ZOOM_IN,
    },
    {
      type: 'role',
      role: 'zoomOut',
      labelKey: 'menu.zoomOut',
      icon: 'ZoomOut',
      shortcutDisplayMac: '⌘-',
      shortcutDisplayOther: 'Ctrl+-',
      ipcChannel: RPC_CHANNELS.menu.ZOOM_OUT,
    },
    {
      type: 'role',
      role: 'resetZoom',
      labelKey: 'menu.resetZoom',
      icon: 'RotateCcw',
      shortcutDisplayMac: '⌘0',
      shortcutDisplayOther: 'Ctrl+0',
      ipcChannel: RPC_CHANNELS.menu.ZOOM_RESET,
    },
    { type: 'separator' },
    {
      type: 'action',
      id: 'toggleFocusMode',
      actionId: 'view.toggleFocusMode',
      labelKey: 'menu.toggleFocusMode',
      shortcut: 'CmdOrCtrl+.',
      shortcutDisplayMac: '⌘.',
      shortcutDisplayOther: 'Ctrl+.',
      ipcChannel: RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE,
      icon: 'Focus',
    },
    {
      type: 'action',
      id: 'toggleSidebar',
      actionId: 'view.toggleSidebar',
      labelKey: 'menu.toggleSidebar',
      shortcut: 'CmdOrCtrl+B',
      shortcutDisplayMac: '⌘B',
      shortcutDisplayOther: 'Ctrl+B',
      ipcChannel: RPC_CHANNELS.menu.TOGGLE_SIDEBAR,
      icon: 'PanelLeft',
    },
  ],
}

export const WINDOW_MENU: MenuSection = {
  id: 'window',
  labelKey: 'menu.window',
  icon: 'AppWindow',
  items: [
    {
      type: 'role',
      role: 'minimize',
      labelKey: 'menu.minimize',
      icon: 'Minimize2',
      shortcutDisplayMac: '⌘M',
      shortcutDisplayOther: '',
      ipcChannel: RPC_CHANNELS.menu.MINIMIZE,
    },
    {
      type: 'role',
      role: 'zoom',
      labelKey: 'menu.maximize',
      icon: 'Maximize2',
      ipcChannel: RPC_CHANNELS.menu.MAXIMIZE,
    },
  ],
}

// All menu sections in order (for renderer)
export const MENU_SECTIONS: MenuSection[] = [EDIT_MENU, VIEW_MENU, WINDOW_MENU]

// ─────────────────────────────────────────────────────────────────────────────
// Settings Menu Items
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settings item definition
 * Used by both AppMenu (logo dropdown) and SettingsNavigator (sidebar panel)
 */
import { SETTINGS_PAGES, type SettingsSubpage } from './settings-registry'

export interface SettingsMenuItem {
  id: SettingsSubpage
  labelKey: string    // i18n key - resolve with t() at render time
  icon: string        // Lucide icon name for AppMenu
  descriptionKey: string // i18n key - resolve with t() at render time
}

/**
 * Icon mapping for settings pages (Lucide icon names)
 * Only icons need to be defined here - page data comes from settings-registry
 */
const SETTINGS_ICONS: Record<SettingsSubpage, string> = {
  app: 'ToggleRight',
  ai: 'Sparkles',
  appearance: 'Palette',
  input: 'Keyboard',
  workspace: 'Building2',
  permissions: 'ShieldCheck',
  labels: 'Tag',
  messaging: 'MessageSquare',
  server: 'Server',
  shortcuts: 'Keyboard',
  preferences: 'UserCircle',
}

/**
 * All settings pages - derived from settings-registry (single source of truth)
 * Order is determined by SETTINGS_PAGES in settings-registry.ts
 */
export const SETTINGS_ITEMS: SettingsMenuItem[] = SETTINGS_PAGES
  .filter(page => page.id !== 'server' || FEATURE_FLAGS.embeddedServer)
  .map(page => ({
    id: page.id,
    labelKey: page.labelKey,
    icon: SETTINGS_ICONS[page.id],
    descriptionKey: page.descriptionKey,
  }))

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the display shortcut for the current platform
 */
export function getShortcutDisplay(item: MenuItemAction | MenuItemRole, isMac: boolean): string {
  return isMac ? (item.shortcutDisplayMac ?? '') : (item.shortcutDisplayOther ?? '')
}
