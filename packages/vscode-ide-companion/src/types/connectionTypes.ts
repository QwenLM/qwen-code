/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'child_process';
import type {
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  AuthenticateUpdateNotification,
  AskUserQuestionRequest,
} from './acpTypes.js';

export interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  method: string;
}

export interface AcpConnectionCallbacks {
  onSessionUpdate: (data: SessionNotification) => void;
  onPermissionRequest: (data: RequestPermissionRequest) => Promise<{
    optionId: string;
  }>;
  onAuthenticateUpdate: (data: AuthenticateUpdateNotification) => void;
  onEndTurn: (reason?: string) => void;
  onAskUserQuestion: (data: AskUserQuestionRequest) => Promise<{
    optionId: string;
    answers?: Record<string, string>;
  }>;
}

export interface AcpConnectionState {
  child: ChildProcess | null;
  pendingRequests: Map<number, PendingRequest<unknown>>;
  nextRequestId: number;
  sessionId: string | null;
  isInitialized: boolean;
}
