import { describe, expect, it } from 'bun:test'
import { buildSemanticHistoryKey, canRunInitialRestore } from '../navigation-history'

describe('buildSemanticHistoryKey', () => {
  it('changes when focused panel index changes even if routes are identical', () => {
    const panelRoutes = ['allSessions/session/s1', 'allSessions/session/s1']

    const keyA = buildSemanticHistoryKey({
      workspaceSlug: 'ws',
      panelRoutes,
      focusedPanelIndex: 0,
      sidebarParam: '',
    })

    const keyB = buildSemanticHistoryKey({
      workspaceSlug: 'ws',
      panelRoutes,
      focusedPanelIndex: 1,
      sidebarParam: '',
    })

    expect(keyA).not.toBe(keyB)
  })

  it('stays stable for identical semantic inputs', () => {
    const input = {
      workspaceSlug: 'ws',
      panelRoutes: ['allSessions/session/s1', 'sources/source/github'],
      focusedPanelIndex: 1,
      sidebarParam: 'files',
    }

    const keyA = buildSemanticHistoryKey(input)
    const keyB = buildSemanticHistoryKey(input)

    expect(keyA).toBe(keyB)
  })
})

describe('canRunInitialRestore', () => {
  it('returns false until session metadata is ready', () => {
    expect(canRunInitialRestore({
      isReady: true,
      isSessionsReady: false,
      workspaceId: 'ws-1',
      initialRouteRestored: false,
    })).toBe(false)
  })

  it('returns true only when all restore conditions are satisfied', () => {
    expect(canRunInitialRestore({
      isReady: true,
      isSessionsReady: true,
      workspaceId: 'ws-1',
      initialRouteRestored: false,
    })).toBe(true)

    expect(canRunInitialRestore({
      isReady: true,
      isSessionsReady: true,
      workspaceId: 'ws-1',
      initialRouteRestored: true,
    })).toBe(false)
  })
})
