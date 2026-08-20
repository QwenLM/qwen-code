import * as React from "react"
import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react"
import { setCurrentZone } from '@/actions/keybinding-context'

/**
 * Focus zone identifiers - ordered for Tab navigation
 */
export type FocusZoneId = 'sidebar' | 'navigator' | 'chat'

/**
 * Focus intent - describes WHY the focus changed.
 * This allows components to respond appropriately:
 * - 'keyboard': User explicitly navigated via keyboard (Cmd+1/2/3, Tab, Arrow keys)
 * - 'click': User clicked within a zone
 * - 'programmatic': Code triggered the focus change (e.g., search activation)
 */
export type FocusIntent = 'keyboard' | 'click' | 'programmatic'

/**
 * Options for focusZone calls
 */
export interface FocusZoneOptions {
  /** Why the focus is changing - affects default moveFocus behavior */
  intent?: FocusIntent
  /** Whether to move DOM focus to the zone. Defaults: keyboard=true, click=false, programmatic=true */
  moveFocus?: boolean
}

const ZONE_ORDER: FocusZoneId[] = ['sidebar', 'navigator', 'chat']

interface FocusZone {
  id: FocusZoneId
  ref: React.RefObject<HTMLElement>
  focusFirst?: () => void // Optional: custom focus behavior
}

/**
 * Focus state - tracks both the active zone and the intent behind the change
 */
interface FocusState {
  zone: FocusZoneId | null
  intent: FocusIntent | null
  shouldMoveDOMFocus: boolean
}

interface FocusContextValue {
  /** Currently focused zone */
  currentZone: FocusZoneId | null
  /** Current focus state with intent information */
  focusState: FocusState
  /** Register a zone (call on mount) */
  registerZone: (zone: FocusZone) => void
  /** Unregister a zone (call on unmount) */
  unregisterZone: (id: FocusZoneId) => void
  /** Focus a specific zone with optional intent/moveFocus control */
  focusZone: (id: FocusZoneId, options?: FocusZoneOptions) => void
  /** Focus next zone (Tab) */
  focusNextZone: () => void
  /** Focus previous zone (Shift+Tab) */
  focusPreviousZone: () => void
  /** Check if a zone is focused */
  isZoneFocused: (id: FocusZoneId) => boolean
}

const FocusContext = createContext<FocusContextValue | null>(null)

export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [focusState, setFocusState] = useState<FocusState>({
    zone: null,
    intent: null,
    shouldMoveDOMFocus: false,
  })
  const zonesRef = useRef<Map<FocusZoneId, FocusZone>>(new Map())

  const registerZone = useCallback((zone: FocusZone) => {
    zonesRef.current.set(zone.id, zone)
  }, [])

  const unregisterZone = useCallback((id: FocusZoneId) => {
    zonesRef.current.delete(id)
  }, [])

  const focusZone = useCallback((id: FocusZoneId, options?: FocusZoneOptions) => {
    const zone = zonesRef.current.get(id)
    if (!zone) return

    const intent = options?.intent ?? 'programmatic'
    // Default behavior: keyboard navigation moves focus, clicks don't
    const shouldMoveFocus = options?.moveFocus ?? (intent === 'keyboard' || intent === 'programmatic')

    setFocusState({
      zone: id,
      intent,
      shouldMoveDOMFocus: shouldMoveFocus,
    })

    // Sync to keybinding context for when-clause evaluation
    setCurrentZone(id)

    // Only move DOM focus if explicitly requested
    if (shouldMoveFocus) {
      if (zone.focusFirst) {
        zone.focusFirst()
      } else if (zone.ref.current) {
        zone.ref.current.focus()
      }
      // Reset shouldMoveDOMFocus after focus is moved - "consume" the intent
      // This prevents effects from re-triggering on data changes
      // Use setTimeout(0) to ensure subscribers see true first, then false
      setTimeout(() => {
        setFocusState(prev => ({ ...prev, shouldMoveDOMFocus: false }))
      }, 0)
    }
  }, [])

  const focusNextZone = useCallback(() => {
    const currentIndex = focusState.zone ? ZONE_ORDER.indexOf(focusState.zone) : -1
    const nextIndex = (currentIndex + 1) % ZONE_ORDER.length
    // Tab navigation is explicit keyboard intent - always move focus
    focusZone(ZONE_ORDER[nextIndex], { intent: 'keyboard', moveFocus: true })
  }, [focusState.zone, focusZone])

  const focusPreviousZone = useCallback(() => {
    const currentIndex = focusState.zone ? ZONE_ORDER.indexOf(focusState.zone) : 0
    const prevIndex = (currentIndex - 1 + ZONE_ORDER.length) % ZONE_ORDER.length
    // Shift+Tab navigation is explicit keyboard intent - always move focus
    focusZone(ZONE_ORDER[prevIndex], { intent: 'keyboard', moveFocus: true })
  }, [focusState.zone, focusZone])

  const isZoneFocused = useCallback((id: FocusZoneId) => {
    return focusState.zone === id
  }, [focusState.zone])

  // NOTE: Removed automatic focusin tracking - it caused cascading re-renders
  // across all mounted tabs (250-780ms per focus change). Focus state now only
  // changes via explicit focusZone() calls (keyboard shortcuts Cmd+1/2/3, Tab).
  // Components that need to focus on session change should use session?.id as
  // the effect dependency instead of isFocused.

  const value: FocusContextValue = {
    currentZone: focusState.zone,
    focusState,
    registerZone,
    unregisterZone,
    focusZone,
    focusNextZone,
    focusPreviousZone,
    isZoneFocused,
  }

  return (
    <FocusContext.Provider value={value}>
      {children}
    </FocusContext.Provider>
  )
}

export function useFocusContext() {
  const context = useContext(FocusContext)
  if (!context) {
    throw new Error('useFocusContext must be used within a FocusProvider')
  }
  return context
}
