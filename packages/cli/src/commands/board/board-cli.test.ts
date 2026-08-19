/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveBoardName,
  resolveParticipantName,
  isInteractiveInvocation,
} from './context.js';
import {
  renderBoard,
  findDeadlocks,
  age,
  type BoardSnapshot,
} from './render.js';
import type {
  BoardTaskRecord,
  AskRecord,
  DecisionRecord,
} from '@qwen-code/qwen-code-core';

function task(over: Partial<BoardTaskRecord> = {}): BoardTaskRecord {
  return {
    schemaVersion: 1,
    id: 't-1',
    subject: 'investigate contract',
    owner: 'api-worker',
    status: 'in_progress',
    createdAt: 0,
    updatedAt: 0,
    notes: [],
    blocks: [],
    blockedBy: [],
    ...over,
  };
}

function ask(over: Partial<AskRecord> = {}): AskRecord {
  return {
    schemaVersion: 1,
    id: 'a-1',
    from: 'api-worker',
    to: 'web-worker',
    question: 'is status a string?',
    state: 'open',
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    answer: null,
    reason: null,
    settledAt: null,
    ...over,
  };
}

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    schemaVersion: 1,
    id: 'd-1',
    kind: 'approval',
    raisedBy: 'web-worker',
    question: 'may I write src/client.ts?',
    state: 'open',
    createdAt: 0,
    resolvedAt: null,
    note: null,
    ...over,
  };
}

describe('board context', () => {
  it('derives a board name from the project directory', () => {
    expect(resolveBoardName({ cwd: '/home/me/work/api', env: {} })).toBe('api');
  });

  it('sanitises a directory name the layout would reject', () => {
    expect(resolveBoardName({ cwd: '/home/me/my project!', env: {} })).toBe(
      'my-project-',
    );
  });

  // An explicit board is what makes cross-workspace collaboration expressible:
  // a board that were merely the directory could not span two repositories.
  it('prefers an explicit board, then the environment', () => {
    expect(resolveBoardName({ board: 'shared', cwd: '/x/api', env: {} })).toBe(
      'shared',
    );
    expect(
      resolveBoardName({ cwd: '/x/api', env: { QWEN_BOARD: 'from-env' } }),
    ).toBe('from-env');
  });

  it('falls back to a usable participant name with no configuration', () => {
    const name = resolveParticipantName({ env: {} });
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(resolveParticipantName({ as: 'api-worker', env: {} })).toBe(
      'api-worker',
    );
  });
});

describe('board rendering', () => {
  const now = 10 * 60 * 1000;

  it('leads with what needs a human, then what is blocked, then work', () => {
    const snapshot: BoardSnapshot = {
      board: 'demo',
      tasks: [task()],
      asks: [ask()],
      decisions: [decision()],
      participantCount: 2,
    };
    const lines = renderBoard(snapshot, now).split('\n');
    const decisionAt = lines.findIndex((l) => l.includes('d-1'));
    const askAt = lines.findIndex((l) => l.includes('a-1'));
    const taskAt = lines.findIndex((l) => l.includes('t-1'));

    expect(decisionAt).toBeGreaterThan(-1);
    expect(decisionAt).toBeLessThan(askAt);
    expect(askAt).toBeLessThan(taskAt);
  });

  it('hides settled items — the panel is for what has not moved', () => {
    const snapshot: BoardSnapshot = {
      board: 'demo',
      tasks: [task({ status: 'completed' })],
      asks: [ask({ state: 'answered', answer: 'yes' })],
      decisions: [decision({ state: 'approved' })],
      participantCount: 2,
    };
    const out = renderBoard(snapshot, now);
    expect(out).not.toContain('a-1');
    expect(out).not.toContain('d-1');
    expect(out).toContain('1 done');
  });

  it('shows the live participant count', () => {
    const out = renderBoard(
      {
        board: 'demo',
        tasks: [task()],
        asks: [ask()],
        decisions: [],
        participantCount: 2,
      },
      now,
    );
    expect(out).toContain('2 participants');
  });

  it('says so when there is nothing on the board', () => {
    expect(
      renderBoard(
        {
          board: 'demo',
          tasks: [],
          asks: [],
          decisions: [],
          participantCount: 0,
        },
        now,
      ),
    ).toContain('(empty)');
  });

  it('formats ages compactly enough for a narrow pane', () => {
    expect(age(0, 30_000)).toBe('30s');
    expect(age(0, 4 * 60_000)).toBe('4m');
    expect(age(0, 3 * 3_600_000)).toBe('3h');
    expect(age(0, 2 * 86_400_000)).toBe('2d');
  });

  // The one thing a cross-session view sees that no participant sees about
  // itself: from inside, each is simply waiting.
  describe('deadlock detection', () => {
    it('finds a mutual wait once, not twice', () => {
      const pairs = findDeadlocks([
        ask({ id: 'a-1', from: 'api', to: 'web' }),
        ask({ id: 'a-2', from: 'web', to: 'api' }),
      ]);
      expect(pairs).toHaveLength(1);
      expect(pairs[0].sort()).toEqual(['api', 'web']);
    });

    it('ignores one-way waits and settled asks', () => {
      expect(
        findDeadlocks([ask({ id: 'a-1', from: 'api', to: 'web' })]),
      ).toEqual([]);
      expect(
        findDeadlocks([
          ask({ id: 'a-1', from: 'api', to: 'web' }),
          ask({ id: 'a-2', from: 'web', to: 'api', state: 'answered' }),
        ]),
      ).toEqual([]);
    });

    it('surfaces the cycle above the asks it is made of', () => {
      const out = renderBoard(
        {
          board: 'demo',
          tasks: [],
          decisions: [],
          asks: [
            ask({ id: 'a-1', from: 'api', to: 'web' }),
            ask({ id: 'a-2', from: 'web', to: 'api' }),
          ],
        },
        now,
      );
      const lines = out.split('\n');
      expect(lines.findIndex((l) => l.includes('each waiting'))).toBeLessThan(
        lines.findIndex((l) => l.includes('a-1')),
      );
    });
  });

  // `decision` exists because approval needs authority no agent holds. That was
  // a sentence in the prompt on a command line agents use for everything else,
  // so anything with a shell could approve its own request. A tty is the
  // cheapest structural difference between a person and a tool call.
  describe('decision authority', () => {
    it('recognises a terminal, and does not recognise a captured pipe', () => {
      expect(isInteractiveInvocation({ isTTY: true }, { isTTY: true })).toBe(
        true,
      );
      expect(isInteractiveInvocation({ isTTY: false }, { isTTY: true })).toBe(
        false,
      );
      expect(isInteractiveInvocation({ isTTY: true }, { isTTY: false })).toBe(
        false,
      );
      // An agent's shell tool captures both ends.
      expect(isInteractiveInvocation({}, {})).toBe(false);
    });
  });
});
