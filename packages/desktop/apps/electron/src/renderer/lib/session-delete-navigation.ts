import { routes, type Route } from './navigate'

interface SessionDeleteNavigationOptions {
  deleted: boolean
  deletedSessionId: string
  selectedSessionId: string | null | undefined
}

export function getSessionDeleteNavigationRoute({
  deleted,
  deletedSessionId,
  selectedSessionId,
}: SessionDeleteNavigationOptions): Route | null {
  if (!deleted || selectedSessionId !== deletedSessionId) {
    return null
  }

  return routes.action.newSession()
}
