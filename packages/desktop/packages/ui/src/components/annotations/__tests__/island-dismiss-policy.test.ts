import { describe, expect, it } from 'bun:test'
import { resolveIslandOutsideDismissAction } from '../island-dismiss-policy'

describe('island dismiss policy', () => {
  it('chooses back on outside click when stack is not compact', () => {
    const action = resolveIslandOutsideDismissAction({
      isCompactView: false,
      behavior: 'back-or-close',
    })

    expect(action).toBe('back')
  })

  it('chooses close on outside click when compact/root view is active', () => {
    const action = resolveIslandOutsideDismissAction({
      isCompactView: true,
      behavior: 'back-or-close',
    })

    expect(action).toBe('close')
  })

  it('honors close-only behavior regardless of stack state', () => {
    const compactAction = resolveIslandOutsideDismissAction({
      isCompactView: true,
      behavior: 'close-only',
    })
    const stackedAction = resolveIslandOutsideDismissAction({
      isCompactView: false,
      behavior: 'close-only',
    })

    expect(compactAction).toBe('close')
    expect(stackedAction).toBe('close')
  })
})
