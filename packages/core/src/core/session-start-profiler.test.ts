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

describe('session-start-profiler', () => {
  const itNoSymlink = process.platform === 'win32' ? it.skip : it;

  beforeEach(() => {
    debugLoggerMock.debug.mockClear();
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
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });

    await expect(
      profiler.time('tool_registry_warm', async () => 'ok'),
    ).resolves.toBe('ok');
    expect(profiler.timeSync('system_instruction', () => 42)).toBe(42);
    profiler.finish({ ok: true });

    expect(profiler.enabled).toBe(false);
    expect(now).not.toHaveBeenCalled();
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('records sync and async stages when enabled', async () => {
    const records: SessionStartProfileRecord[] = [];
    const profiler = createSessionStartProfiler(SessionStartSource.Resume, {
      enabled: true,
      now: clockFrom([10, 12, 15, 16, 21, 30]),
      writeRecord: (record) => records.push(record),
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });

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
        totalMs: 20,
        stages: {
          initial_chat_history: 3,
          system_instruction: 5,
        },
        extraHistoryLength: 3,
        historyLength: 4,
        snapshotEntryCount: 2,
        deferredReminderCount: 1,
      },
    ]);
  });

  it('rounds elapsed durations to two decimal places', async () => {
    const records: SessionStartProfileRecord[] = [];
    const profiler = createSessionStartProfiler(SessionStartSource.Resume, {
      enabled: true,
      now: clockFrom([100.111, 100.222, 100.678, 101.111, 102.345, 102.789]),
      writeRecord: (record) => records.push(record),
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });

    await profiler.time('initial_chat_history', async () => undefined);
    profiler.timeSync('system_instruction', () => undefined);
    profiler.finish({ ok: true });

    expect(records[0]).toMatchObject({
      ok: true,
      totalMs: 2.68,
      stages: {
        initial_chat_history: 0.46,
        system_instruction: 1.23,
      },
    });
  });

  it('accumulates repeated stage durations', () => {
    const records: SessionStartProfileRecord[] = [];
    const profiler = createSessionStartProfiler(SessionStartSource.Clear, {
      enabled: true,
      now: clockFrom([10, 12, 15, 18, 23, 30]),
      writeRecord: (record) => records.push(record),
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });

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
      stages: {
        system_instruction: 8,
      },
    });
  });

  it('rethrows stage errors and preserves the failed stage', async () => {
    const records: SessionStartProfileRecord[] = [];
    const profiler = createSessionStartProfiler(SessionStartSource.Startup, {
      enabled: true,
      now: clockFrom([100, 110, 125, 130]),
      writeRecord: (record) => records.push(record),
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });
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
      stages: {
        set_tools: 15,
      },
      failedStage: 'set_tools',
    });
  });

  it('preserves the first failed stage', async () => {
    const records: SessionStartProfileRecord[] = [];
    const profiler = createSessionStartProfiler(SessionStartSource.Startup, {
      enabled: true,
      now: clockFrom([100, 110, 115, 120, 130, 140]),
      writeRecord: (record) => records.push(record),
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });

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
      stages: {
        stage_a: 5,
        stage_b: 10,
      },
      failedStage: 'stage_a',
    });
  });

  it('rethrows sync stage errors and preserves the failed stage', () => {
    const records: SessionStartProfileRecord[] = [];
    const profiler = createSessionStartProfiler(SessionStartSource.Startup, {
      enabled: true,
      now: clockFrom([100, 110, 120, 130]),
      writeRecord: (record) => records.push(record),
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });
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
      stages: {
        system_instruction: 10,
      },
      failedStage: 'system_instruction',
    });
  });

  it('writes at most one record when finish is called multiple times', () => {
    const records: SessionStartProfileRecord[] = [];
    const profiler = createSessionStartProfiler(SessionStartSource.Clear, {
      enabled: true,
      now: clockFrom([1, 2, 3]),
      writeRecord: (record) => records.push(record),
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });

    profiler.finish({ ok: true });
    profiler.finish({ ok: false });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ok: true,
      totalMs: 1,
    });
    expect(records[0]).not.toHaveProperty('extraHistoryLength');
    expect(records[0]).not.toHaveProperty('historyLength');
    expect(records[0]).not.toHaveProperty('snapshotEntryCount');
    expect(records[0]).not.toHaveProperty('deferredReminderCount');
    expect(records[0]).not.toHaveProperty('failedStage');
  });

  it('does not throw when the output writer fails', () => {
    const profiler = createSessionStartProfiler(SessionStartSource.Clear, {
      enabled: true,
      now: clockFrom([1, 2]),
      writeRecord: () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
      getTimestamp: () => new Date('2026-07-06T00:00:00.000Z'),
    });

    expect(() => profiler.finish({ ok: true })).not.toThrow();
    expect(debugLoggerMock.debug).toHaveBeenCalledWith(
      'session-start-profiler write failed',
      { name: 'Error', code: 'ENOSPC' },
    );
  });

  it('does not throw when finish metadata collection fails', () => {
    const writeRecord = vi.fn();
    const profiler = createSessionStartProfiler(SessionStartSource.Clear, {
      enabled: true,
      now: clockFrom([1, 2]),
      writeRecord,
      getTimestamp: () => {
        throw new Error('clock failed');
      },
    });

    expect(() => profiler.finish({ ok: false })).not.toThrow();
    expect(writeRecord).not.toHaveBeenCalled();
  });

  it('writes bounded JSONL without sensitive fields', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'session-start-profiler-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
    vi.stubEnv(SESSION_START_PROFILE_ENV, '1');

    try {
      const profiler = createSessionStartProfiler(SessionStartSource.Clear, {
        now: clockFrom([10, 15, 20, 30]),
        getTimestamp: () => new Date('2026-07-06T12:34:56.789Z'),
      });
      profiler.timeSync('system_instruction', () => 'system');
      profiler.finish({
        ok: true,
        extraHistoryLength: 0,
        historyLength: 1,
        snapshotEntryCount: 0,
        deferredReminderCount: 0,
      });

      const perfDir = join(runtimeDir, 'session-start-perf');
      const profilePath = join(perfDir, 'session-start-2026-07-06.jsonl');
      const files = await readdir(perfDir);
      expect(files).toEqual(['session-start-2026-07-06.jsonl']);
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
      expect(serialized).not.toContain('prompt');
      expect(serialized).not.toContain('/test/');
      expect(serialized).not.toContain('test-session-id');
      expect(serialized).not.toContain('hook output');
      expect(serialized).not.toContain('tool name');
    } finally {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  it('appends to an existing JSONL file', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'session-start-profiler-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
    vi.stubEnv(SESSION_START_PROFILE_ENV, '1');

    try {
      const perfDir = join(runtimeDir, 'session-start-perf');
      const profilePath = join(perfDir, 'session-start-2026-07-06.jsonl');
      await mkdir(perfDir);
      await writeFile(profilePath, '{"existing":true}\n', 'utf8');

      const profiler = createSessionStartProfiler(SessionStartSource.Clear, {
        now: clockFrom([10, 15, 20]),
        getTimestamp: () => new Date('2026-07-06T12:34:56.789Z'),
      });
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
    } finally {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  itNoSymlink('does not write through a symlinked JSONL file', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'session-start-profiler-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
    vi.stubEnv(SESSION_START_PROFILE_ENV, '1');

    try {
      const perfDir = join(runtimeDir, 'session-start-perf');
      const targetPath = join(runtimeDir, 'target.jsonl');
      const profilePath = join(perfDir, 'session-start-2026-07-06.jsonl');
      await mkdir(perfDir);
      await writeFile(targetPath, 'sentinel', 'utf8');
      await symlink(targetPath, profilePath);

      const profiler = createSessionStartProfiler(SessionStartSource.Clear, {
        now: clockFrom([10, 20]),
        getTimestamp: () => new Date('2026-07-06T12:34:56.789Z'),
      });
      expect(() => profiler.finish({ ok: true })).not.toThrow();

      await expect(readFile(targetPath, 'utf8')).resolves.toBe('sentinel');
      expect(debugLoggerMock.debug).toHaveBeenCalledWith(
        'session-start-profiler write failed',
        expect.objectContaining({ name: 'Error' }),
      );
    } finally {
      await rm(runtimeDir, { recursive: true, force: true });
    }
  });

  itNoSymlink(
    'does not write through a symlinked profile directory',
    async () => {
      const runtimeDir = await mkdtemp(
        join(tmpdir(), 'session-start-profiler-'),
      );
      vi.stubEnv('QWEN_RUNTIME_DIR', runtimeDir);
      vi.stubEnv(SESSION_START_PROFILE_ENV, '1');

      try {
        const targetDir = join(runtimeDir, 'target-perf');
        const perfDir = join(runtimeDir, 'session-start-perf');
        await mkdir(targetDir);
        await symlink(targetDir, perfDir);

        const profiler = createSessionStartProfiler(SessionStartSource.Clear, {
          now: clockFrom([10, 20]),
          getTimestamp: () => new Date('2026-07-06T12:34:56.789Z'),
        });
        expect(() => profiler.finish({ ok: true })).not.toThrow();

        await expect(readdir(targetDir)).resolves.toEqual([]);
        expect(debugLoggerMock.debug).toHaveBeenCalledWith(
          'session-start-profiler write failed',
          expect.objectContaining({ name: 'Error' }),
        );
      } finally {
        await rm(runtimeDir, { recursive: true, force: true });
      }
    },
  );
});
