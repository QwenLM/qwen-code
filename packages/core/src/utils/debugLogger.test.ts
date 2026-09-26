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
  runWithDebugLogSession,
  runWithoutDebugLogSession,
  setDebugLogSession,
  type DebugLogSession,
} from './debugLogger.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Storage } from '../config/storage.js';
import { getTraceContext } from '../telemetry/trace-context.js';
import { sessionIdContext } from './sessionIdContext.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      appendFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      symlink: vi.fn().mockResolvedValue(undefined),
      readlink: vi.fn().mockResolvedValue(''),
      copyFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('../telemetry/trace-context.js', () => ({
  getTraceContext: vi.fn().mockReturnValue(null),
}));

const appendFile = vi.mocked(fs.appendFile);
const symlink = vi.mocked(fs.symlink);
const readlink = vi.mocked(fs.readlink);
type Level = 'debug' | 'info' | 'warn' | 'error';

/** Logs once through a fresh untagged logger, then drains timers. */
const logOnce = (level: Level, ...args: unknown[]) => {
  createDebugLogger()[level](...args);
  return vi.runAllTimersAsync();
};

/** Logs `message` at info (inside `sessionId`'s context if given), then drains timers. */
const infoAndFlush = (
  logger: ReturnType<typeof createDebugLogger>,
  message: string,
  sessionId?: string,
) => {
  if (sessionId) sessionIdContext.run(sessionId, () => logger.info(message));
  else logger.info(message);
  return vi.runAllTimersAsync();
};

/** The text of the `index`-th appended log line. */
const lineAt = (index: number) => appendFile.mock.calls[index]?.[1];

/** Asserts some appended line contains `text`. */
const expectLineContaining = (text: string) =>
  expect(appendFile).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining(text),
    'utf8',
  );

describe('debugLogger', () => {
  const mockSession: DebugLogSession = {
    getSessionId: () => 'test-session-123',
  };

  const previousDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];

  beforeEach(async () => {
    process.env['QWEN_DEBUG_LOG_FILE'] = '1';
    Storage.setRuntimeBaseDir(null);
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-24T10:30:00.000Z'));
    resetDebugLoggingState();
    setDebugLogSession(mockSession);
    await vi.runAllTimersAsync();
    resetDebugLoggingState();
    vi.clearAllMocks();
    readlink.mockImplementation(async () => {
      const target = symlink.mock.calls.at(-1)?.[0];
      if (typeof target !== 'string') {
        throw new Error('symlink target unavailable');
      }
      return target;
    });
    vi.mocked(getTraceContext).mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setDebugLogSession(null);
    Storage.setRuntimeBaseDir(null);
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
      logger.debug('test');
      logger.info('test');
      logger.warn('test');
      logger.error('test');
      expect(fs.appendFile).not.toHaveBeenCalled();
    });

    it('suppresses the global debug session within an async context', async () => {
      const logger = createDebugLogger('READ_ONLY');

      await runWithoutDebugLogSession(async () => {
        logger.warn('hidden before await');
        await Promise.resolve();
        logger.error('hidden after await');
      });
      await vi.runAllTimersAsync();

      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.appendFile).not.toHaveBeenCalled();

      logger.info('visible outside context');
      await vi.runAllTimersAsync();
      expect(fs.appendFile).toHaveBeenCalledOnce();
    });

    it('writes debug log without trace context when telemetry context is unset', async () => {
      await logOnce('debug', 'Hello world');

      expect(fs.mkdir).toHaveBeenCalledWith(Storage.getGlobalDebugDir(), {
        recursive: true,
      });
      expect(fs.appendFile).toHaveBeenCalledWith(
        Storage.getDebugLogPath('test-session-123'),
        '2026-01-24T10:30:00.000Z [DEBUG] Hello world\n',
        'utf8',
      );
    });

    it('does not write debug log by default when QWEN_DEBUG_LOG_FILE is unset', async () => {
      delete process.env['QWEN_DEBUG_LOG_FILE'];

      await logOnce('info', 'default log');

      expect(fs.appendFile).not.toHaveBeenCalled();
    });

    it.each(['', ' ', '0', 'false', 'off', 'no'])(
      'does not write debug log when QWEN_DEBUG_LOG_FILE is %j',
      async (value) => {
        process.env['QWEN_DEBUG_LOG_FILE'] = value;

        await logOnce('info', 'disabled log');

        expect(fs.appendFile).not.toHaveBeenCalled();
      },
    );

    it('writes log with tag when provided', async () => {
      createDebugLogger('STARTUP').info('Server started');

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

      expect(lineAt(0)).toContain('[DEBUG]');
      expect(lineAt(1)).toContain('[INFO]');
      expect(lineAt(2)).toContain('[WARN]');
      expect(lineAt(3)).toContain('[ERROR]');
    });

    it('uses trace context when getTraceContext returns a context', async () => {
      vi.mocked(getTraceContext).mockReturnValue({
        traceId: 'realtraceidddddddddddddddddddddd',
        spanId: 'realspanid111111',
        traceFlags: 1,
      });

      await logOnce('debug', 'with real span');

      expectLineContaining(
        '[trace_id=realtraceidddddddddddddddddddddd span_id=realspanid111111]',
      );
    });

    it('omits trace context when getTraceContext returns null', async () => {
      vi.mocked(getTraceContext).mockReturnValue(null);

      await logOnce('debug', 'no trace context');

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.stringContaining('trace_id='),
        'utf8',
      );
    });

    it('does not synthesize span ids when telemetry context is unset', async () => {
      const logger = createDebugLogger();
      logger.debug('first line');
      logger.debug('second line');

      await vi.runAllTimersAsync();

      expect(appendFile.mock.calls).toHaveLength(2);
      expect(lineAt(0)).not.toContain('span_id=');
      expect(lineAt(1)).not.toContain('span_id=');
    });

    it('uses the session root span context for fallback trace context', async () => {
      vi.mocked(getTraceContext).mockReturnValue({
        traceId: 'cccccccccccccccccccccccccccccccc',
        spanId: 'dddddddddddddddd',
        traceFlags: 1,
      });

      await logOnce('debug', 'session root fallback');

      expectLineContaining(
        '[trace_id=cccccccccccccccccccccccccccccccc span_id=dddddddddddddddd]',
      );
    });

    it('creates a new debug directory after the runtime base dir changes', async () => {
      Storage.setRuntimeBaseDir(path.resolve('runtime-a'));
      const logger = createDebugLogger();
      logger.debug('first');
      await vi.runAllTimersAsync();

      Storage.setRuntimeBaseDir(path.resolve('runtime-b'));
      logger.debug('second');
      await vi.runAllTimersAsync();

      const mkdirCalls = vi.mocked(fs.mkdir).mock.calls;
      expect(mkdirCalls).toContainEqual([
        path.join(path.resolve('runtime-a'), 'debug'),
        { recursive: true },
      ]);
      expect(mkdirCalls).toContainEqual([
        path.join(path.resolve('runtime-b'), 'debug'),
        { recursive: true },
      ]);
    });

    it('formats multiple arguments', async () => {
      await logOnce('debug', 'Count:', 42, 'items');

      expectLineContaining('Count: 42 items');
    });

    it('formats Error objects with stack trace', async () => {
      await logOnce('error', 'Failed:', new Error('Something went wrong'));

      expect(lineAt(0)).toContain('Failed:');
      expect(lineAt(0)).toContain('Error: Something went wrong');
    });

    it('formats objects using util.inspect', async () => {
      await logOnce('debug', 'Data:', { foo: 'bar', count: 123 });

      expect(lineAt(0)).toContain('foo');
      expect(lineAt(0)).toContain('bar');
    });

    it('prefers sessionIdContext over the global debug session', async () => {
      // Simulate daemon mode: a Config for session-B was created last and
      // overwrote the process-wide debug session, but this code is running
      // inside session-A's async context.
      setDebugLogSession({ getSessionId: () => 'session-B' });
      await infoAndFlush(
        createDebugLogger('DAEMON'),
        'message from A',
        'session-A',
      );

      expect(fs.appendFile).toHaveBeenCalledWith(
        Storage.getDebugLogPath('session-A'),
        expect.stringContaining('[DAEMON] message from A'),
        'utf8',
      );
      expect(fs.appendFile).not.toHaveBeenCalledWith(
        Storage.getDebugLogPath('session-B'),
        expect.stringContaining('message from A'),
        'utf8',
      );
    });

    it('preserves runWithDebugLogSession override above sessionIdContext', async () => {
      setDebugLogSession({ getSessionId: () => 'session-B' });
      const logger = createDebugLogger('OVERRIDE');

      sessionIdContext.run('session-A', () => {
        runWithDebugLogSession({ getSessionId: () => 'session-C' }, () => {
          logger.info('message from C');
        });
      });

      await vi.runAllTimersAsync();

      expect(fs.appendFile).toHaveBeenCalledExactlyOnceWith(
        Storage.getDebugLogPath('session-C'),
        expect.stringContaining('[OVERRIDE] message from C'),
        'utf8',
      );
    });

    it('honors runWithoutDebugLogSession suppression inside sessionIdContext', async () => {
      setDebugLogSession({ getSessionId: () => 'session-B' });
      const logger = createDebugLogger('SUPPRESSED');

      sessionIdContext.run('session-A', () => {
        runWithoutDebugLogSession(() => {
          logger.info('this must not be logged');
        });
      });

      await vi.runAllTimersAsync();

      expect(fs.appendFile).not.toHaveBeenCalled();
    });
  });

  describe('isDebugLoggingDegraded', () => {
    it('returns false when no failures have occurred', () => {
      expect(isDebugLoggingDegraded()).toBe(false);
    });

    it('returns true when mkdir fails', async () => {
      resetDebugLoggingState();
      vi.mocked(fs.mkdir).mockRejectedValueOnce(new Error('Permission denied'));

      await logOnce('debug', 'test');

      expect(isDebugLoggingDegraded()).toBe(true);
    });

    it('returns true when appendFile fails', async () => {
      appendFile.mockRejectedValueOnce(new Error('Disk full'));

      await logOnce('debug', 'test');

      expect(isDebugLoggingDegraded()).toBe(true);
    });

    it('stays true after failure even if subsequent writes succeed', async () => {
      appendFile.mockRejectedValueOnce(new Error('Temporary error'));

      const logger = createDebugLogger();
      logger.debug('first write fails');
      await vi.runAllTimersAsync();

      expect(isDebugLoggingDegraded()).toBe(true);

      appendFile.mockResolvedValue(undefined);
      logger.debug('second write succeeds');
      await vi.runAllTimersAsync();

      expect(isDebugLoggingDegraded()).toBe(true);
    });
  });

  describe('latest debug log symlink', () => {
    const expectedLatestPath = path.join(Storage.getGlobalDebugDir(), 'latest');
    const uuid = '92ec0176-d354-4147-848b-5cd2d80609c4';
    const otherSession = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const uuidSession: DebugLogSession = { getSessionId: () => uuid };

    /** Resets logger state, sets `session` and drains its alias update. */
    const activate = (session: DebugLogSession | null = uuidSession) => {
      resetDebugLoggingState();
      setDebugLogSession(session);
      return vi.runAllTimersAsync();
    };
    /** Restores the alias mocks' factory defaults for later tests. */
    const restoreAliasMocks = () => {
      symlink.mockResolvedValue(undefined);
      readlink.mockResolvedValue('');
    };

    it('creates a symlink to the current session log file', async () => {
      await activate();

      expect(fs.unlink).toHaveBeenCalledWith(expectedLatestPath);
      expect(symlink).toHaveBeenCalledWith(`${uuid}.txt`, expectedLatestPath);
    });

    it('does not create latest symlink when QWEN_DEBUG_LOG_FILE is unset', async () => {
      delete process.env['QWEN_DEBUG_LOG_FILE'];
      vi.clearAllMocks();
      await activate();

      expect(symlink).not.toHaveBeenCalled();
    });

    it('does not point latest at non-session debug logs', async () => {
      await activate({ getSessionId: () => 'log-to-span-sink-test' });

      expect(symlink).not.toHaveBeenCalled();
      expect(fs.appendFile).not.toHaveBeenCalled();
    });

    it('does not create symlink when session is cleared', async () => {
      vi.clearAllMocks();
      await activate(null);

      expect(symlink).not.toHaveBeenCalled();
    });

    it('does not fall back to copy when symlink fails', async () => {
      symlink.mockRejectedValueOnce(new Error('EPERM'));
      readlink.mockRejectedValueOnce(new Error('ENOENT'));

      await activate();

      expect(fs.copyFile).not.toHaveBeenCalled();
    });

    it('retries the latest alias after a failed update', async () => {
      symlink
        .mockRejectedValueOnce(new Error('EPERM'))
        .mockResolvedValue(undefined);
      readlink
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValue(`${uuid}.txt`);

      await activate();
      expect(symlink).toHaveBeenCalledOnce();

      await infoAndFlush(createDebugLogger(), 'retry alias update');

      expect(symlink).toHaveBeenCalledTimes(2);
      expect(symlink).toHaveBeenLastCalledWith(
        `${uuid}.txt`,
        expectedLatestPath,
      );

      // A successful (re)try must leave the dedup marker in place: another
      // write for the same session may not re-run the alias update.
      await infoAndFlush(createDebugLogger(), 'same session again');

      expect(symlink).toHaveBeenCalledTimes(2);
    });

    it('resets the failure streak on a successful alias update', async () => {
      symlink.mockResolvedValue(undefined);
      readlink
        // A's first attempt fails, its retry verifies successfully.
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(`${uuid}.txt`)
        // B's first attempt "succeeds" at the fs level but points at the
        // wrong target — the mismatch branch must count as a failure.
        .mockResolvedValueOnce(`${uuid}.txt`)
        .mockRejectedValue(new Error('ENOENT'));

      await activate();

      const logger = createDebugLogger();
      await infoAndFlush(logger, 'A retries');
      expect(symlink).toHaveBeenCalledTimes(2);

      // A's success reset the streak, so B's two failures land at streak 1
      // and 2 — below the cap — and B still gets a third attempt. Without
      // the reset, A's initial failure would push B's second failure to the
      // cap and the marker would go sticky one failure early.
      await infoAndFlush(logger, 'B first failure', otherSession);
      await infoAndFlush(logger, 'B second failure', otherSession);
      await infoAndFlush(logger, 'B third attempt', otherSession);

      expect(symlink).toHaveBeenCalledTimes(5);

      restoreAliasMocks();
    });

    it('stops retrying the alias after consecutive persistent failures', async () => {
      symlink.mockRejectedValue(new Error('EPERM'));
      readlink.mockRejectedValue(new Error('ENOENT'));

      await activate();

      const logger = createDebugLogger();
      for (let i = 0; i < 5; i += 1) {
        await infoAndFlush(logger, `doomed alias attempt ${i}`);
      }

      // Attempts 1-3 retry; at the streak cap the marker stays sticky, so
      // the remaining writes must not re-run the doomed unlink/symlink.
      expect(symlink).toHaveBeenCalledTimes(3);

      restoreAliasMocks();
    });

    it('recovers from the streak cap when a later alias update succeeds', async () => {
      // The cap must behave like a circuit breaker, not a latch: a capped
      // streak still attempts on a session CHANGE (different dedup key), and
      // one success re-opens retries for subsequent transient failures.
      symlink.mockResolvedValue(undefined);
      readlink
        // A's three failures reach the cap.
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'))
        // B's attempt succeeds and resets the streak.
        .mockResolvedValueOnce(`${otherSession}.txt`)
        // A's post-recovery failure must retry again.
        .mockRejectedValue(new Error('ENOENT'));

      await activate();
      const logger = createDebugLogger();
      await infoAndFlush(logger, 'A failure 2');
      await infoAndFlush(logger, 'A failure 3');
      await infoAndFlush(logger, 'A at cap — sticky');
      expect(symlink).toHaveBeenCalledTimes(3);

      // Session change: the capped streak must not block B's attempt.
      await infoAndFlush(logger, 'B succeeds', otherSession);
      expect(symlink).toHaveBeenCalledTimes(4);

      // B's success re-opened the breaker: A's next failure retries again.
      await infoAndFlush(logger, 'A fails after recovery');
      await infoAndFlush(logger, 'A retries');
      expect(symlink).toHaveBeenCalledTimes(6);

      restoreAliasMocks();
    });

    it('does not let a stale failed update clear a newer session marker', async () => {
      resetDebugLoggingState();
      vi.clearAllMocks();

      const deferreds: Array<{
        resolve: () => void;
        reject: (err: Error) => void;
      }> = [];
      symlink.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            deferreds.push({ resolve: () => resolve(), reject });
          }),
      );
      vi.mocked(fs.unlink).mockResolvedValue(undefined);
      readlink.mockResolvedValue(`${otherSession}.txt`);

      const logger = createDebugLogger();
      sessionIdContext.run(uuid, () => logger.info('message from A'));
      sessionIdContext.run(otherSession, () => logger.info('message from B'));
      await vi.runAllTimersAsync();

      // A's update fails only after B's was scheduled (B owns the marker).
      deferreds[0]!.reject(new Error('EPERM'));
      await vi.runAllTimersAsync();
      deferreds[1]!.resolve();
      await vi.runAllTimersAsync();

      expect(symlink).toHaveBeenCalledTimes(2);

      // B's marker must have survived A's stale failure: another write from
      // B may not re-run the alias update.
      await infoAndFlush(logger, 'B again', otherSession);

      expect(symlink).toHaveBeenCalledTimes(2);

      restoreAliasMocks();
    });

    it('does not create symlink when debug logging is disabled', async () => {
      process.env['QWEN_DEBUG_LOG_FILE'] = '0';
      vi.clearAllMocks();
      await activate();

      expect(symlink).not.toHaveBeenCalled();
    });

    it('updates latest alias when the active session changes mid-process', async () => {
      resetDebugLoggingState();
      setDebugLogSession(uuidSession);

      vi.clearAllMocks();
      await infoAndFlush(
        createDebugLogger(),
        'message from other session',
        otherSession,
      );

      expect(symlink).toHaveBeenCalledWith(
        `${otherSession}.txt`,
        expectedLatestPath,
      );
    });

    it('serializes alias updates so two sessions do not race unlink/symlink', async () => {
      resetDebugLoggingState();
      vi.clearAllMocks();

      // Each symlink call returns a deferred promise so we can control when
      // the serialized update finishes and observe the next one waiting.
      const deferreds: Array<{ resolve: () => void }> = [];
      symlink.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            deferreds.push({ resolve });
          }),
      );
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      const sessionA = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const sessionB = '7ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const logger = createDebugLogger();

      sessionIdContext.run(sessionA, () => logger.info('message from A'));
      sessionIdContext.run(sessionB, () => logger.info('message from B'));

      // Let the first serialized alias update reach fs.symlink.
      await vi.runAllTimersAsync();

      expect(symlink).toHaveBeenCalledOnce();
      expect(symlink).toHaveBeenLastCalledWith(
        `${sessionA}.txt`,
        expectedLatestPath,
      );

      // Finish the first update; the second should now start.
      deferreds[0]!.resolve();
      await vi.runAllTimersAsync();

      expect(symlink).toHaveBeenCalledTimes(2);
      expect(symlink).toHaveBeenLastCalledWith(
        `${sessionB}.txt`,
        expectedLatestPath,
      );
    });
  });

  describe('resetDebugLoggingState', () => {
    it('resets the degraded state', async () => {
      appendFile.mockRejectedValueOnce(new Error('Disk full'));

      await logOnce('debug', 'test');

      expect(isDebugLoggingDegraded()).toBe(true);

      resetDebugLoggingState();

      expect(isDebugLoggingDegraded()).toBe(false);
    });
  });
});
