/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Map the gateway's webpush {@link PushPayload} onto an APNs payload
 * (add-native-mobile-shells "APNs delivery pipeline"): `aps.alert.title` from
 * `summary`, `aps.alert.body` from a short subtitle (the session name), `category`
 * from `kind`, `thread-id` from `sessionId`, and `mutable-content:1` for
 * `permission.required` (so the iOS notification-service extension can add inline
 * approve actions). The same non-secret deep-link fields ride alongside `aps`.
 */

import type { PushPayload } from '../webpush/payload.js';

export interface ApnsPayload {
  aps: {
    alert: { title: string; body?: string };
    category: string;
    'thread-id': string;
    'mutable-content'?: 1;
  };
  // Custom keys (read by the shell to deep-link). No tokens/secrets.
  kind: string;
  sessionId: string;
  url: string;
  requestId?: string;
  approveOptionId?: string;
}

export function buildApnsPayload(payload: PushPayload): ApnsPayload {
  const out: ApnsPayload = {
    aps: {
      alert: {
        title: payload.summary,
        ...(payload.sessionName ? { body: payload.sessionName } : {}),
      },
      category: payload.kind,
      'thread-id': payload.sessionId,
      ...(payload.kind === 'permission.required'
        ? { 'mutable-content': 1 as const }
        : {}),
    },
    kind: payload.kind,
    sessionId: payload.sessionId,
    url: payload.url,
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
    ...(payload.approveOptionId
      ? { approveOptionId: payload.approveOptionId }
      : {}),
  };
  return out;
}
