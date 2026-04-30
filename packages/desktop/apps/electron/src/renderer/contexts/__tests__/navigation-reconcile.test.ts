import { describe, expect, it } from 'bun:test'
import { normalizePanelRouteForReconcile } from '../navigation-reconcile'
import type { NavigationState } from '../../../shared/types'

describe('normalizePanelRouteForReconcile', () => {
  it('auto-selects session details for filter-only session routes', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions/session/s1')
  })

  it('keeps explicit session details unchanged', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions/session/s2', resolver)
    expect(normalized).toBe('allSessions/session/s2')
  })

  it('normalizes each session panel route independently', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        const sessionId = state.filter.kind === 'flagged' ? 'flagged-1' : 'all-1'
        return {
          ...state,
          details: { type: 'session', sessionId },
        }
      }
      return state
    }

    const routes = ['allSessions', 'flagged'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/all-1', 'flagged/session/flagged-1'])
  })

  it('keeps route unchanged when resolver leaves state without details', () => {
    const resolver = (state: NavigationState): NavigationState => state

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions')
  })

  it('keeps non-session routes unchanged with session-only resolver', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('settings', resolver)).toBe('settings/app')
    expect(normalizePanelRouteForReconcile('sources', resolver)).toBe('sources')
  })

  it('keeps explicit detail route even if resolver tries to rewrite it', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if ('details' in state) {
        if (state.navigator === 'sessions') {
          return { ...state, details: { type: 'session', sessionId: 'rewritten' } }
        }
        if (state.navigator === 'sources') {
          return { ...state, details: { type: 'source', sourceSlug: 'rewritten' } }
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('allSessions/session/s2', resolver)).toBe('allSessions/session/s2')
    expect(normalizePanelRouteForReconcile('sources/source/github', resolver)).toBe('sources/source/github')
  })

  it('keeps explicit detail routes distinct across multiple panels', () => {
    const resolver = (_state: NavigationState): NavigationState => {
      return {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: { type: 'session', sessionId: 'same' },
      }
    }

    const routes = ['allSessions/session/left', 'allSessions/session/right'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/left', 'allSessions/session/right'])
  })
})
