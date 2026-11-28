/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildMessage } from './message-factory.js';

describe('buildMessage', () => {
  it('builds a Message from a stamp with defaults', () => {
    const message = buildMessage({
      uuid: 'm1',
      sessionId: 's1',
      role: 'assistant',
      payload: { content: 'hello' },
    });

    expect(message.getUuid()).toBe('m1');
    expect(message.getSessionId()).toBe('s1');
    expect(message.getRole()).toBe('assistant');
    expect(message.getParent()).toBeNull();
    expect(message.getPayload()).toEqual({ content: 'hello' });
  });

  it('defaults missing fields', () => {
    const message = buildMessage({});

    expect(message.getUuid()).toBe('');
    expect(message.getRole()).toBe('user');
    expect(message.getParent()).toBeNull();
    expect(message.getTimestamp()).toMatch(/\d{4}-/);
  });
});
