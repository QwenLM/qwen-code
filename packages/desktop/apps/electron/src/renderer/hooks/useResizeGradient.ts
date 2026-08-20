import * as React from "react"

const RESIZE_GRADIENT_EDGE_BUFFER_PX = 64

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Creates the gradient style for the resize indicator.
 *
 * Behavior:
 * - Fade always resolves to transparent at the very top/bottom edges.
 * - Gradient center follows cursor Y, but is clamped to stay at least
 *   RESIZE_GRADIENT_EDGE_BUFFER_PX from either edge (when height allows).
 */
export function getResizeGradientStyle(
  mouseY: number | null,
  handleHeight: number | null,
): React.CSSProperties {
  if (mouseY === null || !handleHeight || handleHeight <= 0) {
    return {
      transition: 'opacity 150ms ease-out',
      opacity: 0,
      background: 'none',
    }
  }

  const height = handleHeight
  const edgeBuffer = Math.min(RESIZE_GRADIENT_EDGE_BUFFER_PX, Math.max(0, Math.floor(height / 2)))
  const centerY = clamp(mouseY, edgeBuffer, height - edgeBuffer)

  const nearCenterDelta = Math.max(20, Math.round(edgeBuffer * 0.22))
  const farCenterDelta = Math.max(56, Math.round(edgeBuffer * 0.75))

  const stopTopNear = clamp(centerY - nearCenterDelta, 0, height)
  const stopTopFar = clamp(centerY - farCenterDelta, 0, height)
  const stopBottomNear = clamp(centerY + nearCenterDelta, 0, height)
  const stopBottomFar = clamp(centerY + farCenterDelta, 0, height)

  return {
    transition: 'opacity 150ms ease-out',
    opacity: 1,
    background: `linear-gradient(
      to bottom,
      transparent 0px,
      color-mix(in oklch, var(--foreground) 10%, transparent) ${stopTopFar}px,
      color-mix(in oklch, var(--foreground) 18%, transparent) ${stopTopNear}px,
      color-mix(in oklch, var(--foreground) 36%, transparent) ${centerY}px,
      color-mix(in oklch, var(--foreground) 18%, transparent) ${stopBottomNear}px,
      color-mix(in oklch, var(--foreground) 10%, transparent) ${stopBottomFar}px,
      transparent ${height}px
    )`,
  }
}

/**
 * useResizeGradient - Hook for resize handle gradient that follows cursor
 *
 * Returns:
 * - ref: Attach to the touch area element
 * - mouseY: Current Y position (null when not hovering)
 * - handlers: onMouseMove, onMouseLeave, onMouseDown for the touch area
 * - gradientStyle: CSS style object for the visual indicator
 */
export function useResizeGradient() {
  const [mouseY, setMouseY] = React.useState<number | null>(null)
  const [isDragging, setIsDragging] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  const onMouseMove = React.useCallback((e: React.MouseEvent) => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setMouseY(e.clientY - rect.top)
    }
  }, [])

  const onMouseLeave = React.useCallback(() => {
    if (!isDragging) {
      setMouseY(null)
    }
  }, [isDragging])

  const onMouseDown = React.useCallback(() => {
    setIsDragging(true)
  }, [])

  // Track mouse position during drag and cleanup on mouseup
  React.useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (ref.current) {
        const rect = ref.current.getBoundingClientRect()
        setMouseY(e.clientY - rect.top)
      }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      setMouseY(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  return {
    ref,
    mouseY,
    isDragging,
    handlers: { onMouseMove, onMouseLeave, onMouseDown },
    gradientStyle: getResizeGradientStyle(mouseY, ref.current?.clientHeight ?? null),
  }
}
