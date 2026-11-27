/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Entry } from '../../protocol/transcript/entry.js';
import { WriterCoordinator } from './append-coordinator.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function title(value: string): Entry {
  return {
    type: 'custom-title',
    sessionId: 'session-1',
    customTitle: value,
  };
}

describe('WriterCoordinator', () => {
  it('shares one ordered channel across real and symlinked paths', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'transcript-coordinator-'),
    );
    tempDirs.push(root);
    const realDirectory = path.join(root, 'real');
    const aliasDirectory = path.join(root, 'alias');
    await fs.mkdir(realDirectory);
    await fs.symlink(realDirectory, aliasDirectory, 'dir');
    const coordinator = new WriterCoordinator({ flushIntervalMs: 60_000 });
    const realLease = await coordinator.acquire(
      path.join(realDirectory, 'session.jsonl'),
    );
    const aliasLease = await coordinator.acquire(
      path.join(aliasDirectory, 'session.jsonl'),
    );

    expect(aliasLease.filePath).toBe(realLease.filePath);
    const first = realLease.append([title('first')]);
    const second = aliasLease.append([title('second')]);
    await aliasLease.barrier();
    await Promise.all([first, second]);

    const lines = (await fs.readFile(realLease.filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { customTitle: string });
    expect(lines.map((entry) => entry.customTitle)).toEqual([
      'first',
      'second',
    ]);
    await coordinator.close();
  });

  it('releasing one lease does not affect another lease', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'transcript-coordinator-'),
    );
    tempDirs.push(root);
    const coordinator = new WriterCoordinator({ flushIntervalMs: 0 });
    const filePath = path.join(root, 'session.jsonl');
    const firstLease = await coordinator.acquire(filePath);
    const secondLease = await coordinator.acquire(filePath);

    await firstLease.release();
    expect(() => firstLease.append([title('rejected')])).toThrow(
      'AppendChannelLease is released',
    );
    await secondLease.append([title('accepted')]);
    await secondLease.release();

    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('"customTitle":"accepted"');
    await coordinator.close();
  });

  it('uses exclusive create for competing fork targets', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'transcript-coordinator-'),
    );
    tempDirs.push(root);
    const coordinator = new WriterCoordinator();
    const filePath = path.join(root, 'fork.jsonl');

    await coordinator.createFileExclusive(filePath, [title('winner')]);
    await expect(
      coordinator.createFileExclusive(filePath, [title('loser')]),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    const lease = await coordinator.acquire(filePath);
    await lease.append([title('continued after collision')]);
    await lease.release();

    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('"customTitle":"winner"');
    expect(content).not.toContain('loser');
    expect(content).toContain('"customTitle":"continued after collision"');
    await coordinator.close();
  });
});
