/**
 * Navigation Utilities
 *
 * Provides a unified `navigate()` function for internal navigation.
 * Works by dispatching a custom event that the NavigationContext listens for.
 *
 * Usage:
 *   import { navigate, routes } from '@/lib/navigate'
 *
 *   navigate(routes.tab.settings())
 *   navigate(routes.action.newChat({ agentId: 'qwen' }))
 *   navigate(routes.view.allSessions())
 */

import { routes, type Route } from '../../shared/routes'

// Re-export routes for convenience
export { routes }
export type { Route }

// Event name for internal navigation
export const NAVIGATE_EVENT = 'craft-agent-navigate'

export interface NavigateOptions {
  /** Open the target in a new panel instead of navigating the current one */
  newPanel?: boolean
  /**
   * Optional explicit lane target for new-panel opens.
   *
   * This is intentionally generic (not browser-specific) so future lane types
   * can reuse the same API without introducing per-feature navigation flags.
   */
  targetLaneId?: 'main'
  /** Skip auto-selecting first item when navigating to a list view (used when closing panels) */
  skipAutoSelect?: boolean
}

/**
 * Navigate to a route
 *
 * This dispatches a custom event that the NavigationContext listens for.
 * Can be called from anywhere in the app.
 */
export function navigate(route: Route, options?: NavigateOptions): void {
  const event = new CustomEvent(NAVIGATE_EVENT, {
    detail: { route, ...options },
    bubbles: true,
  })
  window.dispatchEvent(event)
}
