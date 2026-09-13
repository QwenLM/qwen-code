/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerAsk,
  createAsk,
  declineAsk,
  getAsk,
  listAsks,
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

import { Storage } from '../../config/storage.js';

function setGlobalDir(dir: string): void {
  (
    Storage as unknown as { __setMockGlobalDir: (value: string) => void }
  ).__setMockGlobalDir(dir);
}

const VALID_ASK_ID = 'a-11111111-2222-4333-8444-555555555555';

async function writeAskRecord(record: Record<string, unknown>): Promise<void> {
  const dir = getCollectionDir('demo', 'asks');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${record['id']}.json`),
    JSON.stringify(record),
  );
}

function validAskFile(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: VALID_ASK_ID,
    from: 'api',
    to: 'web',
    question: 'ready?',
    state: 'open',
    createdAt: now,
    expiresAt: now + 60_000,
    answer: null,
    reason: null,
    settledAt: null,
    ...overrides,
  };
}

describe('board ask records', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-asks-'));
    setGlobalDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('refuses an ask addressed to its own actor', async () => {
    await expect(
      createAsk({
        board: 'demo',
        from: 'same',
        to: 'same',
        question: 'self?',
      }),
    ).rejects.toThrow('An ask must target another actor.');
  });

  it('auto-transitions an expired open ask to timeout on read', async () => {
    const ask = await createAsk({
      board: 'demo',
      from: 'api',
      to: 'web',
      question: 'still needed?',
      ttlMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    await expect(getAsk('demo', ask.id)).resolves.toMatchObject({
      id: ask.id,
      state: 'timeout',
      settledAt: ask.expiresAt,
      answer: null,
      reason: null,
    });
    // The on-disk record keeps its original shape; the transition is a read
    // projection, and listings expose it too (exit-code-3 depends on it).
    await expect(listAsks('demo')).resolves.toMatchObject([
      { state: 'timeout' },
    ]);
  });

  it('accepts a foreign timeout record with the settled shape', async () => {
    const base = validAskFile();
    await writeAskRecord({
      ...base,
      state: 'timeout',
      settledAt: base.expiresAt,
    });

    await expect(getAsk('demo', VALID_ASK_ID)).resolves.toMatchObject({
      state: 'timeout',
    });
    // A settled ask is final for every mutation.
    await expect(
      answerAsk('demo', VALID_ASK_ID, 'web', 'late'),
    ).rejects.toThrow('already timeout');
    await expect(
      declineAsk('demo', VALID_ASK_ID, 'web', 'late'),
    ).rejects.toThrow('already timeout');
  });

  it.each([
    ['missing settledAt', { state: 'timeout', settledAt: null }],
    [
      'carrying an answer',
      { state: 'timeout', settledAt: Date.now(), answer: 'late' },
    ],
    [
      'carrying a reason',
      { state: 'timeout', settledAt: Date.now(), reason: 'gone' },
    ],
    ['unknown state', { state: 'archived' }],
    ['expiresAt before createdAt', { expiresAt: 0, createdAt: 1000 }],
    [
      'open with a result',
      { state: 'open', settledAt: Date.now(), answer: 'early' },
    ],
    ['answered without answer', { state: 'answered', settledAt: Date.now() }],
    ['declined without reason', { state: 'declined', settledAt: Date.now() }],
  ])('rejects a record with %s', async (_label, overrides) => {
    await writeAskRecord(validAskFile(overrides));
    await expect(getAsk('demo', VALID_ASK_ID)).resolves.toBeNull();
    await expect(listAsks('demo')).resolves.toEqual([]);
  });
});
