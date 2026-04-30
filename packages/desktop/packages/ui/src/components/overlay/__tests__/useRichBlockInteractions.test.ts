import { describe, expect, it } from 'vitest'
import {
  clampScale,
  computeFitScale,
  cursorAnchoredTranslate,
  zoomStepScale,
} from '../useRichBlockInteractions'

describe('useRichBlockInteractions helpers', () => {
  it('clamps scale within bounds', () => {
    expect(clampScale(0.1, 0.25, 4)).toBe(0.25)
    expect(clampScale(10, 0.25, 4)).toBe(4)
    expect(clampScale(1.5, 0.25, 4)).toBe(1.5)
  })

  it('computes step zoom in and out', () => {
    expect(zoomStepScale(1, 'in', 1.25, 0.25, 4)).toBe(1.25)
    expect(zoomStepScale(1, 'out', 1.25, 0.25, 4)).toBeCloseTo(0.8)
  })

  it('keeps cursor-anchored point stable when zooming', () => {
    const result = cursorAnchoredTranslate({ x: 20, y: -10 }, { x: 100, y: 50 }, 1.5)
    expect(result).toEqual({ x: -20, y: -40 })
  })

  it('computes zoom-to-fit scale with 90% padding', () => {
    const fit = computeFitScale(
      { width: 1000, height: 800 },
      { width: 2000, height: 1000 },
      0.25,
      4,
    )
    // min((1000*0.9)/2000 = 0.45, (800*0.9)/1000 = 0.72) = 0.45
    expect(fit).toBeCloseTo(0.45)
  })
})
