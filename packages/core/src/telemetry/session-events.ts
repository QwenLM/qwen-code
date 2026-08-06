/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { logs } from '@opentelemetry/api-logs';
import type { LogAttributes } from '@opentelemetry/api-logs';
import {
  EVENT_SESSION_END,
  EVENT_SESSION_START,
  SERVICE_NAME,
} from './constants.js';

export function emitSessionStart(
  sessionId: string,
  previousSessionId?: string,
): void {
  const attributes: LogAttributes = {
    'event.name': EVENT_SESSION_START,
    'session.id': sessionId,
    ...(previousSessionId ? { 'session.previous_id': previousSessionId } : {}),
  };

  logs.getLogger(SERVICE_NAME).emit({
    body: 'Session started.',
    attributes,
  });
}

export function emitSessionEnd(sessionId: string): void {
  logs.getLogger(SERVICE_NAME).emit({
    body: 'Session ended.',
    attributes: {
      'event.name': EVENT_SESSION_END,
      'session.id': sessionId,
    },
  });
}
