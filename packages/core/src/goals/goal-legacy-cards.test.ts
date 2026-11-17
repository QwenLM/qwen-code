/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { findRunningLegacyGoalCard } from './goal-legacy-cards.js';
import type { GoalRecoveryRecord } from './goal-persistence.js';

function card(
  kind: string,
  condition: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'goal_status', kind, condition, ...extra };
}

function cardRecord(
  uuid: string,
  cards: unknown[],
  phase: 'invocation' | 'result' = 'result',
): GoalRecoveryRecord {
  return {
    uuid,
    type: 'system',
    subtype: 'slash_command',
    systemPayload: {
      phase,
      rawCommand: '/goal',
      outputHistoryItems: cards,
    },
  };
}

function stateRecord(uuid: string): GoalRecoveryRecord {
  return {
    uuid,
    type: 'system',
    subtype: 'goal_state',
    systemPayload: { v: 2, cause: 'clear', snapshot: { goal: null } },
  };
}

describe('findRunningLegacyGoalCard', () => {
  it('returns the newest running card with its iteration count', () => {
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'ship it', { iterations: 0 })]),
        { uuid: 'u1', type: 'user' },
        cardRecord('r2', [card('checking', 'ship it', { iterations: 3 })]),
      ]),
    ).toEqual({ condition: 'ship it', iterations: 3 });
  });

  it('returns nothing when the newest card ended the run', () => {
    for (const kind of ['achieved', 'cleared', 'aborted', 'failed', 'paused']) {
      expect(
        findRunningLegacyGoalCard([
          cardRecord('r1', [card('set', 'ship it')]),
          cardRecord('r2', [card(kind, 'ship it')]),
        ]),
      ).toBeUndefined();
    }
  });

  it('returns nothing once a goal_state record follows the card', () => {
    // A build that journals Goal state has decided the Goal since the card,
    // whatever that record holds; the card is history.
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'ship it')]),
        stateRecord('s1'),
      ]),
    ).toBeUndefined();
  });

  it('ignores a goal_state record older than the running card', () => {
    expect(
      findRunningLegacyGoalCard([
        stateRecord('s1'),
        cardRecord('r1', [card('set', 'ship it')]),
      ]),
    ).toEqual({ condition: 'ship it', iterations: 0 });
  });

  it('carries setAt from the set card that opened the run', () => {
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'ship it', { setAt: 100 })]),
        cardRecord('r2', [card('checking', 'ship it', { iterations: 1 })]),
        cardRecord('r3', [card('checking', 'ship it', { iterations: 2 })]),
      ]),
    ).toEqual({ condition: 'ship it', iterations: 2, setAt: 100 });
  });

  it('does not borrow setAt from an earlier run', () => {
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'earlier', { setAt: 100 })]),
        cardRecord('r2', [card('achieved', 'earlier')]),
        cardRecord('r3', [card('checking', 'ship it', { iterations: 1 })]),
      ]),
    ).toEqual({ condition: 'ship it', iterations: 1 });
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'earlier', { setAt: 100 })]),
        cardRecord('r2', [card('checking', 'ship it', { iterations: 1 })]),
      ]),
    ).toEqual({ condition: 'ship it', iterations: 1 });
  });

  it('does not borrow setAt from across a goal_state record', () => {
    // The run the running card belongs to started after the journaled
    // transition; a same-condition set card before it is an earlier run.
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'ship it', { setAt: 100 })]),
        stateRecord('s1'),
        cardRecord('r2', [card('checking', 'ship it', { iterations: 1 })]),
      ]),
    ).toEqual({ condition: 'ship it', iterations: 1 });
  });

  it('reads the newest card of a record that holds several', () => {
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [
          card('set', 'ship it', { setAt: 5 }),
          card('checking', 'ship it', { iterations: 4 }),
        ]),
      ]),
    ).toEqual({ condition: 'ship it', iterations: 4, setAt: 5 });
  });

  it('skips invocation records, malformed entries and other record kinds', () => {
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'ship it')]),
        cardRecord('r2', [card('cleared', 'ship it')], 'invocation'),
        {
          uuid: 'r3',
          type: 'system',
          subtype: 'slash_command',
          systemPayload: { phase: 'result', outputHistoryItems: 'nope' },
        },
        cardRecord('r4', [null, 7, { type: 'goal_status', kind: 'set' }]),
        { uuid: 'u1', type: 'user', subtype: 'slash_command' },
      ]),
    ).toEqual({ condition: 'ship it', iterations: 0 });
  });

  it('skips a card of a kind no replay shows', () => {
    // The replay drops it, so the card before it is still the newest shown.
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'ship it')]),
        cardRecord('r2', [card('retired-kind', 'ship it')]),
      ]),
    ).toEqual({ condition: 'ship it', iterations: 0 });
  });

  it('lets a card with an empty condition still end the run before it', () => {
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'goal A')]),
        cardRecord('r2', [card('cleared', '')]),
      ]),
    ).toBeUndefined();
    // The newest card wins, so goal A must not come back; the empty
    // condition is reported as it is for the caller to refuse.
    expect(
      findRunningLegacyGoalCard([
        cardRecord('r1', [card('set', 'goal A')]),
        cardRecord('r2', [card('set', '')]),
      ])?.condition,
    ).toBe('');
  });

  it('returns nothing for a transcript with no card', () => {
    expect(findRunningLegacyGoalCard([])).toBeUndefined();
    expect(
      findRunningLegacyGoalCard([{ uuid: 'u1', type: 'user' }]),
    ).toBeUndefined();
  });
});
