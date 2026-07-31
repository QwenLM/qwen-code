/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { selectTip } from './tipScheduler.js';
import { TipHistory } from './tipHistory.js';
import type { ContextualTip, TipContext } from './tipRegistry.js';

const tempPaths: string[] = [];

function tmpPath(): string {
  const p = join(
    tmpdir(),
    `test-scheduler-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  tempPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tempPaths) {
    rmSync(p, { force: true });
  }
  tempPaths.length = 0;
});

function createContext(overrides: Partial<TipContext> = {}): TipContext {
  return {
    lastPromptTokenCount: 0,
    contextWindowSize: 1_000_000,
    sessionPromptCount: 5,
    sessionCount: 10,
    platform: 'linux',
    ...overrides,
  };
}

function createHistory(): TipHistory {
  return new TipHistory({ sessionCount: 10, tips: {} }, tmpPath());
}

const tipA: ContextualTip = {
  id: 'tip-a',
  content: 'Tip A content',
  trigger: 'post-response',
  isRelevant: () => true,
  cooldownPrompts: 3,
  priority: 10,
};

const tipB: ContextualTip = {
  id: 'tip-b',
  content: 'Tip B content',
  trigger: 'post-response',
  isRelevant: () => true,
  cooldownPrompts: 3,
  priority: 20,
};

const tipC: ContextualTip = {
  id: 'tip-c',
  content: 'Tip C content',
  trigger: 'startup',
  isRelevant: () => true,
  cooldownPrompts: 0,
  priority: 10,
};

describe('selectTip', () => {
  it('returns null for empty tips', () => {
    const result = selectTip(
      'post-response',
      createContext(),
      [],
      createHistory(),
    );
    expect(result).toBeNull();
  });

  it('filters by trigger type', () => {
    const history = createHistory();
    const result = selectTip(
      'startup',
      createContext(),
      [tipA, tipB, tipC],
      history,
    );
    expect(result).not.toBeNull();
    expect(result!.id).toBe('tip-c');
  });

  it('selects highest priority tip', () => {
    const history = createHistory();
    const result = selectTip(
      'post-response',
      createContext(),
      [tipA, tipB],
      history,
    );
    expect(result!.id).toBe('tip-b');
  });

  it('uses LRU for equal priority — prefers never-shown tip', () => {
    const history = createHistory();
    const tipX: ContextualTip = { ...tipA, id: 'tip-x', priority: 10 };
    const tipY: ContextualTip = { ...tipA, id: 'tip-y', priority: 10 };

    // Show tip-x first (gets high session-shown score)
    history.recordShown('tip-x', 1);

    const ctx = createContext({ sessionPromptCount: 10 });
    const result = selectTip('post-response', ctx, [tipX, tipY], history);
    // tip-y was never shown (lastShown=0), so it should be selected (LRU)
    expect(result!.id).toBe('tip-y');
  });

  it('respects cooldown', () => {
    const history = createHistory();
    const tip: ContextualTip = {
      ...tipA,
      cooldownPrompts: 5,
    };

    // Show at prompt 3
    history.recordShown(tip.id, 3);

    // At prompt 5, cooldown not met (5 - 3 = 2 < 5)
    const ctx1 = createContext({ sessionPromptCount: 5 });
    const result1 = selectTip('post-response', ctx1, [tip], history);
    expect(result1).toBeNull();

    // At prompt 8, cooldown met (8 - 3 = 5 >= 5)
    const ctx2 = createContext({ sessionPromptCount: 8 });
    const result2 = selectTip('post-response', ctx2, [tip], history);
    expect(result2!.id).toBe('tip-a');
  });

  it('skips tips where isRelevant returns false', () => {
    const history = createHistory();
    const irrelevant: ContextualTip = {
      ...tipB,
      isRelevant: () => false,
    };
    const result = selectTip(
      'post-response',
      createContext(),
      [irrelevant, tipA],
      history,
    );
    expect(result!.id).toBe('tip-a');
  });

  it('handles isRelevant throwing an error', () => {
    const history = createHistory();
    const broken: ContextualTip = {
      ...tipB,
      isRelevant: () => {
        throw new Error('boom');
      },
    };
    const result = selectTip(
      'post-response',
      createContext(),
      [broken, tipA],
      history,
    );
    expect(result!.id).toBe('tip-a');
  });
});
