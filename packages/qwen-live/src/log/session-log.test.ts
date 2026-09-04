/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLog } from './session-log.js';

interface LoggedLine {
  ts: number;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-log-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function readLines(path: string): Promise<LoggedLine[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedLine);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('SessionLog', () => {
  it('writes one JSON line per event with ts, monotonic seq, type, and payload', async () => {
    const base = await temporaryDirectory();
    let tick = 100;
    const log = new SessionLog({
      directory: join(base, 'logs'),
      liveSessionId: 'live_test',
      now: () => tick,
    });

    log.write('session.start', { liveSessionId: 'live_test' });
    tick = 250;
    log.write('tool.call', { name: 'start_job' });
    tick = 400;
    log.write('session.end', {});
    await log.close();

    expect(log.filePath).toBe(join(base, 'logs', 'live_test.jsonl'));
    const lines = await readLines(log.filePath);
    expect(lines).toEqual([
      {
        ts: 100,
        seq: 1,
        type: 'session.start',
        payload: { liveSessionId: 'live_test' },
      },
      { ts: 250, seq: 2, type: 'tool.call', payload: { name: 'start_job' } },
      { ts: 400, seq: 3, type: 'session.end', payload: {} },
    ]);
    const sequences = lines.map((line) => line.seq);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it('creates a 0700 directory and a 0600 log file', async () => {
    const base = await temporaryDirectory();
    const directory = join(base, 'nested', 'logs');
    const log = new SessionLog({ directory, liveSessionId: 'live_modes' });

    log.write('session.start', {});
    await log.close();

    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(log.filePath)).mode & 0o777).toBe(0o600);
    }
    await expect(readFile(log.filePath, 'utf8')).resolves.toContain(
      'session.start',
    );
  });

  it('rotates to a .1 file past maxBytes and keeps writing to a fresh file', async () => {
    const base = await temporaryDirectory();
    const log = new SessionLog({
      directory: base,
      liveSessionId: 'live_rotate',
      maxBytes: 250,
      now: () => 1,
    });

    // Two ~100-byte lines fit; the third overflows and triggers rotation.
    log.write('backend.event', { marker: 'first', filler: 'x'.repeat(20) });
    log.write('backend.event', { marker: 'second', filler: 'x'.repeat(20) });
    log.write('backend.event', { marker: 'third', filler: 'x'.repeat(20) });
    await log.close();

    const rotatedPath = `${log.filePath}.1`;
    // The rotated-out stream flushes its remaining buffer asynchronously
    // after the rename; poll until both files hold their final content.
    await vi.waitFor(async () => {
      const rotated = await readLines(rotatedPath);
      expect(rotated.map((line) => line.payload['marker'])).toEqual([
        'first',
        'second',
      ]);
      const current = await readLines(log.filePath);
      expect(current.map((line) => line.payload['marker'])).toEqual(['third']);
      expect(current[0]?.seq).toBe(3);
    });
  });

  it('does not throw when written after close', async () => {
    const base = await temporaryDirectory();
    const log = new SessionLog({ directory: base, liveSessionId: 'live_late' });

    log.write('session.start', {});
    await log.close();

    // close() is terminal: a late write must not silently reopen a stream
    // whose buffer would be lost at process.exit. Deleting the file first
    // proves the write was a no-op rather than a reopen.
    await rm(log.filePath);
    expect(() => {
      log.write('session.end', {});
    }).not.toThrow();
    await expect(stat(log.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await log.close();
  });

  it('flips to silent no-op mode after a write failure', async () => {
    const base = await temporaryDirectory();
    const log = new SessionLog({
      directory: base,
      liveSessionId: 'live_fail',
    });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    // JSON.stringify throws on the circular payload; the log must swallow it.
    expect(() => {
      log.write('error', circular);
    }).not.toThrow();
    // Every later write is silently dropped.
    expect(() => {
      log.write('session.start', {});
    }).not.toThrow();
    await log.close();

    await expect(stat(log.filePath)).rejects.toThrow();
  });
});
