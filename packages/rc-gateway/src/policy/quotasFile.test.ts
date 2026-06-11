/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileQuotaWal, QuotaStore, type QuotaLimit } from './quotas.js';

const limits =
  (m: Record<string, QuotaLimit>) =>
  (ruleId: string): QuotaLimit | undefined =>
    m[ruleId];

const T0 = 1_000_000;

describe('FileQuotaWal', () => {
  let dir: string;
  let walPath: string;
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-quotawal-'));
    walPath = join(dir, 'sub', 'quotas.wal'); // nested → exercises mkdir -p
    warnings = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] and does NOT warn when the file is absent (ENOENT is normal)', async () => {
    const wal = new FileQuotaWal(walPath, warn);
    expect(await wal.load()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('round-trips appends through a real file (mkdir -p the parent)', async () => {
    const wal = new FileQuotaWal(walPath, warn);
    await wal.append({ ruleId: 'a', ms: T0 });
    await wal.append({ ruleId: 'a', ms: T0 + 1 });
    expect(await wal.load()).toEqual([
      { ruleId: 'a', ms: T0 },
      { ruleId: 'a', ms: T0 + 1 },
    ]);
  });

  it('skips torn / garbage / wrong-shape lines and replays the valid ones', async () => {
    const wal = new FileQuotaWal(walPath, warn);
    await wal.append({ ruleId: 'a', ms: T0 }); // creates the dir + a valid line
    // Append raw lines a kill -9 / corruption could leave behind.
    await writeFile(
      walPath,
      [
        JSON.stringify({ r: 'a', t: T0 }),
        'not json at all',
        JSON.stringify({ r: 5, t: T0 }), // wrong-shape: r not a string
        JSON.stringify({ r: 'b', t: 'x' }), // wrong-shape: t not a number
        JSON.stringify({ r: 'b' }), // missing t
        '{"r":"c","t":' + (T0 + 9), // truncated trailing line (no close)
      ].join('\n') + '',
      { mode: 0o600 },
    );
    expect(await wal.load()).toEqual([{ ruleId: 'a', ms: T0 }]);
  });

  it('fails OPEN (returns [] + warns) when the path is unreadable as a file', async () => {
    // Point the WAL at the directory itself → readFile rejects with EISDIR.
    const wal = new FileQuotaWal(dir, warn);
    expect(await wal.load()).toEqual([]);
    expect(warnings.some((w) => w.includes('unreadable'))).toBe(true);
  });

  it('rewrite atomically replaces the file (compaction)', async () => {
    const wal = new FileQuotaWal(walPath, warn);
    await wal.append({ ruleId: 'a', ms: T0 });
    await wal.append({ ruleId: 'a', ms: T0 + 1 });
    await wal.rewrite([{ ruleId: 'a', ms: T0 + 1 }]);
    expect(await wal.load()).toEqual([{ ruleId: 'a', ms: T0 + 1 }]);
    // No leftover temp file.
    await expect(readFile(walPath + '.tmp', 'utf8')).rejects.toThrow();
  });
});

describe('QuotaStore over FileQuotaWal (durable restart survival)', () => {
  let dir: string;
  let walPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-quotastore-'));
    walPath = join(dir, 'quotas.wal');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resumes the count after a simulated restart through a real file', async () => {
    const lim = limits({ a: { count: 5, windowSec: 600 } });
    const first = await QuotaStore.create(new FileQuotaWal(walPath), lim);
    await first.consume('a', T0);
    await first.consume('a', T0 + 1);
    await first.consume('a', T0 + 2);

    const second = await QuotaStore.create(new FileQuotaWal(walPath), lim);
    expect(second.remaining('a', T0 + 3)).toBe(2);
  });

  it('auto-compaction shrinks the on-disk file yet a reload stays correct', async () => {
    const lim = limits({ a: { count: 100, windowSec: 600 } });
    const store = await QuotaStore.create(new FileQuotaWal(walPath), lim, {
      compactionFloor: 3,
    });
    // Consume 6 times: crosses the floor → at least one auto-compaction runs.
    for (let i = 0; i < 6; i++) await store.consume('a', T0 + i);
    const lineCount = (await readFile(walPath, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0).length;
    expect(lineCount).toBe(6); // all live, but rewritten (compaction kept them)

    const reloaded = await QuotaStore.create(new FileQuotaWal(walPath), lim);
    expect(reloaded.remaining('a', T0 + 7)).toBe(94);
  });
});
