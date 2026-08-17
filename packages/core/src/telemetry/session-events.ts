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

// The SDK settle-time catch-up in initializeTelemetry and logStartSession can
// both observe the same session in every init mode. Keep session.start
// idempotent so those two legitimate paths cannot duplicate the record.
let startedSessionId: string | undefined;

export function emitSessionStart(
  sessionId: string,
  previousSessionId?: string,
): void {
  if (startedSessionId === sessionId) return;
  startedSessionId = sessionId;

  const attributes: LogAttributes = {
    'event.name': EVENT_SESSION_START,
    'event.timestamp': new Date().toISOString(),
    'session.id': sessionId,
    ...(previousSessionId ? { 'session.previous_id': previousSessionId } : {}),
  };

  logs.getLogger(SERVICE_NAME).emit({
    body: 'Session started.',
    attributes,
  });
}

export function emitSessionEnd(sessionId: string): void {
  if (startedSessionId === sessionId) {
    startedSessionId = undefined;
  }

  logs.getLogger(SERVICE_NAME).emit({
    body: 'Session ended.',
    attributes: {
      'event.name': EVENT_SESSION_END,
      'event.timestamp': new Date().toISOString(),
      'session.id': sessionId,
    },
  });
}
