/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// The ordering witness injects per-call delays (and an optional first-call
// failure) into the atomic write; default is a passthrough with no delay.
const writeControl = vi.hoisted(() => ({
  delays: [] as number[],
  failFirst: false,
}));
// ESM namespace exports are not spy-able, so mock node:fs/promises with a
// passthrough unlink spy; every other fs method stays real (temp dirs, io).
// unlinkControl injects a genuinely slow unlink (or a one-off ENOENT race),
// so the re-create case can pin the direction that actually loses a clear.
const unlinkControl = vi.hoisted(() => ({
  delays: [] as number[],
  failWith: null as NodeJS.ErrnoException | null,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: vi.fn(async (...args: Parameters<typeof actual.unlink>) => {
      if (unlinkControl.failWith) {
        const error = unlinkControl.failWith;
        unlinkControl.failWith = null;
        throw error;
      }
      const delay = unlinkControl.delays.shift() ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return actual.unlink(...args);
    }),
  };
});
vi.mock('../utils/atomicFileWrite.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/atomicFileWrite.js')>();
  return {
    ...actual,
    atomicWriteJSON: vi.fn(
      async (...args: Parameters<typeof actual.atomicWriteJSON>) => {
        if (writeControl.failFirst) {
          writeControl.failFirst = false;
          throw new Error('injected write failure');
        }
        const delay = writeControl.delays.shift() ?? 0;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        return actual.atomicWriteJSON(...args);
      },
    ),
  };
});
import {
  deleteSessionGoalSidecar,
  isValidSessionGoalSidecar,
  moveSessionGoalSidecar,
  projectGoalSidecar,
  readSessionGoalSidecar,
  writeSessionGoalSidecar,
  type SessionGoalSidecar,
} from './session-goal-sidecar.js';
import type { GoalRecord } from '../goals/goal-protocol.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-sidecar-'));
  writeControl.delays = [];
  writeControl.failFirst = false;
  unlinkControl.delays = [];
  unlinkControl.failWith = null;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const projection: SessionGoalSidecar = {
  v: 1,
  goalId: 'goal-1',
  status: 'active',
  objective: 'all tests pass',
  updatedAt: 1_700_000_000_000,
};

const goalRecord = (over: Partial<GoalRecord> = {}): GoalRecord => ({
  goalId: 'goal-1',
  revision: 1,
  objective: 'all tests pass',
  status: 'active',
  evidenceCursor: { recordId: null },
  turnCount: 0,
  activeTimeMs: 0,
  tokensUsed: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...over,
});

describe('session-goal-sidecar', () => {
  it('projects only the list-facing fields from a goal record', () => {
    expect(projectGoalSidecar(goalRecord({ status: 'paused' }))).toEqual({
      v: 1,
      goalId: 'goal-1',
      status: 'paused',
      objective: 'all tests pass',
      updatedAt: 1_700_000_000_000,
    });
  });

  it('round-trips a projection through write and read', async () => {
    const file = path.join(dir, 's1.goal.json');
    await writeSessionGoalSidecar(file, projection);
    expect(await readSessionGoalSidecar(file)).toEqual(projection);
  });

  it('reads an absent file as null (no goal)', async () => {
    expect(
      await readSessionGoalSidecar(path.join(dir, 'missing.goal.json')),
    ).toBeNull();
  });

  it('reads invalid JSON and failed shape checks as null', async () => {
    const file = path.join(dir, 's1.goal.json');
    await fs.writeFile(file, '{not json', 'utf-8');
    expect(await readSessionGoalSidecar(file)).toBeNull();
    await fs.writeFile(file, JSON.stringify({ v: 1 }), 'utf-8');
    expect(await readSessionGoalSidecar(file)).toBeNull();
    await fs.writeFile(
      file,
      JSON.stringify({ ...projection, status: 'bogus' }),
      'utf-8',
    );
    expect(await readSessionGoalSidecar(file)).toBeNull();
  });

  it('shape check rejects non-objects, bad version, and empty goalId', () => {
    expect(isValidSessionGoalSidecar(null)).toBe(false);
    expect(isValidSessionGoalSidecar('x')).toBe(false);
    expect(isValidSessionGoalSidecar({ ...projection, v: 2 })).toBe(false);
    expect(isValidSessionGoalSidecar({ ...projection, goalId: '' })).toBe(
      false,
    );
    expect(isValidSessionGoalSidecar({ ...projection, updatedAt: NaN })).toBe(
      false,
    );
    expect(isValidSessionGoalSidecar(projection)).toBe(true);
  });

  it('shape check rejects updatedAt outside the Date range', () => {
    // The catalog renders updatedAt via new Date(...).toISOString(), which
    // throws beyond ±8.64e15 ms; the boundary itself is still representable.
    expect(
      isValidSessionGoalSidecar({ ...projection, updatedAt: 8.64e15 }),
    ).toBe(true);
    expect(
      isValidSessionGoalSidecar({ ...projection, updatedAt: 8.64e15 + 1 }),
    ).toBe(false);
    expect(
      isValidSessionGoalSidecar({ ...projection, updatedAt: -8.64e15 - 1 }),
    ).toBe(false);
  });

  it('reads an out-of-range updatedAt as null', async () => {
    const file = path.join(dir, 's1.goal.json');
    await fs.writeFile(
      file,
      JSON.stringify({ ...projection, updatedAt: 8.64e15 + 1 }),
      'utf-8',
    );
    expect(await readSessionGoalSidecar(file)).toBeNull();
  });

  it('delete removes the projection and tolerates absence', async () => {
    const file = path.join(dir, 's1.goal.json');
    await writeSessionGoalSidecar(file, projection);
    await deleteSessionGoalSidecar(file);
    expect(await readSessionGoalSidecar(file)).toBeNull();
    await expect(deleteSessionGoalSidecar(file)).resolves.toBeUndefined();
  });

  it('does not issue an unlink when the sidecar is absent', async () => {
    // A goal-less restore backfill must not spend a redundant unlink (and
    // must not pollute the shared fs spy that unrelated suites assert on).
    const unlink = vi.mocked(fs.unlink);
    unlink.mockClear();
    await deleteSessionGoalSidecar(path.join(dir, 'missing.goal.json'));
    expect(unlink).not.toHaveBeenCalled();
  });

  it('tolerates ENOENT when an existing file vanishes before unlink', async () => {
    // existsSync saw the projection, then a racing archive rename removed
    // it; the unlink's ENOENT must read as already-cleared, not a failure.
    const file = path.join(dir, 's1.goal.json');
    await writeSessionGoalSidecar(file, projection);
    unlinkControl.failWith = Object.assign(new Error('gone'), {
      code: 'ENOENT',
    });
    await expect(deleteSessionGoalSidecar(file)).resolves.toBeUndefined();
  });

  it('move carries the projection and tolerates an absent source', async () => {
    const from = path.join(dir, 'active', 's1.goal.json');
    const to = path.join(dir, 'archived', 's1.goal.json');
    await writeSessionGoalSidecar(from, projection);
    await moveSessionGoalSidecar(from, to);
    expect(await readSessionGoalSidecar(from)).toBeNull();
    expect(await readSessionGoalSidecar(to)).toEqual(projection);
    await expect(
      moveSessionGoalSidecar(path.join(dir, 'gone.json'), to),
    ).resolves.toBeUndefined();
  });

  it('write creates missing parent directories', async () => {
    const file = path.join(dir, 'deep', 'nested', 's1.goal.json');
    await writeSessionGoalSidecar(file, projection);
    expect(await readSessionGoalSidecar(file)).toEqual(projection);
  });

  it('concurrent transitions land in order even when the first write is slowest', async () => {
    // Without serialization the slowest (oldest) projection would rename
    // last and strand a stale marker. Delays are inverted on purpose.
    const file = path.join(dir, 's1.goal.json');
    writeControl.delays = [40, 10, 0];
    const older = { ...projection, status: 'active' as const, updatedAt: 1 };
    const middle = { ...projection, status: 'paused' as const, updatedAt: 2 };
    const newest = {
      ...projection,
      status: 'usage_limited' as const,
      updatedAt: 3,
    };

    await Promise.all([
      writeSessionGoalSidecar(file, older),
      writeSessionGoalSidecar(file, middle),
      writeSessionGoalSidecar(file, newest),
    ]);

    expect(await readSessionGoalSidecar(file)).toEqual(newest);
  });

  it('a queued delete lands after a slower pending write (clear wins)', async () => {
    // A goal cleared while a slower projection write is still queued must
    // stay cleared: moving the delete off the queue would let the pending
    // write rename its projection back into place after the unlink.
    const file = path.join(dir, 's1.goal.json');
    writeControl.delays = [40];
    const write = writeSessionGoalSidecar(file, projection);
    const clear = deleteSessionGoalSidecar(file);

    await Promise.all([write, clear]);

    expect(await readSessionGoalSidecar(file)).toBeNull();
  });

  it('a queued write lands after a pending delete (re-create wins)', async () => {
    // The delay belongs on the UNLINK: a genuinely slow delete racing a
    // re-create is the case that loses the marker. Unqueued, the delete
    // would finish AFTER the new projection was written and unlink it.
    const file = path.join(dir, 's1.goal.json');
    await writeSessionGoalSidecar(file, projection);
    unlinkControl.delays = [40];
    const clear = deleteSessionGoalSidecar(file);
    const write = writeSessionGoalSidecar(file, {
      ...projection,
      status: 'paused',
    });

    await Promise.all([clear, write]);

    expect(await readSessionGoalSidecar(file)).toEqual({
      ...projection,
      status: 'paused',
    });
  });

  it('a failed mutation does not block later mutations', async () => {
    const file = path.join(dir, 's1.goal.json');
    writeControl.failFirst = true;
    const failed = writeSessionGoalSidecar(file, projection);
    const succeeded = writeSessionGoalSidecar(file, {
      ...projection,
      status: 'paused',
    });

    await expect(failed).rejects.toThrow('injected write failure');
    await expect(succeeded).resolves.toBeUndefined();
    expect(await readSessionGoalSidecar(file)).toEqual({
      ...projection,
      status: 'paused',
    });
  });
});
