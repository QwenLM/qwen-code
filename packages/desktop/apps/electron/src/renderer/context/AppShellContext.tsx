/**
 * AppShellContext
 *
 * Provides session and workspace data to tab panels without prop drilling.
 * This context is used by ChatTabPanel and other components that need
 * access to the current session, workspace, and callback functions.
 */

import * as React from 'react'
import { createContext, useContext, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import type { ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import type {
  Session,
  Workspace,
  FileAttachment,
  PermissionRequest,
  CredentialRequest,
  CredentialResponse,
  PermissionMode,
  SessionStatus,
  LoadedSource,
  LoadedSkill,
  NewChatActionParams,
  LlmConnectionWithStatus,
  TestAutomationResult,
} from '../../shared/types'
import type { SessionStatus as SessionStatusConfig } from '@/config/session-status-config'
import type { SessionOptions, SessionOptionUpdates } from '../hooks/useSessionOptions'
import { defaultSessionOptions } from '../hooks/useSessionOptions'
import { sessionAtomFamily } from '../atoms/sessions'
import type { ViewRoute } from '../../shared/routes'

export interface AppShellContextType {
  // Data
  // NOTE: sessions is NOT included here - use sessionMetaMapAtom for listing
  // and useSession(id) hook for individual sessions. This prevents closures
  // from retaining the full messages array and causing memory leaks.
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  activeSessionId?: string | null
  /** Workspace slug for SDK skill qualification (derived from workspace path) */
  activeWorkspaceSlug: string | null
  /** All LLM connections with authentication status */
  llmConnections: LlmConnectionWithStatus[]
  /** Default LLM connection slug for the current workspace */
  workspaceDefaultLlmConnection?: string
  /** Refresh LLM connections from config */
  refreshLlmConnections: () => Promise<void>
  /** Optimistically update a connection's default model before backend refresh completes */
  onOptimisticDefaultModelChange: (model: string, connectionSlug?: string) => void
  pendingPermissions: Map<string, PermissionRequest[]>
  pendingCredentials: Map<string, CredentialRequest[]>
  /** Get draft input text for a session - reads from ref without triggering re-renders */
  getDraft: (sessionId: string) => string
  /** Get persisted attachment refs (path + name) for a session's draft - no file IO */
  getDraftAttachmentRefs: (sessionId: string) => import('@craft-agent/shared/config').DraftAttachmentRef[]
  /** Hydrate persisted attachment refs into full FileAttachment objects (async, reads files) */
  hydrateDraftAttachments: (sessionId: string) => Promise<FileAttachment[]>
  /** All enabled sources for this workspace - provided by AppShell component */
  enabledSources?: LoadedSource[]
  /** All skills for this workspace - provided by AppShell component (for @mentions) */
  skills?: LoadedSkill[]
  /** Working directory of the active session — needed for project-level skill resolution */
  activeSessionWorkingDirectory?: string
  /** All label configs (tree) for label menu and badge display */
  labels?: import('@craft-agent/shared/labels').LabelConfig[]
  /** Callback when session labels change */
  onSessionLabelsChange?: (sessionId: string, labels: string[]) => void
  /** Enabled permission modes for Shift+Tab cycling */
  enabledModes?: PermissionMode[]
  /** Dynamic todo states from workspace config (provided by AppShell, defaults to empty) */
  sessionStatuses?: SessionStatusConfig[]

  // Unified session options map
  /** All session-scoped options in one map. Use useSessionOptionsFor() hook for easy access. */
  sessionOptions: Map<string, SessionOptions>

  // Session callbacks
  onCreateSession: (workspaceId: string, options?: import('../../shared/types').CreateSessionOptions) => Promise<Session>
  onSendMessage: (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], badges?: import('@craft-agent/core').ContentBadge[]) => void
  onRenameSession: (sessionId: string, name: string) => void
  onFlagSession: (sessionId: string) => void
  onUnflagSession: (sessionId: string) => void
  onArchiveSession: (sessionId: string) => void
  onUnarchiveSession: (sessionId: string) => void
  onMarkSessionRead: (sessionId: string) => void
  onMarkSessionUnread: (sessionId: string) => void
  /** Track which session user is viewing (for unread state machine) */
  onSetActiveViewingSession: (sessionId: string) => void
  onSessionStatusChange: (sessionId: string, state: SessionStatus) => void
  onDeleteSession: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>

  // Permission handling
  onRespondToPermission?: (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../../shared/types').PermissionResponseOptions
  ) => void

  // Credential handling
  onRespondToCredential?: (
    sessionId: string,
    requestId: string,
    response: CredentialResponse
  ) => void

  // File/URL handlers - these can open in previews, the built-in browser,
  // or external apps.
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void

  // Workspace
  onSelectWorkspace: (id: string, openInNewWindow?: boolean, options?: { route?: ViewRoute; suppressSessionListLoading?: boolean }) => void | Promise<void>
  onRefreshWorkspaces?: () => void

  // App actions
  onOpenSettings: () => void
  onOpenKeyboardShortcuts: () => void
  onOpenStoredUserPreferences: () => void
  onReset: () => void

  // Unified session options callback
  onSessionOptionsChange: (sessionId: string, updates: SessionOptionUpdates) => void

  // Input draft callback
  onInputChange: (sessionId: string, value: string) => void

  // Attachment draft callback — persists attachment refs per session
  onAttachmentsChange: (sessionId: string, attachments: FileAttachment[]) => void

  // Source selection callback (per-session) - provided by AppShell component
  onSessionSourcesChange?: (sessionId: string, sourceSlugs: string[]) => void

  // Open a new chat with optional agent, name, and pre-filled input
  openNewChat?: (params?: NewChatActionParams) => Promise<void>

  // Right sidebar button (for page headers)
  rightSidebarButton?: React.ReactNode

  // Leading action button for panel header (e.g., back button in compact mode)
  leadingAction?: React.ReactNode

  /** Whether this panel is the focused panel (for multi-panel visual differentiation) */
  isFocusedPanel?: boolean

  /** Whether the shell is currently in compact/narrow mode */
  isCompactMode?: boolean

  // Session list search state (for ChatDisplay highlighting)
  /** Current search query from session list - used to highlight matches in ChatDisplay */
  sessionListSearchQuery?: string
  /** Whether search mode is active (prevents focus stealing to chat input even with empty query) */
  isSearchModeActive?: boolean
  /** Callback to update session list search query */
  setSessionListSearchQuery?: (query: string) => void
  /** Ref to ChatDisplay for navigation between matches */
  chatDisplayRef?: React.RefObject<ChatDisplayHandle>
  /** Callback when ChatDisplay match info changes (for immediate UI updates) */
  onChatMatchInfoChange?: (info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => void

  // Automation management
  /** Test an automation by ID — executes its actions and returns results */
  onTestAutomation?: (automationId: string) => void
  /** Toggle an automation's enabled state by ID */
  onToggleAutomation?: (automationId: string) => void
  /** Duplicate an automation by ID — clones config with " Copy" suffix */
  onDuplicateAutomation?: (automationId: string) => void
  /** Delete an automation by ID — removes from automations config */
  onDeleteAutomation?: (automationId: string) => void
  /** Map of automationId → last test result */
  automationTestResults?: Record<string, import('../components/automations/types').TestResult>
  /** Fetch execution history for an automation by ID */
  getAutomationHistory?: (automationId: string) => Promise<import('../components/automations/types').ExecutionEntry[]>
  /** Replay (re-execute) webhook actions for a failed automation */
  onReplayAutomation?: (automationId: string, event: string) => void
}

const AppShellContext = createContext<AppShellContextType | null>(null)

export function AppShellProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: AppShellContextType
}) {
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>
}

/** Returns context or null if outside provider (safe for optional consumers like playground) */
export function useOptionalAppShellContext(): AppShellContextType | null {
  return useContext(AppShellContext)
}

export function useAppShellContext(): AppShellContextType {
  const context = useContext(AppShellContext)
  if (!context) {
    throw new Error('useAppShellContext must be used within an AppShellProvider')
  }
  return context
}

/**
 * Get a specific session by ID using per-session atoms
 * This hook only re-renders when the specific session changes,
 * not when other sessions change (solves streaming isolation)
 */
export function useSession(sessionId: string): Session | null {
  // Use per-session atom for isolated updates
  return useAtomValue(sessionAtomFamily(sessionId))
}

/**
 * Get the active workspace
 */
export function useActiveWorkspace(): Workspace | null {
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  if (!activeWorkspaceId) return null
  return workspaces.find((w) => w.id === activeWorkspaceId) || null
}

/**
 * Get pending permission for a session (first in queue)
 */
export function usePendingPermission(sessionId: string): PermissionRequest | undefined {
  const { pendingPermissions } = useAppShellContext()
  return pendingPermissions.get(sessionId)?.[0]
}

/**
 * Get pending credential request for a session (first in queue)
 */
export function usePendingCredential(sessionId: string): CredentialRequest | undefined {
  const { pendingCredentials } = useAppShellContext()
  return pendingCredentials.get(sessionId)?.[0]
}

/**
 * Hook to get and update session options for a specific session.
 * This is the primary way components should access session options.
 *
 * Usage:
 *   const { options, setPermissionMode } = useSessionOptionsFor(sessionId)
 *   setPermissionMode('safe')
 */
export function useSessionOptionsFor(sessionId: string): {
  options: SessionOptions
  setOption: <K extends keyof SessionOptions>(key: K, value: SessionOptions[K]) => void
  setOptions: (updates: SessionOptionUpdates) => void
  setPermissionMode: (mode: PermissionMode) => void
  isSafeModeActive: () => boolean
} {
  const { sessionOptions, onSessionOptionsChange } = useAppShellContext()

  const options = sessionOptions.get(sessionId) ?? defaultSessionOptions

  const setOption = useCallback(<K extends keyof SessionOptions>(
    key: K,
    value: SessionOptions[K]
  ) => {
    onSessionOptionsChange(sessionId, { [key]: value })
  }, [sessionId, onSessionOptionsChange])

  const setOptions = useCallback((updates: SessionOptionUpdates) => {
    onSessionOptionsChange(sessionId, updates)
  }, [sessionId, onSessionOptionsChange])

  const setPermissionMode = useCallback((mode: PermissionMode) => {
    setOption('permissionMode', mode)
  }, [setOption])

  const isSafeModeActive = useCallback(() => {
    return options.permissionMode === 'safe'
  }, [options.permissionMode])

  return {
    options,
    setOption,
    setOptions,
    setPermissionMode,
    isSafeModeActive,
  }
}
