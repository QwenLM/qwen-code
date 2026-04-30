import { describe, expect, it } from 'bun:test'
import { canAnnotateMessage, shouldRenderAnnotationIslandInPortal } from '../annotation-host-config'

describe('annotation host config', () => {
  it('only allows annotation when handler + message context are present and content is not streaming', () => {
    expect(canAnnotateMessage({ hasAddAnnotationHandler: true, hasMessageId: true, isStreaming: false })).toBe(true)
    expect(canAnnotateMessage({ hasAddAnnotationHandler: false, hasMessageId: true, isStreaming: false })).toBe(false)
    expect(canAnnotateMessage({ hasAddAnnotationHandler: true, hasMessageId: false, isStreaming: false })).toBe(false)
    expect(canAnnotateMessage({ hasAddAnnotationHandler: true, hasMessageId: true, isStreaming: true })).toBe(false)
  })

  it('keeps portal strategy explicit per host', () => {
    expect(shouldRenderAnnotationIslandInPortal('turncard')).toBe(true)
    expect(shouldRenderAnnotationIslandInPortal('fullscreen')).toBe(false)
  })
})
