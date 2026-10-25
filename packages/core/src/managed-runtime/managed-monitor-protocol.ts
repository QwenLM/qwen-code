/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSessionKey } from './managed-session-records.js';
import type { ManagedShellExitEvidence } from './managed-shell-protocol.js';

// H3 of #12827: the private maintenance route for Monitors, sibling to
// `managed-shell-protocol.ts`. Status and stop are the kinds: both answer
// about one supervised watch named by `targetOperationId` — the execution
// identity that started it — never about a new model turn. The stop kind
// carries the recovery `targetOperationId` as the design's recovery list
// requires. See docs/design/2026-10-03-managed-shell-monitor-runtime.md.

export const MANAGED_MONITOR_ROUTE = '/internal/managed-runtime/v3/monitors';

interface Identity {
  readonly sessionKey: ManagedSessionKey;
  readonly operationId: string;
}

export type ManagedMonitorLook = Identity & {
  readonly targetOperationId: string;
} & ({ readonly kind: 'monitor-status' } | { readonly kind: 'monitor-stop' });

export type ManagedMonitorControl = ManagedMonitorLook;

/**
 * The supervised watch unit's name, derived from the execution identity,
 * so the route, the watcher and every maintainer derive the same unit
 * without a lookup.
 */
export function monitorUnitNameOf(targetOperationId: string): string {
  return `qwen-mon-${targetOperationId.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

export interface ManagedMonitorOperationView {
  readonly operationId: string;
  readonly state: 'running' | 'exited' | 'unknown';
  readonly unitName?: string;
  readonly evidence?: ManagedShellExitEvidence;
}
