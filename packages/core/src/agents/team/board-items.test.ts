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
  createAsk,
  getAsk,
  listAsks,
  answerAsk,
  declineAsk,
  settleAsk,
  AskSettledError,
  type AskRecord,
} from './asks.js';
import {
  raiseDecision,
  getDecision,
  listDecisions,
  resolveDecision,
  DecisionSettledError,
} from './decisions.js';
import { getBoardDir } from './board-lock.js';

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

describe('board items', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-items-test-'));
    setMockDir(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('ask', () => {
    it('lands under boards/{board}/asks with a typeable id', async () => {
      const ask = await createAsk({
        board: BOARD,
        from: 'api',
        to: 'web',
        question: 'is status a string?',
      });
      expect(ask.id).toBe('a-1');
      expect(ask.state).toBe('open');
      await expect(
        fs.stat(path.join(getBoardDir(BOARD), 'asks', 'a-1.json')),
      ).resolves.toBeDefined();
    });

    it('allocates ids from the directory, not a counter', async () => {
      await createAsk({ board: BOARD, from: 'a', to: 'b', question: 'q1' });
      const second = await createAsk({
        board: BOARD,
        from: 'a',
        to: 'b',
        question: 'q2',
      });
      expect(second.id).toBe('a-2');
    });

    // The point of an ask over a message: a sender always learns which of the
    // three outcomes happened.
    it('reaches answered, declined and timeout', async () => {
      const a1 = await createAsk({
        board: BOARD,
        from: 'a',
        to: 'b',
        question: 'q',
      });
      expect((await answerAsk(BOARD, a1.id, 'yes')).state).toBe('answered');

      const a2 = await createAsk({
        board: BOARD,
        from: 'a',
        to: 'b',
        question: 'q',
      });
      const declined = await declineAsk(BOARD, a2.id, 'not my area');
      expect(declined.state).toBe('declined');
      expect(declined.reason).toBe('not my area');

      const a3 = await createAsk({
        board: BOARD,
        from: 'a',
        to: 'b',
        question: 'q',
        ttlMs: 1,
      });
      await new Promise((r) => setTimeout(r, 5));
      expect((await getAsk(BOARD, a3.id))?.state).toBe('timeout');
    });

    // Lazy settling is what lets timeout be terminal with no daemon running.
    it('reports timeout on read without rewriting the file', async () => {
      const ask = await createAsk({
        board: BOARD,
        from: 'a',
        to: 'b',
        question: 'q',
        ttlMs: 1,
      });
      await new Promise((r) => setTimeout(r, 5));

      expect((await getAsk(BOARD, ask.id))?.state).toBe('timeout');

      const onDisk = JSON.parse(
        await fs.readFile(
          path.join(getBoardDir(BOARD), 'asks', `${ask.id}.json`),
          'utf8',
        ),
      ) as AskRecord;
      expect(onDisk.state).toBe('open');
    });

    it('settleAsk is a pure function of the deadline', () => {
      const base: AskRecord = {
        schemaVersion: 1,
        id: 'a-1',
        from: 'a',
        to: 'b',
        question: 'q',
        state: 'open',
        createdAt: 0,
        expiresAt: 100,
        answer: null,
        reason: null,
        settledAt: null,
      };
      expect(settleAsk(base, 99).state).toBe('open');
      expect(settleAsk(base, 100).state).toBe('timeout');
      expect(settleAsk({ ...base, state: 'answered' }, 999).state).toBe(
        'answered',
      );
    });

    // Answering a lapsed ask would silently resurrect it, so the deadline is
    // re-checked under the lock rather than only at read time.
    it('refuses to answer an ask that lapsed while waiting', async () => {
      const ask = await createAsk({
        board: BOARD,
        from: 'a',
        to: 'b',
        question: 'q',
        ttlMs: 1,
      });
      await new Promise((r) => setTimeout(r, 5));
      await expect(answerAsk(BOARD, ask.id, 'late')).rejects.toBeInstanceOf(
        AskSettledError,
      );
    });

    it('refuses to settle twice', async () => {
      const ask = await createAsk({
        board: BOARD,
        from: 'a',
        to: 'b',
        question: 'q',
      });
      await answerAsk(BOARD, ask.id, 'yes');
      await expect(declineAsk(BOARD, ask.id, 'no')).rejects.toBeInstanceOf(
        AskSettledError,
      );
    });

    it('filters by recipient and state', async () => {
      await createAsk({ board: BOARD, from: 'a', to: 'b', question: 'q1' });
      const other = await createAsk({
        board: BOARD,
        from: 'a',
        to: 'c',
        question: 'q2',
      });
      await answerAsk(BOARD, other.id, 'done');

      expect((await listAsks(BOARD, { to: 'b' })).map((x) => x.id)).toEqual([
        'a-1',
      ]);
      expect(
        (await listAsks(BOARD, { states: ['answered'] })).map((x) => x.id),
      ).toEqual(['a-2']);
    });

    it('ignores files that are not items', async () => {
      await createAsk({ board: BOARD, from: 'a', to: 'b', question: 'q' });
      const dir = path.join(getBoardDir(BOARD), 'asks');
      await fs.writeFile(path.join(dir, 'notes-2026.md'), 'not an item');
      await fs.writeFile(path.join(dir, 'a-x.json'), '{}');
      expect((await listAsks(BOARD)).map((x) => x.id)).toEqual(['a-1']);
    });

    it('returns an empty list for a board that does not exist', async () => {
      expect(await listAsks('never-used')).toEqual([]);
    });

    it('rejects names that could escape the board root', async () => {
      await expect(
        createAsk({ board: '../escape', from: 'a', to: 'b', question: 'q' }),
      ).rejects.toThrow(/Invalid board name/);
    });
  });

  describe('decision', () => {
    it('records the three kinds', async () => {
      const d = await raiseDecision({
        board: BOARD,
        kind: 'approval',
        raisedBy: 'api',
        question: 'may I write src/auth.ts?',
      });
      expect(d.id).toBe('d-1');
      expect(d.state).toBe('open');
      expect(d.resolvedAt).toBeNull();
    });

    it('requires the task for acceptance and adjudication', async () => {
      await expect(
        raiseDecision({
          board: BOARD,
          kind: 'acceptance',
          raisedBy: 'api',
          question: 'accept?',
        }),
      ).rejects.toThrow(/must name the task/);

      await expect(
        raiseDecision({
          board: BOARD,
          kind: 'adjudication',
          raisedBy: 'api',
          question: 'who is right?',
          about: 't-3',
        }),
      ).resolves.toBeDefined();
    });

    // No expiry, deliberately: silent expiry would convert "nobody looked" into
    // "the system decided", which is authority only a human may hold.
    it('never expires', async () => {
      const d = await raiseDecision({
        board: BOARD,
        kind: 'approval',
        raisedBy: 'api',
        question: 'q',
      });
      await new Promise((r) => setTimeout(r, 5));
      const later = await getDecision(BOARD, d.id);
      expect(later?.state).toBe('open');
      expect(later).not.toHaveProperty('expiresAt');
    });

    it('resolves once, with an optional note', async () => {
      const d = await raiseDecision({
        board: BOARD,
        kind: 'acceptance',
        raisedBy: 'api',
        question: 'accept t-3?',
        about: 't-3',
      });
      const resolved = await resolveDecision(
        BOARD,
        d.id,
        'rejected',
        'evidence is thin',
      );
      expect(resolved.state).toBe('rejected');
      expect(resolved.note).toBe('evidence is thin');
      await expect(
        resolveDecision(BOARD, d.id, 'approved'),
      ).rejects.toBeInstanceOf(DecisionSettledError);
    });

    it('lists oldest first so the longest wait reads at the top', async () => {
      const first = await raiseDecision({
        board: BOARD,
        kind: 'approval',
        raisedBy: 'a',
        question: 'q1',
      });
      const second = await raiseDecision({
        board: BOARD,
        kind: 'approval',
        raisedBy: 'a',
        question: 'q2',
      });
      const open = await listDecisions(BOARD, { states: ['open'] });
      expect(open.map((d) => d.id)).toEqual([first.id, second.id]);
    });
  });
});
