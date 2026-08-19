/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  joinBoard,
  leaveBoard,
  listParticipants,
} from './board-participants.js';

vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let mockGlobalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => mockGlobalDir,
      __setMockGlobalDir: (dir: string) => {
        mockGlobalDir = dir;
      },
    },
  };
});

import { Storage } from '../../config/storage.js';

function setMockDir(dir: string): void {
  (
    Storage as unknown as { __setMockGlobalDir: (d: string) => void }
  ).__setMockGlobalDir(dir);
}

const BOARD = 'demo';
/** A pid that is certainly not running — 2^22 is above every Linux default. */
const DEAD_PID = 4_194_303;

describe('board participants', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-people-test-'));
    setMockDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('claims a name and lists it', async () => {
    const rec = await joinBoard({ board: BOARD, name: 'api-worker' });
    expect(rec.name).toBe('api-worker');
    expect(rec.kind).toBe('interactive');
    expect((await listParticipants(BOARD)).map((p) => p.name)).toEqual([
      'api-worker',
    ]);
  });

  // Failing the claim would leave the caller to invent a name, which it will
  // either do badly or give up on. Suffixing keeps it addressable.
  it('suffixes when a live process holds the name', async () => {
    await joinBoard({ board: BOARD, name: 'worker', pid: process.pid });
    const second = await joinBoard({
      board: BOARD,
      name: 'worker',
      pid: process.pid + 1_000_000,
    });
    expect(second.name).toBe('worker-2');
  });

  // Otherwise a crash loop would burn through every reasonable name.
  it('reclaims a name whose holder is gone', async () => {
    await joinBoard({ board: BOARD, name: 'worker', pid: DEAD_PID });
    const again = await joinBoard({ board: BOARD, name: 'worker' });
    expect(again.name).toBe('worker');
  });

  it('re-joining as the same process keeps the name', async () => {
    await joinBoard({ board: BOARD, name: 'worker' });
    expect((await joinBoard({ board: BOARD, name: 'worker' })).name).toBe(
      'worker',
    );
  });

  // Liveness comes from the pid, so a crashed agent disappears without having
  // to have checked in — no heartbeat anywhere in this design.
  it('hides participants whose process is gone, unless asked', async () => {
    await joinBoard({ board: BOARD, name: 'ghost', pid: DEAD_PID });
    await joinBoard({ board: BOARD, name: 'live' });

    expect((await listParticipants(BOARD)).map((p) => p.name)).toEqual([
      'live',
    ]);
    expect(
      (await listParticipants(BOARD, { includeStale: true })).map(
        (p) => p.name,
      ),
    ).toContain('ghost');
  });

  it('leaves, and reports when there was nothing to leave', async () => {
    await joinBoard({ board: BOARD, name: 'worker' });
    expect(await leaveBoard(BOARD, 'worker')).toBe(true);
    expect(await listParticipants(BOARD)).toEqual([]);
    expect(await leaveBoard(BOARD, 'worker')).toBe(false);
  });

  it('records the kind, which is what tells a spawned agent from a peer', async () => {
    await joinBoard({ board: BOARD, name: 'codex-1', kind: 'foreign' });
    expect((await listParticipants(BOARD))[0].kind).toBe('foreign');
  });

  it('returns an empty list for a board nobody joined', async () => {
    expect(await listParticipants('never-used')).toEqual([]);
  });

  it('rejects names that could escape the board root', async () => {
    await expect(
      joinBoard({ board: BOARD, name: '../escape' }),
    ).rejects.toThrow(/Invalid participant name/);
  });
});
