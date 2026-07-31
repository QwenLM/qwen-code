/**
 * FilePreviewPanel - Resizable, docked side panel that hosts the in-app file preview.
 *
 * Replaces the previous fullscreen file overlay: instead of taking over the whole window,
 * a clicked file opens in this panel on the right while the conversation / file tree stays
 * visible and interactive next to it (VS Code / Cursor style split layout).
 *
 * The panel width is user-adjustable via a drag handle on its left edge and is persisted
 * to localStorage so it survives reloads. The preview content itself (rendered as children)
 * uses each overlay's `embedded` mode to fill this panel.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import * as storage from '@/lib/local-storage'

const MIN_WIDTH = 320
const MAX_WIDTH = 900
const DEFAULT_WIDTH = 460

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}

export function FilePreviewPanel({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = React.useState(() =>
    clampWidth(storage.get(storage.KEYS.filePreviewWidth, DEFAULT_WIDTH)),
  )
  const [isResizing, setIsResizing] = React.useState(false)

  // Persist width changes (debounced via the natural render cadence is fine here).
  React.useEffect(() => {
    storage.set(storage.KEYS.filePreviewWidth, width)
  }, [width])

  const handleResizeStart = React.useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = width
      setIsResizing(true)

      const handleMove = (moveEvent: MouseEvent) => {
        // The handle sits on the LEFT edge of the panel, so dragging left widens it.
        const delta = startX - moveEvent.clientX
        setWidth(clampWidth(startWidth + delta))
      }

      const handleUp = () => {
        setIsResizing(false)
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [width],
  )

  return (
    <div
      className="relative h-full shrink-0 flex flex-col"
      style={{ width }}
      data-testid="file-preview-panel"
    >
      {/* Drag handle on the left edge — a thin line that thickens/tints on hover or while dragging. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file preview"
        onMouseDown={handleResizeStart}
        className="group absolute left-0 top-0 bottom-0 z-20 w-2 -translate-x-1/2 cursor-col-resize"
      >
        <div
          className={cn(
            'mx-auto h-full w-px transition-colors',
            isResizing ? 'bg-accent' : 'bg-border group-hover:bg-accent/70',
          )}
        />
      </div>

      {/* Preview content fills the panel. min-h-0 lets inner scroll containers work. */}
      <div className="flex-1 min-h-0 h-full pl-px">{children}</div>
    </div>
  )
}
