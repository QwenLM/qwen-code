/**
 * ChatPage
 *
 * Displays a single session's chat with a consistent PanelHeader.
 * Extracted from MainContentPanel for consistency with other pages.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertCircle, Globe, Copy, RefreshCw, Link2Off, Info } from 'lucide-react'
import { ChatDisplay, type ChatDisplayHandle } from '@/components/app-shell/ChatDisplay'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SessionMenu } from '@/components/app-shell/SessionMenu'
import { SessionInfoPopover } from '@/components/app-shell/SessionInfoPopover'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { toast } from 'sonner'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem, StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown'
import { useAppShellContext, usePendingPermission, usePendingCredential, useSessionOptionsFor, useSession as useSessionData } from '@/context/AppShellContext'
import { rendererPerf } from '@/lib/perf'
import { routes } from '@/lib/navigate'
import { coerceInputText } from '@/lib/input-text'
import { formatSessionLoadFailure, hasSessionContentHint, shouldShowForegroundMessageLoading } from '@/lib/session-load'
import { ensureSessionMessagesLoadedAtom, loadedSessionsAtom, sessionMetaMapAtom } from '@/atoms/sessions'
import { getSessionTitle } from '@/utils/session'
// Model resolution: connection.defaultModel (no hardcoded defaults)
import { resolveEffectiveConnectionSlug, isSessionConnectionUnavailable } from '@config/llm-connections'

export interface ChatPageProps {
  sessionId: string
}

const ChatPage = React.memo(function ChatPage({ sessionId }: ChatPageProps) {
  const { t } = useTranslation()
  // Diagnostic: mark when component runs
  React.useLayoutEffect(() => {
    rendererPerf.markSessionSwitch(sessionId, 'panel.mounted')
  }, [sessionId])

  const {
    activeWorkspaceId,
    llmConnections,
    workspaceDefaultLlmConnection,
    onSendMessage,
    onOpenFile,
    onOpenUrl,
    workspaces,
    onRespondToPermission,
    onRespondToCredential,
    onMarkSessionRead,
    onMarkSessionUnread,
    onSetActiveViewingSession,
    getDraft,
    hydrateDraftAttachments,
    onInputChange,
    onAttachmentsChange,
    enabledSources,
    skills,
    labels,
    onSessionLabelsChange,
    enabledModes,
    sessionStatuses,
    onSessionSourcesChange,
    onRenameSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onSessionStatusChange,
    onDeleteSession,
    rightSidebarButton,
    leadingAction,
    isCompactMode,
    sessionListSearchQuery,
    isSearchModeActive,
    chatDisplayRef,
    onChatMatchInfoChange,
    isFocusedPanel,
  } = useAppShellContext()

  // Use the unified session options hook for clean access
  const {
    options: sessionOpts,
    setOption,
    setPermissionMode,
  } = useSessionOptionsFor(sessionId)

  // Use per-session atom for isolated updates
  const session = useSessionData(sessionId)

  // Track if messages are loaded for this session (for lazy loading)
  const loadedSessions = useAtomValue(loadedSessionsAtom)
  const messagesLoaded = loadedSessions.has(sessionId)

  // Check if session exists in metadata (for loading state detection)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const sessionMeta = sessionMetaMap.get(sessionId)

  // Fallback: ensure messages are loaded when session is viewed
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)
  const [messageLoadError, setMessageLoadError] = React.useState<string | null>(null)
  const [messageLoadRetryNonce, setMessageLoadRetryNonce] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    const retryDelaysMs = [0, 400, 1200]

    setMessageLoadError(null)

    const load = async (attempt: number) => {
      try {
        await ensureMessagesLoaded(sessionId)
        if (!cancelled) {
          setMessageLoadError(null)
        }
      } catch (error) {
        if (cancelled) return

        const nextAttempt = attempt + 1
        const nextDelay = retryDelaysMs[nextAttempt]
        if (nextDelay !== undefined) {
          window.setTimeout(() => {
            if (!cancelled) void load(nextAttempt)
          }, nextDelay)
          return
        }

        console.error(`[ChatPage] Failed to load messages for session ${sessionId}:`, error)
        setMessageLoadError(formatSessionLoadFailure(error))
      }
    }

    void load(0)

    return () => {
      cancelled = true
    }
  }, [sessionId, ensureMessagesLoaded, messageLoadRetryNonce])

  const retryMessageLoad = React.useCallback(() => {
    setMessageLoadError(null)
    setMessageLoadRetryNonce((nonce) => nonce + 1)
  }, [])

  // Perf: Mark when session data is available
  const sessionLoadedMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (session && sessionLoadedMarkedRef.current !== sessionId) {
      sessionLoadedMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'session.loaded')
    }
  }, [sessionId, session])

  // Track window focus state for marking session as read when app regains focus
  const [isWindowFocused, setIsWindowFocused] = React.useState(true)
  React.useEffect(() => {
    window.electronAPI.getWindowFocusState().then(setIsWindowFocused)
    const cleanup = window.electronAPI.onWindowFocusChange(setIsWindowFocused)
    return cleanup
  }, [])

  // Track which session user is viewing (for unread state machine).
  // This tells main process user is looking at this session, so:
  // 1. If not processing → clear hasUnread immediately
  // 2. If processing → when it completes, main process will clear hasUnread
  // The main process handles all the logic; we just report viewing state.
  React.useEffect(() => {
    if (session && isWindowFocused && isFocusedPanel !== false) {
      onSetActiveViewingSession(session.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, isWindowFocused, isFocusedPanel, onSetActiveViewingSession])

  // Get pending permission and credential for this session
  const pendingPermission = usePendingPermission(sessionId)
  const pendingCredential = usePendingCredential(sessionId)

  // Track draft value for this session
  const [inputValue, setInputValue] = React.useState(() => coerceInputText(getDraft(sessionId)))
  const inputValueRef = React.useRef(inputValue)
  inputValueRef.current = inputValue

  // Re-sync from parent when session changes
  React.useEffect(() => {
    setInputValue(coerceInputText(getDraft(sessionId)))
  }, [getDraft, sessionId])

  // Sync when draft is set externally (e.g., from notifications or shortcuts)
  // PERFORMANCE NOTE: This bounded polling (max 10 attempts × 50ms = 500ms)
  // handles external draft injection. Drafts use a ref for typing performance,
  // so they're not directly reactive. This polling only runs on session switch,
  // not continuously. Alternative: Add a Jotai atom for draft changes.
  React.useEffect(() => {
    let attempts = 0
    const maxAttempts = 10
    const interval = setInterval(() => {
      const currentDraft = coerceInputText(getDraft(sessionId))
      if (currentDraft !== inputValueRef.current && currentDraft !== '') {
        setInputValue(currentDraft)
        clearInterval(interval)
      }
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 50)

    return () => clearInterval(interval)
  }, [sessionId, getDraft])

  // Listen for restore-input events (queued messages restored to input on abort)
  React.useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: targetId, text } = (e as CustomEvent).detail ?? {}
      if (targetId === sessionId) {
        const nextText = coerceInputText(text)
        setInputValue(nextText)
        inputValueRef.current = nextText
      }
    }
    window.addEventListener('craft:restore-input', handler)
    return () => window.removeEventListener('craft:restore-input', handler)
  }, [sessionId])

  const handleInputChange = React.useCallback((value: string) => {
    const nextText = coerceInputText(value)
    setInputValue(nextText)
    inputValueRef.current = nextText
    onInputChange(sessionId, nextText)
  }, [sessionId, onInputChange])

  // Attachments draft state — hydrated async from persisted refs on session switch.
  // `[]` is the safe default while hydration is in flight; FreeFormInput seeds its
  // local state from this prop and swaps in the restored list when ready.
  const [attachmentsValue, setAttachmentsValue] = React.useState<import('../../shared/types').FileAttachment[]>([])

  React.useEffect(() => {
    let cancelled = false
    setAttachmentsValue([])
    hydrateDraftAttachments(sessionId).then((atts) => {
      if (!cancelled) setAttachmentsValue(atts)
    })
    return () => { cancelled = true }
  }, [sessionId, hydrateDraftAttachments])

  const handleAttachmentsChange = React.useCallback((attachments: import('../../shared/types').FileAttachment[]) => {
    setAttachmentsValue(attachments)
    onAttachmentsChange(sessionId, attachments)
  }, [sessionId, onAttachmentsChange])

  // Session model change handler - persists per-session model and connection
  const handleModelChange = React.useCallback((model: string, connection?: string) => {
    if (activeWorkspaceId) {
      window.electronAPI.setSessionModel(sessionId, activeWorkspaceId, model, connection)
    }
  }, [sessionId, activeWorkspaceId])

  // Session connection change handler - can only change before first message
  const handleConnectionChange = React.useCallback(async (connectionSlug: string) => {
    try {
      await window.electronAPI.sessionCommand(sessionId, { type: 'setConnection', connectionSlug })
    } catch (error) {
      // Connection change may fail if session already started or connection is invalid
      console.error('Failed to change connection:', error)
    }
  }, [sessionId])

  // Check if session's locked connection has been removed
  const connectionUnavailable = React.useMemo(() =>
    isSessionConnectionUnavailable(session?.llmConnection, llmConnections),
    [session?.llmConnection, llmConnections]
  )

  // Effective model for this session (session-specific or global fallback)
  const effectiveModel = React.useMemo(() => {
    if (session?.model) return session.model

    // When connection is unavailable, don't resolve through a different connection
    if (connectionUnavailable) return session?.model ?? ''

    const connectionSlug = resolveEffectiveConnectionSlug(
      session?.llmConnection, workspaceDefaultLlmConnection, llmConnections
    )
    const connection = connectionSlug ? llmConnections.find(c => c.slug === connectionSlug) : null

    return connection?.defaultModel ?? ''
  }, [session?.id, session?.model, session?.llmConnection, workspaceDefaultLlmConnection, llmConnections, connectionUnavailable])

  // Working directory for this session
  const workingDirectory = session?.workingDirectory
  const activeWorkspace = React.useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || null,
    [workspaces, activeWorkspaceId]
  )
  const handleWorkingDirectoryChange = React.useCallback(async (path: string) => {
    if (!session) return
    await window.electronAPI.sessionCommand(session.id, { type: 'updateWorkingDirectory', dir: path })
  }, [session])

  const handleOpenFile = React.useCallback(
    async (path: string) => {
      // Resolve bare relative paths against session working directory,
      // or workspace root as a fallback when workingDirectory is not set.
      const resolved = (() => {
        if (path.startsWith('/') || path.startsWith('~/')) return path

        const baseDir = workingDirectory || activeWorkspace?.rootPath
        if (!baseDir) return path

        const cleanedBase = baseDir.replace(/\/+$/, '')
        const cleanedPath = path.replace(/^\.\//, '')
        return `${cleanedBase}/${cleanedPath}`
      })()

      // Smart fallback for missing files in AI output:
      // if the exact path doesn't exist, search nearby for same basename
      // (e.g. markdown/linkify.test.ts -> markdown/__tests__/linkify.test.ts).
      if (resolved.startsWith('/')) {
        const lastSlash = resolved.lastIndexOf('/')
        if (lastSlash > 0 && lastSlash < resolved.length - 1) {
          const parentDir = resolved.slice(0, lastSlash)
          const fileName = resolved.slice(lastSlash + 1)
          try {
            const matches = await window.electronAPI.searchFiles(parentDir, fileName)
            const files = matches.filter((m) => m.type === 'file' && m.name === fileName)
            const exact = files.find((m) => m.path === resolved)
            if (exact) {
              onOpenFile(exact.path)
              return
            }

            if (files.length === 1) {
              onOpenFile(files[0].path)
              toast.info(t('chat.openedClosestMatch', { path: files[0].relativePath }))
              return
            }
          } catch {
            // Search fallback is best-effort; proceed with original resolved path.
          }
        }
      }

      onOpenFile(resolved)
    },
    [onOpenFile, workingDirectory, activeWorkspace?.rootPath]
  )

  const handleOpenUrl = React.useCallback(
    (url: string) => {
      onOpenUrl(url)
    },
    [onOpenUrl]
  )

  // Perf: Mark when data is ready
  const dataReadyMarkedRef = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    if (messagesLoaded && session && dataReadyMarkedRef.current !== sessionId) {
      dataReadyMarkedRef.current = sessionId
      rendererPerf.markSessionSwitch(sessionId, 'data.ready')
    }
  }, [sessionId, messagesLoaded, session])

  // Perf: Mark render complete after paint
  React.useEffect(() => {
    if (session) {
      const rafId = requestAnimationFrame(() => {
        rendererPerf.endSessionSwitch(sessionId)
      })
      return () => cancelAnimationFrame(rafId)
    }
  }, [sessionId, session])

  // Get display title for header - use getSessionTitle for consistent fallback logic with SessionList
  // Priority: name > first user message > preview > "New chat"
  const displayTitle = session ? getSessionTitle(session) : (sessionMeta ? getSessionTitle(sessionMeta) : t('chat.session'))
  const renameInitialTitle = session?.name || sessionMeta?.name || displayTitle
  const isFlagged = session?.isFlagged || sessionMeta?.isFlagged || false
  const isArchived = session?.isArchived || sessionMeta?.isArchived || false
  const sharedUrl = session?.sharedUrl || sessionMeta?.sharedUrl || null
  const currentSessionStatus = session?.sessionStatus || sessionMeta?.sessionStatus || 'todo'
  const expectedMessageCount = sessionMeta?.messageCount ?? session?.messageCount
  const hasExistingConversationHint = hasSessionContentHint(sessionMeta ?? session)
  const messagesLoading = !messageLoadError && shouldShowForegroundMessageLoading(
    messagesLoaded,
    session?.messages?.length,
    expectedMessageCount,
    hasExistingConversationHint,
  )
  const hasUnreadMessages = sessionMeta
    ? !!(sessionMeta.lastFinalMessageId && sessionMeta.lastFinalMessageId !== sessionMeta.lastReadMessageId)
    : false
  // Use isAsyncOperationOngoing for shimmer effect (sharing, updating share, revoking, title regeneration)
  const isAsyncOperationOngoing = session?.isAsyncOperationOngoing || sessionMeta?.isAsyncOperationOngoing || false

  // Rename dialog state
  const [renameDialogOpen, setRenameDialogOpen] = React.useState(false)
  const [renameName, setRenameName] = React.useState('')

  // Session action handlers
  const handleRename = React.useCallback(() => {
    setRenameName(renameInitialTitle)
    setRenameDialogOpen(true)
  }, [renameInitialTitle])

  const handleRenameSubmit = React.useCallback(() => {
    if (renameName.trim() && renameName.trim() !== displayTitle) {
      onRenameSession(sessionId, renameName.trim())
    }
    setRenameDialogOpen(false)
  }, [sessionId, renameName, displayTitle, onRenameSession])

  const handleFlag = React.useCallback(() => {
    onFlagSession(sessionId)
  }, [sessionId, onFlagSession])

  const handleUnflag = React.useCallback(() => {
    onUnflagSession(sessionId)
  }, [sessionId, onUnflagSession])

  const handleArchive = React.useCallback(() => {
    onArchiveSession(sessionId)
  }, [sessionId, onArchiveSession])

  const handleUnarchive = React.useCallback(() => {
    onUnarchiveSession(sessionId)
  }, [sessionId, onUnarchiveSession])

  const handleMarkUnread = React.useCallback(() => {
    onMarkSessionUnread(sessionId)
  }, [sessionId, onMarkSessionUnread])

  const handleSessionStatusChange = React.useCallback((state: string) => {
    onSessionStatusChange(sessionId, state)
  }, [sessionId, onSessionStatusChange])

  const handleLabelsChange = React.useCallback((newLabels: string[]) => {
    onSessionLabelsChange?.(sessionId, newLabels)
  }, [sessionId, onSessionLabelsChange])

  const handleDelete = React.useCallback(async () => {
    await onDeleteSession(sessionId)
  }, [sessionId, onDeleteSession])

  const handleOpenInNewWindow = React.useCallback(async () => {
    const route = routes.view.allSessions(sessionId)
    const separator = route.includes('?') ? '&' : '?'
    const url = `craftagents://${route}${separator}window=focused`
    try {
      await window.electronAPI?.openUrl(url)
    } catch (error) {
      console.error('[ChatPage] openUrl failed:', error)
    }
  }, [sessionId])

  // Share action handlers
  const handleShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'shareToViewer' }) as { success: boolean; url?: string; error?: string } | undefined
    if (result?.success && result.url) {
      await navigator.clipboard.writeText(result.url)
      toast.success(t('toast.linkCopied'), {
        description: result.url,
        action: { label: t('sendToWorkspace.open'), onClick: () => window.electronAPI.openUrl(result.url!) },
      })
    } else {
      toast.error(t('toast.failedToShare'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId])

  const handleOpenInBrowser = React.useCallback(() => {
    if (sharedUrl) window.electronAPI.openUrl(sharedUrl)
  }, [sharedUrl])

  const handleCopyLink = React.useCallback(async () => {
    if (sharedUrl) {
      await navigator.clipboard.writeText(sharedUrl)
      toast.success(t('toast.linkCopied'))
    }
  }, [sharedUrl])

  const handleUpdateShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' }) as { success: boolean; error?: string } | undefined
    if (result?.success) {
      toast.success(t('chat.shareUpdated'))
    } else {
      toast.error(t('chat.failedToUpdateShare'), { description: result?.error })
    }
  }, [sessionId])

  const handleRevokeShare = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' }) as { success: boolean; error?: string } | undefined
    if (result?.success) {
      toast.success(t('chat.sharingStopped'))
    } else {
      toast.error(t('chat.failedToStopSharing'), { description: result?.error })
    }
  }, [sessionId])

  // Share button with dropdown menu rendered in PanelHeader actions slot
  const shareButton = React.useMemo(() => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PanelHeaderCenterButton
          aria-label={sharedUrl ? 'Shared session options' : 'Share session'}
          icon={sharedUrl
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.2383 10.2871C11.6481 10.0391 12.1486 10.0082 12.5811 10.1943L12.7617 10.2871L13.0088 10.4414C14.2231 11.227 15.1393 12.2124 15.8701 13.502C16.1424 13.9824 15.9736 14.5929 15.4932 14.8652C15.0127 15.1375 14.4022 14.9688 14.1299 14.4883C13.8006 13.9073 13.4303 13.417 13 12.9883V21C13 21.5523 12.5523 22 12 22C11.4477 22 11 21.5523 11 21V12.9883C10.5697 13.417 10.1994 13.9073 9.87012 14.4883C9.59781 14.9688 8.98732 15.1375 8.50684 14.8652C8.02643 14.5929 7.8576 13.9824 8.12988 13.502C8.90947 12.1264 9.90002 11.0972 11.2383 10.2871ZM11.5 3C14.2848 3 16.6594 4.75164 17.585 7.21289C20.1294 7.90815 22 10.235 22 13C22 16.3137 19.3137 19 16 19H15V16.9961C15.5021 16.9966 16.0115 16.8707 16.4795 16.6055C17.9209 15.7885 18.4272 13.9571 17.6104 12.5156C16.6661 10.8495 15.4355 9.56805 13.7969 8.57617C12.692 7.90745 11.308 7.90743 10.2031 8.57617C8.56453 9.56806 7.3339 10.8495 6.38965 12.5156C5.57277 13.957 6.07915 15.7885 7.52051 16.6055C7.98851 16.8707 8.49794 16.9966 9 16.9961V19H7C4.23858 19 2 16.7614 2 14C2 11.9489 3.23498 10.1861 5.00195 9.41504C5.04745 5.86435 7.93852 3 11.5 3Z" />
              </svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" />
              </svg>
          }
          className={sharedUrl ? 'text-accent' : undefined}
        />
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end" sideOffset={8}>
        {sharedUrl ? (
          <>
            <StyledDropdownMenuItem onClick={handleOpenInBrowser}>
              <Globe className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.openInBrowser')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleCopyLink}>
              <Copy className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.copyLink')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={handleUpdateShare}>
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.updateShare')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={handleRevokeShare} variant="destructive">
              <Link2Off className="h-3.5 w-3.5" />
              <span className="flex-1">{t('sessionMenu.stopSharing')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://agents.craft.do/docs/go-further/sharing')}>
              <Info className="h-3.5 w-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        ) : (
          <>
            <StyledDropdownMenuItem onClick={handleShare}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M8 8.53809C6.74209 8.60866 5.94798 8.80911 5.37868 9.37841C4.5 10.2571 4.5 11.6713 4.5 14.4997V15.4997C4.5 18.3282 4.5 19.7424 5.37868 20.6211C6.25736 21.4997 7.67157 21.4997 10.5 21.4997H13.5C16.3284 21.4997 17.7426 21.4997 18.6213 20.6211C19.5 19.7424 19.5 18.3282 19.5 15.4997V14.4997C19.5 11.6713 19.5 10.2571 18.6213 9.37841C18.052 8.80911 17.2579 8.60866 16 8.53809M12 14V3.5M9.5 5.5C9.99903 4.50411 10.6483 3.78875 11.5606 3.24093C11.7612 3.12053 11.8614 3.06033 12 3.06033C12.1386 3.06033 12.2388 3.12053 12.4394 3.24093C13.3517 3.78875 14.001 4.50411 14.5 5.5" />
              </svg>
              <span className="flex-1">{t('chat.shareOnline')}</span>
            </StyledDropdownMenuItem>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onClick={() => window.electronAPI.openUrl('https://agents.craft.do/docs/go-further/sharing')}>
              <Info className="h-3.5 w-3.5" />
              <span className="flex-1">{t('chat.learnMore')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  ), [sharedUrl, handleShare, handleOpenInBrowser, handleCopyLink, handleUpdateShare, handleRevokeShare])

  const compactInfoButton = React.useMemo(() => {
    if (!isCompactMode || !sessionMeta) return undefined

    return (
      <SessionInfoPopover
        sessionId={sessionId}
        sessionFolderPath={session?.sessionFolderPath}
        presentation="drawer"
        trigger={(
          <PanelHeaderCenterButton
            icon={<Info className="h-4 w-4" />}
            aria-label={t("chat.sessionInfo")}
          />
        )}
      />
    )
  }, [isCompactMode, sessionId, session?.sessionFolderPath, sessionMeta])

  const headerActions = isCompactMode ? compactInfoButton : shareButton

  const messageLoadErrorView = messageLoadError ? (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <AlertCircle className="h-9 w-9 text-destructive/70" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("common.errorLoadingContent")}</p>
        <p className="max-w-md text-xs text-muted-foreground break-words">{messageLoadError}</p>
      </div>
      <button
        type="button"
        onClick={retryMessageLoad}
        className="mt-1 inline-flex h-8 items-center justify-center rounded-[8px] bg-foreground px-3 text-sm font-medium text-background transition-opacity hover:opacity-90"
      >
        {t("common.retry")}
      </button>
    </div>
  ) : null

  // Build title menu content for chat sessions using shared SessionMenu
  const titleMenu = React.useMemo(() => sessionMeta ? (
    <SessionMenu
      item={sessionMeta}
      sessionStatuses={sessionStatuses ?? []}
      labels={labels ?? []}
      onLabelsChange={handleLabelsChange}
      onRename={handleRename}
      onFlag={handleFlag}
      onUnflag={handleUnflag}
      onArchive={handleArchive}
      onUnarchive={handleUnarchive}
      onMarkUnread={handleMarkUnread}
      onSessionStatusChange={handleSessionStatusChange}
      onOpenInNewWindow={handleOpenInNewWindow}
      onDelete={handleDelete}
    />
  ) : null, [
    sessionMeta,
    sessionStatuses,
    labels,
    handleLabelsChange,
    handleRename,
    handleFlag,
    handleUnflag,
    handleArchive,
    handleUnarchive,
    handleMarkUnread,
    handleSessionStatusChange,
    handleOpenInNewWindow,
    handleDelete,
  ])

  // Handle missing session - loading or deleted
  if (!session) {
    if (sessionMeta) {
      // Session exists in metadata but not loaded yet - show loading state
      const skeletonSession = {
        id: sessionMeta.id,
        workspaceId: sessionMeta.workspaceId,
        workspaceName: '',
        name: sessionMeta.name,
        preview: sessionMeta.preview,
        lastMessageAt: sessionMeta.lastMessageAt || 0,
        messages: [],
        isProcessing: sessionMeta.isProcessing || false,
        isFlagged: sessionMeta.isFlagged,
        workingDirectory: sessionMeta.workingDirectory,
        enabledSourceSlugs: sessionMeta.enabledSourceSlugs,
      }

      return (
        <>
          <div className="h-full flex flex-col">
            <PanelHeader  title={displayTitle} titleMenu={titleMenu} leadingAction={leadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
            <div className="flex-1 flex flex-col min-h-0">
              {messageLoadErrorView ?? (
                <ChatDisplay
                  ref={chatDisplayRef}
                  session={skeletonSession}
                  onSendMessage={() => {}}
                  onOpenFile={handleOpenFile}
                  onOpenUrl={handleOpenUrl}
                  currentModel={effectiveModel}
                  onModelChange={handleModelChange}
                  onConnectionChange={handleConnectionChange}
                  pendingPermission={undefined}
                  onRespondToPermission={onRespondToPermission}
                  pendingCredential={undefined}
                  onRespondToCredential={onRespondToCredential}
                  thinkingLevel={sessionOpts.thinkingLevel}
                  onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
                  permissionMode={sessionOpts.permissionMode}
                  onPermissionModeChange={setPermissionMode}
                  enabledModes={enabledModes}
                  inputValue={inputValue}
                  onInputChange={handleInputChange}
                  attachmentsValue={attachmentsValue}
                  onAttachmentsChange={handleAttachmentsChange}
                  sources={enabledSources}
                  skills={skills}
                  sessionStatuses={sessionStatuses}
                  onSessionStatusChange={handleSessionStatusChange}
                  workspaceId={activeWorkspaceId || undefined}
                  onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
                  workingDirectory={sessionMeta.workingDirectory}
                  onWorkingDirectoryChange={handleWorkingDirectoryChange}
                  messagesLoading={shouldShowForegroundMessageLoading(
                    messagesLoaded,
                    0,
                    sessionMeta.messageCount,
                    hasSessionContentHint(sessionMeta),
                  )}
                  searchQuery={sessionListSearchQuery}
                  isSearchModeActive={isSearchModeActive}
                  onMatchInfoChange={onChatMatchInfoChange}
                  connectionUnavailable={connectionUnavailable}
                  compactMode={!!isCompactMode}
                />
              )}
            </div>
          </div>
          <RenameDialog
            open={renameDialogOpen}
            onOpenChange={setRenameDialogOpen}
            title={t('chat.renameSession')}
            value={renameName}
            onValueChange={setRenameName}
            onSubmit={handleRenameSubmit}
            placeholder={t('chat.enterSessionName')}
          />
        </>
      )
    }

    // Session truly doesn't exist
    return (
      <div className="h-full flex flex-col">
        <PanelHeader  title={t('chat.session')} leadingAction={leadingAction} rightSidebarButton={rightSidebarButton} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <AlertCircle className="h-10 w-10" />
          <p className="text-sm">{t('chat.sessionNoLongerExists')}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="h-full flex flex-col">
        <PanelHeader  title={displayTitle} titleMenu={titleMenu} leadingAction={leadingAction} actions={headerActions} rightSidebarButton={rightSidebarButton} isRegeneratingTitle={isAsyncOperationOngoing} />
        <div className="flex-1 flex flex-col min-h-0">
          {messageLoadError && session.messages.length === 0 ? messageLoadErrorView : (
            <ChatDisplay
              ref={chatDisplayRef}
              session={session}
              onSendMessage={(message, attachments, skillSlugs) => {
                if (session) {
                  onSendMessage(session.id, message, attachments, skillSlugs)
                }
              }}
              onOpenFile={handleOpenFile}
              onOpenUrl={handleOpenUrl}
              currentModel={effectiveModel}
              onModelChange={handleModelChange}
              onConnectionChange={handleConnectionChange}
              pendingPermission={pendingPermission}
              onRespondToPermission={onRespondToPermission}
              pendingCredential={pendingCredential}
              onRespondToCredential={onRespondToCredential}
              thinkingLevel={sessionOpts.thinkingLevel}
              onThinkingLevelChange={(level) => setOption('thinkingLevel', level)}
              permissionMode={sessionOpts.permissionMode}
              onPermissionModeChange={setPermissionMode}
              enabledModes={enabledModes}
              inputValue={inputValue}
              onInputChange={handleInputChange}
              attachmentsValue={attachmentsValue}
              onAttachmentsChange={handleAttachmentsChange}
              sources={enabledSources}
              skills={skills}
              labels={labels}
              onLabelsChange={(newLabels) => onSessionLabelsChange?.(sessionId, newLabels)}
              sessionStatuses={sessionStatuses}
              onSessionStatusChange={handleSessionStatusChange}
              workspaceId={activeWorkspaceId || undefined}
              onSourcesChange={(slugs) => onSessionSourcesChange?.(sessionId, slugs)}
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={handleWorkingDirectoryChange}
              sessionFolderPath={session?.sessionFolderPath}
              messagesLoading={messagesLoading}
              searchQuery={sessionListSearchQuery}
              isSearchModeActive={isSearchModeActive}
              onMatchInfoChange={onChatMatchInfoChange}
              connectionUnavailable={connectionUnavailable}
              compactMode={!!isCompactMode}
            />
          )}
        </div>
      </div>
      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        title={t('chat.renameSession')}
        value={renameName}
        onValueChange={setRenameName}
        onSubmit={handleRenameSubmit}
        placeholder={t('chat.enterSessionName')}
      />
    </>
  )
})

export default ChatPage
