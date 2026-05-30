import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/hooks/useTheme'
import type { ThemeOverrides } from '@config/theme'
import { useSetAtom, useStore, useAtomValue, useAtom } from 'jotai'
import type { Session, Workspace, SessionEvent, Message, FileAttachment, StoredAttachment, PermissionRequest, CredentialRequest, CredentialResponse, SetupNeeds, SessionStatus, NewChatActionParams, ContentBadge, LlmConnectionWithStatus, PermissionMode, PermissionModeState, LoadedSkill } from '../shared/types'
import type { SessionDraft, DraftAttachmentRef } from '@craft-agent/shared/config'
import type { SessionOptions, SessionOptionUpdates } from './hooks/useSessionOptions'
import { defaultSessionOptions, mergeSessionOptions } from './hooks/useSessionOptions'
import { generateMessageId } from '../shared/types'
import { useEventProcessor } from './event-processor'
import type { AgentEvent, Effect } from './event-processor'
import { AppShell } from '@/components/app-shell/AppShell'
import type { AppShellContextType } from '@/context/AppShellContext'
import { OnboardingWizard, ReauthScreen } from '@/components/onboarding'
import { WorkspacePicker } from '@/components/workspace'
import { ResetConfirmationDialog } from '@/components/ResetConfirmationDialog'
import { SplashScreen } from '@/components/SplashScreen'
import { TooltipProvider } from '@craft-agent/ui'
import { FocusProvider } from '@/context/FocusContext'
import { ModalProvider } from '@/context/ModalContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { useWindowCloseHandler } from '@/hooks/useWindowCloseHandler'
import { useOnboarding } from '@/hooks/useOnboarding'
import { useNotifications } from '@/hooks/useNotifications'
import { useSession } from '@/hooks/useSession'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { navigate, routes } from './lib/navigate'
import type { ViewRoute } from '../shared/routes'
import { attachmentFromContentRef, toDraftRef } from './lib/drafts'
import { getSessionDeleteNavigationRoute } from './lib/session-delete-navigation'
import { stripMarkdown } from './utils/text'
import { getSessionTitle } from './utils/session'
import { coerceInputText } from './lib/input-text'
import { getSessionsToRefreshAfterStaleReconnect } from './lib/reconnect-recovery'
import { formatSessionLoadFailure, shouldTreatSessionLoadFailureAsTransportFallback } from './lib/session-load'
import { extractWorkspaceSlugFromPath } from '@craft-agent/shared/utils/workspace-slug'
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'
import { initRendererPerf } from './lib/perf'
import {
  initializeSessionsAtom,
  initializeWorkspaceSessionsAtom,
  addSessionAtom,
  removeSessionAtom,
  updateSessionAtom,
  refreshSessionsMetadataAtom,
  sessionAtomFamily,
  sessionMetaMapAtom,
  loadedSessionsAtom,
  forceSessionMessagesReloadAtom,
  backgroundTasksAtomFamily,
  extractSessionMeta,
  getWorkspaceSessionMetas,
  mergeStableSessionMetaList,
  sessionFromMeta,
  workspaceSessionMetaCacheAtom,
  workspaceSessionsAtom,
  windowWorkspaceIdAtom,
  type SessionMeta,
} from '@/atoms/sessions'
import { sourcesAtom } from '@/atoms/sources'
import { skillsAtom } from '@/atoms/skills'
import { DEFAULT_DOCKED_BROWSER_INSTANCE_ID } from '@/atoms/browser-pane'
import { extractBadges } from '@/lib/mentions'
import { extractCommandBadges } from '@/lib/slash-command-badges'
import { contentBadgesToTextElements } from '@craft-agent/core/utils'
import { getDefaultStore } from 'jotai'
import {
  ShikiThemeProvider,
  PlatformProvider,
  ImagePreviewOverlay,
  PDFPreviewOverlay,
  CodePreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  JSONPreviewOverlay,
} from '@craft-agent/ui'
import { useLinkInterceptor, type FilePreviewState } from '@/hooks/useLinkInterceptor'
import { useTransportConnectionState } from '@/hooks/useTransportConnectionState'
import { useStaleSessionRecovery } from '@/hooks/useStaleSessionRecovery'
import { TransportConnectionBanner, shouldShowTransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner'
import { getFileManagerName } from '@/lib/platform'
import { ActionRegistryProvider } from '@/actions'
import { toast } from 'sonner'

type AppState = 'loading' | 'onboarding' | 'reauth' | 'workspace-picker' | 'ready'

/** Type for the Jotai store returned by useStore() */
type JotaiStore = ReturnType<typeof getDefaultStore>

function skillsForBadgeExtraction(skills: LoadedSkill[], skillSlugs?: string[]): LoadedSkill[] {
  if (!skillSlugs?.length) return skills

  const seen = new Set(skills.map(skill => skill.slug))
  const syntheticSkills = skillSlugs
    .filter(slug => {
      if (seen.has(slug)) return false
      seen.add(slug)
      return true
    })
    .map((slug): LoadedSkill => ({
      slug,
      metadata: {
        name: slug,
        description: '',
      },
      content: '',
      path: '',
      source: 'provider',
    }))

  return syntheticSkills.length > 0 ? [...skills, ...syntheticSkills] : skills
}

/**
 * Helper to handle background task events from the agent.
 * Updates the backgroundTasksAtomFamily based on event type.
 * Extracted to avoid code duplication between streaming and non-streaming paths.
 */
function handleBackgroundTaskEvent(
  store: JotaiStore,
  sessionId: string,
  event: { type: string },
  agentEvent: unknown
): void {
  // Type guard for accessing properties
  const evt = agentEvent as Record<string, unknown>
  const backgroundTasksAtom = backgroundTasksAtomFamily(sessionId)

  if (event.type === 'task_backgrounded' && 'taskId' in evt && 'toolUseId' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    const exists = currentTasks.some(t => t.toolUseId === evt.toolUseId)
    if (!exists) {
      store.set(backgroundTasksAtom, [
        ...currentTasks,
        {
          id: evt.taskId as string,
          type: 'agent' as const,
          toolUseId: evt.toolUseId as string,
          startTime: Date.now(),
          elapsedSeconds: 0,
          intent: evt.intent as string | undefined,
        },
      ])
    }
  } else if (event.type === 'shell_backgrounded' && 'shellId' in evt && 'toolUseId' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    const exists = currentTasks.some(t => t.toolUseId === evt.toolUseId)
    if (!exists) {
      store.set(backgroundTasksAtom, [
        ...currentTasks,
        {
          id: evt.shellId as string,
          type: 'shell' as const,
          toolUseId: evt.toolUseId as string,
          startTime: Date.now(),
          elapsedSeconds: 0,
          intent: evt.intent as string | undefined,
        },
      ])
    }
  } else if (event.type === 'task_progress' && 'toolUseId' in evt && 'elapsedSeconds' in evt) {
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.map(t =>
      t.toolUseId === evt.toolUseId
        ? { ...t, elapsedSeconds: evt.elapsedSeconds as number }
        : t
    ))
  } else if (event.type === 'task_completed' && 'taskId' in evt) {
    // Remove task when background task completes
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.filter(t => t.id !== evt.taskId))
  } else if (event.type === 'shell_killed' && 'shellId' in evt) {
    // Remove shell task when KillShell succeeds
    const currentTasks = store.get(backgroundTasksAtom)
    store.set(backgroundTasksAtom, currentTasks.filter(t => t.id !== evt.shellId))
  } else if (event.type === 'tool_result' && 'toolUseId' in evt) {
    // Remove task when it completes - but NOT if this is the initial backgrounding result
    // Background tasks return immediately with agentId/shell_id/backgroundTaskId,
    // we should only remove when the task actually completes
    const result = typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result)
    const isBackgroundingResult = result && (
      /agentId:\s*[a-zA-Z0-9_-]+/.test(result) ||
      /shell_id:\s*[a-zA-Z0-9_-]+/.test(result) ||
      /"backgroundTaskId":\s*"[a-zA-Z0-9_-]+"/.test(result)
    )
    if (!isBackgroundingResult) {
      const currentTasks = store.get(backgroundTasksAtom)
      store.set(backgroundTasksAtom, currentTasks.filter(t => t.toolUseId !== evt.toolUseId))
    }
  }
  // Note: We do NOT clear background tasks on complete/error/interrupted
  // Background tasks should persist and keep running after the turn ends
  // They are only removed when:
  // 1. task_completed event arrives (background task finished)
  // 2. Their tool_result comes back (foreground task finished)
  // 3. KillShell succeeds (shell_killed event)
}

function SessionLoadErrorScreen({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-xl border border-border/50 bg-background shadow-minimal p-6 text-center">
        <h2 className="text-lg font-semibold text-foreground">{t("errors.failedToLoadSessions")}</h2>
        <p className="mt-2 text-sm text-foreground/60">
          {t("errors.failedToLoadSessionsDesc")}
        </p>
        <p className="mt-3 rounded-lg bg-foreground/5 px-3 py-2 text-left text-xs text-foreground/70 break-words">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex h-8 items-center justify-center rounded-[8px] bg-foreground text-background px-3 text-sm font-medium hover:opacity-90 transition-opacity"
        >
          {t("errors.retryLoadingSessions")}
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const { t } = useTranslation()

  // Initialize renderer perf tracking early (debug mode = running from source)
  // Uses useEffect with empty deps to run once on mount before any session switches
  useEffect(() => {
    window.electronAPI.isDebugMode().then((isDebug) => {
      initRendererPerf(isDebug)
    })
  }, [])

  // App state: loading -> check auth -> onboarding or ready
  const [appState, setAppState] = useState<AppState>('loading')
  const [setupNeeds, setSetupNeeds] = useState<SetupNeeds | null>(null)

  // Per-session Jotai atom setters for isolated updates
  // NOTE: No sessionsAtom - we don't store a Session[] array anywhere to prevent memory leaks
  // Instead we use:
  // - sessionMetaMapAtom for lightweight listing
  // - sessionAtomFamily(id) for individual session data
  const initializeSessions = useSetAtom(initializeSessionsAtom)
  const initializeWorkspaceSessions = useSetAtom(initializeWorkspaceSessionsAtom)
  const addSession = useSetAtom(addSessionAtom)
  const removeSession = useSetAtom(removeSessionAtom)
  const updateSessionDirect = useSetAtom(updateSessionAtom)
  const store = useStore()

  // Helper to update a session by ID with partial fields
  // Uses per-session atom directly instead of updating an array
  const updateSessionById = useCallback((
    sessionId: string,
    updates: Partial<Session> | ((session: Session) => Partial<Session>)
  ) => {
    updateSessionDirect(sessionId, (prev) => {
      if (!prev) return prev
      const partialUpdates = typeof updates === 'function' ? updates(prev) : updates
      return { ...prev, ...partialUpdates }
    })
  }, [updateSessionDirect])

  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const workspacesRef = useRef<Workspace[]>(workspaces)
  // Window's workspace ID — shared atom so Root/ThemeProvider stays in sync on switch
  const [windowWorkspaceId, setWindowWorkspaceId] = useAtom(windowWorkspaceIdAtom)
  const windowWorkspaceIdRef = useRef<string | null>(windowWorkspaceId)
  const sessionListRequestSeqRef = useRef(0)
  const workspaceSwitchSeqRef = useRef(0)
  const workspaceSwitchChainRef = useRef<Promise<void>>(Promise.resolve())
  const pendingWorkspaceSwitchRouteRef = useRef<{ workspaceId: string; route: ViewRoute } | null>(null)

  useEffect(() => {
    windowWorkspaceIdRef.current = windowWorkspaceId
  }, [windowWorkspaceId])

  useEffect(() => {
    workspacesRef.current = workspaces
  }, [workspaces])

  const consumePendingWorkspaceSwitchRoute = useCallback((workspaceId: string): ViewRoute | null => {
    const pending = pendingWorkspaceSwitchRouteRef.current
    if (!pending || pending.workspaceId !== workspaceId) return null
    pendingWorkspaceSwitchRouteRef.current = null
    return pending.route
  }, [])

  // Derive workspace slug for SDK skill qualification
  const windowWorkspaceSlug = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.slug ?? windowWorkspaceId
  }, [windowWorkspaceId, workspaces])

  // Get initial sessionId and focused mode from URL params (for "Open in New Window" feature)
  const { initialSessionId, isFocusedMode } = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return {
      initialSessionId: params.get('sessionId'),
      isFocusedMode: params.get('focused') === 'true',
    }
  }, [])

  // Derive remote workspace ID for session matching in NavigationContext
  const windowRemoteWorkspaceId = useMemo(() => {
    if (!windowWorkspaceId) return null
    const workspace = workspaces.find(w => w.id === windowWorkspaceId)
    return workspace?.remoteServer?.remoteWorkspaceId ?? null
  }, [windowWorkspaceId, workspaces])

  // LLM connections with authentication status (for provider selection)
  const [llmConnections, setLlmConnections] = useState<LlmConnectionWithStatus[]>([])
  // Workspace default LLM connection (for new sessions)
  const [workspaceDefaultLlmConnection, setWorkspaceDefaultLlmConnection] = useState<string | undefined>()
  // Global default LLM connection slug (from app config)
  const [defaultLlmConnectionSlug, setDefaultLlmConnectionSlug] = useState<string | undefined>()

  // Derive connection default model override from the default LLM connection
  const defaultConnection = useMemo(() => {
    return llmConnections.find(c => c.slug === defaultLlmConnectionSlug) ?? null
  }, [llmConnections, defaultLlmConnectionSlug])

  const [menuNewChatTrigger, setMenuNewChatTrigger] = useState(0)
  // Permission requests per session (queue to handle multiple concurrent requests)
  const [pendingPermissions, setPendingPermissions] = useState<Map<string, PermissionRequest[]>>(new Map())
  // Credential requests per session (queue to handle multiple concurrent requests)
  const [pendingCredentials, setPendingCredentials] = useState<Map<string, CredentialRequest[]>>(new Map())
  // Draft composer state per session (text + attachment refs), preserved across mode
  // switches, conversation changes, and app restarts. Using a ref avoids re-renders
  // during typing; attachments are stored as lightweight refs (path + name) and
  // hydrated via readFileAttachment() on session switch.
  const sessionDraftsRef = useRef<Map<string, SessionDraft>>(new Map())
  // Unified session options for all session-scoped settings
  const [sessionOptions, setSessionOptions] = useState<Map<string, SessionOptions>>(new Map())
  const [globalPermissionMode, setGlobalPermissionMode] = useState<PermissionMode>(
    defaultSessionOptions.permissionMode,
  )

  // Theme state (app-level only)
  const [appTheme, setAppTheme] = useState<ThemeOverrides | null>(null)
  // Reset confirmation dialog
  const [showResetDialog, setShowResetDialog] = useState(false)

  // Splash screen state - tracks when app is fully ready (all data loaded)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [sessionListLoading, setSessionListLoading] = useState(false)
  const [sessionListRefreshWorkspaceIds, setSessionListRefreshWorkspaceIds] = useState<Set<string>>(new Set())
  const [projectSessionSnapshotsReady, setProjectSessionSnapshotsReady] = useState(false)
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null)
  const [splashExiting, setSplashExiting] = useState(false)
  const [splashHidden, setSplashHidden] = useState(false)

  // Notifications enabled state (from app settings)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)

  // Sources and skills for badge extraction
  const sources = useAtomValue(sourcesAtom)
  const skills = useAtomValue(skillsAtom)

  // Compute if app is fully ready (all data loaded)
  const isFullyReady = appState === 'ready' && sessionsLoaded && (sessionLoadError || projectSessionSnapshotsReady)

  // Trigger splash exit animation when fully ready
  useEffect(() => {
    if (isFullyReady && !splashExiting) {
      setSplashExiting(true)
    }
  }, [isFullyReady, splashExiting])

  // Handler for when splash exit animation completes
  const handleSplashExitComplete = useCallback(() => {
    setSplashHidden(true)
  }, [])

  // Apply theme via hook (injects CSS variables)
  // shikiTheme is passed to ShikiThemeProvider to ensure correct syntax highlighting
  // theme for dark-only themes in light system mode
  const { shikiTheme, isDark } = useTheme({ appTheme })

  // Ref for sessionOptions to access current value in event handlers without re-registering
  const sessionOptionsRef = useRef(sessionOptions)
  // Keep ref in sync with state
  useEffect(() => {
    sessionOptionsRef.current = sessionOptions
  }, [sessionOptions])

  useEffect(() => {
    setSessionOptions(prev => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      for (const [sessionId, options] of next) {
        next.set(sessionId, { ...options, permissionMode: globalPermissionMode })
      }
      return next
    })
  }, [globalPermissionMode])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getGlobalPermissionMode()
      .then((mode) => {
        if (!cancelled) setGlobalPermissionMode(mode)
      })
      .catch((error) => {
        console.warn('[App] Failed to load global permission mode:', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const applyPermissionModeState = useCallback((sessionId: string, state: PermissionModeState, source: 'event' | 'reconcile') => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = {
        ...defaultSessionOptions,
        permissionMode: state.permissionMode,
        ...next.get(sessionId),
      }
      const currentVersion = current.permissionModeVersion ?? -1

      if (state.modeVersion < currentVersion) {
        window.electronAPI.debugLog(
          '[ModeSync] Ignoring stale permission mode update',
          { sessionId, source, incoming: state.modeVersion, current: currentVersion }
        )
        return prev
      }

      if (
        state.modeVersion === currentVersion &&
        current.permissionMode !== state.permissionMode
      ) {
        window.electronAPI.debugLog(
          '[ModeSync] Equal modeVersion with differing mode detected, applying and requesting reconciliation',
          {
            sessionId,
            source,
            modeVersion: state.modeVersion,
            currentMode: current.permissionMode,
            incomingMode: state.permissionMode,
          }
        )
      }

      setGlobalPermissionMode(state.permissionMode)
      next.set(sessionId, {
        ...current,
        permissionMode: state.permissionMode,
        permissionModeVersion: state.modeVersion,
      })
      return next
    })
  }, [])

  const reconcilePermissionModeState = useCallback(async (sessionId: string) => {
    try {
      const state = await window.electronAPI.getSessionPermissionModeState(sessionId)
      if (!state) return
      applyPermissionModeState(sessionId, state, 'reconcile')
    } catch (error) {
      window.electronAPI.debugLog('[ModeSync] Failed to reconcile permission mode', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [applyPermissionModeState])

  // Event processor hook - handles all agent events through pure functions
  const { processAgentEvent, clearStreamingState } = useEventProcessor()

  const syncSessionOptionsFromSession = useCallback((session: Session) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = next.get(session.id)
      const merged = {
        ...defaultSessionOptions,
        ...current,
        permissionMode: globalPermissionMode,
        thinkingLevel: session.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      }

      const hasNonDefaultThinking = merged.thinkingLevel !== DEFAULT_THINKING_LEVEL

      if (!hasNonDefaultThinking && merged.permissionModeVersion == null) {
        next.delete(session.id)
      } else {
        next.set(session.id, merged)
      }

      return next
    })
  }, [globalPermissionMode])

  const refreshSessionFromServer = useCallback(async (sessionId: string): Promise<'refreshed' | 'preserved_stale_messages' | 'failed'> => {
    try {
      const fresh = await window.electronAPI.getSessionMessages(sessionId)
      if (!fresh) return 'failed'

      const prevSession = store.get(sessionAtomFamily(sessionId))
      const preservedStaleMessages = !!prevSession && prevSession.messages.length > 0 && (!fresh.messages || fresh.messages.length === 0)
      const nextSession = preservedStaleMessages
        ? { ...fresh, messages: prevSession.messages }
        : fresh

      clearStreamingState(sessionId)
      updateSessionDirect(sessionId, () => nextSession)
      syncSessionOptionsFromSession(nextSession)
      void reconcilePermissionModeState(sessionId)
      return preservedStaleMessages ? 'preserved_stale_messages' : 'refreshed'
    } catch (err) {
      console.error(`[App] Failed to refresh session ${sessionId}:`, err)
      return 'failed'
    }
  }, [clearStreamingState, updateSessionDirect, syncSessionOptionsFromSession, reconcilePermissionModeState, store])

  const cacheWorkspaceSessionMetas = useCallback((workspaceId: string, sessions: Session[]) => {
    const metas = sessions.map(extractSessionMeta)
    const next = new Map(store.get(workspaceSessionMetaCacheAtom))
    next.set(workspaceId, mergeStableSessionMetaList(next.get(workspaceId), metas))
    store.set(workspaceSessionMetaCacheAtom, next)
  }, [store])

  const applyLoadedSessions = useCallback((
    loadedSessions: Session[],
    workspaceId: string | null,
    remoteWorkspaceId?: string | null,
  ) => {
    // Initialize per-session atoms and metadata map.
    // NOTE: No sessionsAtom used - sessions are only in per-session atoms.
    if (workspaceId) {
      initializeWorkspaceSessions({
        workspaceIds: [workspaceId, remoteWorkspaceId ?? ''].filter(Boolean),
        sessions: loadedSessions,
      })
      cacheWorkspaceSessionMetas(workspaceId, loadedSessions)
    } else {
      initializeSessions(loadedSessions)
    }

    // Initialize unified sessionOptions from session data.
    const optionsMap = new Map<string, SessionOptions>()
    for (const s of loadedSessions) {
      const hasNonDefaultThinking = s.thinkingLevel && s.thinkingLevel !== DEFAULT_THINKING_LEVEL
      if (hasNonDefaultThinking) {
        optionsMap.set(s.id, {
          permissionMode: globalPermissionMode,
          thinkingLevel: s.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
        })
      }
    }
    setSessionOptions(optionsMap)
  }, [cacheWorkspaceSessionMetas, globalPermissionMode, initializeSessions, initializeWorkspaceSessions])

  const reconcileLoadedSessionPermissionModes = useCallback((loadedSessions: Session[]) => {
    return Promise.allSettled(
      loadedSessions.map((s) => reconcilePermissionModeState(s.id))
    )
  }, [reconcilePermissionModeState])

  const applyFastLocalSessionSnapshot = useCallback(async (
    workspaceId: string | null,
    requestSeq: number,
  ): Promise<void> => {
    if (!workspaceId) return

    let knownWorkspaces = workspacesRef.current
    if (knownWorkspaces.length === 0) {
      try {
        knownWorkspaces = await window.electronAPI.getWorkspaces()
        if (requestSeq !== sessionListRequestSeqRef.current || workspaceId !== windowWorkspaceIdRef.current) {
          return
        }
        workspacesRef.current = knownWorkspaces
        setWorkspaces(knownWorkspaces)
      } catch (error) {
        console.warn('[App] Failed to load workspaces for fast session snapshot:', error)
        return
      }
    }

    const targetWorkspace = knownWorkspaces.find(workspace => workspace.id === workspaceId)
    if (!targetWorkspace || targetWorkspace.remoteServer) return

    try {
      const fastSessions = await window.electronAPI.getSessionsForWorkspace(workspaceId, { refreshExternal: false })
      if (requestSeq !== sessionListRequestSeqRef.current || workspaceId !== windowWorkspaceIdRef.current) {
        return
      }

      applyLoadedSessions(fastSessions, workspaceId, undefined)
    } catch (error) {
      console.warn(`[App] Failed to load fast session snapshot for workspace ${workspaceId}:`, error)
    }
  }, [applyLoadedSessions])

  const loadSessionsFromServer = useCallback(async () => {
    const requestWorkspaceId = windowWorkspaceIdRef.current
    const requestSeq = ++sessionListRequestSeqRef.current
    setSessionLoadError(null)
    setSessionListLoading(true)

    const fullSessionsPromise: Promise<
      | { ok: true; sessions: Session[] }
      | { ok: false; error: unknown }
    > = window.electronAPI.getSessions().then(
      (sessions) => ({ ok: true as const, sessions }),
      (error) => ({ ok: false as const, error }),
    )

    try {
      await applyFastLocalSessionSnapshot(requestWorkspaceId, requestSeq)

      const fullSessionsResult = await fullSessionsPromise
      if (!fullSessionsResult.ok) {
        throw fullSessionsResult.error
      }
      const loadedSessions = fullSessionsResult.sessions

      if (requestSeq !== sessionListRequestSeqRef.current || requestWorkspaceId !== windowWorkspaceIdRef.current) {
        console.info('[App] Ignoring stale session list response', {
          requestWorkspaceId,
          currentWorkspaceId: windowWorkspaceIdRef.current,
        })
        return
      }

      applyLoadedSessions(loadedSessions, requestWorkspaceId, windowRemoteWorkspaceId)
      setSessionsLoaded(true)
      setSessionListLoading(false)
      void reconcileLoadedSessionPermissionModes(loadedSessions)

      if (initialSessionId && windowWorkspaceId) {
        const session = loadedSessions.find(s => s.id === initialSessionId)
        if (session) {
          navigate(routes.view.allSessions(session.id))
        }
      }
    } catch (err) {
      if (requestSeq !== sessionListRequestSeqRef.current || requestWorkspaceId !== windowWorkspaceIdRef.current) {
        console.info('[App] Ignoring stale session list error', {
          requestWorkspaceId,
          currentWorkspaceId: windowWorkspaceIdRef.current,
        })
        return
      }

      console.error('[App] Failed to load sessions:', err)
      const transportState = await window.electronAPI.getTransportConnectionState().catch(() => null)

      if (shouldTreatSessionLoadFailureAsTransportFallback(transportState)) {
        console.error('[App] Treating session load failure as transport fallback:', transportState)
        setSessionsLoaded(true)
        setSessionLoadError(null)
        return
      }

      setSessionLoadError(formatSessionLoadFailure(err))
      setSessionsLoaded(true)
    } finally {
      if (requestSeq === sessionListRequestSeqRef.current && requestWorkspaceId === windowWorkspaceIdRef.current) {
        setSessionListLoading(false)
      }
    }
  }, [applyFastLocalSessionSnapshot, applyLoadedSessions, initialSessionId, reconcileLoadedSessionPermissionModes, windowRemoteWorkspaceId, windowWorkspaceId])

  const refreshSessionListMetadataFromServer = useCallback(async (): Promise<Map<string, SessionMeta> | null> => {
    const requestWorkspaceId = windowWorkspaceIdRef.current
    try {
      const sessions = await window.electronAPI.getSessions()
      if (requestWorkspaceId !== windowWorkspaceIdRef.current) {
        console.info('[App] Ignoring stale reconnect session metadata response', {
          requestWorkspaceId,
          currentWorkspaceId: windowWorkspaceIdRef.current,
        })
        return null
      }
      console.info(`[App] getSessions returned ${sessions.length} session(s) for reconnect refresh`)
      const loadedSessionIds = store.get(loadedSessionsAtom)

      // Single transactional atom write — all cross-atom mutations happen
      // inside one Jotai write function so React subscribers see one
      // consistent update instead of intermediate states.
      const nextMetaMap = store.set(refreshSessionsMetadataAtom, {
        sessions,
        loadedSessionIds,
        workspaceIds: [requestWorkspaceId ?? '', windowRemoteWorkspaceId ?? ''].filter(Boolean),
      })
      if (requestWorkspaceId) {
        cacheWorkspaceSessionMetas(requestWorkspaceId, sessions)
      }

      // Sync app-level state (React hooks / non-atom concerns) after the atom transaction
      for (const session of sessions) {
        syncSessionOptionsFromSession(session)
      }
      await Promise.allSettled(sessions.map(s => reconcilePermissionModeState(s.id)))

      return nextMetaMap
    } catch (err) {
      if (requestWorkspaceId !== windowWorkspaceIdRef.current) {
        console.info('[App] Ignoring stale reconnect session metadata error', {
          requestWorkspaceId,
          currentWorkspaceId: windowWorkspaceIdRef.current,
        })
        return null
      }
      console.error('[App] Failed to refresh session list metadata after reconnect:', err)
      return null
    }
  }, [cacheWorkspaceSessionMetas, store, syncSessionOptionsFromSession, reconcilePermissionModeState, windowRemoteWorkspaceId])

  const refreshChangedWorkspaceSessions = useCallback(async (workspaceId: string) => {
    try {
      const sessions = await window.electronAPI.getSessionsForWorkspace(workspaceId, { refreshExternal: false })
      cacheWorkspaceSessionMetas(workspaceId, sessions)
      setSessionListRefreshWorkspaceIds(prev => {
        if (!prev.has(workspaceId)) return prev
        const next = new Set(prev)
        next.delete(workspaceId)
        return next
      })

      if (workspaceId !== windowWorkspaceIdRef.current) return

      applyLoadedSessions(sessions, workspaceId, windowRemoteWorkspaceId)
      setSessionsLoaded(true)
      setSessionLoadError(null)
      setSessionListLoading(false)
      void reconcileLoadedSessionPermissionModes(sessions)
    } catch (err) {
      console.error(`[App] Failed to refresh changed session list for workspace ${workspaceId}:`, err)
    }
  }, [
    applyLoadedSessions,
    cacheWorkspaceSessionMetas,
    reconcileLoadedSessionPermissionModes,
    windowRemoteWorkspaceId,
  ])

  useEffect(() => {
    const cleanup = window.electronAPI.onSessionsChanged((workspaceId) => {
      void refreshChangedWorkspaceSessions(workspaceId)
    })

    return cleanup
  }, [refreshChangedWorkspaceSessions])

  useEffect(() => {
    const cleanup = window.electronAPI.onSessionListRefreshStateChanged((workspaceId, isRefreshing) => {
      setSessionListRefreshWorkspaceIds(prev => {
        const hasWorkspace = prev.has(workspaceId)
        if (isRefreshing === hasWorkspace) return prev

        const next = new Set(prev)
        if (isRefreshing) next.add(workspaceId)
        else next.delete(workspaceId)
        return next
      })
    })

    return cleanup
  }, [])

  // Stale session watchdog — catches stuck sessions that the reconnect protocol misses
  const { trackSessionActivity } = useStaleSessionRecovery({
    store,
    refreshSessionFromServer,
  })

  const DRAFT_SAVE_DEBOUNCE_MS = 500
  const qwenModelRefreshInFlightRef = useRef<Promise<void> | null>(null)
  const qwenModelRefreshAttemptedRef = useRef<Set<string>>(new Set())
  const qwenModelRefreshCompletedRef = useRef<Set<string>>(new Set())

  const resolveDefaultConnectionSlug = useCallback((connections: LlmConnectionWithStatus[]) => {
    return connections.find(c => c.isDefault)?.slug ?? connections[0]?.slug
  }, [])

  const handleOptimisticDefaultModelChange = useCallback((model: string, connectionSlug?: string) => {
    setLlmConnections(previousConnections => {
      const targetSlug = connectionSlug ?? resolveDefaultConnectionSlug(previousConnections)
      if (!targetSlug) return previousConnections

      let changed = false
      const nextConnections = previousConnections.map(connection => {
        if (connection.slug !== targetSlug) return connection
        if (connection.defaultModel === model) return connection

        changed = true
        return { ...connection, defaultModel: model }
      })

      return changed ? nextConnections : previousConnections
    })
  }, [resolveDefaultConnectionSlug])

  // Refresh LLM connections from config (called on workspace change and after connection updates)
  const refreshLlmConnections = useCallback(async () => {
    const connections = await window.electronAPI.listLlmConnectionsWithStatus()
    const visibleConnections = connections.map(connection => {
      if (connection.providerType !== 'qwen') return connection
      if (connection.models?.length) {
        qwenModelRefreshCompletedRef.current.add(connection.slug)
      }
      return qwenModelRefreshCompletedRef.current.has(connection.slug)
        ? connection
        : { ...connection, models: [], defaultModel: '' }
    })
    setLlmConnections(visibleConnections)
    setDefaultLlmConnectionSlug(resolveDefaultConnectionSlug(connections))
    // Also refresh workspace default
    if (windowWorkspaceId) {
      const settings = await window.electronAPI.getWorkspaceSettings(windowWorkspaceId)
      setWorkspaceDefaultLlmConnection(settings?.defaultLlmConnection)
    }

    const qwenConnectionToRefresh = connections.find(connection =>
      connection.providerType === 'qwen'
      && !connection.models?.length
      && !qwenModelRefreshAttemptedRef.current.has(connection.slug)
    )
    if (qwenConnectionToRefresh && !qwenModelRefreshInFlightRef.current) {
      qwenModelRefreshAttemptedRef.current.add(qwenConnectionToRefresh.slug)
      qwenModelRefreshInFlightRef.current = (async () => {
        try {
          const result = await window.electronAPI.refreshLlmConnectionModels(qwenConnectionToRefresh.slug)
          if (!result.success) {
            console.warn('[App] Qwen model refresh failed:', result.error)
            qwenModelRefreshAttemptedRef.current.delete(qwenConnectionToRefresh.slug)
            return
          }

          qwenModelRefreshCompletedRef.current.add(qwenConnectionToRefresh.slug)
          const refreshedConnections = await window.electronAPI.listLlmConnectionsWithStatus()
          setLlmConnections(refreshedConnections)
          setDefaultLlmConnectionSlug(resolveDefaultConnectionSlug(refreshedConnections))
        } catch (error) {
          console.warn('[App] Qwen model refresh failed:', error)
        } finally {
          qwenModelRefreshInFlightRef.current = null
        }
      })()
    }
  }, [resolveDefaultConnectionSlug, windowWorkspaceId])

  // Handle onboarding completion
  const handleOnboardingComplete = useCallback(async () => {
    try {
      // Reload workspaces after onboarding
      const ws = await window.electronAPI.getWorkspaces()
      if (ws.length > 0) {
        // Switch to workspace in-place (no window close/reopen)
        await window.electronAPI.switchWorkspace(ws[0].id)
        windowWorkspaceIdRef.current = ws[0].id
        setWindowWorkspaceId(ws[0].id)
        setWorkspaces(ws)
      } else {
        setWorkspaces(ws)
      }
    } catch (error) {
      console.error('[App] Failed to load workspaces after onboarding:', error)
      // Still transition to ready — the app can recover via reconnect
    }
    setAppState('ready')
  }, [])

  // Onboarding hook — onConfigSaved fires immediately when billing is saved,
  // ensuring connection state updates before the wizard closes.
  const onboarding = useOnboarding({
    onComplete: handleOnboardingComplete,
    onConfigSaved: refreshLlmConnections,
    initialSetupNeeds: setupNeeds || undefined,
  })

  // Reauth login handler - placeholder (reauth is not currently used)
  const handleReauthLogin = useCallback(async () => {
    // Re-check setup needs
    const needs = await window.electronAPI.getSetupNeeds()
    if (needs.isFullyConfigured) {
      setAppState('ready')
    } else {
      setSetupNeeds(needs)
      setAppState('onboarding')
    }
  }, [])

  // Reauth reset handler - open reset confirmation dialog
  const handleReauthReset = useCallback(() => {
    setShowResetDialog(true)
  }, [])

  // Check auth state and get window's workspace ID on mount
  useEffect(() => {
    const initialize = async () => {
      try {
        // Get this window's workspace ID (passed via URL query param from main process)
        const wsId = await window.electronAPI.getWindowWorkspace()
        windowWorkspaceIdRef.current = wsId
        setWindowWorkspaceId(wsId)

        const needs = await window.electronAPI.getSetupNeeds()
        setSetupNeeds(needs)

        if (needs.isFullyConfigured) {
          // If no workspace is selected (thin client without CRAFT_WORKSPACE_ID),
          // show workspace picker before entering the main app
          if (!wsId) {
            setAppState('workspace-picker')
          } else {
            setAppState('ready')
          }
        } else {
          // New user or needs setup - show onboarding
          setAppState('onboarding')
        }
      } catch (error) {
        console.error('Failed to check auth state:', error)
        // If check fails, show onboarding to be safe
        setAppState('onboarding')
      }
    }

    initialize()
  }, [])

  // Session selection state
  const [sessionSelection, setSession] = useSession()

  // Notification system - shows native OS notifications and badge count
  const handleNavigateToSession = useCallback((sessionId: string) => {
    // Navigate to the session via central routing (uses allSessions filter)
    navigate(routes.view.allSessions(sessionId))
  }, [])

  const { isWindowFocused, showSessionNotification } = useNotifications({
    workspaceId: windowWorkspaceId,
    // NOTE: sessions removed - hook now uses sessionMetaMapAtom internally
    // to prevent closures from retaining full message arrays
    onNavigateToSession: handleNavigateToSession,
    enabled: notificationsEnabled,
  })

  // Load workspaces, sessions, model, notifications setting, and drafts when app is ready
  useEffect(() => {
    if (appState !== 'ready') return

    window.electronAPI.getWorkspaces().then(setWorkspaces)
    window.electronAPI.getNotificationsEnabled().then(setNotificationsEnabled).catch(() => {})

    // Show actionable toast for missing system dependencies (Windows only)
    window.electronAPI.getSystemWarnings().then((warnings) => {
      if (warnings.vcredistMissing) {
        toast.warning(t('toast.vcRedistNotFound'), {
          description: t('toast.vcRedistNotFoundDesc'),
          duration: Infinity,
          action: {
            label: 'Install',
            onClick: () => window.electronAPI.openUrl(warnings.downloadUrl ?? 'https://aka.ms/vs/17/release/vc_redist.x64.exe'),
          },
        })
      }
    }).catch(() => { /* non-fatal startup check */ })
    void loadSessionsFromServer()
    // Load LLM connections with authentication status
    void refreshLlmConnections()
    // Load persisted input drafts into ref (no re-render needed).
    // Attachment files are not read here — hydration happens lazily when the session
    // is opened so app startup isn't delayed by reading potentially large files.
    window.electronAPI.getAllDrafts().then((drafts) => {
      if (Object.keys(drafts).length > 0) {
        sessionDraftsRef.current = new Map(Object.entries(drafts))
      }
    })
    // Load app-level theme
    window.electronAPI.getAppTheme().then(setAppTheme)
  }, [appState, loadSessionsFromServer, refreshLlmConnections])

  // Subscribe to theme change events (live updates when theme.json changes)
  useEffect(() => {
    const cleanupApp = window.electronAPI.onAppThemeChange((theme) => {
      setAppTheme(theme)
    })
    return () => {
      cleanupApp()
    }
  }, [])

  // Subscribe to LLM connections change events (live updates when models are fetched)
  useEffect(() => {
    const cleanup = window.electronAPI.onLlmConnectionsChanged(() => {
      refreshLlmConnections()
    })
    return () => { cleanup() }
  }, [refreshLlmConnections])

  // Refresh LLM connections and workspace default when workspace changes
  useEffect(() => {
    if (windowWorkspaceId) {
      refreshLlmConnections()
    }
  }, [windowWorkspaceId, refreshLlmConnections])

  // Listen for session events - uses centralized event processor for consistent state transitions
  //
  // SOURCE OF TRUTH LOGIC:
  // - During streaming (atom.isProcessing = true): Atom is source of truth
  //   All events read from and write to atom. This preserves streaming data.
  // - When not streaming: React state is source of truth
  //   Events read/write React state, which syncs to atoms via useEffect.
  // - Handoff events (complete, error, etc.): End streaming, sync atom → React state
  //
  // This is simpler and more robust than checking event types - we just ask
  // "is this session currently streaming?" and route accordingly.
  useEffect(() => {
    // Handoff events signal end of streaming - need to sync back to React state
    // Also includes todo_state_changed so status updates immediately reflect in sidebar
    // async_operation included so shimmer effect on session titles updates in real-time
    const handoffEventTypes = new Set(['complete', 'error', 'interrupted', 'typed_error', 'session_status_changed', 'session_flagged', 'session_unflagged', 'name_changed', 'labels_changed', 'title_generated', 'async_operation'])

    // Helper to handle side effects (same logic for both paths)
    const handleEffects = (effects: Effect[], sessionId: string, eventType: string) => {
      for (const effect of effects) {
        switch (effect.type) {
          case 'permission_request': {
            setPendingPermissions(prevPerms => {
              const next = new Map(prevPerms)
              const existingQueue = next.get(sessionId) || []
              next.set(sessionId, [...existingQueue, effect.request])
              return next
            })

            // Native notification for approval-required pauses (same gating as completion notifications)
            const notifySession = store.get(sessionAtomFamily(sessionId))
            if (notifySession && !notifySession.hidden) {
              const isAdminPrompt = effect.request.type === 'admin_approval'
              const isQuestionPrompt = effect.request.type === 'ask_user_question'
              const promptBody = isQuestionPrompt
                ? 'The agent has a question for you'
                : isAdminPrompt
                  ? `Admin approval required: ${effect.request.appName || effect.request.toolName}`
                  : `Permission required: ${effect.request.toolName}`
              showSessionNotification(notifySession, promptBody)
            }
            break
          }
          case 'permission_mode_changed': {
            if (typeof effect.modeVersion === 'number' && effect.changedAt && effect.changedBy) {
              applyPermissionModeState(effect.sessionId, {
                permissionMode: effect.permissionMode,
                modeVersion: effect.modeVersion,
                changedAt: effect.changedAt,
                changedBy: effect.changedBy,
              }, 'event')
            } else {
              // Backward compatibility: apply mode optimistically then reconcile authoritative state.
              setGlobalPermissionMode(effect.permissionMode)
              setSessionOptions(prevOpts => {
                const next = new Map(prevOpts)
                const current = next.get(effect.sessionId) ?? defaultSessionOptions
                next.set(effect.sessionId, { ...current, permissionMode: effect.permissionMode })
                return next
              })
              void reconcilePermissionModeState(effect.sessionId)
            }
            break
          }
          case 'credential_request': {
            setPendingCredentials(prevCreds => {
              const next = new Map(prevCreds)
              const existingQueue = next.get(sessionId) || []
              next.set(sessionId, [...existingQueue, effect.request])
              return next
            })
            break
          }
          case 'auto_retry': {
            // A source was auto-activated, automatically re-send the original message
            // Add suffix to indicate the source was activated
            const messageWithSuffix = `${effect.originalMessage}\n\n[${effect.sourceSlug} activated]`
            // Use setTimeout to ensure the previous turn has fully completed
            setTimeout(() => {
              window.electronAPI.sendMessage(effect.sessionId, messageWithSuffix)
            }, 100)
            break
          }
          case 'restore_input': {
            // Queued messages were removed from chat on abort — restore their text to the input field.
            // Append to existing draft (user may have started typing) rather than overwrite.
            const existingDraft = sessionDraftsRef.current.get(sessionId)
            const existingText = coerceInputText(existingDraft?.text)
            const restoredText = coerceInputText(effect.text)
            const restored = existingText
              ? `${existingText}\n\n${restoredText}`
              : restoredText
            handleInputChange(sessionId, restored)
            // handleInputChange updates the ref but ChatPage has local state.
            // Dispatch a custom event so ChatPage re-reads the draft.
            window.dispatchEvent(new CustomEvent('craft:restore-input', {
              detail: { sessionId, text: restored },
            }))
            break
          }
          case 'queued_input_add': {
            window.dispatchEvent(new CustomEvent('craft:queued-input-add', {
              detail: {
                sessionId,
                message: effect.message,
                optimisticMessageId: effect.optimisticMessageId,
              },
            }))
            break
          }
          case 'queued_input_remove': {
            window.dispatchEvent(new CustomEvent('craft:queued-input-remove', {
              detail: {
                sessionId,
                messageId: effect.messageId,
                optimisticMessageId: effect.optimisticMessageId,
              },
            }))
            break
          }
          case 'toast_error': {
            toast.error(effect.message, { duration: 5000 })
            break
          }
        }
      }

      // Clear pending permissions and credentials on complete
      if (eventType === 'complete') {
        setPendingPermissions(prevPerms => {
          if (prevPerms.has(sessionId)) {
            const next = new Map(prevPerms)
            next.delete(sessionId)
            return next
          }
          return prevPerms
        })
        setPendingCredentials(prevCreds => {
          if (prevCreds.has(sessionId)) {
            const next = new Map(prevCreds)
            next.delete(sessionId)
            return next
          }
          return prevCreds
        })
      }
    }

    const cleanup = window.electronAPI.onSessionEvent((event: SessionEvent) => {
      if (!('sessionId' in event)) return

      const sessionId = event.sessionId
      const workspaceId = windowWorkspaceId ?? ''

      // Session lifecycle events are handled explicitly (not by the agent event processor).
      if (event.type === 'session_created') {
        window.electronAPI.getSessionMessages(sessionId)
          .then((createdSession: Session | null) => {
            if (createdSession) {
              const existingMeta = store.get(sessionMetaMapAtom).has(sessionId)
              if (existingMeta) {
                updateSessionDirect(sessionId, () => createdSession)
              } else {
                addSession(createdSession)
              }
              if (workspaceId) {
                cacheWorkspaceSessionMetas(
                  workspaceId,
                  Array.from(store.get(sessionMetaMapAtom).values())
                    .filter(meta => meta.workspaceId === workspaceId || (windowRemoteWorkspaceId && meta.workspaceId === windowRemoteWorkspaceId))
                    .map(meta => sessionFromMeta(meta, createdSession.workspaceName)),
                )
              }
              syncSessionOptionsFromSession(createdSession)
              return
            }

            const requestWorkspaceId = windowWorkspaceIdRef.current
            return window.electronAPI.getSessions().then((sessions) => {
              if (requestWorkspaceId !== windowWorkspaceIdRef.current) return
              initializeWorkspaceSessions({
                workspaceIds: [requestWorkspaceId ?? '', windowRemoteWorkspaceId ?? ''].filter(Boolean),
                sessions,
              })
              if (requestWorkspaceId) cacheWorkspaceSessionMetas(requestWorkspaceId, sessions)
            })
          })
          .catch((error: unknown) => console.error('Failed to handle session_created event:', error))
        return
      }

      if (event.type === 'session_deleted') {
        removeSession(sessionId)
        if (sessionSelection.selected === sessionId) {
          setSession({ selected: null })
        }
        return
      }

      const agentEvent = event as unknown as AgentEvent

      // Track activity for stale session watchdog
      trackSessionActivity(sessionId)

      // Dispatch window event when compaction completes
      // This allows FreeFormInput to sequence the plan execution message after compaction
      // Note: markCompactionComplete is called on the backend (sessions.ts) to ensure
      // it happens even if CMD+R occurs during compaction
      if (event.type === 'info' && event.statusType === 'compaction_complete') {
        window.dispatchEvent(new CustomEvent('craft:compaction-complete', {
          detail: { sessionId }
        }))
      }

      // Check if session is currently streaming (atom is source of truth)
      const atomSession = store.get(sessionAtomFamily(sessionId))
      const isStreaming = atomSession?.isProcessing === true
      const isHandoff = handoffEventTypes.has(event.type)

      // During streaming OR for handoff events: use atom as source of truth
      // This ensures all events during streaming see the complete state
      if (isStreaming || isHandoff) {
        const currentSession = atomSession ?? null

        // Process the event
        const { session: updatedSession, effects } = processAgentEvent(
          agentEvent,
          currentSession,
          workspaceId
        )

        // Update atom directly (UI sees update immediately)
        updateSessionDirect(sessionId, () => updatedSession)

        // Handle side effects
        handleEffects(effects, sessionId, event.type)

        // Handle background task events
        handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

        // For handoff events, update metadata map for list display
        // NOTE: No sessionsAtom to sync - atom and metadata are the source of truth
        if (isHandoff) {
          // Show notification on complete (when window is not focused)
          // Skip hidden sessions (mini-agent sessions) - they shouldn't trigger notifications
          if (event.type === 'complete' && !updatedSession.hidden) {
            // Get the last assistant/plan message as preview
            const lastMessage = updatedSession.messages.findLast(
              m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
            )
            // Strip markdown so OS notifications display clean plain text
            const rawPreview = lastMessage?.content?.substring(0, 200) || undefined
            const preview = rawPreview ? stripMarkdown(rawPreview).substring(0, 100) || undefined : undefined
            showSessionNotification(updatedSession, preview)
          }
        }

        return
      }

      // Not streaming: use per-session atoms directly (no sessionsAtom)
      const currentSession = store.get(sessionAtomFamily(sessionId))

      const { session: updatedSession, effects } = processAgentEvent(
        agentEvent,
        currentSession,
        workspaceId
      )

      // Handle side effects
      handleEffects(effects, sessionId, event.type)

      // Handle background task events
      handleBackgroundTaskEvent(store, sessionId, event, agentEvent)

      // Update per-session atom
      updateSessionDirect(sessionId, () => updatedSession)
    })

    return cleanup
  }, [
    processAgentEvent,
    trackSessionActivity,
    windowWorkspaceId,
    store,
    updateSessionDirect,
    showSessionNotification,
    initializeSessions,
    initializeWorkspaceSessions,
    addSession,
    removeSession,
    cacheWorkspaceSessionMetas,
    syncSessionOptionsFromSession,
    applyPermissionModeState,
    reconcilePermissionModeState,
    windowRemoteWorkspaceId,
  ])

  // Transport reconnect recovery — refresh session metadata plus active/processing
  // session content after stale reconnects.
  useEffect(() => {
    const cleanup = window.electronAPI.onReconnected(async (isStale: boolean) => {
      if (!isStale) {
        // Server replayed buffered events — we're caught up, nothing to do
        console.info('[App] Reconnected with event replay — no refresh needed')
        return
      }

      console.warn('[App] Stale reconnect — refreshing session metadata and active/processing sessions')

      const refreshedMetaMap = await refreshSessionListMetadataFromServer()
      const metaMap = refreshedMetaMap ?? store.get(sessionMetaMapAtom)
      const refreshIds = getSessionsToRefreshAfterStaleReconnect(metaMap, sessionSelection.selected)

      console.info(`[App] Stale reconnect — refreshing ${refreshIds.length} session(s):`, refreshIds)

      // Refresh full message content only for the active session plus any
      // session still marked processing after the metadata refresh.
      for (const sessionId of refreshIds) {
        let refreshResult = await refreshSessionFromServer(sessionId)
        if (refreshResult !== 'refreshed') {
          // Server may need time to restart session subprocess after reconnect,
          // or it may still be lazily loading session messages.
          for (const delay of [2000, 4000]) {
            console.warn(`[App] Retrying session refresh for ${sessionId} after ${delay}ms (${refreshResult})`)
            await new Promise(r => setTimeout(r, delay))
            refreshResult = await refreshSessionFromServer(sessionId)
            if (refreshResult === 'refreshed') break
          }
        }
      }

      // Final fallback: if the active session is still empty, force a reload
      // even when the session is already marked loaded.
      if (sessionSelection.selected) {
        const session = store.get(sessionAtomFamily(sessionSelection.selected))
        if (session && (!session.messages || session.messages.length === 0)) {
          console.warn('[App] Active session still has no messages after stale reconnect refresh — forcing message reload')
          await store.set(forceSessionMessagesReloadAtom, sessionSelection.selected)
        } else if (session) {
          console.info(`[App] Stale reconnect recovery complete — active session has ${session.messages?.length ?? 0} messages`)
        }
      }

    })

    return cleanup
  }, [store, sessionSelection.selected, setSession, refreshSessionFromServer, refreshSessionListMetadataFromServer])

  // Listen for menu bar events
  useEffect(() => {
    const unsubNewChat = window.electronAPI.onMenuNewChat(() => {
      setMenuNewChatTrigger(n => n + 1)
    })
    const unsubSettings = window.electronAPI.onMenuOpenSettings(() => {
      handleOpenSettings()
    })
    const unsubShortcuts = window.electronAPI.onMenuKeyboardShortcuts(() => {
      navigate(routes.view.settings('shortcuts'))
    })
    return () => {
      unsubNewChat()
      unsubSettings()
      unsubShortcuts()
    }
  }, [])

  const handleCreateSession = useCallback(async (workspaceId: string, options?: import('../shared/types').CreateSessionOptions): Promise<Session> => {
    const session = await window.electronAPI.createSession(workspaceId, options)
    // Add to per-session atom and metadata map (no sessionsAtom)
    addSession(session)
    syncSessionOptionsFromSession(session)

    return session
  }, [addSession, syncSessionOptionsFromSession])

  // Deep link navigation is initialized later after handleInputChange is defined

  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation = false, displayTitle?: string): Promise<boolean> => {
    if (!skipConfirmation) {
      const metaMap = store.get(sessionMetaMapAtom)
      const meta = metaMap.get(sessionId)
      const confirmed = await window.electronAPI.showDeleteSessionConfirmation(
        displayTitle || (meta ? getSessionTitle(meta) : 'Untitled'),
      )
      if (!confirmed) return false
    }

    await window.electronAPI.deleteSession(sessionId)
    // Remove from per-session atom and metadata map (no sessionsAtom)
    removeSession(sessionId)
    const route = getSessionDeleteNavigationRoute({
      deleted: true,
      deletedSessionId: sessionId,
      selectedSessionId: sessionSelection.selected,
    })
    if (route) {
      navigate(route)
    }
    return true
  }, [store, removeSession, sessionSelection.selected])

  // Auto-delete handler for empty sessions (fire-and-forget, no confirmation)
  const handleAutoDeleteEmptySession = useCallback((sessionId: string) => {
    if (sessionSelection.selected === sessionId) {
      setSession({ selected: null })
    }
    window.electronAPI.deleteSession(sessionId)
    removeSession(sessionId)
  }, [removeSession, sessionSelection.selected, setSession])

  const handleFlagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: true })
    window.electronAPI.sessionCommand(sessionId, { type: 'flag' })
  }, [updateSessionById])

  const handleUnflagSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isFlagged: false })
    window.electronAPI.sessionCommand(sessionId, { type: 'unflag' })
  }, [updateSessionById])

  const handleArchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: true, archivedAt: Date.now() })
    window.electronAPI.sessionCommand(sessionId, { type: 'archive' })
  }, [updateSessionById])

  const handleUnarchiveSession = useCallback((sessionId: string) => {
    updateSessionById(sessionId, { isArchived: false, archivedAt: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'unarchive' })
  }, [updateSessionById])

  /**
   * Set which session user is actively viewing (for unread state machine).
   * Called when user navigates to a session. Main process uses this to determine
   * whether to mark new assistant messages as unread.
   */
  const handleSetActiveViewingSession = useCallback((sessionId: string) => {
    // Optimistic UI update: clear hasUnread immediately
    updateSessionById(sessionId, { hasUnread: false })
    // Tell main process user is viewing this session
    window.electronAPI.sessionCommand(sessionId, { type: 'setActiveViewing', workspaceId: windowWorkspaceId ?? '' })
  }, [updateSessionById, windowWorkspaceId])

  const handleMarkSessionRead = useCallback((sessionId: string) => {
    // Update hasUnread flag (primary source of truth for NEW badge)
    // Also update lastReadMessageId for backwards compatibility
    updateSessionById(sessionId, (s) => {
      const lastFinalId = s.messages.findLast(
        m => (m.role === 'assistant' || m.role === 'plan') && !m.isIntermediate
      )?.id
      return {
        hasUnread: false,
        ...(lastFinalId ? { lastReadMessageId: lastFinalId } : {}),
      }
    })
    window.electronAPI.sessionCommand(sessionId, { type: 'markRead' })
  }, [updateSessionById])

  const handleMarkSessionUnread = useCallback((sessionId: string) => {
    // Set hasUnread flag (primary source of truth for NEW badge)
    updateSessionById(sessionId, { hasUnread: true, lastReadMessageId: undefined })
    window.electronAPI.sessionCommand(sessionId, { type: 'markUnread' })
  }, [updateSessionById])

  const handleSessionStatusChange = useCallback((sessionId: string, state: SessionStatus) => {
    updateSessionById(sessionId, { sessionStatus: state })
    window.electronAPI.sessionCommand(sessionId, { type: 'setSessionStatus', state })
  }, [updateSessionById])

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    updateSessionById(sessionId, { name })
    window.electronAPI.sessionCommand(sessionId, { type: 'rename', name })
  }, [updateSessionById])

  const handleSendMessage = useCallback(async (sessionId: string, message: string, attachments?: FileAttachment[], skillSlugs?: string[], externalBadges?: ContentBadge[]) => {
    let optimisticUserMessage: Message | undefined
    let queuedOptimisticMessage = false
    try {
      // Step 1: Store attachments and get persistent metadata
      let storedAttachments: StoredAttachment[] | undefined
      let processedAttachments: FileAttachment[] | undefined

      if (attachments?.length) {
        // Store each attachment to disk (generates thumbnails, converts Office→markdown)
        // Use allSettled so one failure doesn't kill all attachments
        const storeResults = await Promise.allSettled(
          attachments.map(a => window.electronAPI.storeAttachment(sessionId, a))
        )

        // Filter successful stores, warn about failures
        storedAttachments = []
        const successfulAttachments: FileAttachment[] = []
        storeResults.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            storedAttachments!.push(result.value)
            successfulAttachments.push(attachments[i])
          } else {
            console.warn(`Failed to store attachment "${attachments[i].name}":`, result.reason)
          }
        })

        // Notify user about failed attachments
        const failedCount = storeResults.filter(r => r.status === 'rejected').length
        if (failedCount > 0) {
          console.warn(`${failedCount} attachment(s) failed to store`)
          // Add warning message to session so user knows some attachments weren't included
          const failedNames = attachments
            .filter((_, i) => storeResults[i].status === 'rejected')
            .map(a => a.name)
            .join(', ')
          updateSessionById(sessionId, (s) => ({
            messages: [...s.messages, {
              id: generateMessageId(),
              role: 'warning' as const,
              content: `⚠️ ${failedCount} attachment(s) could not be stored and will not be sent: ${failedNames}`,
              timestamp: Date.now()
            }]
          }))
        }

        // Step 2: Create processed attachments for backend input
        // - Office files: Convert to text with markdown content
        // - Others: Use original FileAttachment
        // - All: Include storedPath so agent knows where files are stored
        // - Resized images: Use resizedBase64 instead of original large base64
        processedAttachments = await Promise.all(
          successfulAttachments.map(async (att, i) => {
            const stored = storedAttachments?.[i]
            if (!stored) {
              console.error(`Missing stored attachment at index ${i}`)
              return att // Fall back to original
            }
            // Include storedPath and markdownPath for all attachment types
            // Agent will use Read tool to access text/office files via these paths
            // If image was resized, use the resized base64 for backend input
            return {
              ...att,
              storedPath: stored.storedPath,
              markdownPath: stored.markdownPath,
              // Use resized base64 if available (for images that exceeded size limits)
              base64: stored.resizedBase64 ?? att.base64,
            }
          })
        )
      }

      // Step 3: Extract inline metadata from mentions, commands, and contextual badges.
      // ContentBadge is only an input-side helper; messages persist/render textElements.
      // Merge with any externally provided badges (e.g., from EditPopover context badges).
      // Use workspace slug (not UUID) for skill qualification - SDK expects "workspaceSlug:skillSlug"
      const badgeSkills = skillsForBadgeExtraction(skills, skillSlugs)
      const mentionBadges: ContentBadge[] = windowWorkspaceSlug
        ? extractBadges(message, badgeSkills, sources, windowWorkspaceSlug)
        : []
      const badges: ContentBadge[] = [...(externalBadges || []), ...mentionBadges]

      // Step 4.1: Detect slash commands and create command badges.
      // The command text itself is preserved for the agent; the badge only affects display.
      badges.unshift(...extractCommandBadges(message))

      // Step 4.2: Detect plan execution messages and create file badges
      // Pattern: "Read the plan at <path> and execute it."
      // This is sent after compaction when accepting a plan, displays as clickable file badge
      // Only the file path is replaced with a badge - surrounding text remains visible
      const planExecuteMatch = message.match(/^(Read the plan at )(.+?)( and execute it\.?)$/i)
      if (planExecuteMatch) {
        const prefix = planExecuteMatch[1]      // "Read the plan at "
        const filePath = planExecuteMatch[2]    // the actual path
        const fileName = filePath.split('/').pop() || 'plan.md'
        badges.push({
          type: 'file',
          label: fileName,
          rawText: filePath,
          filePath: filePath,
          start: prefix.length,
          end: prefix.length + filePath.length,
        })
      }
      const textElements = contentBadgesToTextElements(message, badges)

      // Step 5: Create user message with StoredAttachments (for UI display)
      // Mark as isPending for optimistic UI - will be confirmed by user_message event
      const userMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        attachments: storedAttachments,
        textElements,
        isPending: true,  // Optimistic - will be confirmed by backend
      }
      optimisticUserMessage = userMessage

      const currentSession = store.get(sessionAtomFamily(sessionId))
      const shouldQueueInInput = currentSession?.isProcessing === true

      if (shouldQueueInInput) {
        queuedOptimisticMessage = true
        window.dispatchEvent(new CustomEvent('craft:queued-input-add', {
          detail: {
            sessionId,
            message: {
              ...userMessage,
              isPending: false,
              isQueued: true,
            },
            optimisticMessageId: userMessage.id,
          },
        }))
        updateSessionById(sessionId, {
          isProcessing: true,
          lastMessageAt: Date.now(),
          lastMessageRole: 'user',
        })
      } else {
        // Optimistic UI update - add user message and set processing state
        updateSessionById(sessionId, (s) => ({
          messages: [...s.messages, userMessage],
          isProcessing: true,
          lastMessageAt: Date.now()
        }))
      }

      // Step 6: Send with processed attachments + stored attachments for persistence
      await window.electronAPI.sendMessage(sessionId, message, processedAttachments, storedAttachments, {
        skillSlugs,
        textElements,
        optimisticMessageId: userMessage.id,
      })
    } catch (error) {
      console.error('Failed to send message:', error)
      if (queuedOptimisticMessage && optimisticUserMessage) {
        window.dispatchEvent(new CustomEvent('craft:queued-input-remove', {
          detail: {
            sessionId,
            messageId: optimisticUserMessage.id,
            optimisticMessageId: optimisticUserMessage.id,
          },
        }))
      }
      updateSessionById(sessionId, (s) => ({
        isProcessing: false,
        messages: [
          ...s.messages,
          {
            id: generateMessageId(),
            role: 'error' as const,
            content: `Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`,
            timestamp: Date.now()
          }
        ]
      }))
    }
  }, [sessionOptions, updateSessionById, store, skills, sources, windowWorkspaceSlug])

  /**
   * Unified handler for all session option changes.
   * Handles persistence and backend sync for each option type.
   */
  const handleSessionOptionsChange = useCallback((sessionId: string, updates: SessionOptionUpdates) => {
    setSessionOptions(prev => {
      const next = new Map(prev)
      const current = {
        ...defaultSessionOptions,
        ...next.get(sessionId),
        permissionMode: globalPermissionMode,
      }
      if (updates.permissionMode !== undefined) {
        for (const [id, options] of next) {
          next.set(id, { ...options, permissionMode: updates.permissionMode })
        }
      }
      next.set(sessionId, mergeSessionOptions(current, updates))
      return next
    })

    // Handle persistence/backend for specific options
    if (updates.permissionMode !== undefined) {
      setGlobalPermissionMode(updates.permissionMode)
      window.electronAPI.setGlobalPermissionMode(updates.permissionMode).catch((error) => {
        console.error('[App] Failed to persist global permission mode:', error)
        void reconcilePermissionModeState(sessionId)
      })
    }
    if (updates.thinkingLevel !== undefined) {
      // Sync thinking level change with backend (session-level, persisted)
      window.electronAPI.sessionCommand(sessionId, { type: 'setThinkingLevel', level: updates.thinkingLevel })
    }
  }, [globalPermissionMode, reconcilePermissionModeState])

  // Handle input draft changes per session with debounced persistence
  const draftSaveTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Cleanup draft save timers on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      draftSaveTimeoutRef.current.forEach(clearTimeout)
      draftSaveTimeoutRef.current.clear()
    }
  }, [])

  // Getter for draft text - reads from ref without triggering re-renders
  const getDraft = useCallback((sessionId: string): string => {
    const draft = sessionDraftsRef.current.get(sessionId) as unknown
    const text = draft && typeof draft === 'object'
      ? (draft as { text?: unknown }).text
      : draft
    return coerceInputText(text)
  }, [])

  // Getter for persisted attachment refs (path + name only — not hydrated files).
  // Consumers that need FileAttachment objects should call hydrateDraftAttachments.
  const getDraftAttachmentRefs = useCallback((sessionId: string): DraftAttachmentRef[] => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    return Array.isArray(attachments) ? attachments : []
  }, [])

  // Hydrate persisted attachment refs into full FileAttachment objects.
  //  - Track C (ref.content set): reconstruct directly from the inlined bytes.
  //  - Track P (path-only): re-read from disk via the readUserAttachment RPC.
  // Missing/moved files on Track P are silently dropped with a console warn — same
  // UX as any other editor draft restore when the backing file is gone.
  const hydrateDraftAttachments = useCallback(async (sessionId: string): Promise<FileAttachment[]> => {
    const attachments = sessionDraftsRef.current.get(sessionId)?.attachments
    const refs = Array.isArray(attachments) ? attachments : []
    if (refs.length === 0) return []
    const results = await Promise.all(
      refs.map(async (ref) => {
        if (ref.content) {
          return attachmentFromContentRef(ref)
        }
        try {
          const attachment = await window.electronAPI.readUserAttachment(ref.path)
          if (!attachment) {
            console.warn('[drafts] Attachment missing on restore, dropping:', ref.path)
            return null
          }
          return attachment
        } catch (err) {
          console.warn('[drafts] Failed to restore attachment, dropping:', ref.path, err)
          return null
        }
      })
    )
    return results.filter((a): a is FileAttachment => a !== null)
  }, [])

  // Write a debounced snapshot of the current ref entry to disk.
  const schedulePersistDraft = useCallback((sessionId: string) => {
    const existingTimeout = draftSaveTimeoutRef.current.get(sessionId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }
    const timeout = setTimeout(() => {
      const draft = sessionDraftsRef.current.get(sessionId) ?? { text: '' }
      window.electronAPI.setDraft(sessionId, draft)
      draftSaveTimeoutRef.current.delete(sessionId)
    }, DRAFT_SAVE_DEBOUNCE_MS)
    draftSaveTimeoutRef.current.set(sessionId, timeout)
  }, [])

  const handleInputChange = useCallback((sessionId: string, value: string) => {
    const text = coerceInputText(value)
    const existing = sessionDraftsRef.current.get(sessionId)
    const existingAttachments = Array.isArray(existing?.attachments) ? existing.attachments : []
    const nextDraft: SessionDraft = {
      text,
      ...(existingAttachments.length > 0
        ? { attachments: existingAttachments }
        : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  const handleAttachmentsChange = useCallback((sessionId: string, attachments: FileAttachment[]) => {
    const existing = sessionDraftsRef.current.get(sessionId)
    const refs: DraftAttachmentRef[] = []
    for (const a of attachments) {
      const ref = toDraftRef(a)
      if (ref) {
        refs.push(ref)
      } else {
        console.warn('[drafts] attachment exceeds per-draft size cap, not persisted:', a.name, a.size)
      }
    }
    const nextDraft: SessionDraft = {
      text: coerceInputText(existing?.text),
      ...(refs.length > 0 ? { attachments: refs } : {}),
    }
    const isEmpty = !nextDraft.text && (!nextDraft.attachments || nextDraft.attachments.length === 0)
    if (isEmpty) {
      sessionDraftsRef.current.delete(sessionId)
    } else {
      sessionDraftsRef.current.set(sessionId, nextDraft)
    }
    schedulePersistDraft(sessionId)
  }, [schedulePersistDraft])

  // Open new chat as a draft. The backing session is created on first send.
  // Used by components via AppShellContext and for programmatic navigation
  const openNewChat = useCallback(async (params: NewChatActionParams = {}) => {
    if (!windowWorkspaceId) {
      console.warn('[App] Cannot open new chat: no workspace ID')
      return
    }

    navigate(routes.action.newSession(
      params.input || params.name
        ? {
            ...(params.input ? { input: params.input } : {}),
            ...(params.name ? { name: params.name } : {}),
          }
        : undefined
    ))
  }, [windowWorkspaceId])

  const handleRespondToPermission = useCallback(async (
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: import('../shared/types').PermissionResponseOptions,
  ) => {
    const success = await window.electronAPI.respondToPermission(sessionId, requestId, allowed, alwaysAllow, options)

    if (success) {
      // Remove only the first permission from the queue (the one we just responded to)
      setPendingPermissions(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1) // Remove first item
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
      // Note: No need to force session refresh - per-session atoms update automatically
    } else {
      // Response failed (agent/session gone) - clear the permission anyway
      // to avoid UI being stuck with stale permission
      setPendingPermissions(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1)
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
    }
  }, [])

  const handleRespondToCredential = useCallback(async (sessionId: string, requestId: string, response: CredentialResponse) => {
    const success = await window.electronAPI.respondToCredential(sessionId, requestId, response)

    if (success) {
      // Remove only the first credential from the queue (the one we just responded to)
      setPendingCredentials(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1) // Remove first item
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
      // Note: No need to force session refresh - per-session atoms update automatically
    } else {
      // Response failed (agent/session gone) - clear the credential anyway
      // to avoid UI being stuck with stale credential request
      setPendingCredentials(prev => {
        const next = new Map(prev)
        const queue = next.get(sessionId) || []
        const remainingQueue = queue.slice(1)
        if (remainingQueue.length === 0) {
          next.delete(sessionId)
        } else {
          next.set(sessionId, remainingQueue)
        }
        return next
      })
    }
  }, [])

  // Centralized link interceptor: classifies file types and decides whether to
  // show an in-app preview overlay or open externally. Replaces the old
  // handleOpenFile/handleOpenUrl that always opened in external apps.
  const linkInterceptor = useLinkInterceptor({
    openFileExternal: async (path) => {
      try {
        await window.electronAPI.openFile(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open file:', error)
        toast.error(t('toast.failedToOpenFile'), {
          description: message,
        })
      }
    },
    openUrl: async (url) => {
      try {
        await window.electronAPI.openUrl(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to open URL:', error)
        toast.error(t('toast.failedToOpenLink'), {
          description: `${message}. If this is a local path, use Open File instead.`,
        })
      }
    },
    showInFolder: async (path) => {
      try {
        await window.electronAPI.showInFolder(path)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('Failed to show in folder:', error)
        toast.error(t("toast.failedToReveal", { fileManager: getFileManagerName() }), {
          description: message,
        })
      }
    },
    readFile: (path) => window.electronAPI.readFile(path),
    readFileDataUrl: (path) => window.electronAPI.readFileDataUrl(path),
    readFileBinary: (path) => window.electronAPI.readFileBinary(path),
  })

  const connectionState = useTransportConnectionState()
  const showTransportConnectionBanner = shouldShowTransportConnectionBanner(connectionState)

  const handleReconnectTransport = useCallback(() => {
    void window.electronAPI.reconnectTransport().catch((error) => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.reconnectFailed'), { description: message })
    })
  }, [])

  const handleOpenFile = linkInterceptor.handleOpenFile
  const handleOpenUrlExternal = linkInterceptor.handleOpenUrl

  const handleOpenUrlInBuiltInBrowser = useCallback((url: string) => {
    const open = async () => {
      const trimmedUrl = url.trim()
      const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmedUrl)
      const hasSchemeSeparator = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedUrl)
      const hostPattern =
        /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i
      const looksLikeHost = hostPattern.test(trimmedUrl)
      const shouldUseBuiltInBrowser = hasSchemeSeparator
        ? /^https?:\/\//i.test(trimmedUrl)
        : !hasExplicitScheme || looksLikeHost

      if (!shouldUseBuiltInBrowser) {
        handleOpenUrlExternal(url)
        return
      }

      let instanceId: string | null = null
      try {
        const browserPaneApi = window.electronAPI?.browserPane
        if (!browserPaneApi) {
          handleOpenUrlExternal(url)
          return
        }

        instanceId = await browserPaneApi.create({
          id: DEFAULT_DOCKED_BROWSER_INSTANCE_ID,
          show: true,
          presentation: 'docked',
        })
        await browserPaneApi.navigate(instanceId, trimmedUrl)
        await browserPaneApi.focus(instanceId)
      } catch (error) {
        if (instanceId) {
          console.warn(
            '[App] Failed to finish opening URL in built-in browser:',
            error,
          )
          return
        }

        console.warn(
          '[App] Failed to open URL in built-in browser, falling back to default browser:',
          error,
        )
        handleOpenUrlExternal(url)
      }
    }

    void open()
  }, [handleOpenUrlExternal])

  const handleOpenSettings = useCallback(() => {
    navigate(routes.view.settings())
  }, [])

  const handleOpenKeyboardShortcuts = useCallback(() => {
    navigate(routes.view.settings('shortcuts'))
  }, [])

  const handleOpenStoredUserPreferences = useCallback(() => {
    navigate(routes.view.settings('preferences'))
  }, [])

  // Show reset confirmation dialog
  const handleReset = useCallback(() => {
    setShowResetDialog(true)
  }, [])

  // Execute reset after user confirms in dialog
  const executeReset = useCallback(async () => {
    try {
      await window.electronAPI.logout()
      // Reset all state
      // Clear session atoms - initialize with empty array clears all per-session atoms
      initializeSessions([])
      setWorkspaces([])
      windowWorkspaceIdRef.current = null
      setWindowWorkspaceId(null)
      // Reset setupNeeds to force fresh onboarding start
      setSetupNeeds({
        needsBillingConfig: true,
        needsCredentials: true,
        isFullyConfigured: false,
      })
      // Reset onboarding hook state
      onboarding.reset()
      setAppState('onboarding')
    } catch (error) {
      console.error('Reset failed:', error)
    } finally {
      setShowResetDialog(false)
    }
  }, [onboarding, initializeSessions])

  // Handle workspace selection
  // - Default: switch workspace in same window (in-window switching)
  // - With openInNewWindow=true: open in new window (or focus existing)
  const handleSelectWorkspace = useCallback(async (
    workspaceId: string,
    openInNewWindow = false,
    options?: { route?: ViewRoute; suppressSessionListLoading?: boolean },
  ) => {
    // If selecting current workspace, do nothing
    if (workspaceId === windowWorkspaceIdRef.current) return

    if (openInNewWindow) {
      // Open (or focus) the window for the selected workspace
      window.electronAPI.openWorkspace(workspaceId)
      return
    }

    pendingWorkspaceSwitchRouteRef.current = options?.route
      ? { workspaceId, route: options.route }
      : null

    setSessionLoadError(null)
    if (!options?.suppressSessionListLoading) {
      setSessionListLoading(true)
    }

    const switchSeq = ++workspaceSwitchSeqRef.current
    const requestSeq = ++sessionListRequestSeqRef.current

    const runSwitch = async () => {
      if (switchSeq !== workspaceSwitchSeqRef.current) return

      const targetWorkspace = workspaces.find(w => w.id === workspaceId)
      let loadedSessions: Session[] | null = null
      const workspaceSessions = store.get(workspaceSessionsAtom)
      const cachedMetas = getWorkspaceSessionMetas(workspaceSessions, workspaceId)
      if (targetWorkspace?.remoteServer && cachedMetas.length > 0) {
        loadedSessions = cachedMetas.map(meta => sessionFromMeta(meta, targetWorkspace?.name))
      }

      // Local workspaces can be read before the active window context changes.
      // That lets us commit the target workspace and its session list together.
      if (!targetWorkspace?.remoteServer) {
        try {
          loadedSessions = await window.electronAPI.getSessionsForWorkspace(workspaceId, { refreshExternal: true })
          cacheWorkspaceSessionMetas(workspaceId, loadedSessions)
        } catch (error) {
          console.warn(`[App] Failed to preload sessions for workspace ${workspaceId}:`, error)
          if (cachedMetas.length > 0) {
            loadedSessions = cachedMetas.map(meta => sessionFromMeta(meta, targetWorkspace?.name))
          }
        }
      }

      if (switchSeq !== workspaceSwitchSeqRef.current || requestSeq !== sessionListRequestSeqRef.current) {
        return
      }

      // Switch workspace in current window.
      await window.electronAPI.switchWorkspace(workspaceId)

      if (switchSeq !== workspaceSwitchSeqRef.current || requestSeq !== sessionListRequestSeqRef.current) {
        return
      }

      if (!loadedSessions) {
        try {
          loadedSessions = await window.electronAPI.getSessions()
        } catch (error) {
          if (switchSeq !== workspaceSwitchSeqRef.current || requestSeq !== sessionListRequestSeqRef.current) {
            return
          }
          console.error(`[App] Failed to load sessions while switching to workspace ${workspaceId}:`, error)
          setSessionLoadError(formatSessionLoadFailure(error))
          loadedSessions = []
        }
      }

      if (switchSeq !== workspaceSwitchSeqRef.current || requestSeq !== sessionListRequestSeqRef.current) {
        return
      }

      sessionDraftsRef.current.clear()
      windowWorkspaceIdRef.current = workspaceId

      // Keep the switch visually atomic: the active workspace and its session
      // metadata land in the same paint, instead of briefly rendering empty UI.
      flushSync(() => {
        setWindowWorkspaceId(workspaceId)
        setSession({ selected: null })
        setPendingPermissions(new Map())
        setPendingCredentials(new Map())
        applyLoadedSessions(
          loadedSessions,
          workspaceId,
          targetWorkspace?.remoteServer?.remoteWorkspaceId,
        )
        setSessionsLoaded(true)
        setSessionListLoading(false)
      })

      void reconcileLoadedSessionPermissionModes(loadedSessions)
      // Note: NavigationContext detects the workspaceId change and handles
      // panel restoration from the stored workspace URL (or defaults to allSessions).
      // Sessions and theme still refresh via windowWorkspaceId-dependent effects,
      // but the first frame already has the target workspace's session metadata.
    }

    const nextSwitch = workspaceSwitchChainRef.current
      .catch(() => {})
      .then(runSwitch)
      .catch((error) => {
        if (switchSeq === workspaceSwitchSeqRef.current) {
          setSessionListLoading(false)
        }
        console.error(`[App] Failed to switch workspace to ${workspaceId}:`, error)
      })

    workspaceSwitchChainRef.current = nextSwitch.catch(() => {})
    return nextSwitch
  }, [workspaces, store, setWindowWorkspaceId, setSession, applyLoadedSessions, cacheWorkspaceSessionMetas, reconcileLoadedSessionPermissionModes])

  // Handle workspace switch by slug (called by NavigationContext on popstate when ?ws= changes)
  const handleSwitchWorkspaceBySlug = useCallback((slug: string) => {
    const target = workspaces.find(w => w.slug === slug)
    if (target) {
      handleSelectWorkspace(target.id)
    }
  }, [workspaces, handleSelectWorkspace])

  // Handle workspace refresh (e.g., after icon upload)
  const handleRefreshWorkspaces = useCallback(() => {
    window.electronAPI.getWorkspaces().then(setWorkspaces)
  }, [])

  // Handle cancel during onboarding
  const handleOnboardingCancel = useCallback(() => {
    onboarding.handleCancel()
  }, [onboarding])

  // Build context value for AppShell component
  // This is memoized to prevent unnecessary re-renders
  // IMPORTANT: Must be before early returns to maintain consistent hook order
  const appShellContextValue = useMemo<AppShellContextType>(() => ({
    // Data
    // NOTE: sessions is NOT included - use sessionMetaMapAtom for listing
    // and useSession(id) hook for individual sessions. This prevents memory leaks.
    workspaces,
    activeWorkspaceId: windowWorkspaceId,
    activeWorkspaceSlug: windowWorkspaceSlug,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    onOptimisticDefaultModelChange: handleOptimisticDefaultModelChange,
    pendingPermissions,
    pendingCredentials,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    globalPermissionMode,
    sessionOptions,
    // Session callbacks
    onCreateSession: handleCreateSession,
    onSendMessage: handleSendMessage,
    onRenameSession: handleRenameSession,
    onFlagSession: handleFlagSession,
    onUnflagSession: handleUnflagSession,
    onArchiveSession: handleArchiveSession,
    onUnarchiveSession: handleUnarchiveSession,
    onMarkSessionRead: handleMarkSessionRead,
    onMarkSessionUnread: handleMarkSessionUnread,
    onSetActiveViewingSession: handleSetActiveViewingSession,
    onSessionStatusChange: handleSessionStatusChange,
    onDeleteSession: handleDeleteSession,
    onRespondToPermission: handleRespondToPermission,
    onRespondToCredential: handleRespondToCredential,
    // File/URL handlers
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrlInBuiltInBrowser,
    // Workspace
    onSelectWorkspace: handleSelectWorkspace,
    onRefreshWorkspaces: handleRefreshWorkspaces,
    // App actions
    onOpenSettings: handleOpenSettings,
    onOpenKeyboardShortcuts: handleOpenKeyboardShortcuts,
    onOpenStoredUserPreferences: handleOpenStoredUserPreferences,
    onReset: handleReset,
    // Session options
    onSessionOptionsChange: handleSessionOptionsChange,
    onInputChange: handleInputChange,
    onAttachmentsChange: handleAttachmentsChange,
    // New chat (via deep link navigation)
    openNewChat,
  }), [
    // NOTE: sessions removed to prevent memory leaks - components use atoms instead
    workspaces,
    windowWorkspaceId,
    windowWorkspaceSlug,
    llmConnections,
    workspaceDefaultLlmConnection,
    refreshLlmConnections,
    handleOptimisticDefaultModelChange,
    pendingPermissions,
    pendingCredentials,
    getDraft,
    getDraftAttachmentRefs,
    hydrateDraftAttachments,
    globalPermissionMode,
    sessionOptions,
    handleCreateSession,
    handleSendMessage,
    handleRenameSession,
    handleFlagSession,
    handleUnflagSession,
    handleArchiveSession,
    handleUnarchiveSession,
    handleMarkSessionRead,
    handleMarkSessionUnread,
    handleSetActiveViewingSession,
    handleSessionStatusChange,
    handleDeleteSession,
    handleRespondToPermission,
    handleRespondToCredential,
    handleOpenFile,
    handleOpenUrlInBuiltInBrowser,
    handleSelectWorkspace,
    handleRefreshWorkspaces,
    handleOpenSettings,
    handleOpenKeyboardShortcuts,
    handleOpenStoredUserPreferences,
    handleReset,
    handleSessionOptionsChange,
    handleInputChange,
    handleAttachmentsChange,
    openNewChat,
  ])

  // Platform actions for @craft-agent/ui components (overlays, etc.)
  // Memoized to prevent re-renders when these callbacks don't change
  // NOTE: Must be defined before early returns to maintain consistent hook order
  const platformActions = useMemo(() => ({
    onOpenFile: handleOpenFile,
    onOpenUrl: handleOpenUrlInBuiltInBrowser,
    onOpenUrlExternal: handleOpenUrlExternal,
    // Bypass link interceptor — opens file directly in system editor.
    // Used by overlay header badges (when already viewing a file, "Open" should launch editor).
    onOpenFileExternal: linkInterceptor.openFileExternal,
    // Read file contents as UTF-8 string (used by datatable/spreadsheet/html-preview src fields)
    onReadFile: (path: string) => window.electronAPI.readFile(path),
    // Read file as data URL (used by image-preview blocks)
    onReadFileDataUrl: (path: string) => window.electronAPI.readFileDataUrl(path),
    // Read file as binary Uint8Array (used by PDF preview blocks)
    onReadFileBinary: (path: string) => window.electronAPI.readFileBinary(path),
    // Reveal a file in the system file manager (Finder on macOS, Explorer on Windows, etc.)
    onRevealInFinder: (path: string) => {
      window.electronAPI.showInFolder(path).catch(() => {})
    },
    // Platform-specific file manager name for UI labels
    fileManagerName: getFileManagerName(),
    // Hide/show macOS traffic lights when fullscreen overlays are open
    onSetTrafficLightsVisible: (visible: boolean) => {
      window.electronAPI.setTrafficLightsVisible(visible)
    },
  }), [
    handleOpenFile,
    handleOpenUrlExternal,
    handleOpenUrlInBuiltInBrowser,
    linkInterceptor.openFileExternal,
  ])

  // Loading state - show splash screen
  if (appState === 'loading') {
    return <SplashScreen isExiting={false} />
  }

  // Reauth state - session expired, need to re-login
  // ModalProvider + WindowCloseHandler ensures X button works on Windows
  if (appState === 'reauth') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <ReauthScreen
            onLogin={handleReauthLogin}
            onReset={handleReauthReset}
          />
          <ResetConfirmationDialog
            open={showResetDialog}
            onConfirm={executeReset}
            onCancel={() => setShowResetDialog(false)}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Onboarding state
  // ModalProvider + WindowCloseHandler ensures X button works on Windows
  // (without this, the close IPC message has no listener and window stays open)
  if (appState === 'onboarding') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <OnboardingWizard
            state={onboarding.state}
            onContinue={onboarding.handleContinue}
            onBack={onboarding.handleBack}
            onSelectProvider={onboarding.handleSelectProvider}
            onSkipSetup={onboarding.handleSkipSetup}
            onSelectApiSetupMethod={onboarding.handleSelectApiSetupMethod}
            onSubmitCredential={onboarding.handleSubmitCredential}
            onFinish={onboarding.handleFinish}
            onBrowseGitBash={onboarding.handleBrowseGitBash}
            onUseGitBashPath={onboarding.handleUseGitBashPath}
            onRecheckGitBash={onboarding.handleRecheckGitBash}
            onClearError={onboarding.handleClearError}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Workspace picker — thin client with no workspace selected
  if (appState === 'workspace-picker') {
    return (
      <DismissibleLayerProvider>
        <ModalProvider>
          <WindowCloseHandler />
          <WorkspacePicker
            onSelectWorkspace={async (id) => {
              await window.electronAPI.switchWorkspace(id)
              windowWorkspaceIdRef.current = id
              setWindowWorkspaceId(id)
              setAppState('ready')
            }}
          />
        </ModalProvider>
      </DismissibleLayerProvider>
    )
  }

  // Show splash until exit animation completes
  const showSplash = !splashHidden
  const isActiveSessionListLoading =
    sessionListLoading ||
    (!!windowWorkspaceId && sessionListRefreshWorkspaceIds.has(windowWorkspaceId))

  // Ready state - main app with splash overlay during data loading
  return (
    <PlatformProvider actions={platformActions}>
    <ShikiThemeProvider shikiTheme={shikiTheme}>
      <ActionRegistryProvider>
      <FocusProvider>
        <DismissibleLayerProvider>
        <ModalProvider>
        <TooltipProvider delayDuration={0}>
        <NavigationProvider
          workspaceId={windowWorkspaceId}
          workspaceSlug={windowWorkspaceSlug}
          onSwitchWorkspaceBySlug={handleSwitchWorkspaceBySlug}
          onCreateSession={handleCreateSession}
          onInputChange={handleInputChange}
          getDraft={getDraft}
          onAutoDeleteEmptySession={handleAutoDeleteEmptySession}
          isReady={appState === 'ready'}
          isSessionsReady={sessionsLoaded}
          remoteWorkspaceId={windowRemoteWorkspaceId}
          consumeWorkspaceSwitchRoute={consumePendingWorkspaceSwitchRoute}
        >
          {/* Handle window close requests (X button, Cmd+W) - close modal first if open */}
          <WindowCloseHandler />

          {/* Splash screen overlay - fades out when fully ready */}
          {showSplash && (
            <SplashScreen
              isExiting={splashExiting}
              onExitComplete={handleSplashExitComplete}
            />
          )}

          {/* Main UI - always rendered, splash fades away to reveal it */}
          <div className="h-full flex flex-col text-foreground">
            {showTransportConnectionBanner && connectionState && (
              <TransportConnectionBanner
                state={connectionState}
                onRetry={handleReconnectTransport}
              />
            )}
            <div className="flex-1 min-h-0">
              {sessionLoadError ? (
                <SessionLoadErrorScreen
                  message={sessionLoadError}
                  onRetry={() => { void loadSessionsFromServer() }}
                />
              ) : (
                <AppShell
                  contextValue={appShellContextValue}
                  defaultLayout={[20, 32, 48]}
                  menuNewChatTrigger={menuNewChatTrigger}
                  isFocusedMode={isFocusedMode}
                  isSessionListLoading={isActiveSessionListLoading}
                  onProjectSessionSnapshotsReadyChange={setProjectSessionSnapshotsReady}
                />
              )}
            </div>
            <ResetConfirmationDialog
              open={showResetDialog}
              onConfirm={executeReset}
              onCancel={() => setShowResetDialog(false)}
            />
          </div>

          {/* File preview overlay — rendered by the link interceptor when a previewable file is clicked */}
          {linkInterceptor.previewState && (
            <FilePreviewRenderer
              state={linkInterceptor.previewState}
              onClose={linkInterceptor.closePreview}
              loadDataUrl={linkInterceptor.readFileDataUrl}
              loadPdfData={linkInterceptor.readFileBinary}
              isDark={isDark}
            />
          )}
        </NavigationProvider>
        </TooltipProvider>
        </ModalProvider>
        </DismissibleLayerProvider>
      </FocusProvider>
      </ActionRegistryProvider>
    </ShikiThemeProvider>
    </PlatformProvider>
  )
}

/**
 * Component that handles window close requests.
 * Must be inside ModalProvider to access the modal registry.
 */
function WindowCloseHandler() {
  useWindowCloseHandler()
  return null
}

/**
 * FilePreviewRenderer - Routes file preview state to the correct overlay component.
 *
 * Handles all preview types from the link interceptor:
 * - image → ImagePreviewOverlay (binary, loaded via data URL)
 * - pdf → PDFPreviewOverlay (binary, embedded via Chromium viewer)
 * - code/text → CodePreviewOverlay (syntax highlighted)
 * - markdown → DocumentFormattedMarkdownOverlay
 * - json → JSONPreviewOverlay
 *
 * File path badges with "Open" / "Reveal in {file manager}" menus are provided
 * automatically by PlatformContext — no per-overlay callback props needed.
 */
function FilePreviewRenderer({
  state,
  onClose,
  loadDataUrl,
  loadPdfData,
  isDark,
}: {
  state: FilePreviewState
  onClose: () => void
  loadDataUrl: (path: string) => Promise<string>
  loadPdfData: (path: string) => Promise<Uint8Array>
  isDark: boolean
}) {
  const theme = isDark ? 'dark' : 'light' as const

  switch (state.type) {
    case 'image':
      return (
        <ImagePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadDataUrl={loadDataUrl}
          theme={theme}
        />
      )

    case 'pdf':
      return (
        <PDFPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          loadPdfData={loadPdfData}
          theme={theme}
        />
      )

    case 'code':
    case 'text':
      return (
        <CodePreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          content={state.content ?? ''}
          language={state.type === 'code' ? state.language : 'plaintext'}
          mode="read"
          theme={theme}
          error={state.error}
        />
      )

    case 'markdown': {
      // Show PLAN header for .md files in plans folder (handles both absolute and relative paths)
      const isPlanFile =
        (state.filePath.includes('/plans/') || state.filePath.startsWith('plans/')) &&
        state.filePath.endsWith('.md')
      return (
        <DocumentFormattedMarkdownOverlay
          isOpen
          onClose={onClose}
          content={state.content ?? ''}
          filePath={state.filePath}
          variant={isPlanFile ? 'plan' : 'response'}
        />
      )
    }

    case 'json': {
      // JSONPreviewOverlay expects parsed data, not a raw string.
      // @uiw/react-json-view crashes on null value, so guard against it.
      let parsedData: unknown = null
      try {
        if (state.content) parsedData = JSON.parse(state.content)
      } catch {
        // If parsing fails, fall back to showing as code
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      // If read failed and content is empty, show raw code overlay with the read error.
      if ((!state.content || !state.content.trim()) && state.error) {
        return (
          <CodePreviewOverlay
            isOpen
            onClose={onClose}
            filePath={state.filePath}
            content={state.content ?? ''}
            language="json"
            mode="read"
            theme={theme}
            error={state.error}
          />
        )
      }
      return (
        <JSONPreviewOverlay
          isOpen
          onClose={onClose}
          filePath={state.filePath}
          title={state.filePath.split('/').pop() ?? 'JSON'}
          data={parsedData}
          theme={theme}
          error={state.error}
        />
      )
    }

    default:
      return null
  }
}
