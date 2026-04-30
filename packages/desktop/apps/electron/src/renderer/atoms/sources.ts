/**
 * Sources Atom
 *
 * Simple atom for storing workspace sources.
 * Used by NavigationContext for auto-selection when navigating to sources view.
 */

import { atom } from 'jotai'
import type { LoadedSource } from '../../shared/types'

/**
 * Atom to store the current workspace's sources.
 * AppShell populates this when sources are loaded.
 * NavigationContext reads from it for auto-selection.
 */
export const sourcesAtom = atom<LoadedSource[]>([])
