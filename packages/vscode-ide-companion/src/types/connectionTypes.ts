/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'child_process';
import type {
  AcpSessionUpdate,
  AcpPermissionRequest,
  AuthenticateUpdateNotification,
} from './acpTypes.js';

export interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  method: string;
}

export interface AcpConnectionCallbacks {
  onSessionUpdate: (data: AcpSessionUpdate) => void;
  onPermissionRequest: (data: AcpPermissionRequest) => Promise<{
    optionId: string;
  }>;
  onAuthenticateUpdate: (data: AuthenticateUpdateNotification) => void;
  onEndTurn: (reason?: string) => void;
}

export interface AcpConnectionState {
  child: ChildProcess | null;
  pendingRequests: Map<number, PendingRequest<unknown>>;
  nextRequestId: number;
  sessionId: string | null;
  isInitialized: boolean;
}
