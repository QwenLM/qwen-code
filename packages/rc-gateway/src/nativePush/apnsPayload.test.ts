/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildApnsPayload } from './apnsPayload.js';
import type { PushPayload } from '../webpush/payload.js';

const base: PushPayload = {
  v: 1,
  kind: 'agent.completed',
  sessionId: 'sess_1',
  sessionName: 'my project',
  summary: 'Agent finished',
  url: '/ui/?session=sess_1',
};

describe('buildApnsPayload', () => {
  it('mirrors the webpush payload into the aps structure', () => {
    const p = buildApnsPayload(base);
    expect(p.aps.alert.title).toBe('Agent finished'); // from summary
    expect(p.aps.alert.body).toBe('my project'); // from a short subtitle
    expect(p.aps.category).toBe('agent.completed'); // from kind
    expect(p.aps['thread-id']).toBe('sess_1'); // from sessionId
    expect(p.aps['mutable-content']).toBeUndefined(); // only for permission.required
  });

  it('sets mutable-content:1 for permission.required', () => {
    const p = buildApnsPayload({
      ...base,
      kind: 'permission.required',
      requestId: 'req_9',
      approveOptionId: 'opt_1',
    });
    expect(p.aps['mutable-content']).toBe(1);
    // custom deep-link data is carried alongside aps, no secrets
    expect(p.kind).toBe('permission.required');
    expect(p.sessionId).toBe('sess_1');
    expect(p.requestId).toBe('req_9');
    expect(p.approveOptionId).toBe('opt_1');
    expect(p.url).toBe('/ui/?session=sess_1');
  });

  it('omits a body when there is no session name', () => {
    const p = buildApnsPayload({ ...base, sessionName: undefined });
    expect(p.aps.alert.body).toBeUndefined();
  });
});
