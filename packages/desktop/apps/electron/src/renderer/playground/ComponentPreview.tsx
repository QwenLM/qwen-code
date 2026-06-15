import * as React from 'react'
import { cn } from '@/lib/utils'
import type { ComponentEntry } from './registry'
import { TooltipProvider } from '@craft-agent/ui'

interface ComponentPreviewProps {
  component: ComponentEntry
  props: Record<string, unknown>
}

const MIN_WIDTH = 100
const MIN_HEIGHT = 100
const DEFAULT_WIDTH = 800
const DEFAULT_HEIGHT = 600
const STORAGE_KEY = 'playground-preview-size'

function loadSavedSize(): { width: number; height: number } {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
        return {
          width: Math.max(MIN_WIDTH, parsed.width),
          height: Math.max(MIN_HEIGHT, parsed.height),
        }
      }
    }
  } catch {
    // Ignore parse errors
  }
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
}

export function ComponentPreview({ component, props }: ComponentPreviewProps) {
  const [size, setSize] = React.useState(loadSavedSize)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const isDraggingRef = React.useRef<'right' | 'bottom' | 'corner' | null>(null)
  const startPosRef = React.useRef({ x: 0, y: 0 })
  const startSizeRef = React.useRef({ width: 0, height: 0 })

  // Merge default props, mock data, and current props
  const mergedProps = React.useMemo(() => {
    const defaults: Record<string, unknown> = {}
    for (const prop of component.props) {
      defaults[prop.name] = prop.defaultValue
    }
    const mockData = component.mockData?.() ?? {}
    return { ...defaults, ...mockData, ...props }
  }, [component, props])

  // Render with optional wrapper
  const Component = component.component
  const Wrapper = component.wrapper ?? React.Fragment

  const handleMouseDown = React.useCallback((e: React.MouseEvent, direction: 'right' | 'bottom' | 'corner') => {
    e.preventDefault()
    isDraggingRef.current = direction
    startPosRef.current = { x: e.clientX, y: e.clientY }
    startSizeRef.current = { ...size }
  }, [size])

  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return

      const deltaX = e.clientX - startPosRef.current.x
      const deltaY = e.clientY - startPosRef.current.y

      setSize(prev => {
        let newWidth = prev.width
        let newHeight = prev.height

        if (isDraggingRef.current === 'right' || isDraggingRef.current === 'corner') {
          newWidth = Math.max(MIN_WIDTH, startSizeRef.current.width + deltaX)
        }
        if (isDraggingRef.current === 'bottom' || isDraggingRef.current === 'corner') {
          newHeight = Math.max(MIN_HEIGHT, startSizeRef.current.height + deltaY)
        }

        return { width: newWidth, height: newHeight }
      })
    }

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        // Save size to localStorage when drag ends
        setSize(currentSize => {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSize))
          return currentSize
        })
      }
      isDraggingRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  const previewOverflowClass = component.previewOverflow
    ? (component.previewOverflow === 'visible' ? 'overflow-visible' : component.previewOverflow === 'hidden' ? 'overflow-hidden' : 'overflow-auto')
    : (component.layout === 'full' ? 'overflow-hidden' : 'overflow-auto')

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-border px-4 pt-3 pb-3">
        <h2 className="text-lg font-semibold text-foreground font-sans">
          {component.name}
        </h2>
        <div className="mt-1 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          <p>{component.description}</p>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono">
              {Math.round(size.width)} × {Math.round(size.height)}
            </span>
            <button
              onClick={() => {
                setSize({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
                localStorage.removeItem(STORAGE_KEY)
              }}
              className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
            >
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* Preview area */}
      <div
        className={cn(
          'flex-1 overflow-auto p-4 flex',
          component.layout === 'top' ? 'items-start justify-center' : 'items-center justify-center'
        )}
      >
        {/* Resizable container */}
        <div
          ref={containerRef}
          className="relative"
          style={{ width: size.width, height: size.height }}
        >
          {/* Component preview box */}
          <div
            className={cn(
              'w-full h-full rounded-lg border border-border',
              previewOverflowClass,
              component.layout === 'centered' || !component.layout ? 'flex items-center justify-center' : '',
              'bg-background'
            )}
          >
            <TooltipProvider>
              <Wrapper>
                <Component {...mergedProps} />
              </Wrapper>
            </TooltipProvider>
          </div>

          {/* Right resize handle */}
          <div
            onMouseDown={(e) => handleMouseDown(e, 'right')}
            className="absolute top-0 -right-1 w-2 h-full cursor-ew-resize hover:bg-foreground/20 active:bg-foreground/30 transition-colors"
          />

          {/* Bottom resize handle */}
          <div
            onMouseDown={(e) => handleMouseDown(e, 'bottom')}
            className="absolute -bottom-1 left-0 h-2 w-full cursor-ns-resize hover:bg-foreground/20 active:bg-foreground/30 transition-colors"
          />

          {/* Corner resize handle */}
          <div
            onMouseDown={(e) => handleMouseDown(e, 'corner')}
            className="absolute -bottom-1 -right-1 w-3 h-3 cursor-nwse-resize hover:bg-foreground/30 active:bg-foreground/40 transition-colors rounded-br"
          />
        </div>
      </div>
    </div>
  )
}
