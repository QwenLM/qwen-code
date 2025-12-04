/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP Connection Type Definitions
 *
 * Contains all types and interface definitions required for ACP connection
 */

import type { ChildProcess } from 'child_process';
import type {
  AcpSessionUpdate,
  AcpPermissionRequest,
} from '../constants/acpTypes.js';

/**
 * Pending Request Information
 */
export interface PendingRequest<T = unknown> {
  /** Success callback */
  resolve: (value: T) => void;
  /** Failure callback */
  reject: (error: Error) => void;
  /** Timeout timer ID */
  timeoutId?: NodeJS.Timeout;
  /** Request method name */
  method: string;
}

/**
 * ACP Connection Callback Function Types
 */
export interface AcpConnectionCallbacks {
  /** Session update callback */
  onSessionUpdate: (data: AcpSessionUpdate) => void;
  /** Permission request callback */
  onPermissionRequest: (data: AcpPermissionRequest) => Promise<{
    optionId: string;
  }>;
  /** Turn end callback */
  onEndTurn: () => void;
}

/**
 * ACP Connection State
 */
export interface AcpConnectionState {
  /** Child process instance */
  child: ChildProcess | null;
  /** Pending requests map */
  pendingRequests: Map<number, PendingRequest<unknown>>;
  /** Next request ID */
  nextRequestId: number;
  /** Current session ID */
  sessionId: string | null;
  /** Whether initialized */
  isInitialized: boolean;
  /** Backend type */
  backend: string | null;
}
