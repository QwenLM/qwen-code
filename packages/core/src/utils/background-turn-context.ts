/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface BackgroundNotificationTurn {
  turnId: string;
  taskId: string;
  kind: 'agent' | 'monitor' | 'shell' | 'workflow';
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
