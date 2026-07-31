import { describe, expect, it } from 'bun:test'
import { releaseBrowserOwnershipOnForcedStop } from '@craft-agent/server-core/domain'

describe('releaseBrowserOwnershipOnForcedStop', () => {
  it('clears visuals and unbinds session ownership', async () => {
    const calls: string[] = []

    const browserPaneManager = {
      clearVisualsForSession: async (sessionId: string) => {
        calls.push(`clear:${sessionId}`)
      },
      unbindAllForSession: (sessionId: string) => {
        calls.push(`unbind:${sessionId}`)
      },
    }

    await releaseBrowserOwnershipOnForcedStop(browserPaneManager, 'session-1')

    expect(calls).toEqual(['clear:session-1', 'unbind:session-1'])
  })

  it('is a safe no-op when browser manager is missing', async () => {
    await expect(releaseBrowserOwnershipOnForcedStop(null, 'session-2')).resolves.toBeUndefined()
    await expect(releaseBrowserOwnershipOnForcedStop(undefined, 'session-3')).resolves.toBeUndefined()
  })
})
