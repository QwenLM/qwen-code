import { useRef, useCallback } from 'react'

/**
 * useDynamicStack — Realtime dynamic stacking with equal visible strips.
 *
 * Returns a callback ref that, when attached to a flex container, computes
 * per-badge marginLeft values via ResizeObserver. Two phases:
 *
 * 1. TRANSITION (gaps shrinking): uniform margins for even spacing.
 *    As container shrinks, all gaps decrease equally from `gap` toward 0.
 *    Used when V >= min(non-last badge widths) — prevents uneven positive
 *    margins that would appear with the per-badge formula.
 *
 * 2. STACKING (equal visible strips): per-badge margins so each badge
 *    exposes exactly V pixels regardless of natural width. Wider badges
 *    get more negative margins. All margins ≤ 0 in this phase.
 *    Used when V < min(non-last badge widths).
 *
 * A smooth blend over a short range at the crossover prevents discontinuity.
 *
 * Key design decisions:
 * - Callback ref: observer attaches immediately on mount, before first paint
 * - No rAF: ResizeObserver fires between layout and paint (same-frame updates)
 * - Direct child style manipulation (no CSS variables, no React re-renders)
 * - MutationObserver: recomputes when children are added/removed
 *
 * @param options.gap - Gap between badges when space allows (default: 8)
 * @param options.minVisible - Minimum visible strip per badge in px (default: 20)
 * @param options.reservedStart - Optional visual reserve applied only in stacking
 *   math (capped to one gap) to keep fade behavior stable (default: 0)
 */
export function useDynamicStack(options?: { gap?: number; minVisible?: number; reservedStart?: number }) {
  const { gap = 8, minVisible = 20, reservedStart = 0 } = options ?? {}
  const observerRef = useRef<ResizeObserver | null>(null)
  const mutationRef = useRef<MutationObserver | null>(null)

  // Callback ref — fires synchronously during React commit phase on mount/unmount.
  const callbackRef = useCallback((el: HTMLDivElement | null) => {
    // Cleanup previous observers
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    if (mutationRef.current) {
      mutationRef.current.disconnect()
      mutationRef.current = null
    }

    if (!el) return

    const compute = () => {
      const children = el.children
      const childCount = children.length
      if (childCount === 0) return

      if (childCount === 1) {
        const child = children[0] as HTMLElement
        child.style.marginLeft = '0px'
        child.style.maskImage = 'none'
        child.style.webkitMaskImage = 'none'
        return
      }

      // Measure each child's natural width (offsetWidth excludes margins)
      const widths: number[] = []
      for (let i = 0; i < childCount; i++) {
        widths.push((children[i] as HTMLElement).offsetWidth)
      }

      const totalWidth = widths.reduce((sum, w) => sum + w, 0)
      const availableWidth = el.clientWidth

      // Phase 0: Enough real space — uniform gap, no stacking needed.
      // Use the actual measured width here so stacking doesn't start prematurely
      // when visual-reserve tuning is configured.
      const totalWithGaps = totalWidth + (childCount - 1) * gap
      if (totalWithGaps <= availableWidth) {
        for (let i = 0; i < childCount; i++) {
          const child = children[i] as HTMLElement
          child.style.marginLeft = i === 0 ? '0px' : `${gap}px`
          // No overlap in Phase 0 — clear any previously applied masks
          child.style.maskImage = 'none'
          child.style.webkitMaskImage = 'none'
        }
        return
      }

      // Optional tiny reserve for stacking phase only (capped to one gap).
      // This keeps visual fade behavior stable without forcing premature overlap.
      const stackingWidth = Math.max(0, availableWidth - Math.min(reservedStart, gap))

      // Target visible strip V (for the equal-strip formula)
      const V = Math.max(minVisible, (stackingWidth - widths[childCount - 1]) / (childCount - 1))

      // Narrowest non-last badge — the crossover threshold.
      // When V < this, all per-badge margins are ≤ 0 (no uneven positive gaps).
      const nonLastWidths = widths.slice(0, -1)
      const minNonLastWidth = Math.min(...nonLastWidths)

      // Uniform margin: distributes the total deficit evenly across all gaps.
      // Gives visually even spacing regardless of individual badge widths.
      const uniformMargin = Math.min(gap, (stackingWidth - totalWidth) / (childCount - 1))

      if (V >= minNonLastWidth) {
        // Phase 1: TRANSITION — V is larger than some badge widths.
        // Per-badge formula would give positive margins for narrow badges (uneven).
        // Use uniform margin for consistent even spacing.
        for (let i = 0; i < childCount; i++) {
          ;(children[i] as HTMLElement).style.marginLeft = i === 0 ? '0px' : `${uniformMargin}px`
        }
      } else {
        // Phase 2: STACKING — V < all non-last badge widths.
        // Per-badge margins are all ≤ 0, giving equal visible strips.
        // Blend from uniform toward per-badge for smooth crossover.
        // t=0 at crossover (V = minNonLastWidth), t=1 when deeply stacked.
        const blendRange = minNonLastWidth * 0.5
        const t = Math.min(1, (minNonLastWidth - V) / blendRange)

        for (let i = 0; i < childCount; i++) {
          if (i === 0) {
            ;(children[i] as HTMLElement).style.marginLeft = '0px'
          } else {
            // Lerp: uniform (even gaps) → per-badge (equal visible strips)
            const perBadge = V - widths[i - 1]
            const blended = uniformMargin * (1 - t) + perBadge * t
            ;(children[i] as HTMLElement).style.marginLeft = `${blended}px`
          }
        }
      }

      // Mask + z-index pass: fade out the right edge of each non-last badge,
      // and stack later badges on top so their opaque backgrounds cover the
      // clipped shadow areas of earlier badges.
      for (let i = 0; i < childCount; i++) {
        const child = children[i] as HTMLElement
        // Ascending z-index: later badges paint on top, covering earlier badges'
        // clipped shadows in the overlap zone
        child.style.position = 'relative'
        child.style.zIndex = `${i}`
        if (i === childCount - 1) {
          // Last badge sits on top — fully visible, no mask needed
          child.style.maskImage = 'none'
          child.style.webkitMaskImage = 'none'
        } else {
          // Check proximity to the next badge and apply gradual fade.
          // Fade begins when the gap shrinks below 4px (before actual overlap),
          // ramping transparency from 0→66% over 36px of proximity/overlap.
          const nextMargin = parseFloat((children[i + 1] as HTMLElement).style.marginLeft || '0')
          const fadeStart = 4 // start fading when gap is this small
          if (nextMargin < fadeStart) {
            const proximity = fadeStart - nextMargin // 0 at threshold, grows as badges get closer/overlap
            const fadeZone = 36
            const t = Math.min(1, proximity / 36)
            const endAlpha = 1 - t * 0.66 // max fade capped at 66% transparency
            // Position gradient ahead of the overlap zone, shifted 24px right.
            // gradientEnd = right edge of the fade; gradientStart = left edge (clamped to 12px from badge left).
            const actualOverlap = Math.max(0, -nextMargin)
            const gradientEnd = Math.max(0, actualOverlap - 24) // shifted 24px right
            const gradientStart = Math.min(widths[i] - 12, gradientEnd + fadeZone) // left edge never past 12px from left
            const mask = `linear-gradient(to right, black calc(100% - ${gradientStart}px), rgba(0,0,0,${endAlpha}) calc(100% - ${gradientEnd}px), rgba(0,0,0,${endAlpha}) 100%)`
            child.style.maskImage = mask
            child.style.webkitMaskImage = mask
          } else {
            // Enough space — clear mask
            child.style.maskImage = 'none'
            child.style.webkitMaskImage = 'none'
          }
        }
      }
    }

    // Compute immediately on mount (before first paint)
    compute()

    // ResizeObserver: fires between layout and paint — zero frame delay
    observerRef.current = new ResizeObserver(compute)
    observerRef.current.observe(el)

    // MutationObserver: recompute when badges are added/removed
    mutationRef.current = new MutationObserver(compute)
    mutationRef.current.observe(el, { childList: true })
  }, [gap, minVisible, reservedStart])

  return callbackRef
}
