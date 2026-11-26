/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getTranslationModuleExport,
  isTranslationDict,
  type TranslationDict,
} from '../../i18n/translationDict.js';
import { composeGoalBudgetReason, type GoalT } from './goal-budget-reason.js';
import {
  describeGoalCard,
  type GoalCardView,
  type GoalSnapshotLike,
} from './goal-card-view.js';

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

/** The EN prose core records as `lastReason` for this exact budget. */
const EN_RAW_REASON =
  'The Goal spent its autonomous token budget (30,000,000 tokens). ' +
  'Resume the Goal to authorize another budget window, or clear it.';

/** RU composition: the grouping separators are NBSP, not spaces. */
const RU_COMPOSED_REASON =
  'Цель исчерпала автономный бюджет токенов (30\u00A0000\u00A0000 токенов). ' +
  'Возобновите цель, чтобы выдать ещё одно окно бюджета, или снимите её.';

function usageLimitedSnapshot(
  overrides: Partial<NonNullable<GoalSnapshotLike['goal']>> = {},
): GoalSnapshotLike {
  return {
    activity: 'idle',
    goal: {
      objective: 'ship the release notes',
      status: 'usage_limited',
      turnCount: 0,
      activeTimeMs: 0,
      tokensUsed: 30_000_000,
      tokenBudget: 30_000_000,
      lastReason: EN_RAW_REASON,
      ...overrides,
    },
  };
}

function cardView(
  view: GoalCardView,
): Extract<GoalCardView, { state: 'card' }> {
  if (view.state !== 'card') {
    throw new Error(`expected a card view, got ${view.state}`);
  }
  return view;
}

describe('describeGoalCard budget stop-reason', () => {
  let tEn: GoalT;
  let tRu: GoalT;

  beforeAll(async () => {
    tEn = makeT(await loadLocaleDict('en'));
    tRu = makeT(await loadLocaleDict('ru'));
  });

  it('renders the composed EN budget reason over the recorded one', () => {
    // EN composition is byte-parity with the core prose the record carries,
    // so the composed phrase and the raw one read identically here; the RU
    // case below is what separates the two.
    const view = describeGoalCard(
      usageLimitedSnapshot({ limitKind: 'token_budget' }),
      undefined,
      (goal) => composeGoalBudgetReason(goal, tEn, 'en'),
    );
    expect(cardView(view).reason).toBe(EN_RAW_REASON);
  });

  it('renders the composed RU budget reason in a RU client', () => {
    const view = describeGoalCard(
      usageLimitedSnapshot({ limitKind: 'token_budget' }),
      undefined,
      (goal) => composeGoalBudgetReason(goal, tRu, 'ru'),
    );
    expect(cardView(view).reason).toBe(RU_COMPOSED_REASON);
  });

  it('keeps the raw recorded reason when no composer is passed', () => {
    const view = describeGoalCard(
      usageLimitedSnapshot({ limitKind: 'token_budget' }),
    );
    expect(cardView(view).reason).toBe(EN_RAW_REASON);
  });

  it('keeps the raw reason for a pre-limitKind record even with a composer', () => {
    // The record predates `limitKind`: the composer must decline it.
    const view = describeGoalCard(usageLimitedSnapshot(), undefined, (goal) =>
      composeGoalBudgetReason(goal, tEn, 'en'),
    );
    expect(cardView(view).reason).toBe(EN_RAW_REASON);
  });

  it('shows no reason while the Goal is active', () => {
    const view = describeGoalCard(
      usageLimitedSnapshot({
        status: 'active',
        limitKind: 'token_budget',
        lastReason: 'Paused with /goal pause.',
      }),
      undefined,
      (goal) => composeGoalBudgetReason(goal, tEn, 'en'),
    );
    expect(cardView(view).reason).toBeUndefined();
  });
});
