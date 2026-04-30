import { atom } from 'jotai'

/**
 * Tracks whether a full-screen overlay is open (e.g., workspace creation).
 * Used by AppShell to apply a scale-back effect on the main content.
 */
export const fullscreenOverlayOpenAtom = atom(false)
