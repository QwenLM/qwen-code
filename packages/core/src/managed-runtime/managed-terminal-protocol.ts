/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSessionKey } from './managed-session-records.js';

// The private maintenance route for user terminals, sibling to
// `managed-shell-protocol.ts`. Status and terminate are the only kinds: both
// answer about one open terminal named by `targetOperationId` — the terminal
// id the relay admitted the hold for — never about a new model turn. See
// docs/design/2026-11-10-managed-web-terminal.md.

export const MANAGED_TERMINAL_ROUTE = '/internal/managed-runtime/v3/terminals';

interface Identity {
  readonly sessionKey: ManagedSessionKey;
  readonly operationId: string;
}

export type ManagedTerminalLook = Identity & {
  readonly targetOperationId: string;
} & (
    | { readonly kind: 'terminal-status' }
    | { readonly kind: 'terminal-terminate' }
  );

export type ManagedTerminalControl = ManagedTerminalLook;

export interface ManagedTerminalExitEvidence {
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

export interface ManagedTerminalOperationView {
  readonly operationId: string;
  /** `exited` is proven, `running` is registered-live, `unknown` is nothing. */
  readonly state: 'exited' | 'running' | 'unknown';
  /** The worker's unit name; the wire requires it on a `running` answer. */
  readonly unitName?: string;
  readonly evidence?: ManagedTerminalExitEvidence;
}
