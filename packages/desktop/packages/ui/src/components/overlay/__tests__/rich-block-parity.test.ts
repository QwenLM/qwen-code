import { describe, expect, it } from 'vitest'
import { RICH_BLOCK_DEFAULTS } from '../rich-block-interaction-spec'
import { zoomStepScale } from '../useRichBlockInteractions'

describe('rich block interaction parity defaults', () => {
  it('uses shared zoom presets for all rich blocks', () => {
    expect(RICH_BLOCK_DEFAULTS.zoomPresets).toEqual([25, 50, 75, 100, 150, 200, 400])
  })

  it('uses invertible in/out step factor', () => {
    const inScale = zoomStepScale(1, 'in', RICH_BLOCK_DEFAULTS.zoomStepFactor, RICH_BLOCK_DEFAULTS.minScale, RICH_BLOCK_DEFAULTS.maxScale)
    const outScale = zoomStepScale(inScale, 'out', RICH_BLOCK_DEFAULTS.zoomStepFactor, RICH_BLOCK_DEFAULTS.minScale, RICH_BLOCK_DEFAULTS.maxScale)
    expect(outScale).toBeCloseTo(1)
  })
})
