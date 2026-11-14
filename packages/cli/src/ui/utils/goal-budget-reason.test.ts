/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  goalActiveTimeBudgetReason,
  goalTokenBudgetReason,
  goalTurnBudgetReason,
} from '@qwen-code/qwen-code-core';
import {
  getTranslationModuleExport,
  isTranslationDict,
  type TranslationDict,
} from '../../i18n/translationDict.js';
import { composeGoalBudgetReason, type GoalT } from './goal-budget-reason.js';

async function loadLocaleDict(code: string): Promise<TranslationDict> {
  const localePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../i18n/locales',
    `${code}.js`,
  );
  const module = await import(pathToFileURL(localePath).href);
  const dict = getTranslationModuleExport(module);
  if (!isTranslationDict(dict)) {
    throw new Error(`Invalid locale module: ${localePath}`);
  }
  return dict;
}

/** Mirror of `t`/`interpolate` in `i18n/index.ts` over a static dict. */
function makeT(dict: TranslationDict): GoalT {
  return (key, params) => {
    const translation = dict[key] ?? key;
    if (Array.isArray(translation)) {
      return key;
    }
    if (!params) {
      return translation;
    }
    return translation.replace(
      /\{\{(\w+)\}\}/g,
      (match, name) => params[name] ?? match,
    );
  };
}

describe('composeGoalBudgetReason', () => {
  let tEn: GoalT;
  let tRu: GoalT;

  beforeAll(async () => {
    tEn = makeT(await loadLocaleDict('en'));
    tRu = makeT(await loadLocaleDict('ru'));
  });

  describe('EN parity with core generators', () => {
    it.each([1, 2, 30_000_000, 1_000_005])(
      'token budget %i matches goalTokenBudgetReason',
      (n) => {
        expect(
          composeGoalBudgetReason(
            { limitKind: 'token_budget', tokenBudget: n },
            tEn,
            'en',
          ),
        ).toBe(goalTokenBudgetReason(n));
      },
    );

    it.each([1, 2, 20])('turn budget %i matches goalTurnBudgetReason', (n) => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'turn_budget', turnBudget: n },
          tEn,
          'en',
        ),
      ).toBe(goalTurnBudgetReason(n));
    });

    it.each([60_000, 900_000, 59_999, 1_000, 500])(
      'active-time budget %i ms matches goalActiveTimeBudgetReason',
      (ms) => {
        expect(
          composeGoalBudgetReason(
            { limitKind: 'time_budget', activeTimeBudgetMs: ms },
            tEn,
            'en',
          ),
        ).toBe(goalActiveTimeBudgetReason(ms));
      },
    );
  });

  describe('EN singular and plural units', () => {
    it('uses the singular unit at 1 and the plural at 2', () => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'token_budget', tokenBudget: 1 },
          tEn,
          'en',
        ),
      ).toContain('(1 token)');
      expect(
        composeGoalBudgetReason(
          { limitKind: 'turn_budget', turnBudget: 1 },
          tEn,
          'en',
        ),
      ).toContain('(1 turn)');
      expect(
        composeGoalBudgetReason(
          { limitKind: 'time_budget', activeTimeBudgetMs: 60_000 },
          tEn,
          'en',
        ),
      ).toContain('(1 minute)');
      expect(
        composeGoalBudgetReason(
          { limitKind: 'token_budget', tokenBudget: 2 },
          tEn,
          'en',
        ),
      ).toContain('(2 tokens)');
      expect(
        composeGoalBudgetReason(
          { limitKind: 'turn_budget', turnBudget: 2 },
          tEn,
          'en',
        ),
      ).toContain('(2 turns)');
      expect(
        composeGoalBudgetReason(
          { limitKind: 'time_budget', activeTimeBudgetMs: 120_000 },
          tEn,
          'en',
        ),
      ).toContain('(2 minutes)');
    });

    it('renders sub-minute budgets in seconds', () => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'time_budget', activeTimeBudgetMs: 500 },
          tEn,
          'en',
        ),
      ).toContain('(1 second)');
      expect(
        composeGoalBudgetReason(
          { limitKind: 'time_budget', activeTimeBudgetMs: 59_999 },
          tEn,
          'en',
        ),
      ).toContain('(60 seconds)');
    });
  });

  describe('RU plural forms (token budget)', () => {
    it('picks the Russian plural form for each count', () => {
      const cases: Array<[number, string]> = [
        [1, '(1 токен)'],
        [2, '(2 токена)'],
        [5, '(5 токенов)'],
        [11, '(11 токенов)'],
        [21, '(21 токен)'],
        [101, '(101 токен)'],
        [102, '(102 токена)'],
        [111, '(111 токенов)'],
      ];
      for (const [n, unitText] of cases) {
        expect(
          composeGoalBudgetReason(
            { limitKind: 'token_budget', tokenBudget: n },
            tRu,
            'ru',
          ),
        ).toContain(unitText);
      }
    });

    it('renders the full RU sentence for a single token', () => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'token_budget', tokenBudget: 1 },
          tRu,
          'ru',
        ),
      ).toBe(
        'Цель исчерпала автономный бюджет токенов (1 токен). Возобновите цель, чтобы выдать ещё одно окно бюджета, или снимите её.',
      );
    });

    it('groups large counts with NBSP separators (ru-RU)', () => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'token_budget', tokenBudget: 30_000_000 },
          tRu,
          'ru',
        ),
      ).toContain('(30\u00a0000\u00a0000 токенов)');
    });
  });

  describe('fallbacks return undefined', () => {
    it('without limitKind (legacy record)', () => {
      expect(
        composeGoalBudgetReason({ tokenBudget: 5 }, tEn, 'en'),
      ).toBeUndefined();
    });

    it('for an evidence limit kind', () => {
      expect(
        composeGoalBudgetReason({ limitKind: 'evidence_catalog' }, tEn, 'en'),
      ).toBeUndefined();
    });

    it('for a non-budget limit kind with a permissive dictionary', () => {
      const tPermissive: GoalT = (key, params) => {
        if (key.startsWith('goal.reason.unit.')) {
          return 'unit';
        }
        if (key.startsWith('goal.reason.')) {
          return `sentence(${params?.['count']})`;
        }
        return key;
      };
      expect(
        composeGoalBudgetReason(
          { limitKind: 'evidence_catalog', tokenBudget: 5 },
          tPermissive,
          'en',
        ),
      ).toBeUndefined();
    });

    it('for a budget kind missing its number', () => {
      expect(
        composeGoalBudgetReason({ limitKind: 'token_budget' }, tEn, 'en'),
      ).toBeUndefined();
    });

    it('for time_budget with activeTimeBudgetMs undefined', () => {
      expect(
        composeGoalBudgetReason(
          { limitKind: 'time_budget', activeTimeBudgetMs: undefined },
          tEn,
          'en',
        ),
      ).toBeUndefined();
    });

    it('when the locale dictionary lacks the keys', () => {
      const tMissing: GoalT = (key) => key;
      expect(
        composeGoalBudgetReason(
          { limitKind: 'token_budget', tokenBudget: 5 },
          tMissing,
          'en',
        ),
      ).toBeUndefined();
    });
  });
});
