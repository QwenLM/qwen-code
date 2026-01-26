/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createDebugLogger,
  isDebugLoggingDegraded,
  resetDebugLoggingState,
  setDebugLogSession,
  type DebugLogSession,
} from './debugLogger.js';
import { promises as fs } from 'node:fs';
import { Storage } from '../config/storage.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe('debugLogger', () => {
  const mockSession: DebugLogSession = {
    getSessionId: () => 'test-session-123',
  };

  const previousDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];

  beforeEach(() => {
    process.env['QWEN_DEBUG_LOG_FILE'] = '1';
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T10:30:00.000Z'));
    resetDebugLoggingState();
    setDebugLogSession(mockSession);
  });

  afterEach(() => {
    vi.useRealTimers();
    setDebugLogSession(null);
    if (previousDebugLogFileEnv === undefined) {
      delete process.env['QWEN_DEBUG_LOG_FILE'];
    } else {
      process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFileEnv;
    }
  });

  describe('createDebugLogger', () => {
    it('returns no-op logger when session is unset', () => {
      setDebugLogSession(null);
      const logger = createDebugLogger();
      // Should not throw
      logger.debug('test');
      logger.info('test');
      logger.warn('test');
      logger.error('test');
      expect(fs.appendFile).not.toHaveBeenCalled();
    });

    it('writes debug log with correct format', async () => {
      const logger = createDebugLogger();
      logger.debug('Hello world');

      await vi.runAllTimersAsync();

      expect(fs.mkdir).toHaveBeenCalledWith(Storage.getGlobalDebugDir(), {
        recursive: true,
      });
      expect(fs.appendFile).toHaveBeenCalledWith(
        Storage.getDebugLogPath('test-session-123'),
        '2026-01-24T10:30:00.000Z [DEBUG] Hello world\n',
        'utf8',
      );
    });

    it('writes log with tag when provided', async () => {
      const logger = createDebugLogger('STARTUP');
      logger.info('Server started');

      await vi.runAllTimersAsync();

      expect(fs.appendFile).toHaveBeenCalledWith(
        Storage.getDebugLogPath('test-session-123'),
        '2026-01-24T10:30:00.000Z [INFO] [STARTUP] Server started\n',
        'utf8',
      );
    });

    it('writes different log levels correctly', async () => {
      const logger = createDebugLogger();

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      await vi.runAllTimersAsync();

      const calls = vi.mocked(fs.appendFile).mock.calls;
      expect(calls[0]?.[1]).toContain('[DEBUG]');
      expect(calls[1]?.[1]).toContain('[INFO]');
      expect(calls[2]?.[1]).toContain('[WARN]');
      expect(calls[3]?.[1]).toContain('[ERROR]');
    });

    it('formats multiple arguments', async () => {
      const logger = createDebugLogger();
      logger.debug('Count:', 42, 'items');

      await vi.runAllTimersAsync();

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Count: 42 items'),
        'utf8',
      );
    });

    it('formats Error objects with stack trace', async () => {
      const logger = createDebugLogger();
      const error = new Error('Something went wrong');
      logger.error('Failed:', error);

      await vi.runAllTimersAsync();

      const call = vi.mocked(fs.appendFile).mock.calls[0];
      expect(call?.[1]).toContain('Failed:');
      expect(call?.[1]).toContain('Error: Something went wrong');
    });

    it('formats objects using util.inspect', async () => {
      const logger = createDebugLogger();
      logger.debug('Data:', { foo: 'bar', count: 123 });

      await vi.runAllTimersAsync();

      const call = vi.mocked(fs.appendFile).mock.calls[0];
      expect(call?.[1]).toContain('foo');
      expect(call?.[1]).toContain('bar');
    });
  });

  describe('isDebugLoggingDegraded', () => {
    it('returns false when no failures have occurred', () => {
      expect(isDebugLoggingDegraded()).toBe(false);
    });

    it('returns true when mkdir fails', async () => {
      vi.mocked(fs.mkdir).mockRejectedValueOnce(new Error('Permission denied'));

      const logger = createDebugLogger();
      logger.debug('test');

      await vi.runAllTimersAsync();

      expect(isDebugLoggingDegraded()).toBe(true);
    });

    it('returns true when appendFile fails', async () => {
      vi.mocked(fs.appendFile).mockRejectedValueOnce(new Error('Disk full'));

      const logger = createDebugLogger();
      logger.debug('test');

      await vi.runAllTimersAsync();

      expect(isDebugLoggingDegraded()).toBe(true);
    });

    it('stays true after failure even if subsequent writes succeed', async () => {
      vi.mocked(fs.appendFile).mockRejectedValueOnce(
        new Error('Temporary error'),
      );

      const logger = createDebugLogger();
      logger.debug('first write fails');
      await vi.runAllTimersAsync();

      expect(isDebugLoggingDegraded()).toBe(true);

      // Reset mock to succeed
      vi.mocked(fs.appendFile).mockResolvedValue(undefined);
      logger.debug('second write succeeds');
      await vi.runAllTimersAsync();

      // Should still be degraded
      expect(isDebugLoggingDegraded()).toBe(true);
    });
  });

  describe('resetDebugLoggingState', () => {
    it('resets the degraded state', async () => {
      vi.mocked(fs.appendFile).mockRejectedValueOnce(new Error('Disk full'));

      const logger = createDebugLogger();
      logger.debug('test');
      await vi.runAllTimersAsync();

      expect(isDebugLoggingDegraded()).toBe(true);

      resetDebugLoggingState();

      expect(isDebugLoggingDegraded()).toBe(false);
    });
  });
});
