import type { ActionDefinition } from './types'

export const actions = {
  // ═══════════════════════════════════════════
  // General
  // ═══════════════════════════════════════════
  'app.newChat': {
    id: 'app.newChat',
    label: 'New Chat',
    description: 'Create a new chat session',
    defaultHotkey: 'mod+n',
    category: 'General',
  },
  'app.newChatInPanel': {
    id: 'app.newChatInPanel',
    label: 'New Chat in Panel',
    description: 'Create a new chat session in a new panel',
    defaultHotkey: 'mod+t',
    category: 'General',
  },
  'app.settings': {
    id: 'app.settings',
    label: 'Settings',
    description: 'Open application settings',
    defaultHotkey: 'mod+,',
    category: 'General',
  },
  'app.toggleTheme': {
    id: 'app.toggleTheme',
    label: 'Toggle Theme',
    description: 'Switch between light and dark mode',
    defaultHotkey: 'mod+shift+a',
    category: 'General',
  },
  'app.search': {
    id: 'app.search',
    label: 'Search',
    description: 'Open search panel',
    defaultHotkey: 'mod+f',
    category: 'General',
  },
  'app.keyboardShortcuts': {
    id: 'app.keyboardShortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Show keyboard shortcuts reference',
    defaultHotkey: 'mod+/',
    category: 'General',
  },
  'app.newWindow': {
    id: 'app.newWindow',
    label: 'New Window',
    description: 'Open a new window',
    defaultHotkey: 'mod+shift+n',
    category: 'General',
  },
  'app.quit': {
    id: 'app.quit',
    label: 'Quit',
    description: 'Quit the application',
    defaultHotkey: 'mod+q',
    category: 'General',
  },

  // ═══════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════
  'nav.focusSidebar': {
    id: 'nav.focusSidebar',
    label: 'Focus Sidebar',
    defaultHotkey: 'mod+1',
    category: 'Navigation',
  },
  'nav.focusNavigator': {
    id: 'nav.focusNavigator',
    label: 'Focus Navigator',
    defaultHotkey: 'mod+2',
    category: 'Navigation',
  },
  'nav.focusChat': {
    id: 'nav.focusChat',
    label: 'Focus Chat',
    defaultHotkey: 'mod+3',
    category: 'Navigation',
  },
  'nav.nextZone': {
    id: 'nav.nextZone',
    label: 'Focus Next Zone',
    defaultHotkey: 'tab',
    category: 'Navigation',
    when: '!inputFocus',  // Tab should work normally in text inputs
  },
  'nav.goBack': {
    id: 'nav.goBack',
    label: 'Go Back',
    description: 'Navigate to previous session',
    defaultHotkey: 'mod+[',
    category: 'Navigation',
  },
  'nav.goForward': {
    id: 'nav.goForward',
    label: 'Go Forward',
    description: 'Navigate to next session',
    defaultHotkey: 'mod+]',
    category: 'Navigation',
  },
  'nav.goBackAlt': {
    id: 'nav.goBackAlt',
    label: 'Go Back',
    description: 'Navigate to previous session (arrow key)',
    defaultHotkey: 'mod+left',
    category: 'Navigation',
    when: '!inputFocus',  // CMD+Left = cursor to line start in text inputs
  },
  'nav.goForwardAlt': {
    id: 'nav.goForwardAlt',
    label: 'Go Forward',
    description: 'Navigate to next session (arrow key)',
    defaultHotkey: 'mod+right',
    category: 'Navigation',
    when: '!inputFocus',  // CMD+Right = cursor to line end in text inputs
  },

  // ═══════════════════════════════════════════
  // View
  // ═══════════════════════════════════════════
  'view.toggleSidebar': {
    id: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    defaultHotkey: 'mod+b',
    category: 'View',
  },
  'view.toggleFocusMode': {
    id: 'view.toggleFocusMode',
    label: 'Toggle Focus Mode',
    description: 'Hide both sidebars for distraction-free work',
    defaultHotkey: 'mod+.',
    category: 'View',
  },

  // ═══════════════════════════════════════════
  // Navigator (scoped — active entity list in middle panel)
  // ═══════════════════════════════════════════
  'navigator.selectAll': {
    id: 'navigator.selectAll',
    label: 'Select All',
    defaultHotkey: 'mod+a',
    category: 'Navigator',
    scope: 'navigator',
    when: 'navigatorFocus',  // CMD+A = select all text when in input
  },
  'navigator.clearSelection': {
    id: 'navigator.clearSelection',
    label: 'Clear Selection',
    defaultHotkey: 'escape',
    category: 'Navigator',
    scope: 'navigator',
    when: 'navigatorFocus',
  },

  // ═══════════════════════════════════════════
  // Panels
  // ═══════════════════════════════════════════
  'panel.focusNext': {
    id: 'panel.focusNext',
    label: 'Focus Next Panel',
    description: 'Move focus to the next panel',
    defaultHotkey: 'mod+shift+]',
    category: 'Navigation',
  },
  'panel.focusPrev': {
    id: 'panel.focusPrev',
    label: 'Focus Previous Panel',
    description: 'Move focus to the previous panel',
    defaultHotkey: 'mod+shift+[',
    category: 'Navigation',
  },

  // ═══════════════════════════════════════════
  // Chat
  // ═══════════════════════════════════════════
  'chat.stopProcessing': {
    id: 'chat.stopProcessing',
    label: 'Stop Processing',
    description: 'Cancel the current agent task (double-press)',
    defaultHotkey: 'escape',
    category: 'Chat',
    scope: 'chat',
    when: '!hasSelection',  // Let browser clear selection first; overlays handled by hasOpenOverlay() in enabled callback
  },
  'chat.cyclePermissionMode': {
    id: 'chat.cyclePermissionMode',
    label: 'Cycle Permission Mode',
    description: 'Switch between YOLO, Plan mode, Ask before edits, and Edit automatically',
    defaultHotkey: 'shift+tab',
    category: 'Chat',
    when: '!inputFocus && !menuOpen',
  },
  'chat.nextSearchMatch': {
    id: 'chat.nextSearchMatch',
    label: 'Next Search Match',
    defaultHotkey: 'mod+g',
    category: 'Chat',
  },
  'chat.prevSearchMatch': {
    id: 'chat.prevSearchMatch',
    label: 'Previous Search Match',
    defaultHotkey: 'mod+shift+g',
    category: 'Chat',
  },

} as const satisfies Record<string, ActionDefinition>

// Type-safe action IDs
export type ActionId = keyof typeof actions

// Get all actions as array (for shortcuts page)
export const actionList = Object.values(actions)

// Get actions by category (for organized display)
export const actionsByCategory = actionList.reduce((acc, action) => {
  if (!acc[action.category]) acc[action.category] = []
  acc[action.category].push(action)
  return acc
}, {} as Record<string, ActionDefinition[]>)
