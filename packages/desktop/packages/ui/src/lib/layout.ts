/**
 * Shared layout constants for chat UI
 *
 * These values ensure visual consistency between Electron and web viewer.
 * Import and use these in both ChatDisplay (Electron) and SessionViewer (UI package).
 */

/**
 * Overlay layout configuration
 * Controls when overlays show as modals vs fullscreen
 */
export const OVERLAY_LAYOUT = {
  /** Minimum viewport width for modal display (below this = fullscreen) */
  /** Set very high to always use fullscreen mode */
  modalBreakpoint: 99999,
  /** Modal max width */
  modalMaxWidth: 1100,
  /** Modal max height as percentage of viewport */
  modalMaxHeightPercent: 85,
  /** Backdrop class for modal mode (semi-transparent) */
  modalBackdropClass: 'bg-black/50',
  /** Backdrop class for fullscreen mode (solid) */
  fullscreenBackdropClass: 'bg-background',
} as const

/**
 * Chat layout configuration
 */
export const CHAT_LAYOUT = {
  /** Max width for chat content area */
  maxWidth: 'max-w-[840px]',

  /** Horizontal padding for main container */
  containerPaddingX: 'px-5',

  /** Vertical padding for main container */
  containerPaddingY: 'py-8',

  /** Combined container padding */
  containerPadding: 'px-5 py-8',

  /** Vertical spacing between messages/turns */
  messageSpacing: 'space-y-2.5',

  /** Extra padding for user messages (visual separation from AI responses) */
  userMessagePadding: 'pt-4 pb-2',

  /** Bottom branding area padding */
  brandingPadding: 'pt-16 pb-24',
} as const

/**
 * Composed class strings for common patterns
 */
export const CHAT_CLASSES = {
  /** Main message container: max-width + centered + padding + spacing */
  messageContainer: `${CHAT_LAYOUT.maxWidth} mx-auto ${CHAT_LAYOUT.containerPadding} ${CHAT_LAYOUT.messageSpacing}`,

  /** User message wrapper with padding */
  userMessageWrapper: CHAT_LAYOUT.userMessagePadding,

  /** Bottom branding container */
  brandingContainer: `flex justify-center ${CHAT_LAYOUT.brandingPadding}`,
} as const

// ============================================================================
// Responsive Overlay Hook
// ============================================================================

import { useState, useEffect } from 'react'

export type OverlayMode = 'modal' | 'fullscreen'

/**
 * Hook to determine if overlay should show as modal or fullscreen
 * based on viewport size.
 *
 * @returns 'modal' if viewport is large enough, 'fullscreen' otherwise
 */
export function useOverlayMode(): OverlayMode {
  const [mode, setMode] = useState<OverlayMode>(() => {
    if (typeof window === 'undefined') return 'fullscreen'
    return window.innerWidth >= OVERLAY_LAYOUT.modalBreakpoint ? 'modal' : 'fullscreen'
  })

  useEffect(() => {
    const handleResize = () => {
      const newMode = window.innerWidth >= OVERLAY_LAYOUT.modalBreakpoint ? 'modal' : 'fullscreen'
      setMode(newMode)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return mode
}
