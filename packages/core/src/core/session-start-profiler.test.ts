/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStartSource } from '../hooks/types.js';
import {
  SESSION_START_PROFILE_ENV,
  createSessionStartProfiler,
  type SessionStartProfileRecord,
} from './session-start-profiler.js';

const debugLoggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => true),
  warn: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => debugLoggerMock),
}));

function clockFrom(values: number[]) {
  let last = values[values.length - 1] ?? 0;
  return vi.fn(() => {
    const next = values.shift();
    if (next !== undefined) {
      last = next;
    }
    return last;
  });
}

type ProfilerOptions = NonNullable<
  Parameters<typeof createSessionStartProfiler>[1]
>;
const T0 = () => new Date('2026-07-06T00:00:00.000Z');
const T1 = () => new Date('2026-07-06T12:34:56.789Z');

/** Enabled profiler on a scripted clock that collects its records in memory. */
function profile(
  source: SessionStartSource,
  now: number[],
  opts: ProfilerOptions = {},
) {
  const records: SessionStartProfileRecord[] = [];
  const profiler = createSessionStartProfiler(source, {
    enabled: true,
    now: clockFrom(now),
    writeRecord: (record) => records.push(record),
    getTimestamp: T0,
    ...opts,
  });
  return { profiler, records };
}

const expectWriteFailed = (
  payload: unknown = expect.objectContaining({ name: 'Error' }),
) =>
  expect(debugLoggerMock.debug).toHaveBeenCalledWith(
    'session-start-profiler write failed',
    payload,
  );

interface RuntimeDirCtx {
  runtimeDir: string;
  perfDir: string;
  profilePath: string;
  /** Env-enabled Clear profiler with the real JSONL writer. */
  start: (now: number[]) => ReturnType<typeof createSessionStartProfiler>;
}

/**
 * Runs `body` against a temp QWEN_RUNTIME_DIR with profiling enabled by env.
 * `noFollowless` reloads the module with O_NOFOLLOW stubbed away (the Windows
 * flag set).
 */
async function withRuntimeDir(
  body: (ctx: RuntimeDirCtx) => Promise<void>,
  noFollowless = false,
) {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'session-start-profiler-'));
  vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
  vi.stubEnv(SESSION_START_PROFILE_ENV, '1');
  if (noFollowless) {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        constants: { ...actual.constants, O_NOFOLLOW: undefined },
      };
    });
  }

  try {
    const create = noFollowless
      ? (await import('./session-start-profiler.js')).createSessionStartProfiler
      : createSessionStartProfiler;
    const perfDir = join(runtimeDir, 'session-start-perf');
    await body({
      runtimeDir,
      perfDir,
      profilePath: join(perfDir, 'session-start-2026-07-06.jsonl'),
      start: (now) =>
        create(SessionStartSource.Clear, {
          now: clockFrom(now),
          getTimestamp: T1,
        }),
    });
  } finally {
    if (noFollowless) {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

/** Plants a symlink at the profile path; finish() must not write through it. */
const expectSymlinkedFileRefused = (noFollowless: boolean) =>
  withRuntimeDir(async ({ runtimeDir, perfDir, profilePath, start }) => {
    const targetPath = join(runtimeDir, 'target.jsonl');
    await mkdir(perfDir);
    await writeFile(targetPath, 'sentinel', 'utf8');
    await symlink(targetPath, profilePath);

    expect(() => start([10, 20]).finish({ ok: true })).not.toThrow();

    await expect(readFile(targetPath, 'utf8')).resolves.toBe('sentinel');
    expectWriteFailed();
  }, noFollowless);

describe('session-start-profiler', () => {
  const itNoSymlink = process.platform === 'win32' ? it.skip : it;

  beforeEach(() => {
    debugLoggerMock.debug.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is a no-op when disabled', async () => {
    const now = vi.fn(() => {
      throw new Error('disabled profiler should not read time');
    });
    const writeRecord = vi.fn();
    const profiler = createSessionStartProfiler(SessionStartSource.Startup, {
      enabled: false,
      now,
      writeRecord,
      getTimestamp: T0,
    });

    await expect(
      profiler.time('tool_registry_warm', async () => 'ok'),
    ).resolves.toBe('ok');
    const existingPromise = Promise.resolve('same-promise');
    expect(profiler.time('same_promise', () => existingPromise)).toBe(
      existingPromise,
    );
    const disabledError = new Error('disabled failure');
    await expect(
      profiler.time('disabled_error', () => {
        throw disabledError;
      }),
    ).rejects.toBe(disabledError);
    expect(profiler.timeSync('system_instruction', () => 42)).toBe(42);
    profiler.finish({ ok: true });

    expect(profiler.enabled).toBe(false);
    expect(now).not.toHaveBeenCalled();
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it.each(['true', '0', ''])(
    'stays disabled when env var is set to %j',
    (envValue) => {
      vi.stubEnv(SESSION_START_PROFILE_ENV, envValue);
      const now = vi.fn(() => {
        throw new Error('disabled profiler should not read time');
      });
      const writeRecord = vi.fn();

      const profiler = createSessionStartProfiler(SessionStartSource.Startup, {
        now,
        writeRecord,
      });
      profiler.finish({ ok: true });

      expect(profiler.enabled).toBe(false);
      expect(now).not.toHaveBeenCalled();
      expect(writeRecord).not.toHaveBeenCalled();
      expect(debugLoggerMock.debug).not.toHaveBeenCalled();
    },
  );

  it('records sync and async stages when enabled', async () => {
    const { profiler, records } = profile(
      SessionStartSource.Resume,
      [10, 12, 15, 16, 21, 30],
      { sessionId: 'session-123' },
    );

    await expect(
      profiler.time('initial_chat_history', async () => 'history'),
    ).resolves.toBe('history');
    expect(profiler.timeSync('system_instruction', () => 'system')).toBe(
      'system',
    );
    profiler.finish({
      ok: true,
      extraHistoryLength: 3,
      historyLength: 4,
      snapshotEntryCount: 2,
      deferredReminderCount: 1,
    });

    expect(records).toEqual([
      {
        timestamp: '2026-07-06T00:00:00.000Z',
        source: 'resume',
        ok: true,
        sessionId: 'session-123',
        totalMs: 20,
        stages: { initial_chat_history: 3, system_instruction: 5 },
        extraHistoryLength: 3,
        historyLength: 4,
        snapshotEntryCount: 2,
        deferredReminderCount: 1,
      },
    ]);
    expect(debugLoggerMock.debug).toHaveBeenCalledWith(
      'session-start-profiler enabled',
      { source: 'resume' },
    );
  });

  it('rounds elapsed durations to two decimal places', async () => {
    const { profiler, records } = profile(
      SessionStartSource.Resume,
      [100.111, 100.222, 100.678, 101.111, 102.345, 102.789],
    );

    await profiler.time('initial_chat_history', async () => undefined);
    profiler.timeSync('system_instruction', () => undefined);
    profiler.finish({ ok: true });

    expect(records[0]).toMatchObject({
      ok: true,
      totalMs: 2.68,
      stages: { initial_chat_history: 0.46, system_instruction: 1.23 },
    });
  });

  it('accumulates repeated stage durations', () => {
    const { profiler, records } = profile(
      SessionStartSource.Clear,
      [10, 12, 15, 18, 23, 30],
    );

    expect(profiler.timeSync('system_instruction', () => 'first')).toBe(
      'first',
    );
    expect(profiler.timeSync('system_instruction', () => 'second')).toBe(
      'second',
    );
    profiler.finish({ ok: true });

    expect(records[0]).toMatchObject({
      ok: true,
      totalMs: 20,
      stages: { system_instruction: 8 },
    });
  });

  it('rethrows stage errors and preserves the failed stage', async () => {
    const { profiler, records } = profile(
      SessionStartSource.Startup,
      [100, 110, 125, 130],
    );
    const error = new Error('setTools failed');

    await expect(
      profiler.time('set_tools', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    profiler.finish({ ok: false });

    expect(records[0]).toMatchObject({
      ok: false,
      totalMs: 30,
      stages: { set_tools: 15 },
      failedStage: 'set_tools',
    });
  });

  it('preserves the first failed stage', async () => {
    const { profiler, records } = profile(
      SessionStartSource.Startup,
      [100, 110, 115, 120, 130, 140],
    );

    await expect(
      profiler.time('stage_a', async () => {
        throw new Error('stage a failed');
      }),
    ).rejects.toThrow('stage a failed');
    await expect(
      profiler.time('stage_b', async () => {
        throw new Error('stage b failed');
      }),
    ).rejects.toThrow('stage b failed');
    profiler.finish({ ok: false });

    expect(records[0]).toMatchObject({
      ok: false,
      totalMs: 40,
      stages: { stage_a: 5, stage_b: 10 },
      failedStage: 'stage_a',
    });
  });

  it('rethrows sync stage errors and preserves the failed stage', () => {
    const { profiler, records } = profile(
      SessionStartSource.Startup,
      [100, 110, 120, 130],
    );
    const error = new Error('system instruction failed');

    expect(() =>
      profiler.timeSync('system_instruction', () => {
        throw error;
      }),
    ).toThrow(error);
    profiler.finish({ ok: false });

    expect(records[0]).toMatchObject({
      ok: false,
      totalMs: 30,
      stages: { system_instruction: 10 },
      failedStage: 'system_instruction',
    });
  });

  it('writes at most one record when finish is called multiple times', () => {
    const { profiler, records } = profile(SessionStartSource.Clear, [1, 2, 3]);

    profiler.finish({ ok: true });
    profiler.finish({ ok: false });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ok: true, totalMs: 1 });
    for (const key of [
      'extraHistoryLength',
      'historyLength',
      'snapshotEntryCount',
      'deferredReminderCount',
      'failedStage',
    ]) {
      expect(records[0]).not.toHaveProperty(key);
    }
  });

  it('does not throw when the output writer fails', () => {
    const { profiler } = profile(SessionStartSource.Clear, [1, 2], {
      writeRecord: () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    });

    expect(() => profiler.finish({ ok: true })).not.toThrow();
    expectWriteFailed({ name: 'Error', message: 'disk full', code: 'ENOSPC' });
  });

  it('does not throw when recovery debug logging fails', () => {
    const { profiler } = profile(SessionStartSource.Clear, [1, 2], {
      writeRecord: () => {
        throw new Error('disk full');
      },
    });
    debugLoggerMock.debug.mockImplementation(() => {
      throw new Error('debug log failed');
    });

    expect(() => profiler.finish({ ok: true })).not.toThrow();
  });

  it('does not throw when enabled debug logging fails', () => {
    debugLoggerMock.debug.mockImplementation(() => {
      throw new Error('debug log failed');
    });
    let profiler: ReturnType<typeof createSessionStartProfiler> | undefined;

    expect(() => {
      profiler = profile(SessionStartSource.Clear, [1, 2], {
        writeRecord: vi.fn(),
      }).profiler;
    }).not.toThrow();
    expect(profiler?.enabled).toBe(true);
  });

  it('does not throw when finish metadata collection fails', () => {
    const writeRecord = vi.fn();
    const { profiler } = profile(SessionStartSource.Clear, [1, 2], {
      writeRecord,
      getTimestamp: () => {
        throw new Error('clock failed');
      },
    });

    expect(() => profiler.finish({ ok: false })).not.toThrow();
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('writes bounded JSONL without sensitive fields', () =>
    withRuntimeDir(async ({ perfDir, profilePath, start }) => {
      const profiler = start([10, 15, 20, 30]);
      profiler.timeSync('system_instruction', () => 'system');
      profiler.finish({
        ok: true,
        extraHistoryLength: 0,
        historyLength: 1,
        snapshotEntryCount: 0,
        deferredReminderCount: 0,
      });

      expect(await readdir(perfDir)).toEqual([
        'session-start-2026-07-06.jsonl',
      ]);
      if (process.platform !== 'win32') {
        expect((await stat(perfDir)).mode & 0o777).toBe(0o700);
        expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
      }
      const raw = await readFile(profilePath, 'utf8');
      const record = JSON.parse(raw.trim()) as SessionStartProfileRecord;
      const serialized = JSON.stringify(record);

      expect(record).toMatchObject({
        timestamp: '2026-07-06T12:34:56.789Z',
        source: 'clear',
        ok: true,
        totalMs: 20,
        stages: { system_instruction: 5 },
      });
      expect(record).not.toHaveProperty('sessionId');
      for (const secret of [
        'prompt',
        '/test/',
        'test-session-id',
        'hook output',
        'tool name',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    }));

  it('writes profile records when O_NOFOLLOW is unavailable', () =>
    withRuntimeDir(async ({ profilePath, start }) => {
      start([10, 20]).finish({ ok: true });

      const raw = await readFile(profilePath, 'utf8');
      expect(JSON.parse(raw.trim())).toMatchObject({ ok: true });
      expect(debugLoggerMock.error).not.toHaveBeenCalled();
    }, true));

  it('appends to an existing JSONL file', () =>
    withRuntimeDir(async ({ perfDir, profilePath, start }) => {
      await mkdir(perfDir);
      await writeFile(profilePath, '{"existing":true}\n', 'utf8');

      const profiler = start([10, 15, 20]);
      profiler.timeSync('system_instruction', () => undefined);
      profiler.finish({ ok: true });

      const lines = (await readFile(profilePath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual({ existing: true });
      expect(JSON.parse(lines[1]!)).toMatchObject({
        timestamp: '2026-07-06T12:34:56.789Z',
        source: 'clear',
        ok: true,
        stages: { system_instruction: 5 },
      });
    }));

  itNoSymlink('does not write through a symlinked JSONL file', () =>
    expectSymlinkedFileRefused(false),
  );

  // The cross-product the two sibling tests miss: O_NOFOLLOW stubbed away (the
  // Windows flag set) AND a symlink planted at the profile path. On Windows the
  // lstat pre-check is the ONLY guard, so this pins that
  // assertSafeExistingProfileFile still refuses the link before the open — and
  // it runs on Linux CI, where the kernel would otherwise mask it.
  itNoSymlink(
    'rejects a symlinked JSONL file even when O_NOFOLLOW is unavailable',
    () => expectSymlinkedFileRefused(true),
  );

  itNoSymlink('does not write through a symlinked profile directory', () =>
    withRuntimeDir(async ({ runtimeDir, perfDir, start }) => {
      const targetDir = join(runtimeDir, 'target-perf');
      await mkdir(targetDir);
      await symlink(targetDir, perfDir);

      expect(() => start([10, 20]).finish({ ok: true })).not.toThrow();

      await expect(readdir(targetDir)).resolves.toEqual([]);
      expectWriteFailed();
    }),
  );
});
