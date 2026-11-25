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
   * What produced the turn. `peer` is a message another session sent to
   * this one, which the cross-session gate accepted; it is not a task, so
   * its `taskId` is the message id and nothing in the task registry
   * answers to it.
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
