/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isChannelStartupFailure,
  isChannelStartupReportAckMessage,
  isChannelStartupReportMessage,
  isChannelStartupReportType,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
} from './channel-worker-startup-ipc.js';

describe('channel worker startup IPC', () => {
  it('accepts bounded connect failures and protocol messages', () => {
    const failure = {
      channel: 'telegram',
      phase: 'connect' as const,
      code: 'ECONNREFUSED',
      message: 'connection refused',
    };

    expect(isChannelStartupFailure(failure)).toBe(true);
    expect(
      isChannelStartupReportMessage({
        type: 'channel_startup_failure',
        failure,
      }),
    ).toBe(true);
    expect(
      isChannelStartupReportMessage({
        type: 'channel_startup_failures_truncated',
      }),
    ).toBe(true);
    expect(
      isChannelStartupReportAckMessage({
        type: 'channel_startup_report_ack',
      }),
    ).toBe(true);
  });

  it('rejects malformed and overlong failure fields by code point', () => {
    expect(
      isChannelStartupFailure({
        channel: '',
        phase: 'connect',
        message: 'failed',
      }),
    ).toBe(false);
    expect(
      isChannelStartupReportMessage({
        type: 'channel_startup_failure',
      }),
    ).toBe(false);
    expect(
      isChannelStartupFailure({
        channel: 'telegram',
        phase: 'create',
        message: 'failed',
      }),
    ).toBe(false);
    expect(
      isChannelStartupFailure({
        channel: '😀'.repeat(MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH + 1),
        phase: 'connect',
        message: 'failed',
      }),
    ).toBe(false);
    expect(
      isChannelStartupFailure({
        channel: 'telegram',
        phase: 'connect',
        code: 'x'.repeat(MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH + 1),
        message: 'failed',
      }),
    ).toBe(false);
    expect(
      isChannelStartupFailure({
        channel: 'telegram',
        phase: 'connect',
        message: 'x'.repeat(MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH + 1),
      }),
    ).toBe(false);
  });

  it('distinguishes known startup report types from unrelated IPC', () => {
    expect(
      isChannelStartupReportType({ type: 'channel_startup_failure' }),
    ).toBe(true);
    expect(isChannelStartupReportType({ type: 'ready' })).toBe(false);
    expect(isChannelStartupReportType(null)).toBe(false);

    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('malformed IPC getter');
        },
      },
    );
    expect(isChannelStartupFailure(throwing)).toBe(false);
    expect(isChannelStartupReportMessage(throwing)).toBe(false);
    expect(isChannelStartupReportAckMessage(throwing)).toBe(false);
    expect(isChannelStartupReportType(throwing)).toBe(false);
  });
});
