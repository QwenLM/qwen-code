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

  it('extracts data details from Error rejections carrying JSON-RPC data', () => {
    const err = Object.assign(new Error('Internal error'), {
      name: 'RequestError',
      data: { details: 'session not found' },
    });
    expect(describePromptTurnFailure(err)).toBe(
      '[RequestError] session not found',
    );
  });

  it('keeps the Error name prefix over a code prefix', () => {
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(describePromptTurnFailure(err)).toBe('[Error] write EPIPE');
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
      { code: -32603 },
      {},
      { message: '' },
    ];
    for (const candidate of candidates) {
      const rendered = describePromptTurnFailure(candidate);
      expect(rendered).not.toBe('');
      expect(rendered).not.toContain('[object Object]');
    }
  });

  it('stringifies primitive rejections', () => {
    expect(describePromptTurnFailure('socket hang up')).toBe('socket hang up');
  });
});
