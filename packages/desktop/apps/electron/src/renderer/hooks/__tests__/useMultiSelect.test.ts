import { describe, it, expect } from 'bun:test'
import {
  createInitialState,
  singleSelect,
  toggleSelect,
  rangeSelect,
  extendSelection,
  selectAll,
  clearMultiSelect,
  removeFromSelection,
  isMultiSelectActive,
  getSelectionCount,
  isItemSelected,
  type MultiSelectState,
} from '../useMultiSelect'

describe('useMultiSelect', () => {
  const items = ['a', 'b', 'c', 'd', 'e']

  describe('createInitialState', () => {
    it('creates empty state', () => {
      const state = createInitialState()
      expect(state.selected).toBe(null)
      expect(state.selectedIds.size).toBe(0)
      expect(state.anchorId).toBe(null)
      expect(state.anchorIndex).toBe(-1)
    })
  })

  describe('singleSelect', () => {
    it('selects single item and clears previous selection', () => {
      const state = singleSelect('b', 1)
      expect(state.selected).toBe('b')
      expect(state.selectedIds.size).toBe(1)
      expect(state.selectedIds.has('b')).toBe(true)
      expect(state.anchorId).toBe('b')
      expect(state.anchorIndex).toBe(1)
    })

    it('sets the selected item as anchor', () => {
      const state = singleSelect('c', 2)
      expect(state.anchorId).toBe('c')
      expect(state.anchorIndex).toBe(2)
    })
  })

  describe('toggleSelect', () => {
    it('adds item to selection when not selected', () => {
      const initial = singleSelect('a', 0)
      const state = toggleSelect(initial, 'c', 2)
      expect(state.selectedIds.size).toBe(2)
      expect(state.selectedIds.has('a')).toBe(true)
      expect(state.selectedIds.has('c')).toBe(true)
    })

    it('removes item when already selected', () => {
      const initial = singleSelect('a', 0)
      const withB = toggleSelect(initial, 'b', 1)
      const state = toggleSelect(withB, 'a', 0)
      expect(state.selectedIds.size).toBe(1)
      expect(state.selectedIds.has('a')).toBe(false)
      expect(state.selectedIds.has('b')).toBe(true)
    })

    it('keeps at least one item selected (cannot deselect last)', () => {
      const initial = singleSelect('a', 0)
      const state = toggleSelect(initial, 'a', 0)
      expect(state.selectedIds.size).toBe(1)
      expect(state.selectedIds.has('a')).toBe(true)
    })

    it('updates anchor to toggled item', () => {
      const initial = singleSelect('a', 0)
      const state = toggleSelect(initial, 'c', 2)
      expect(state.anchorId).toBe('c')
      expect(state.anchorIndex).toBe(2)
    })

    it('updates selected to toggled item when adding', () => {
      const initial = singleSelect('a', 0)
      const state = toggleSelect(initial, 'c', 2)
      expect(state.selected).toBe('c')
    })

    it('updates selected to another item when removing current selection', () => {
      const initial = singleSelect('a', 0)
      const withBC = toggleSelect(toggleSelect(initial, 'b', 1), 'c', 2)
      // Now remove 'c' which is the current selection
      const state = toggleSelect(withBC, 'c', 2)
      expect(state.selected).not.toBe('c')
      expect(state.selectedIds.has(state.selected!)).toBe(true)
    })
  })

  describe('rangeSelect', () => {
    it('selects range from anchor forward', () => {
      const initial = singleSelect('b', 1)
      const state = rangeSelect(initial, 4, items)
      expect(state.selectedIds.size).toBe(4)
      expect([...state.selectedIds].sort()).toEqual(['b', 'c', 'd', 'e'])
    })

    it('selects range from anchor backward', () => {
      const initial = singleSelect('d', 3)
      const state = rangeSelect(initial, 1, items)
      expect(state.selectedIds.size).toBe(3)
      expect([...state.selectedIds].sort()).toEqual(['b', 'c', 'd'])
    })

    it('handles same index (single item)', () => {
      const initial = singleSelect('c', 2)
      const state = rangeSelect(initial, 2, items)
      expect(state.selectedIds.size).toBe(1)
      expect(state.selectedIds.has('c')).toBe(true)
    })

    it('updates selected to target index', () => {
      const initial = singleSelect('b', 1)
      const state = rangeSelect(initial, 4, items)
      expect(state.selected).toBe('e')
    })

    it('preserves anchor', () => {
      const initial = singleSelect('b', 1)
      const state = rangeSelect(initial, 4, items)
      expect(state.anchorId).toBe('b')
      expect(state.anchorIndex).toBe(1)
    })

    it('handles empty items array', () => {
      const initial = singleSelect('a', 0)
      const state = rangeSelect(initial, 2, [])
      // Should return unchanged state
      expect(state).toBe(initial)
    })

    it('clamps out of bounds index', () => {
      const initial = singleSelect('a', 0)
      const state = rangeSelect(initial, 10, items)
      expect(state.selectedIds.size).toBe(5)
      expect([...state.selectedIds].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('handles negative index', () => {
      const initial = singleSelect('c', 2)
      const state = rangeSelect(initial, -5, items)
      expect(state.selectedIds.size).toBe(3)
      expect([...state.selectedIds].sort()).toEqual(['a', 'b', 'c'])
    })
  })

  describe('extendSelection', () => {
    it('works same as rangeSelect for shift+arrow', () => {
      const initial = singleSelect('b', 1)
      const state = extendSelection(initial, 3, items)
      expect(state.selectedIds.size).toBe(3)
      expect([...state.selectedIds].sort()).toEqual(['b', 'c', 'd'])
    })
  })

  describe('selectAll', () => {
    it('selects all provided items', () => {
      const state = selectAll(items)
      expect(state.selectedIds.size).toBe(5)
      expect([...state.selectedIds].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('sets first item as selected', () => {
      const state = selectAll(items)
      expect(state.selected).toBe('a')
    })

    it('sets first item as anchor', () => {
      const state = selectAll(items)
      expect(state.anchorId).toBe('a')
      expect(state.anchorIndex).toBe(0)
    })

    it('handles empty array', () => {
      const state = selectAll([])
      expect(state.selectedIds.size).toBe(0)
      expect(state.selected).toBe(null)
      expect(state.anchorId).toBe(null)
    })
  })

  describe('clearMultiSelect', () => {
    it('clears selection keeping only active item', () => {
      const initial = selectAll(items)
      const withSelected: MultiSelectState = { ...initial, selected: 'c' }
      const state = clearMultiSelect(withSelected)
      expect(state.selectedIds.size).toBe(1)
      expect(state.selectedIds.has('c')).toBe(true)
      expect(state.selected).toBe('c')
    })

    it('returns empty state if no active item', () => {
      const initial: MultiSelectState = {
        selected: null,
        selectedIds: new Set(['a', 'b']),
        anchorId: 'a',
        anchorIndex: 0,
      }
      const state = clearMultiSelect(initial)
      expect(state.selectedIds.size).toBe(0)
      expect(state.selected).toBe(null)
    })
  })

  describe('removeFromSelection', () => {
    it('removes specified items from selection', () => {
      const initial = selectAll(items)
      const state = removeFromSelection(initial, ['b', 'd'])
      expect(state.selectedIds.size).toBe(3)
      expect([...state.selectedIds].sort()).toEqual(['a', 'c', 'e'])
    })

    it('updates selected if removed', () => {
      const initial: MultiSelectState = {
        selected: 'b',
        selectedIds: new Set(['a', 'b', 'c']),
        anchorId: 'a',
        anchorIndex: 0,
      }
      const state = removeFromSelection(initial, ['b'])
      expect(state.selected).not.toBe('b')
      expect(state.selectedIds.has(state.selected!)).toBe(true)
    })

    it('sets selected to null if all removed', () => {
      const initial = singleSelect('a', 0)
      const state = removeFromSelection(initial, ['a'])
      expect(state.selected).toBe(null)
      expect(state.selectedIds.size).toBe(0)
    })

    it('updates anchor if removed', () => {
      const initial: MultiSelectState = {
        selected: 'b',
        selectedIds: new Set(['a', 'b', 'c']),
        anchorId: 'a',
        anchorIndex: 0,
      }
      const state = removeFromSelection(initial, ['a'])
      expect(state.anchorId).toBe('b') // Falls back to selected
    })
  })

  describe('isMultiSelectActive', () => {
    it('returns false for empty selection', () => {
      const state = createInitialState()
      expect(isMultiSelectActive(state)).toBe(false)
    })

    it('returns false for single selection', () => {
      const state = singleSelect('a', 0)
      expect(isMultiSelectActive(state)).toBe(false)
    })

    it('returns true for multiple selections', () => {
      const initial = singleSelect('a', 0)
      const state = toggleSelect(initial, 'b', 1)
      expect(isMultiSelectActive(state)).toBe(true)
    })
  })

  describe('getSelectionCount', () => {
    it('returns 0 for empty selection', () => {
      const state = createInitialState()
      expect(getSelectionCount(state)).toBe(0)
    })

    it('returns correct count', () => {
      const state = selectAll(items)
      expect(getSelectionCount(state)).toBe(5)
    })
  })

  describe('isItemSelected', () => {
    it('returns false for unselected item', () => {
      const state = singleSelect('a', 0)
      expect(isItemSelected(state, 'b')).toBe(false)
    })

    it('returns true for selected item', () => {
      const state = singleSelect('a', 0)
      expect(isItemSelected(state, 'a')).toBe(true)
    })
  })

  describe('integration scenarios', () => {
    it('simulates typical multi-select workflow', () => {
      // 1. Click on item 'b'
      let state = singleSelect('b', 1)
      expect(state.selectedIds.size).toBe(1)

      // 2. Cmd+click on 'd'
      state = toggleSelect(state, 'd', 3)
      expect(state.selectedIds.size).toBe(2)
      expect([...state.selectedIds].sort()).toEqual(['b', 'd'])

      // 3. Shift+click on 'a' (from anchor 'd')
      state = rangeSelect(state, 0, items)
      expect(state.selectedIds.size).toBe(4)
      expect([...state.selectedIds].sort()).toEqual(['a', 'b', 'c', 'd'])

      // 4. Regular click clears multi-select
      state = singleSelect('c', 2)
      expect(state.selectedIds.size).toBe(1)
      expect(state.selected).toBe('c')
    })

    it('simulates keyboard navigation with shift', () => {
      // Start at item 'c'
      let state = singleSelect('c', 2)

      // Shift+ArrowDown twice
      state = extendSelection(state, 3, items)
      state = extendSelection(state, 4, items)
      expect([...state.selectedIds].sort()).toEqual(['c', 'd', 'e'])

      // Shift+ArrowUp back
      state = extendSelection(state, 3, items)
      expect([...state.selectedIds].sort()).toEqual(['c', 'd'])
    })

    it('handles escape to clear multi-select', () => {
      const initial = selectAll(items)
      const withSelected: MultiSelectState = { ...initial, selected: 'c' }
      const state = clearMultiSelect(withSelected)
      expect(isMultiSelectActive(state)).toBe(false)
      expect(state.selected).toBe('c')
    })
  })
})
