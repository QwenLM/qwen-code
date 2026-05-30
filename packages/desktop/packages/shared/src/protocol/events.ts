/**
 * Typed event map for server → client push channels.
 * Keys are channel string literals, values are argument tuples.
 */

import type { ThemeOverrides } from '../config/index'
import type { LoadedSource } from '../sources/types'
import type { LoadedSkill } from '../skills/types'
import { RPC_CHANNELS } from './channels'
import type {
  SessionEvent,
  UnreadSummary,
  UpdateInfo,
  BrowserInstanceInfo,
  DeepLinkNavigation,
} from './dto'

export interface BroadcastEventMap {
  // Session events (workspace-scoped via broadcastToWorkspace)
  [RPC_CHANNELS.sessions.EVENT]: [event: SessionEvent]
  [RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED]: [summary: UnreadSummary]
  [RPC_CHANNELS.sessions.LIST_CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.sessions.LIST_REFRESH_STATE_CHANGED]: [
    workspaceId: string,
    isRefreshing: boolean,
  ]
  [RPC_CHANNELS.sessions.FILES_CHANGED]: [sessionId: string]

  // Domain change broadcasts (global via broadcastToAll)
  [RPC_CHANNELS.sources.CHANGED]: [workspaceId: string, sources: LoadedSource[]]
  [RPC_CHANNELS.labels.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.statuses.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.automations.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.skills.CHANGED]: [workspaceId: string, skills: LoadedSkill[]]
  [RPC_CHANNELS.llmConnections.CHANGED]: []
  [RPC_CHANNELS.permissions.DEFAULTS_CHANGED]: [value: null]

  // Theme broadcasts (global)
  [RPC_CHANNELS.theme.APP_CHANGED]: [theme: ThemeOverrides | null]
  [RPC_CHANNELS.theme.SYSTEM_CHANGED]: [isDark: boolean]
  [RPC_CHANNELS.theme.PREFERENCES_CHANGED]: [preferences: { mode: string; colorTheme: string; font: string }]
  [RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED]: [data: { workspaceId: string; themeId: string | null }]

  // Update broadcasts (global)
  [RPC_CHANNELS.update.AVAILABLE]: [info: UpdateInfo]
  [RPC_CHANNELS.update.DOWNLOAD_PROGRESS]: [progress: number]

  // Badge broadcasts (global)
  [RPC_CHANNELS.badge.DRAW]: [data: { count: number; iconDataUrl: string }]
  [RPC_CHANNELS.badge.DRAW_WINDOWS]: [data: { count: number }]

  // Window events (per-window)
  [RPC_CHANNELS.window.FOCUS_STATE]: [isFocused: boolean]
  [RPC_CHANNELS.window.CLOSE_REQUESTED]: []

  // Browser pane events (global)
  [RPC_CHANNELS.browserPane.STATE_CHANGED]: [info: BrowserInstanceInfo]
  [RPC_CHANNELS.browserPane.REMOVED]: [id: string]
  [RPC_CHANNELS.browserPane.INTERACTED]: [id: string]

  // Navigation events (per-window)
  [RPC_CHANNELS.notification.NAVIGATE]: [data: { workspaceId: string; sessionId: string }]
  [RPC_CHANNELS.deeplink.NAVIGATE]: [navigation: DeepLinkNavigation]

  // Menu events (per-window, no payload)
  [RPC_CHANNELS.menu.NEW_CHAT]: []
  [RPC_CHANNELS.menu.OPEN_SETTINGS]: []
  [RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS]: []
  [RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE]: []
  [RPC_CHANNELS.menu.TOGGLE_SIDEBAR]: []

  // Messaging gateway broadcasts
  [RPC_CHANNELS.messaging.BINDING_CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.messaging.PLATFORM_STATUS]: [workspaceId: string, platform: string, connected: boolean]
}
