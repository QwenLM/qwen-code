/**
 * Qwen Code Session Viewer
 *
 * A minimal web app for viewing Qwen Code session transcripts.
 * Users can upload session JSON files or view shared sessions via URL.
 *
 * Routes:
 * - / - Upload interface
 * - /s/{id} - View shared session
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import type { StoredSession } from '@craft-agent/core'
import {
  SessionViewer,
  GenericOverlay,
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  JSONPreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  TooltipProvider,
  extractOverlayData,
  detectLanguage,
  openExternalUrl,
  type PlatformActions,
  type ActivityItem,
  type OverlayData,
  type FileChange,
} from '@craft-agent/ui'
import { SessionUpload } from './components/SessionUpload'
import { Header } from './components/Header'

/** Default session ID for development */
const DEV_SESSION_ID = 'tz5-13I84pwK_he'

/** Extract session ID from URL path /s/{id} */
function getSessionIdFromUrl(): string | null {
  const path = window.location.pathname
  const match = path.match(/^\/s\/([a-zA-Z0-9_-]+)$/)
  if (match) return match[1]

  // In development, redirect root to default session
  if (import.meta.env.DEV && path === '/') {
    window.history.replaceState({}, '', `/s/${DEV_SESSION_ID}`)
    return DEV_SESSION_ID
  }

  return null
}

export function App() {
  const { t } = useTranslation()
  const [session, setSession] = useState<StoredSession | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(() => getSessionIdFromUrl())
  const [isDark, setIsDark] = useState(() => {
    // Check system preference on mount
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  // Fetch session from API when we have a session ID
  useEffect(() => {
    if (!sessionId) return

    const fetchSession = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const response = await fetch(`/s/api/${sessionId}`)
        if (!response.ok) {
          if (response.status === 404) {
            setError(t('errors.sessionNotFound'))
          } else {
            setError(t('errors.failedToLoadSession'))
          }
          return
        }

        const data = await response.json()
        setSession(data)
      } catch (err) {
        console.error('Failed to fetch session:', err)
        setError(t('errors.failedToLoadSession'))
      } finally {
        setIsLoading(false)
      }
    }

    fetchSession()
  }, [sessionId])

  // Handle browser navigation
  useEffect(() => {
    const handlePopState = () => {
      const newId = getSessionIdFromUrl()
      setSessionId(newId)
      if (!newId) {
        setSession(null)
        setError(null)
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  // Apply dark mode class to html element
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  }, [])

  const handleSessionLoad = useCallback((loadedSession: StoredSession) => {
    setSession(loadedSession)
  }, [])

  const handleClear = useCallback(() => {
    setSession(null)
    setSessionId(null)
    setError(null)
    // Update URL to root
    window.history.pushState({}, '', '/')
  }, [])

  const toggleTheme = useCallback(() => {
    setIsDark(prev => !prev)
  }, [])

  // State for overlay
  const [overlayActivity, setOverlayActivity] = useState<ActivityItem | null>(null)
  // State for multi-diff overlay (Edit/Write activities shown as diffs)
  const [multiDiffState, setMultiDiffState] = useState<{ changes: FileChange[] } | null>(null)

  // Handle activity click - Edit/Write opens multi-diff, others use extractOverlayData
  const handleActivityClick = useCallback((activity: ActivityItem) => {
    if (activity.toolName === 'Edit' || activity.toolName === 'Write') {
      const input = activity.toolInput as Record<string, unknown> | undefined
      // Canonical fields are primary; structured edit fields are additive fallbacks.
      const filePath = (input?.file_path as string) || (input?.path as string) || 'unknown'
      const change: FileChange = {
        id: activity.id,
        filePath,
        toolType: activity.toolName,
        original: activity.toolName === 'Edit'
          ? ((input?.old_string as string) || (input?.oldText as string) || '')
          : '',
        modified: activity.toolName === 'Edit'
          ? ((input?.new_string as string) || (input?.newText as string) || '')
          : ((input?.content as string) || ''),
        error: activity.error || undefined,
      }
      setMultiDiffState({ changes: [change] })
    } else {
      setOverlayActivity(activity)
    }
  }, [])

  const handleCloseOverlay = useCallback(() => {
    setOverlayActivity(null)
    setMultiDiffState(null)
  }, [])

  // Extract overlay data using shared parser (non-Edit/Write tools only)
  const overlayData: OverlayData | null = useMemo(() => {
    if (!overlayActivity) return null
    return extractOverlayData(overlayActivity)
  }, [overlayActivity])

  // Platform actions for the viewer (limited functionality)
  const platformActions: PlatformActions = {
    onOpenUrl: (url) => {
      const result = openExternalUrl(url)
      if (!result.opened) {
        const detail = result.reason === 'dangerous' ? result.detail : result.reason
        console.warn('[viewer:onOpenUrl] blocked URL:', detail, url)
      }
    },
    onCopyToClipboard: async (text) => {
      await navigator.clipboard.writeText(text)
    },
  }

  const theme = isDark ? 'dark' : 'light'

  return (
    <TooltipProvider>
    <div className="h-full flex flex-col bg-foreground-2 text-foreground">
      <Header
        hasSession={!!session}
        sessionTitle={session?.name}
        isDark={isDark}
        onToggleTheme={toggleTheme}
        onClear={handleClear}
      />

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center text-muted-foreground">
            <div className="animate-pulse">Loading session...</div>
          </div>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <div className="text-destructive mb-4">{error}</div>
            <button
              onClick={handleClear}
              className="px-4 py-2 rounded-md bg-background text-foreground shadow-sm border border-border hover:bg-foreground/5 transition-colors"
            >
              Go back
            </button>
          </div>
        </div>
      ) : session ? (
        <SessionViewer
          session={session}
          mode="readonly"
          platformActions={platformActions}
          defaultExpanded={false}
          className="flex-1 min-h-0"
          onActivityClick={handleActivityClick}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center p-8">
          <SessionUpload onSessionLoad={handleSessionLoad} />
        </div>
      )}

      {/* Code preview overlay for Read/Write tools */}
      {overlayData?.type === 'code' && (
        <CodePreviewOverlay
          isOpen={!!overlayActivity}
          onClose={handleCloseOverlay}
          content={overlayData.content}
          filePath={overlayData.filePath}
          mode={overlayData.mode}
          startLine={overlayData.startLine}
          totalLines={overlayData.totalLines}
          numLines={overlayData.numLines}
          theme={theme}
          error={overlayData.error}
          command={overlayData.command}
        />
      )}

      {/* Multi-diff preview overlay for Edit/Write tools */}
      {multiDiffState && (
        <MultiDiffPreviewOverlay
          isOpen={true}
          onClose={handleCloseOverlay}
          changes={multiDiffState.changes}
          consolidated={false}
          theme={theme}
        />
      )}

      {/* Terminal preview overlay for Bash/Grep/Glob tools */}
      {overlayData?.type === 'terminal' && (
        <TerminalPreviewOverlay
          isOpen={!!overlayActivity}
          onClose={handleCloseOverlay}
          command={overlayData.command}
          output={overlayData.output}
          exitCode={overlayData.exitCode}
          toolType={overlayData.toolType}
          description={overlayData.description}
          theme={theme}
        />
      )}

      {/* JSON preview overlay for tools returning JSON data */}
      {overlayData?.type === 'json' && (
        <JSONPreviewOverlay
          isOpen={!!overlayActivity}
          onClose={handleCloseOverlay}
          data={overlayData.data}
          title={overlayData.title}
          theme={theme}
          error={overlayData.error}
        />
      )}

      {/* Document overlay for formatted markdown content (Write tool on .md/.txt, WebSearch results) */}
      {overlayData?.type === 'document' && (
        <DocumentFormattedMarkdownOverlay
          isOpen={!!overlayActivity}
          onClose={handleCloseOverlay}
          content={overlayData.content}
          filePath={overlayData.filePath}
          typeBadge={{ icon: FileText, label: overlayData.toolName, variant: 'default' }}
          onOpenUrl={platformActions.onOpenUrl}
          error={overlayData.error}
        />
      )}

      {/* Generic overlay for unknown tools - route markdown to fullscreen viewer */}
      {overlayData?.type === 'generic' && (
        detectLanguage(overlayData.content) === 'markdown' ? (
          <DocumentFormattedMarkdownOverlay
            isOpen={!!overlayActivity}
            onClose={handleCloseOverlay}
            content={overlayData.content}
            onOpenUrl={platformActions.onOpenUrl}
            error={overlayData.error}
          />
        ) : (
          <GenericOverlay
            isOpen={!!overlayActivity}
            onClose={handleCloseOverlay}
            content={overlayData.content}
            title={overlayData.title}
            theme={theme}
          />
        )
      )}
    </div>
    </TooltipProvider>
  )
}
