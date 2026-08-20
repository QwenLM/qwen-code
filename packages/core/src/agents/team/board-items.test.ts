/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerAsk, createAsk, declineAsk, listAsks } from './asks.js';
import {
  listDecisions,
  pruneDecisions,
  raiseDecision,
  resolveDecision,
} from './decisions.js';
import { getCollectionDir, withItemLock } from './board-lock.js';

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

import { Storage } from '../../config/storage.js';

function setGlobalDir(dir: string): void {
  (
    Storage as unknown as { __setMockGlobalDir: (value: string) => void }
  ).__setMockGlobalDir(dir);
}

describe('board asks and decisions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-items-'));
    setGlobalDir(tmpDir);
  });

  afterEach(async () => {
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

  it('records who raised and resolved a decision', async () => {
    const decision = await raiseDecision({
      board: 'demo',
      raisedBy: 'worker',
      question: 'ship it?',
    });
    await expect(
      resolveDecision('demo', decision.id, 'human', 'approved', 'looks good'),
    ).resolves.toMatchObject({
      state: 'approved',
      raisedBy: 'worker',
      resolvedBy: 'human',
      note: 'looks good',
    });
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
    const decisionsDir = getCollectionDir('demo', 'decisions');
    await fs.mkdir(decisionsDir, { recursive: true });
    await fs.writeFile(
      path.join(decisionsDir, 'd-00000000-0000-4000-8000-000000000000.json'),
      '{}',
    );
    await expect(listAsks('demo')).resolves.toMatchObject([
      { question: 'healthy' },
    ]);
    await expect(listDecisions('demo')).resolves.toEqual([]);
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

    const firstDecision = await raiseDecision({
      board: 'demo',
      raisedBy: 'worker',
      question: 'first?',
    });
    const secondDecision = await raiseDecision({
      board: 'demo',
      raisedBy: 'worker',
      question: 'second?',
    });
    await fs.writeFile(
      path.join(
        getCollectionDir('demo', 'decisions'),
        `${firstDecision.id}.json`,
      ),
      JSON.stringify({ ...firstDecision, id: secondDecision.id }),
    );
    await expect(listDecisions('demo')).resolves.toMatchObject([
      { question: 'second?' },
    ]);
    await expect(
      resolveDecision('demo', firstDecision.id, 'human', 'approved'),
    ).rejects.toThrow('does not match its filename');
  });

  it('re-checks prune eligibility while holding the item lock', async () => {
    const decision = await raiseDecision({
      board: 'demo',
      raisedBy: 'worker',
      question: 'ship it?',
    });
    const resolved = await resolveDecision(
      'demo',
      decision.id,
      'human',
      'approved',
    );
    const target = path.join(
      getCollectionDir('demo', 'decisions'),
      `${decision.id}.json`,
    );

    let pruning: Promise<string[]> | undefined;
    await withItemLock(target, async () => {
      pruning = pruneDecisions('demo', 0, Date.now() + 1);
      await new Promise((resolve) => setImmediate(resolve));
      await fs.writeFile(
        target,
        JSON.stringify({
          ...resolved,
          state: 'open',
          resolvedAt: null,
          resolvedBy: null,
        }),
      );
    });

    await expect(pruning).resolves.toEqual([]);
    await expect(listDecisions('demo')).resolves.toMatchObject([
      { state: 'open' },
    ]);
  });
});
