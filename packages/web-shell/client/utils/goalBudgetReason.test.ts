/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  goalActiveTimeBudgetReason,
  goalTokenBudgetReason,
  goalTurnBudgetReason,
} from '@qwen-code/qwen-code-core';
import { getTranslator } from '../i18n';
import { composeGoalBudgetReason } from './goalBudgetReason';

/** The RU grouping separator is NBSP, not a space. */
const RU_SENTENCE = (count: string, unit: string) =>
  `Цель исчерпала автономный бюджет токенов (${count} ${unit}). ` +
  `Возобновите цель, чтобы выдать ещё одно окно бюджета, или снимите её.`;

describe('composeGoalBudgetReason', () => {
  it.each([1, 2, 30_000_000, 1_000_005])(
    'token budget %i matches goalTokenBudgetReason',
    (n) => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'token_budget', tokenBudget: n },
          'en',
          getTranslator('en'),
        ),
      ).toBe(goalTokenBudgetReason(n));
    },
  );

  it.each([1, 2, 20])('turn budget %i matches goalTurnBudgetReason', (n) => {
    expect(
      composeGoalBudgetReason(
        { limitKind: 'turn_budget', turnBudget: n },
        'en',
        getTranslator('en'),
      ),
    ).toBe(goalTurnBudgetReason(n));
  });

  it.each([60_000, 900_000, 59_999, 1_000, 500])(
    'active-time budget %i ms matches goalActiveTimeBudgetReason',
    (ms) => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'time_budget', activeTimeBudgetMs: ms },
          'en',
          getTranslator('en'),
        ),
      ).toBe(goalActiveTimeBudgetReason(ms));
    },
  );

  it.each([
    [1, '1', 'токен'],
    [2, '2', 'токена'],
    [5, '5', 'токенов'],
    [11, '11', 'токенов'],
    [21, '21', 'токен'],
    [101, '101', 'токен'],
    [102, '102', 'токена'],
    [111, '111', 'токенов'],
  ] as const)('RU token budget %i renders %s %s', (n, count, unit) => {
    expect(
      composeGoalBudgetReason(
        { limitKind: 'token_budget', tokenBudget: n },
        'ru',
        getTranslator('ru'),
      ),
    ).toBe(RU_SENTENCE(count, unit));
  });

  it('groups the RU million with NBSP separators', () => {
    expect(
      composeGoalBudgetReason(
        { limitKind: 'token_budget', tokenBudget: 30_000_000 },
        'ru',
        getTranslator('ru'),
      ),
    ).toBe(RU_SENTENCE('30\u00A0000\u00A0000', 'токенов'));
  });

  it('composes the zh-CN token reason with the token unit', () => {
    expect(
      composeGoalBudgetReason(
        { limitKind: 'token_budget', tokenBudget: 1 },
        'zh-CN',
        getTranslator('zh-CN'),
      ),
    ).toBe(
      '目标已用完自主 token 预算（1 token）。恢复目标以授权另一个预算窗口，或将其清除。',
    );
  });

  it('composes the zh-CN turn reason with the 轮 unit', () => {
    expect(
      composeGoalBudgetReason(
        { limitKind: 'turn_budget', turnBudget: 2 },
        'zh-CN',
        getTranslator('zh-CN'),
      ),
    ).toBe(
      '目标已用完轮次预算（2 轮）。恢复目标以授权另一个轮次窗口，或将其清除。',
    );
  });

  describe('declines (undefined) so the caller keeps the raw reason', () => {
    it('when the record has no limitKind', () => {
      expect(
        composeGoalBudgetReason(
          { tokenBudget: 30_000_000 },
          'en',
          getTranslator('en'),
        ),
      ).toBeUndefined();
    });

    it('when the limitKind is an evidence sentinel', () => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'evidence_catalog' },
          'en',
          getTranslator('en'),
        ),
      ).toBeUndefined();
    });

    it('when the budget figure is missing', () => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'token_budget' },
          'en',
          getTranslator('en'),
        ),
      ).toBeUndefined();
    });

    it('when the time-budget figure is missing', () => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'time_budget' },
          'en',
          getTranslator('en'),
        ),
      ).toBeUndefined();
    });

    it('when the locale has no key', () => {
      // A catalog without the keys returns the key itself; the guard must
      // decline to compose rather than surface the key in the UI.
      const noKey = (key: string) => key;
      expect(
        composeGoalBudgetReason(
          { limitKind: 'token_budget', tokenBudget: 30_000_000 },
          'en',
          noKey,
        ),
      ).toBeUndefined();
    });
  });
});
