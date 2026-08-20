import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { Spinner } from '@craft-agent/ui'
import { fullscreenOverlayOpenAtom } from '@/atoms/overlay'
import {
  activeBrowserInstanceIdAtom,
  browserInstancesAtom,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import { cn } from '@/lib/utils'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { RADIUS_EDGE } from './panel-constants'
import type { BrowserInstanceInfo } from '../../../shared/types'

const DOCK_WIDTH = 'clamp(640px, 48vw, 960px)'
const DOCK_HEADER_HEIGHT = 48
const DOCK_NATIVE_LEFT_INSET = 4

type BrowserDockAction = 'expand' | 'close'

interface BrowserDockPanelProps {
  expandedLeft: number
  autoHideKey?: string | null
  isCompact?: boolean
}

export function BrowserDockPanel({
  expandedLeft,
  autoHideKey = null,
  isCompact = false,
}: BrowserDockPanelProps) {
  const browserInstances = useAtomValue(browserInstancesAtom)
  const setBrowserInstances = useSetAtom(setBrowserInstancesAtom)
  const updateBrowserInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeBrowserInstance = useSetAtom(removeBrowserInstanceAtom)
  const setActiveBrowserInstanceId = useSetAtom(activeBrowserInstanceIdAtom)
  const [hoveredAction, setHoveredAction] = React.useState<BrowserDockAction | null>(null)
  const fullscreenOverlayOpen = useAtomValue(fullscreenOverlayOpenAtom)
  const dockedInstance = React.useMemo(() => {
    return browserInstances.find(
      (instance) => instance.presentation === 'docked' && instance.isVisible,
    ) ?? null
  }, [browserInstances])
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const lastBoundsKeyRef = React.useRef<string | null>(null)
  const lastBoundsInstanceIdRef = React.useRef<string | null>(null)
  const autoHideKeyRef = React.useRef<string | null>(autoHideKey)

  const expanded = isCompact || !!dockedInstance?.dockExpanded

  const handleToggleExpanded = React.useCallback(() => {
    if (!dockedInstance) return

    void window.electronAPI?.browserPane
      ?.toggleDockExpanded(dockedInstance.id)
      .catch((error) => {
        console.warn('[BrowserDockPanel] Failed to toggle browser dock:', error)
      })
  }, [dockedInstance])

  const handleClose = React.useCallback(() => {
    if (!dockedInstance) return

    void window.electronAPI?.browserPane
      ?.hide(dockedInstance.id)
      .catch((error) => {
        console.warn('[BrowserDockPanel] Failed to close browser dock:', error)
      })
  }, [dockedInstance])

  React.useEffect(() => {
    const previousKey = autoHideKeyRef.current
    autoHideKeyRef.current = autoHideKey
    if (previousKey === autoHideKey || !dockedInstance?.isVisible) return

    void window.electronAPI?.browserPane
      ?.hide(dockedInstance.id)
      .catch((error) => {
        console.warn('[BrowserDockPanel] Failed to auto-hide browser dock:', error)
      })
  }, [autoHideKey, dockedInstance?.id, dockedInstance?.isVisible])

  React.useEffect(() => {
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi || !window.electronAPI.isChannelAvailable('browser-pane:list')) {
      setBrowserInstances([])
      setActiveBrowserInstanceId(null)
      return
    }

    let cancelled = false

    void browserPaneApi.list()
      .then((items) => {
        if (cancelled) return
        setBrowserInstances(items)
        setActiveBrowserInstanceId((prev) => {
          if (prev && items.some((item) => item.id === prev)) return prev
          return items[0]?.id ?? null
        })
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('[BrowserDockPanel] Failed to list browser panes:', error)
        setBrowserInstances([])
        setActiveBrowserInstanceId(null)
      })

    const cleanupState = browserPaneApi.onStateChanged((info: BrowserInstanceInfo) => {
      updateBrowserInstance(info)
      setActiveBrowserInstanceId((prev) => prev ?? info.id)
    })

    const cleanupRemoved = browserPaneApi.onRemoved((id: string) => {
      removeBrowserInstance(id)
      setActiveBrowserInstanceId((prev) => (prev === id ? null : prev))
    })

    const cleanupInteracted = browserPaneApi.onInteracted((id: string) => {
      setActiveBrowserInstanceId(id)
    })

    return () => {
      cancelled = true
      cleanupState()
      cleanupRemoved()
      cleanupInteracted()
    }
  }, [
    removeBrowserInstance,
    setActiveBrowserInstanceId,
    setBrowserInstances,
    updateBrowserInstance,
  ])

  React.useLayoutEffect(() => {
    if (!dockedInstance) {
      lastBoundsKeyRef.current = null
      lastBoundsInstanceIdRef.current = null
      return
    }

    if (lastBoundsInstanceIdRef.current !== dockedInstance.id) {
      lastBoundsKeyRef.current = null
      lastBoundsInstanceIdRef.current = dockedInstance.id
    }

    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi?.dock) return

    if (fullscreenOverlayOpen) {
      const suspendedBoundsKey = 'suspended'
      if (lastBoundsKeyRef.current === suspendedBoundsKey) return
      lastBoundsKeyRef.current = suspendedBoundsKey

      void browserPaneApi.dock(dockedInstance.id, {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }).catch((error) => {
        console.warn('[BrowserDockPanel] Failed to suspend browser dock:', error)
      })
      return
    }

    const syncBounds = () => {
      const rect = viewportRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return

      const left = Math.ceil(rect.left) + DOCK_NATIVE_LEFT_INSET
      const top = Math.ceil(rect.top)
      const right = Math.floor(rect.right)
      const bottom = Math.floor(rect.bottom)
      const width = Math.max(0, right - left)
      const height = Math.max(0, bottom - top)
      if (width <= 0 || height <= 0) return

      const bounds = {
        x: left,
        y: top,
        width,
        height,
      }
      const boundsKey = [
        Math.round(bounds.x),
        Math.round(bounds.y),
        Math.round(bounds.width),
        Math.round(bounds.height),
      ].join(':')

      if (lastBoundsKeyRef.current === boundsKey) return
      lastBoundsKeyRef.current = boundsKey

      void browserPaneApi.dock(dockedInstance.id, bounds).catch((error) => {
        console.warn('[BrowserDockPanel] Failed to sync browser dock bounds:', error)
      })
    }

    const frame = requestAnimationFrame(syncBounds)
    const observer = new ResizeObserver(syncBounds)
    if (viewportRef.current) {
      observer.observe(viewportRef.current)
    }
    window.addEventListener('resize', syncBounds)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [dockedInstance, expanded, fullscreenOverlayOpen])

  if (!dockedInstance || fullscreenOverlayOpen) return null

  const expandLabel = expanded ? 'Restore panel width' : 'Expand panel'
  const tooltipLabel =
    hoveredAction === 'expand'
      ? expandLabel
      : hoveredAction === 'close'
        ? 'Close side panel'
        : null

  return (
    <div
      ref={panelRef}
      className={cn(
        'shrink-0 overflow-hidden bg-background shadow-middle',
        'border-l border-foreground/10',
        expanded ? 'absolute z-fullscreen' : 'relative z-panel',
      )}
      style={
        expanded
          ? {
              top: 0,
              bottom: 0,
              left: Math.max(0, expandedLeft),
              right: 0,
              borderBottomRightRadius: RADIUS_EDGE,
            }
          : {
              width: DOCK_WIDTH,
              borderBottomRightRadius: RADIUS_EDGE,
            }
      }
    >
      <div
        className={cn(
          'relative flex items-center justify-between gap-2 px-3',
          'border-b border-foreground/10 bg-background/95',
        )}
        style={{ height: DOCK_HEADER_HEIGHT }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              'flex h-3.5 w-3.5 shrink-0 items-center justify-center',
              'transition-opacity duration-150',
              dockedInstance.isLoading ? 'opacity-100' : 'opacity-0',
            )}
            aria-hidden={!dockedInstance.isLoading}
          >
            <Spinner className="text-[10px] text-foreground/60" />
          </span>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/80">
            {dockedInstance.title || 'Browser'}
          </div>
        </div>
        <div className="relative flex shrink-0 items-center gap-1">
          {tooltipLabel && (
            <div className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-[6px] bg-popover px-2 py-1 text-xs text-popover-foreground shadow-modal-small">
              {tooltipLabel}
            </div>
          )}
          <HeaderIconButton
            icon={
              expanded ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )
            }
            aria-label={expandLabel}
            onMouseEnter={() => setHoveredAction('expand')}
            onMouseLeave={() => setHoveredAction(null)}
            onFocus={() => setHoveredAction('expand')}
            onBlur={() => setHoveredAction(null)}
            onClick={handleToggleExpanded}
          />
          <HeaderIconButton
            icon={<X className="h-3.5 w-3.5" />}
            aria-label="Close side panel"
            onMouseEnter={() => setHoveredAction('close')}
            onMouseLeave={() => setHoveredAction(null)}
            onFocus={() => setHoveredAction('close')}
            onBlur={() => setHoveredAction(null)}
            onClick={handleClose}
          />
        </div>
        {dockedInstance.isLoading && (
          <div
            className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden"
            role="progressbar"
            aria-label="Loading page"
          >
            <div
              className="h-full w-full animate-shimmer-loading"
              style={{
                background:
                  'linear-gradient(90deg, transparent 0%, var(--accent) 50%, transparent 100%)',
              }}
            />
          </div>
        )}
      </div>
      <div
        ref={viewportRef}
        className="absolute inset-x-0 bottom-0 overflow-hidden"
        style={{
          top: DOCK_HEADER_HEIGHT,
          borderBottomRightRadius: RADIUS_EDGE,
        }}
      />
    </div>
  )
}
