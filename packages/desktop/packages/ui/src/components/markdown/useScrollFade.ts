import * as React from 'react'

const DEFAULT_FADE_SIZE = 32

/**
 * Hook for horizontal scroll containers with CSS mask fade indicators.
 * Tracks scroll position and produces a maskImage gradient that fades
 * edges when content overflows — same pattern used in Mermaid diagrams.
 */
export function useScrollFade(fadeSize = DEFAULT_FADE_SIZE) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = React.useState(false)
  const [canScrollRight, setCanScrollRight] = React.useState(false)

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = el
      setCanScrollLeft(scrollLeft > 1)
      setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)

    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])

  const maskImage = React.useMemo(() => {
    if (canScrollLeft && canScrollRight) {
      return `linear-gradient(to right, transparent, black ${fadeSize}px, black calc(100% - ${fadeSize}px), transparent)`
    }
    if (canScrollRight) {
      return `linear-gradient(to right, black calc(100% - ${fadeSize}px), transparent)`
    }
    if (canScrollLeft) {
      return `linear-gradient(to right, transparent, black ${fadeSize}px)`
    }
    return undefined
  }, [canScrollLeft, canScrollRight, fadeSize])

  return { scrollRef, maskImage, canScrollLeft, canScrollRight }
}
