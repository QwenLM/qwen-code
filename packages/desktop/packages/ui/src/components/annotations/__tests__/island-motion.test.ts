import { describe, it, expect } from 'bun:test'
import {
  buildAnnotationChipEntryTransition,
  buildSelectionEntryTransition,
} from '../island-motion'

describe('annotation island motion utils', () => {
  it('buildAnnotationChipEntryTransition returns stable defaults', () => {
    const transition = buildAnnotationChipEntryTransition()
    expect(transition.entryAngleDeg).toBe(90)
    expect(transition.entryDistancePx).toBe(64)
    expect(transition.entryStartScale).toBe(0.25)
  })

  it('buildSelectionEntryTransition falls back when pointer snapshots missing', () => {
    const transition = buildSelectionEntryTransition(null, null)
    expect(transition.entryAngleDeg).toBe(90)
    expect(transition.entryDistancePx).toBe(44)
    expect(transition.entryStartScale).toBe(0.25)
  })

  it('buildSelectionEntryTransition derives finite values from pointer snapshots', () => {
    const transition = buildSelectionEntryTransition(
      { x: 100, y: 100, ts: 1000 },
      { x: 160, y: 120, ts: 1100 },
    )

    expect(Number.isFinite(transition.entryAngleDeg)).toBe(true)
    expect(Number.isFinite(transition.entryDistancePx)).toBe(true)
    expect(transition.entryStartScale).toBe(0.25)
    expect(transition.entryDistancePx).toBeGreaterThanOrEqual(20)
    expect(transition.entryDistancePx).toBeLessThanOrEqual(132)
  })
})
