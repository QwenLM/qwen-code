/**
 * useEntityListInteractions — Convenience hook that wires together:
 * - useRovingTabIndex (keyboard navigation)
 * - useMultiSelect (pure selection state)
 * - Optional search filtering
 *
 * Returns props to spread onto EntityList and EntityRow.
 *
 * NOTE: Does NOT include useFocusZone — that requires app-level FocusContext.
 * Consumers who need zone integration compose it externally (see SessionList).
 */

import { useState, useCallback, useMemo, useRef } from 'react'
import { useRovingTabIndex } from '@/hooks/keyboard'
import * as MultiSelect from '@/hooks/useMultiSelect'

// ============================================================================
// Types
// ============================================================================

export interface UseEntityListInteractionsOptions<T> {
  /** List of items (pre-filtering) */
  items: T[]
  /** Unique ID extractor */
  getId: (item: T) => string

  /** Keyboard navigation (opt-in) */
  keyboard?: {
    /** Called when Enter/Space is pressed on the active item */
    onActivate?: (item: T, index: number) => void
    /** Called when arrow keys move to a new item */
    onNavigate?: (item: T, index: number) => void
    /** Whether keyboard navigation is enabled (default: true) */
    enabled?: boolean
    /** Keep DOM focus elsewhere (e.g. search input) while navigating (default: false) */
    virtualFocus?: boolean
  }

  /** Multi-select (opt-in — set to true to enable) */
  multiSelect?: boolean

  /** Search filtering (opt-in) */
  search?: {
    /** Current search query */
    query: string
    /** Filter function — return true to include the item */
    fn: (item: T, query: string) => boolean
  }

  /**
   * External selection store (opt-in).
   * When provided, the hook uses this instead of its own internal useState.
   * This enables atom-backed selection shared with other components (e.g. Jotai).
   *
   * @example
   * const [state, setState] = useAtom(sessionSelectionAtom)
   * const interactions = useEntityListInteractions({ ..., selectionStore: { state, setState } })
   */
  selectionStore?: {
    state: MultiSelect.MultiSelectState
    setState: (fn: MultiSelect.MultiSelectState | ((prev: MultiSelect.MultiSelectState) => MultiSelect.MultiSelectState)) => void
  }

  /**
   * Override which item ID is considered "selected" for highlighting.
   * When provided, `getRowProps` uses this instead of `selectionState.selected`.
   * Used by multi-panel focus tracking where the focused panel determines selection.
   */
  selectedIdOverride?: string | null
}

export interface EntityListInteractions<T> {
  /** Filtered items (after search). Use this as EntityList's items prop. */
  items: T[]

  /** Props to spread on EntityList */
  listProps: {
    containerRef?: React.Ref<HTMLDivElement>
    containerProps: Record<string, string>
  }

  /** Get props to spread on each EntityRow */
  getRowProps: (item: T, index: number) => {
    buttonProps: Record<string, unknown>
    isSelected: boolean
    isInMultiSelect: boolean
    onMouseDown: (e: React.MouseEvent) => void
  }

  /** Keyboard state */
  keyboard: {
    activeIndex: number
    setActiveIndex: (index: number) => void
    focusActiveItem: () => void
  }

  /** Props to spread on a search <input> — forwards ArrowDown/Up to the list */
  searchInputProps: {
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  }

  /** Selection state (only meaningful when multiSelect is enabled) */
  selection: {
    state: MultiSelect.MultiSelectState
    isMultiSelectActive: boolean
    selectedIds: Set<string>
    toggle: (id: string, index: number) => void
    range: (toIndex: number) => void
    selectAll: () => void
    clear: () => void
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useEntityListInteractions<T>({
  items: rawItems,
  getId,
  keyboard: keyboardOpts,
  multiSelect: multiSelectEnabled = false,
  search,
  selectionStore,
  selectedIdOverride,
}: UseEntityListInteractionsOptions<T>): EntityListInteractions<T> {
  // ---- Search filtering ----
  const items = useMemo(() => {
    if (!search || !search.query.trim()) return rawItems
    return rawItems.filter(item => search.fn(item, search.query))
  }, [rawItems, search?.query, search?.fn]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Multi-select state ----
  // Use external store (e.g. Jotai atom) when provided, otherwise local useState
  const [internalState, setInternalState] = useState<MultiSelect.MultiSelectState>(
    MultiSelect.createInitialState
  )
  const selectionState = selectionStore?.state ?? internalState
  const setSelectionState = selectionStore?.setState ?? setInternalState

  const allIds = useMemo(() => items.map(getId), [items, getId])

  const toggle = useCallback((id: string, index: number) => {
    setSelectionState(prev => MultiSelect.toggleSelect(prev, id, index))
  }, [])

  const range = useCallback((toIndex: number) => {
    setSelectionState(prev => MultiSelect.rangeSelect(prev, toIndex, allIds))
  }, [allIds])

  const selectAllItems = useCallback(() => {
    setSelectionState(MultiSelect.selectAll(allIds))
  }, [allIds])

  const clearSelection = useCallback(() => {
    setSelectionState(prev => MultiSelect.clearMultiSelect(prev))
  }, [])

  const isMultiSelectActive = MultiSelect.isMultiSelectActive(selectionState)

  // ---- Keyboard navigation ----
  const handleNavigate = useCallback((item: T, index: number) => {
    // Scroll into view
    const id = getId(item)
    requestAnimationFrame(() => {
      const el = document.getElementById(`item-${id}`)
      el?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    })

    // Exit multi-select on plain arrow navigation, then single-select the navigated item
    if (multiSelectEnabled && isMultiSelectActive) {
      clearSelection()
    }

    // Update selection to follow the keyboard cursor
    setSelectionState(MultiSelect.singleSelect(id, index))

    keyboardOpts?.onNavigate?.(item, index)
  }, [getId, multiSelectEnabled, isMultiSelectActive, clearSelection, keyboardOpts?.onNavigate]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleActivate = useCallback((item: T, index: number) => {
    if (multiSelectEnabled && !isMultiSelectActive) {
      // Single-select on Enter
      setSelectionState(MultiSelect.singleSelect(getId(item), index))
    }
    keyboardOpts?.onActivate?.(item, index)
  }, [multiSelectEnabled, isMultiSelectActive, getId, keyboardOpts?.onActivate]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleExtendSelection = useCallback((toIndex: number) => {
    if (multiSelectEnabled) {
      range(toIndex)
    }
  }, [multiSelectEnabled, range])

  const {
    activeIndex,
    setActiveIndex,
    getItemProps,
    getContainerProps,
    focusActiveItem,
  } = useRovingTabIndex({
    items,
    getId: (item) => getId(item),
    orientation: 'vertical',
    wrap: true,
    onNavigate: handleNavigate,
    onActivate: handleActivate,
    enabled: keyboardOpts?.enabled ?? true,
    moveFocus: !(keyboardOpts?.virtualFocus ?? false),
    onExtendSelection: multiSelectEnabled ? handleExtendSelection : undefined,
  })

  // ---- Mouse interaction ----
  // Track last selected index for range select — separate from activeIndex
  // because activeIndex follows keyboard, this follows clicks.
  const lastClickIndexRef = useRef<number>(-1)

  const getRowMouseDown = useCallback((item: T, index: number) => {
    return (e: React.MouseEvent) => {
      const id = getId(item)

      // Right-click: preserve multi-select, let context menu handle batch actions
      if (e.button === 2) {
        if (multiSelectEnabled && isMultiSelectActive && !selectionState.selectedIds.has(id)) {
          // Right-clicking an unselected item during multi-select: add it to selection
          toggle(id, index)
        }
        // Don't change selection — context menu shows batch or single actions
        return
      }

      const isMetaKey = e.metaKey || e.ctrlKey
      const isShiftKey = e.shiftKey

      if (multiSelectEnabled && isMetaKey) {
        e.preventDefault()
        toggle(id, index)
        lastClickIndexRef.current = index
        return
      }

      if (multiSelectEnabled && isShiftKey) {
        e.preventDefault()
        range(index)
        return
      }

      // Normal click — single select
      setSelectionState(MultiSelect.singleSelect(id, index))
      lastClickIndexRef.current = index
      setActiveIndex(index)
    }
  }, [getId, multiSelectEnabled, isMultiSelectActive, selectionState.selectedIds, toggle, range, setActiveIndex])

  // ---- Search input keyboard forwarding ----
  // Forwards ArrowDown/ArrowUp from a search input to the roving tabindex handler.
  // Matches SessionList pattern (SessionList.tsx:1598).
  const searchInputOnKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      // Forward to the roving tabindex container handler
      getContainerProps().onKeyDown(e as unknown as React.KeyboardEvent)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      ;(e.target as HTMLInputElement).blur()
      return
    }
    if (e.key === 'Enter') {
      // Forward Enter to activate the focused item
      e.preventDefault()
      getContainerProps().onKeyDown(e as unknown as React.KeyboardEvent)
      return
    }
  }, [getContainerProps])

  // ---- Build return values ----
  const containerProps = getContainerProps()

  const listProps = useMemo(() => ({
    containerRef: undefined as React.Ref<HTMLDivElement> | undefined,
    containerProps: {
      role: containerProps.role,
      'aria-activedescendant': containerProps['aria-activedescendant'] ?? '',
    },
  }), [containerProps.role, containerProps['aria-activedescendant']])

  const getRowProps = useCallback((item: T, index: number) => {
    const id = getId(item)
    const itemProps = getItemProps(item, index)
    const effectiveSelected = selectedIdOverride !== undefined
      ? selectedIdOverride
      : selectionState.selected
    const isSelected = multiSelectEnabled
      ? effectiveSelected === id
      : index === activeIndex
    const isInMultiSelect = multiSelectEnabled && isMultiSelectActive && selectionState.selectedIds.has(id)

    return {
      buttonProps: {
        id: itemProps.id,
        tabIndex: itemProps.tabIndex,
        ref: itemProps.ref,
        onKeyDown: itemProps.onKeyDown,
        onFocus: itemProps.onFocus,
        'aria-selected': itemProps['aria-selected'],
        role: itemProps.role,
      } as Record<string, unknown>,
      isSelected,
      isInMultiSelect,
      onMouseDown: getRowMouseDown(item, index),
    }
  }, [getId, getItemProps, multiSelectEnabled, selectionState, activeIndex, isMultiSelectActive, getRowMouseDown, selectedIdOverride])

  return {
    items,
    listProps,
    getRowProps,
    searchInputProps: {
      onKeyDown: searchInputOnKeyDown,
    },
    keyboard: {
      activeIndex,
      setActiveIndex,
      focusActiveItem,
    },
    selection: {
      state: selectionState,
      isMultiSelectActive,
      selectedIds: selectionState.selectedIds,
      toggle,
      range,
      selectAll: selectAllItems,
      clear: clearSelection,
    },
  }
}
