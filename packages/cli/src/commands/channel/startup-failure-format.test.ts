/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  channelStartupFailureBody,
  formatChannelStartupFailures,
  safeChannelCommandErrorMessage,
  sanitizeChannelCommandValue,
} from './startup-failure-format.js';

describe('channel startup failure formatting', () => {
  it('normalizes before redacting and truncating daemon diagnostics', () => {
    const lines = formatChannelStartupFailures({
      startupFailures: [
        {
          workspaceCwd: '/work',
          channel: 'telegram',
          phase: 'connect',
          code: 'ECONNREFUSED',
          message:
            'Authorization: Bea\u200b\u0085rer secret-token; Bearer \u001b]0;window-title\u0007 runtime-secret https://user:pass@example.com/path',
        },
      ],
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret-token');
    expect(lines[0]).not.toContain('runtime-secret');
    expect(lines[0]).not.toContain('user:pass');
    expect(lines[0]).not.toContain('\u200b');
    expect(lines[0]).not.toContain('\u0085');
  });

  it('caps output at 64 failures and appends one truncation line', () => {
    const startupFailures = Array.from({ length: 65 }, (_, index) => ({
      workspaceCwd: '/work',
      channel: `channel-${index}`,
      phase: 'connect',
      message: `failure-${index}`,
    }));

    const lines = formatChannelStartupFailures({ startupFailures });

    expect(lines).toHaveLength(65);
    expect(lines[63]).toContain('channel-63');
    expect(lines[64]).toBe(
      '[Channel] Additional startup failures were truncated.',
    );
    expect(lines.join('\n')).not.toContain('channel-64');
  });

  it('ignores malformed entries and throwing getters without exposing values', () => {
    const throwing = {};
    Object.defineProperty(throwing, 'message', {
      get() {
        throw new Error('secret getter value');
      },
    });
    const lines = formatChannelStartupFailures({
      startupFailures: [
        throwing,
        { channel: 'bad', phase: 'create', message: 'must not render' },
        { channel: '', phase: 'connect', message: 'must not render' },
      ],
    });

    expect(lines).toEqual([]);

    const throwingArray = new Proxy([], {
      get() {
        throw new Error('array getter failed');
      },
    });
    expect(
      formatChannelStartupFailures({ startupFailures: throwingArray }),
    ).toEqual([]);
  });

  it('reads only channel worker start error bodies and safely formats errors', () => {
    expect(
      channelStartupFailureBody({
        body: { code: 'channel_worker_start_failed' },
      }),
    ).toEqual({ code: 'channel_worker_start_failed' });
    expect(
      channelStartupFailureBody({ body: { code: 'unrelated_error' } }),
    ).toBeUndefined();
    expect(
      safeChannelCommandErrorMessage(
        new Error('Authorization: Bearer command-secret'),
      ),
    ).not.toContain('command-secret');
    expect(
      sanitizeChannelCommandValue('https://user:pass@example.com'),
    ).not.toContain('user:pass');

    const throwingBody = {};
    Object.defineProperty(throwingBody, 'body', {
      get() {
        throw new Error('body getter failed');
      },
    });
    expect(channelStartupFailureBody(throwingBody)).toBeUndefined();
  });
});
