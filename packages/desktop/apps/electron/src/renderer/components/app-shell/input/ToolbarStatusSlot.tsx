/**
 * ToolbarStatusSlot
 *
 * Priority-based overlay slot for the input toolbar bottom row.
 * Shows contextual status indicators — escape-to-interrupt hint (highest priority),
 * browser session state, or future status types.
 *
 * Positioned absolute inset-0 over the toolbar's relative container.
 * Uses AnimatePresence for smooth fade transitions between states.
 *
 * Browser state is consumed directly from Jotai atoms (same pattern as BrowserTabStrip)
 * to avoid threading props through 4 component levels.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Globe } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { useTranslation, Trans } from 'react-i18next'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'
import { getHostname, getThemeLuminance } from '@/components/browser/utils'
import { browserInstancesAtom } from '@/atoms/browser-pane'
import type { BrowserInstanceInfo } from '../../../../shared/types'

interface ToolbarStatusSlotProps {
  /** Whether the escape interrupt overlay should be visible (highest priority) */
  showEscapeOverlay: boolean
  /** Session ID to find the bound browser instance */
  sessionId?: string
}

export function ToolbarStatusSlot({
  showEscapeOverlay,
  sessionId,
}: ToolbarStatusSlotProps) {
  const browserInstances = useAtomValue(browserInstancesAtom)

  // Find the visible browser instance bound to this session with active agent control.
  // Hidden instances are intentionally excluded so the status slot mirrors actual visibility.
  const browserInstance = React.useMemo(() => {
    if (!sessionId) return null

    const visibleCandidates = browserInstances.filter(
      i => i.boundSessionId === sessionId && i.agentControlActive && i.isVisible
    )
    if (visibleCandidates.length === 0) return null

    return visibleCandidates.at(-1) ?? null
  }, [browserInstances, sessionId])

  // Priority resolution: escape interrupt > browser status
  const showBrowser = !showEscapeOverlay && browserInstance !== null

  const handleBrowserClick = React.useCallback((instanceId: string) => {
    window.electronAPI?.browserPane?.focus?.(instanceId)
  }, [])

  return (
    <AnimatePresence>
      {showEscapeOverlay && (
        <motion.div
          key="escape"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={cn(
            "absolute inset-0 z-10",
            "rounded-b-[12px]",
            "shadow-tinted",
            "flex items-center justify-center",
            "pointer-events-auto",
          )}
          style={{
            '--shadow-color': 'var(--info-rgb)',
            backgroundColor: 'color-mix(in srgb, var(--info) 10%, var(--background))',
            color: 'color-mix(in oklab, var(--info) 30%, var(--foreground))',
          } as React.CSSProperties}
        >
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Trans
              i18nKey="toolbar.escapeToInterrupt"
              components={{ kbd: <Kbd className="text-inherit bg-current/10" /> }}
            />
          </span>
        </motion.div>
      )}

      {showBrowser && browserInstance && (
        <BrowserStatusBar
          key="browser"
          instance={browserInstance}
          onClick={() => handleBrowserClick(browserInstance.id)}
        />
      )}
    </AnimatePresence>
  )
}

/**
 * Browser status bar — shows when the agent is actively using a browser window.
 * Uses the site's theme color as background with luminance-based text contrast.
 */
function BrowserStatusBar({
  instance,
  onClick,
}: {
  instance: BrowserInstanceInfo
  onClick: () => void
}) {
  const { t } = useTranslation()
  const hostname = getHostname(instance.url)
  const themeColor = instance.themeColor
  const themeLuminance = themeColor ? getThemeLuminance(themeColor) : null
  const isDarkTheme = themeLuminance !== null && themeLuminance < 0.42

  // Compute styles based on whether we have a theme color
  const backgroundStyle = themeColor
    ? { backgroundColor: themeColor }
    : { backgroundColor: 'color-mix(in srgb, var(--accent) 15%, var(--background))' }

  const textColorClass = themeColor
    ? (isDarkTheme ? 'text-white/90' : 'text-black/80')
    : ''

  const [faviconFailed, setFaviconFailed] = React.useState(false)

  React.useEffect(() => {
    setFaviconFailed(false)
  }, [instance.favicon])

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className={cn(
        "absolute inset-0 z-10",
        "rounded-b-[12px]",
        "flex items-center justify-center gap-2",
        "pointer-events-auto cursor-pointer",
        "transition-[background-color] duration-200",
        textColorClass,
      )}
      style={{
        ...backgroundStyle,
      } as React.CSSProperties}
      onClick={onClick}
    >
      {/* Accent gradient loading line at top of banner */}
      <div className="absolute top-0 left-0 right-0 h-[2px] z-10 overflow-hidden">
        <div
          className="h-full w-full animate-shimmer-loading"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%)',
          }}
        />
      </div>

      <span className={`shrink-0 flex items-center justify-center ${isDarkTheme ? 'h-4 w-4' : 'h-3.5 w-3.5'}`}>
        {instance.isLoading ? (
          <Spinner className="text-[10px] leading-none" />
        ) : instance.favicon && !faviconFailed ? (
          isDarkTheme ? (
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-[5px] bg-white/90 p-[1px] leading-none">
              <img
                src={instance.favicon}
                alt=""
                className="h-3.5 w-3.5 aspect-square rounded-none object-cover block"
                onError={() => setFaviconFailed(true)}
              />
            </span>
          ) : (
            <img
              src={instance.favicon}
              alt=""
              className="h-3.5 w-3.5 rounded-sm block"
              onError={() => setFaviconFailed(true)}
            />
          )
        ) : (
          <Globe className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="text-sm font-medium truncate max-w-[200px]">
        {t('chat.usingConnection', { name: hostname })}
      </span>
    </motion.button>
  )
}
