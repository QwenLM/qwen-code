import { describe, expect, it } from 'vitest'
import { routes } from '../navigate'
import { getSessionDeleteNavigationRoute } from '../session-delete-navigation'

describe('getSessionDeleteNavigationRoute', () => {
  it('opens a new session after deleting the selected session', () => {
    expect(
      getSessionDeleteNavigationRoute({
        deleted: true,
        deletedSessionId: 'session-1',
        selectedSessionId: 'session-1',
      }),
    ).toBe(routes.action.newSession())
  })

  it('does not navigate when deletion is cancelled', () => {
    expect(
      getSessionDeleteNavigationRoute({
        deleted: false,
        deletedSessionId: 'session-1',
        selectedSessionId: 'session-1',
      }),
    ).toBeNull()
  })

  it('does not navigate after deleting a background session', () => {
    expect(
      getSessionDeleteNavigationRoute({
        deleted: true,
        deletedSessionId: 'session-1',
        selectedSessionId: 'session-2',
      }),
    ).toBeNull()
  })
})
