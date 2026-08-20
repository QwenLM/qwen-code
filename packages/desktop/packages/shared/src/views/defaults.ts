/**
 * Default Views
 *
 * Built-in views provided to new workspaces (or when views.json is missing).
 * Users can modify or remove these — they're just the starting point.
 */

import type { ViewConfig } from './types.ts';

/**
 * Default views seeded into views.json.
 * Each represents a common session state that users want to see at a glance.
 */
export function getDefaultViews(): ViewConfig[] {
  return [
    {
      id: 'view-new',
      name: 'New',
      description: 'Sessions with unread messages',
      color: 'accent',
      expression: 'hasUnread == true',
    },
    {
      id: 'view-plan',
      name: 'Plan',
      description: 'Sessions with a pending plan awaiting approval',
      color: 'info',
      expression: 'hasPendingPlan == true',
    },
    {
      id: 'view-explore',
      name: 'Explore',
      description: 'Sessions in Explore (read-only) mode',
      color: 'foreground/50',
      expression: 'permissionMode == "safe"',
    },
    {
      id: 'view-processing',
      name: 'Processing',
      description: 'Sessions where the agent is currently running',
      color: 'success',
      expression: 'isProcessing == true',
    },
  ];
}
