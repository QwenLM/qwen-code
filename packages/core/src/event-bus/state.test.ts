/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createRunStateStore, currentRound } from './state.js';

describe('createRunStateStore', () => {
  it('creates, reads and deletes a run', () => {
    const store = createRunStateStore();
    const state = store.create({ runId: 'r1', promptId: 'p' });
    expect(store.get('r1')).toBe(state);
    store.delete('r1');
    expect(store.get('r1')).toBeUndefined();
  });

  it('rejects a second create for the same runId', () => {
    const store = createRunStateStore();
    store.create({ runId: 'r1', promptId: 'p' });
    expect(() => store.create({ runId: 'r1', promptId: 'p' })).toThrow(
      /already exists/,
    );
  });

  it('keeps runs independent', () => {
    const store = createRunStateStore();
    store.create({ runId: 'r1', promptId: 'p1' });
    store.create({ runId: 'r2', promptId: 'p2' });
    store.delete('r1');
    expect(store.get('r1')).toBeUndefined();
    expect(store.get('r2')?.promptId).toBe('p2');
  });
});

describe('currentRound', () => {
  it('returns the round when it matches the state', () => {
    expect(currentRound({ runId: 'r1', promptId: 'p', round: 2 }, 2)).toBe(2);
  });

  it('drops a late event from an abandoned round', () => {
    expect(
      currentRound({ runId: 'r1', promptId: 'p', round: 2 }, 1),
    ).toBeUndefined();
  });

  it('drops when the state or round is missing', () => {
    expect(currentRound(undefined, 1)).toBeUndefined();
    expect(currentRound({ runId: 'r1', promptId: 'p' }, 1)).toBeUndefined();
    expect(
      currentRound({ runId: 'r1', promptId: 'p', round: 1 }, undefined),
    ).toBeUndefined();
  });

  it('matches round 0 rather than treating it as absent', () => {
    expect(currentRound({ runId: 'r1', promptId: 'p', round: 0 }, 0)).toBe(0);
  });
});
