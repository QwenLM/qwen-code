/**
 * Multi-select state management for session list.
 *
 * This module provides pure functions for managing multi-selection state,
 * enabling shift+click range selection, cmd/ctrl+click toggle, and keyboard
 * navigation with selection extension.
 */

export type MultiSelectState = {
  /** Currently active/focused session ID */
  selected: string | null
  /** Set of all selected session IDs */
  selectedIds: Set<string>
  /** Anchor ID for shift+click range selection */
  anchorId: string | null
  /** Anchor index for range selection (index in flat list) */
  anchorIndex: number
}

/**
 * Create initial empty multi-select state
 */
export function createInitialState(): MultiSelectState {
  return {
    selected: null,
    selectedIds: new Set(),
    anchorId: null,
    anchorIndex: -1,
  }
}

/**
 * Single select - clears all selection and selects only the given item.
 * Sets this item as the anchor for future shift+click operations.
 */
export function singleSelect(id: string, index: number): MultiSelectState {
  return {
    selected: id,
    selectedIds: new Set([id]),
    anchorId: id,
    anchorIndex: index,
  }
}

/**
 * Toggle select - adds or removes an item from the selection (cmd/ctrl+click).
 * Updates the anchor to the toggled item.
 * Prevents deselecting the last item (minimum 1 must remain selected).
 */
export function toggleSelect(state: MultiSelectState, id: string, index: number): MultiSelectState {
  const newSelectedIds = new Set(state.selectedIds)

  if (newSelectedIds.has(id)) {
    // Don't allow deselecting if it's the last item
    if (newSelectedIds.size > 1) {
      newSelectedIds.delete(id)
      // If we removed the active selection, pick another one
      const newSelected = state.selected === id
        ? [...newSelectedIds][0]
        : state.selected
      return {
        selected: newSelected,
        selectedIds: newSelectedIds,
        anchorId: id,
        anchorIndex: index,
      }
    }
    // Can't remove last item - return unchanged
    return state
  } else {
    // Add to selection
    newSelectedIds.add(id)
    return {
      selected: id,
      selectedIds: newSelectedIds,
      anchorId: id,
      anchorIndex: index,
    }
  }
}

/**
 * Range select - selects all items between the anchor and the target index (shift+click).
 * The anchor remains unchanged, but the active selection moves to the target.
 */
export function rangeSelect(
  state: MultiSelectState,
  toIndex: number,
  items: string[]
): MultiSelectState {
  if (items.length === 0) {
    return state
  }

  // Clamp target index to valid range
  const clampedToIndex = Math.max(0, Math.min(toIndex, items.length - 1))

  // Find anchor position using key-based lookup (handles reordering and stale indices)
  let anchorIndex: number
  if (state.anchorIndex >= 0 && state.anchorIndex < items.length &&
      items[state.anchorIndex] === state.anchorId) {
    // Fast path: cached index is still valid
    anchorIndex = state.anchorIndex
  } else if (state.anchorId) {
    // Look up anchor by ID (handles reordering)
    const foundIndex = items.indexOf(state.anchorId)
    anchorIndex = foundIndex >= 0 ? foundIndex : clampedToIndex
  } else {
    // No anchor set - use target as anchor (first shift+click/arrow)
    anchorIndex = clampedToIndex
  }

  // Determine range direction
  const startIndex = Math.min(anchorIndex, clampedToIndex)
  const endIndex = Math.max(anchorIndex, clampedToIndex)

  // Select all items in range
  const newSelectedIds = new Set<string>()
  for (let i = startIndex; i <= endIndex; i++) {
    newSelectedIds.add(items[i])
  }

  return {
    selected: items[clampedToIndex],
    selectedIds: newSelectedIds,
    anchorId: state.anchorId ?? items[anchorIndex],
    anchorIndex: anchorIndex,
  }
}

/**
 * Extend selection - extends the current selection by one item (shift+arrow).
 * Unlike rangeSelect, this preserves existing selections outside the range
 * and just adds/adjusts the contiguous selection from anchor.
 */
export function extendSelection(
  state: MultiSelectState,
  toIndex: number,
  items: string[]
): MultiSelectState {
  // For shift+arrow, we want the same behavior as rangeSelect
  // but keeping the anchor fixed
  return rangeSelect(state, toIndex, items)
}

/**
 * Select all - selects all provided items.
 * Sets the first item as the anchor.
 */
export function selectAll(items: string[]): MultiSelectState {
  if (items.length === 0) {
    return createInitialState()
  }

  return {
    selected: items[0],
    selectedIds: new Set(items),
    anchorId: items[0],
    anchorIndex: 0,
  }
}

/**
 * Clear multi-select - reduces selection to only the currently active item.
 * If no active item, clears everything.
 */
export function clearMultiSelect(state: MultiSelectState): MultiSelectState {
  if (!state.selected) {
    return createInitialState()
  }

  // Find the index of the selected item if we need it
  return {
    selected: state.selected,
    selectedIds: new Set([state.selected]),
    anchorId: state.selected,
    anchorIndex: state.anchorIndex,
  }
}

/**
 * Remove items from selection - removes the given IDs from the selection.
 * Used when items are deleted.
 */
export function removeFromSelection(
  state: MultiSelectState,
  idsToRemove: string[]
): MultiSelectState {
  const removeSet = new Set(idsToRemove)
  const newSelectedIds = new Set(
    [...state.selectedIds].filter(id => !removeSet.has(id))
  )

  // If selected item was removed, pick first remaining or null
  const newSelected = removeSet.has(state.selected ?? '')
    ? [...newSelectedIds][0] ?? null
    : state.selected

  // If anchor was removed, reset it
  const newAnchorId = removeSet.has(state.anchorId ?? '')
    ? newSelected
    : state.anchorId

  return {
    selected: newSelected,
    selectedIds: newSelectedIds,
    anchorId: newAnchorId,
    anchorIndex: state.anchorIndex, // Index may be stale but will be updated on next interaction
  }
}

/**
 * Check if multi-select mode is active (more than one item selected)
 */
export function isMultiSelectActive(state: MultiSelectState): boolean {
  return state.selectedIds.size > 1
}

/**
 * Get the count of selected items
 */
export function getSelectionCount(state: MultiSelectState): number {
  return state.selectedIds.size
}

/**
 * Check if a specific item is in the selection
 */
export function isItemSelected(state: MultiSelectState, id: string): boolean {
  return state.selectedIds.has(id)
}
