/**
 * useEntitySelection — Generic atom-backed selection factory.
 *
 * Creates a Jotai atom + hooks for any entity type (sessions, sources, skills).
 * Each call to createEntitySelection() produces an independent atom and hook set.
 *
 * Hooks returned:
 * - useSelection()         — Full action hook (select, toggle, range, clear, etc.)
 * - useSelectionStore()    — Raw { state, setState } for useEntityListInteractions
 * - useIsMultiSelectActive() — Read-only boolean
 * - useSelectedIds()       — Read-only Set<string>
 * - useSelectionCount()    — Read-only number
 */

import { atom, useAtom, useAtomValue } from 'jotai'
import { useCallback, useMemo } from 'react'
import {
  type MultiSelectState,
  createInitialState,
  singleSelect,
  toggleSelect,
  rangeSelect,
  selectAll,
  clearMultiSelect,
  removeFromSelection,
  isMultiSelectActive,
  getSelectionCount,
  isItemSelected,
} from './useMultiSelect'

export function createEntitySelection() {
  const selectionAtom = atom<MultiSelectState>(createInitialState())

  function useSelection() {
    const [state, setState] = useAtom(selectionAtom)

    const actions = useMemo(() => ({
      select: (id: string, index: number) => {
        setState(singleSelect(id, index))
      },
      toggle: (id: string, index: number) => {
        setState(prev => toggleSelect(prev, id, index))
      },
      selectRange: (toIndex: number, items: string[]) => {
        setState(prev => rangeSelect(prev, toIndex, items))
      },
      selectAll: (items: string[]) => {
        setState(selectAll(items))
      },
      clearMultiSelect: () => {
        setState(prev => clearMultiSelect(prev))
      },
      removeFromSelection: (ids: string[]) => {
        setState(prev => removeFromSelection(prev, ids))
      },
      reset: () => {
        setState(createInitialState())
      },
    }), [setState])

    return {
      state,
      ...actions,
      isMultiSelectActive: isMultiSelectActive(state),
      selectionCount: getSelectionCount(state),
      isSelected: (id: string) => isItemSelected(state, id),
    }
  }

  function useSelectionStore() {
    const [state, setState] = useAtom(selectionAtom)
    return { state, setState }
  }

  function useIsMultiSelectActive_(): boolean {
    const state = useAtomValue(selectionAtom)
    return isMultiSelectActive(state)
  }

  function useSelectedIds_(): Set<string> {
    const state = useAtomValue(selectionAtom)
    return state.selectedIds
  }

  function useSelectionCount_(): number {
    const state = useAtomValue(selectionAtom)
    return getSelectionCount(state)
  }

  return {
    useSelection,
    useSelectionStore,
    useIsMultiSelectActive: useIsMultiSelectActive_,
    useSelectedIds: useSelectedIds_,
    useSelectionCount: useSelectionCount_,
  }
}

// ============================================================================
// Instances — one per entity type
// ============================================================================

export const sessionSelection = createEntitySelection()
export const sourceSelection = createEntitySelection()
export const skillSelection = createEntitySelection()
export const automationSelection = createEntitySelection()
