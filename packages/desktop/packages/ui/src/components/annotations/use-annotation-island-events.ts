import * as React from 'react'
import {
  resolveIslandOutsideDismissAction,
  type IslandOutsideDismissBehavior,
} from './island-dismiss-policy'

export const ISLAND_BLOCKER_SELECTOR = '[data-ca-island-blocker="true"]'

export function isIslandBlockerTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false

  const maybeElement = target as {
    closest?: (selector: string) => Element | null
    parentElement?: {
      closest?: (selector: string) => Element | null
    } | null
  }

  if (typeof maybeElement.closest === 'function') {
    return Boolean(maybeElement.closest(ISLAND_BLOCKER_SELECTOR))
  }

  if (maybeElement.parentElement && typeof maybeElement.parentElement.closest === 'function') {
    return Boolean(maybeElement.parentElement.closest(ISLAND_BLOCKER_SELECTOR))
  }

  return false
}

export interface UseAnnotationIslandEventsOptions {
  enabled: boolean
  openedAtRef: React.MutableRefObject<number>
  isCompactView: boolean
  isTargetInsideAnnotationIsland: (target: Node | null) => boolean
  onClose: () => void
  onBack?: () => boolean
  outsideClickBehavior?: IslandOutsideDismissBehavior
  scrollGraceMs?: number
}

export function useAnnotationIslandEvents({
  enabled,
  openedAtRef,
  isCompactView,
  isTargetInsideAnnotationIsland,
  onClose,
  onBack,
  outsideClickBehavior = 'back-or-close',
  scrollGraceMs = 180,
}: UseAnnotationIslandEventsOptions): void {
  React.useEffect(() => {
    if (!enabled) return

    const dismissOutside = () => {
      const action = resolveIslandOutsideDismissAction({
        isCompactView,
        behavior: outsideClickBehavior,
      })

      if (action === 'back' && onBack?.()) {
        return
      }

      onClose()
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (isIslandBlockerTarget(event.target)) return

      const target = event.target as Node | null
      if (!target) return
      if (isTargetInsideAnnotationIsland(target)) return
      dismissOutside()
    }

    const handleScroll = (event: Event) => {
      if (Date.now() - openedAtRef.current < scrollGraceMs) {
        return
      }

      if (!isCompactView) {
        return
      }

      if (isIslandBlockerTarget(event.target)) {
        return
      }

      const target = event.target as Node | null
      if (target && isTargetInsideAnnotationIsland(target)) {
        return
      }

      dismissOutside()
    }

    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('scroll', handleScroll, true)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [
    enabled,
    openedAtRef,
    isCompactView,
    isTargetInsideAnnotationIsland,
    onClose,
    onBack,
    outsideClickBehavior,
    scrollGraceMs,
  ])
}
