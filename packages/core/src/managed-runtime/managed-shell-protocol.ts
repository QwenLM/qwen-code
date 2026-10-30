/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSessionKey } from './managed-session-records.js';

// H3 of #12827: the private maintenance route for background Shells,
// sibling to `managed-hook-protocol.ts`. Status and terminate are the only
// kinds: both answer about one supervised process named by
// `targetOperationId` — the start call's runtime invocation identity —
// never about a new model turn. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

export const MANAGED_SHELL_ROUTE = '/internal/managed-runtime/v3/shells';

interface Identity {
  readonly sessionKey: ManagedSessionKey;
  readonly operationId: string;
}

export type ManagedShellLook = Identity & {
  readonly targetOperationId: string;
} & ({ readonly kind: 'shell-status' } | { readonly kind: 'shell-terminate' });

export type ManagedShellControl = ManagedShellLook;

/**
 * The supervised unit's name, derived from the runtime invocation
 * identity, so Java, the hosted turn and the worker all derive the same
 * unit without a lookup.
 */
export function shellUnitNameOf(targetOperationId: string): string {
  return `qwen-bg-${targetOperationId.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

export interface ManagedShellExitEvidence {
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

export interface ManagedShellOperationView {
  readonly operationId: string;
  /** `exited` is proven, `running` is registered-live, `unknown` is nothing. */
  readonly state: 'exited' | 'running' | 'unknown';
  readonly unitName?: string;
  readonly evidence?: ManagedShellExitEvidence;
}
