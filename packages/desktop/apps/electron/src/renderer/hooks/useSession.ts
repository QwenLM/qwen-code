/**
 * Session selection hooks.
 *
 * Re-exports from the generic useEntitySelection factory.
 * The legacy useSession() hook is preserved for backward compatibility.
 */

import { useCallback } from 'react'
import { createInitialState, singleSelect } from './useMultiSelect'
import { sessionSelection } from './useEntitySelection'

/**
 * Legacy type alias for backward compatibility
 */
type Config = {
  selected: string | null
}

/**
 * Legacy hook - maintains backward compatibility with existing code.
 * Returns [{ selected }, setSession] tuple.
 *
 * @deprecated Use useSessionSelection() for full multi-select support
 */
export function useSession(): [Config, (config: Config) => void] {
  const { state, setState } = sessionSelection.useSelectionStore()

  const legacySetSession = useCallback((config: Config) => {
    if (config.selected === null) {
      setState(createInitialState())
    } else {
      setState(singleSelect(config.selected, -1))
    }
  }, [setState])

  return [{ selected: state.selected }, legacySetSession]
}

// Re-export factory-generated hooks under existing names
export const useSessionSelection = sessionSelection.useSelection
export const useSessionSelectionStore = sessionSelection.useSelectionStore
export const useIsMultiSelectActive = sessionSelection.useIsMultiSelectActive
export const useSelectedIds = sessionSelection.useSelectedIds
export const useSelectionCount = sessionSelection.useSelectionCount
