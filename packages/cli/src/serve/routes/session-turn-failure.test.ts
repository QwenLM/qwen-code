/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { describePromptTurnFailure } from './session.js';

describe('describePromptTurnFailure', () => {
  it('keeps Error name and message', () => {
    const err = new Error('agent channel closed mid-request');
    err.name = 'BridgeChannelClosedError';
    expect(describePromptTurnFailure(err)).toBe(
      '[BridgeChannelClosedError] agent channel closed mid-request',
    );
  });

  it('extracts message and code from a bare JSON-RPC error object', () => {
    expect(
      describePromptTurnFailure({ code: -32603, message: 'Internal error' }),
    ).toBe('[code -32603] Internal error');
  });

  it('prefers JSON-RPC data details over the generic message', () => {
    expect(
      describePromptTurnFailure({
        code: -32603,
        message: 'Internal error',
        data: { details: 'model provider rejected the request' },
      }),
    ).toBe('[code -32603] model provider rejected the request');
  });

  it('prefers nested provider error text shipped as parsed data', () => {
    expect(
      describePromptTurnFailure({
        code: -32603,
        message: 'Internal error',
        data: { error: { message: 'upstream 429 rate limited' } },
      }),
    ).toBe('[code -32603] upstream 429 rate limited');
  });

  it('reads a plain object message property without a code', () => {
    expect(describePromptTurnFailure({ message: 'something broke' })).toBe(
      'something broke',
    );
  });

  it('never degrades structured rejections to [object Object]', () => {
    const candidates: unknown[] = [
      { code: -32000, message: 'boom' },
      { code: 'EPIPE', message: 'write failed' },
      { data: 'provider closed the stream' },
      { message: 'partial' },
    ];
    for (const candidate of candidates) {
      expect(describePromptTurnFailure(candidate)).not.toContain(
        '[object Object]',
      );
    }
  });

  it('stringifies primitive rejections', () => {
    expect(describePromptTurnFailure('socket hang up')).toBe('socket hang up');
  });
});
