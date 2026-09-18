/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface BackgroundNotificationTurn {
  turnId: string;
  taskId: string;
  /**
   * `peer` is a message from another session or an outside program,
   * accepted by this session's cross-session gate; its `taskId` is the
   * message id.
   */
  kind: 'agent' | 'monitor' | 'shell' | 'workflow' | 'peer';
  toolUseId?: string;
  sourceTurnId?: string;
  label?: string;
  startedAt: number;
}

export const backgroundTurnContext = new AsyncLocalStorage<{
  sessionId: string;
  turn: BackgroundNotificationTurn;
  active: boolean;
}>();
