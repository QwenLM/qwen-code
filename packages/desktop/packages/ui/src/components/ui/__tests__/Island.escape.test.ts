import { describe, expect, it, mock } from 'bun:test'
import { handleIslandEscape } from '../Island'

describe('handleIslandEscape', () => {
  it('uses back in back-or-close mode when back handler succeeds', () => {
    const onRequestBack = mock(() => true)
    const onRequestClose = mock(() => {})

    const handled = handleIslandEscape({
      dialogBehavior: 'back-or-close',
      onRequestBack,
      onRequestClose,
    })

    expect(handled).toBe(true)
    expect(onRequestBack).toHaveBeenCalledTimes(1)
    expect(onRequestClose).not.toHaveBeenCalled()
  })

  it('falls back to close in back-or-close mode when back is unavailable', () => {
    const onRequestBack = mock(() => false)
    const onRequestClose = mock(() => {})

    const handled = handleIslandEscape({
      dialogBehavior: 'back-or-close',
      onRequestBack,
      onRequestClose,
    })

    expect(handled).toBe(true)
    expect(onRequestBack).toHaveBeenCalledTimes(1)
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('closes directly in close mode', () => {
    const onRequestBack = mock(() => true)
    const onRequestClose = mock(() => {})

    const handled = handleIslandEscape({
      dialogBehavior: 'close',
      onRequestBack,
      onRequestClose,
    })

    expect(handled).toBe(true)
    expect(onRequestBack).not.toHaveBeenCalled()
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('does nothing in none mode', () => {
    const onRequestBack = mock(() => true)
    const onRequestClose = mock(() => {})

    const handled = handleIslandEscape({
      dialogBehavior: 'none',
      onRequestBack,
      onRequestClose,
    })

    expect(handled).toBe(false)
    expect(onRequestBack).not.toHaveBeenCalled()
    expect(onRequestClose).not.toHaveBeenCalled()
  })
})
