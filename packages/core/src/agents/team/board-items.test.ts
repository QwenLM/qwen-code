/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerAsk,
  createAsk,
  declineAsk,
  listAsks,
  pruneAsks,
} from './asks.js';
import { getCollectionDir } from './board-lock.js';

vi.mock('../../config/storage.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../config/storage.js')>();
  let globalDir = '';
  return {
    ...original,
    Storage: {
      ...original.Storage,
      getGlobalQwenDir: () => globalDir,
      __setMockGlobalDir: (dir: string) => {
        globalDir = dir;
      },
    },
  };
});

// Observability only: every `lockfile.lock` call still goes to the real
// implementation. A prune that reaches for the item lock tells the test it has
// finished scanning, which is what makes "the record is re-read under the lock"
// a pinned guarantee rather than a timing coincidence.
const lockProbe = vi.hoisted(() => ({
  path: undefined as string | undefined,
  reached: undefined as (() => void) | undefined,
}));

vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    default: {
      ...actual,
      lock(...args: Parameters<typeof actual.lock>) {
        if (String(args[0]) === lockProbe.path) lockProbe.reached?.();
        return actual.lock(...args);
      },
    },
  };
});

import { Storage } from '../../config/storage.js';

function setGlobalDir(dir: string): void {
  (
    Storage as unknown as { __setMockGlobalDir: (value: string) => void }
  ).__setMockGlobalDir(dir);
}

describe('board asks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-items-'));
    setGlobalDir(tmpDir);
  });

  afterEach(async () => {
    lockProbe.path = undefined;
    lockProbe.reached = undefined;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('lets only the addressed actor answer or decline', async () => {
    const ask = await createAsk({
      board: 'demo',
      from: 'api',
      to: 'web',
      question: 'is status a string?',
    });
    await expect(answerAsk('demo', ask.id, 'api', 'yes')).rejects.toThrow(
      'addressed to "web"',
    );
    await expect(
      answerAsk('demo', ask.id, 'web', 'yes'),
    ).resolves.toMatchObject({ state: 'answered', answer: 'yes' });

    const second = await createAsk({
      board: 'demo',
      from: 'api',
      to: 'web',
      question: 'can you check?',
    });
    await expect(
      declineAsk('demo', second.id, 'web', 'not now'),
    ).resolves.toMatchObject({ state: 'declined', reason: 'not now' });
  });

  it('skips malformed records in list operations', async () => {
    await createAsk({
      board: 'demo',
      from: 'api',
      to: 'web',
      question: 'healthy',
    });
    const asksDir = getCollectionDir('demo', 'asks');
    await fs.writeFile(
      path.join(asksDir, 'a-00000000-0000-4000-8000-000000000000.json'),
      JSON.stringify({ schemaVersion: 99 }),
    );
    // Valid UUIDv4 filenames so these records reach content validation
    // (all-zero names are rejected by the filename filter before parsing).
    await fs.writeFile(
      path.join(asksDir, 'a-00000000-0000-4000-8000-000000000001.json'),
      '{}',
    );
    await expect(listAsks('demo')).resolves.toMatchObject([
      { question: 'healthy' },
    ]);
  });

  it('rejects records whose id does not match the filename', async () => {
    const firstAsk = await createAsk({
      board: 'demo',
      from: 'api',
      to: 'web',
      question: 'first',
    });
    const secondAsk = await createAsk({
      board: 'demo',
      from: 'api',
      to: 'web',
      question: 'second',
    });
    const firstAskPath = path.join(
      getCollectionDir('demo', 'asks'),
      `${firstAsk.id}.json`,
    );
    await fs.writeFile(
      firstAskPath,
      JSON.stringify({ ...firstAsk, id: secondAsk.id }),
    );
    await expect(listAsks('demo')).resolves.toMatchObject([
      { question: 'second' },
    ]);
    await expect(answerAsk('demo', firstAsk.id, 'web', 'yes')).rejects.toThrow(
      'does not match its filename',
    );
  });

  it('re-checks prune eligibility while holding the item lock', async () => {
    const ask = await createAsk({
      board: 'demo',
      from: 'api',
      to: 'web',
      question: 'still needed?',
      ttlMs: 1000,
    });
    const target = path.join(
      getCollectionDir('demo', 'asks'),
      `${ask.id}.json`,
    );
    const pruneNow = ask.expiresAt + 1;

    // Hold the cross-process lock the way a foreign runtime sharing the board
    // would — through proper-lockfile directly, leaving the in-process mutex
    // free so prune gets all the way to its own lock attempt.
    const release = await lockfile.lock(target, { retries: 0 });
    const pruneIsBlocked = new Promise<void>((resolve) => {
      lockProbe.reached = resolve;
    });
    lockProbe.path = target;

    const pruning = pruneAsks('demo', 0, pruneNow);
    // Reopen the ask only once prune is provably waiting on the lock. An
    // implementation that reads before locking has already picked up the
    // expired bytes by now, and goes on to delete a record a foreign runtime
    // just reopened.
    const finishedFirst = await Promise.race([
      pruneIsBlocked.then(() => false),
      // Both handlers attached so neither outcome can surface later as an
      // unhandled rejection once the race has already settled.
      pruning.then(
        () => true,
        () => true,
      ),
    ]);
    if (finishedFirst) {
      // Prune never blocked on the lock. Report whatever it actually did.
      await expect(pruning).resolves.toEqual([]);
      throw new Error('prune finished without waiting for the item lock');
    }
    await fs.writeFile(
      target,
      JSON.stringify({ ...ask, expiresAt: pruneNow + 1000 }),
    );
    await release();

    await expect(pruning).resolves.toEqual([]);
    await expect(listAsks('demo')).resolves.toMatchObject([{ state: 'open' }]);
  });

  it('reports pruned items by id, not by filename', async () => {
    const ask = await createAsk({
      board: 'demo',
      from: 'api',
      to: 'web',
      question: 'settled',
      ttlMs: 1000,
    });
    await declineAsk('demo', ask.id, 'web', 'not my area');
    await expect(pruneAsks('demo', 0)).resolves.toEqual([ask.id]);
    await expect(listAsks('demo')).resolves.toEqual([]);
  });
});
