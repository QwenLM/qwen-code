/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildDaemonLogLine, initDaemonLogger } from './daemonLogger.js';

describe('buildDaemonLogLine', () => {
  const FIXED = new Date('2026-05-26T03:14:15.926Z');

  it('formats INFO with no ctx', () => {
    expect(
      buildDaemonLogLine({
        level: 'INFO',
        message: 'daemon started',
        now: FIXED,
      }),
    ).toBe('2026-05-26T03:14:15.926Z [INFO] [DAEMON] daemon started\n');
  });

  it('renders ctx fields in fixed order', () => {
    const line = buildDaemonLogLine({
      level: 'ERROR',
      message: 'route failed',
      now: FIXED,
      ctx: {
        sessionId: 'sess-1',
        route: 'POST /session/:id/prompt',
        clientId: 'client-x',
        childPid: 4242,
        channelId: 'ch-9',
      },
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [ERROR] [DAEMON] ' +
        'route=POST /session/:id/prompt sessionId=sess-1 clientId=client-x ' +
        'childPid=4242 channelId=ch-9 route failed\n',
    );
  });

  it('appends extra ctx keys sorted lexicographically after fixed keys', () => {
    const line = buildDaemonLogLine({
      level: 'WARN',
      message: 'note',
      now: FIXED,
      ctx: { zeta: 1, alpha: 'a', sessionId: 's' },
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [WARN] [DAEMON] sessionId=s alpha=a zeta=1 note\n',
    );
  });

  it('JSON.stringify-quotes values that contain spaces or =', () => {
    const line = buildDaemonLogLine({
      level: 'INFO',
      message: 'hi',
      now: FIXED,
      ctx: { weird: 'has space', eq: 'a=b' },
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [INFO] [DAEMON] eq="a=b" weird="has space" hi\n',
    );
  });

  it('appends error stack as indented continuation lines', () => {
    const err = new Error('boom');
    err.stack =
      'Error: boom\n    at fn (file.ts:1:1)\n    at main (file.ts:2:2)';
    const line = buildDaemonLogLine({
      level: 'ERROR',
      message: 'failed',
      now: FIXED,
      err,
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [ERROR] [DAEMON] failed\n' +
        '  Error: boom\n' +
        '      at fn (file.ts:1:1)\n' +
        '      at main (file.ts:2:2)\n',
    );
  });

  it('falls back to err.message when stack missing', () => {
    const err: Error = { name: 'Plain', message: 'no stack' } as Error;
    const line = buildDaemonLogLine({
      level: 'ERROR',
      message: 'failed',
      now: FIXED,
      err,
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [ERROR] [DAEMON] failed\n' +
        '  Plain: no stack\n',
    );
  });
});

describe('initDaemonLogger opt-out', () => {
  const originalEnv = process.env['QWEN_DAEMON_LOG_FILE'];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env['QWEN_DAEMON_LOG_FILE'];
    else process.env['QWEN_DAEMON_LOG_FILE'] = originalEnv;
  });

  for (const val of ['0', 'false', 'off', 'no', 'False', ' OFF ']) {
    it(`returns no-op logger when QWEN_DAEMON_LOG_FILE=${JSON.stringify(val)}`, () => {
      process.env['QWEN_DAEMON_LOG_FILE'] = val;
      const stderr: string[] = [];
      const logger = initDaemonLogger({
        boundWorkspace: '/tmp/ws',
        baseDir: '/tmp/nonexistent-should-not-touch',
        stderr: (s) => stderr.push(s),
      });
      logger.info('hello');
      logger.warn('there');
      logger.error('boom');
      logger.raw('raw');
      expect(stderr).toEqual([]); // no-op = nothing
      expect(logger.getLogPath()).toBe('');
      expect(logger.getDaemonId()).toBe('');
    });
  }
});
