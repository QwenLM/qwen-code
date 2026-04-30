import { describe, expect, it } from 'bun:test'
import {
  clearDomSelection,
  restoreDomSelection,
  scheduleDomSelectionRestore,
} from '../selection-restore'

describe('selection restore helpers', () => {
  it('returns false when selection is missing', () => {
    const restored = restoreDomSelection({} as HTMLElement, null)
    expect(restored).toBe(false)
  })

  it('no-ops when scheduled restore has no selection', () => {
    expect(() => scheduleDomSelectionRestore({ current: null }, null)).not.toThrow()
  })

  it('no-ops when scheduled restore runs without window', () => {
    expect(() => scheduleDomSelectionRestore({ current: null }, { start: 1, end: 2 })).not.toThrow()
  })

  it('clearDomSelection is safe in non-DOM test environments', () => {
    expect(() => clearDomSelection()).not.toThrow()
  })
})
