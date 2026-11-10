/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebShellLanguage } from '../i18n';

/**
 * The slice of the Goal record the budget stop-reason composition reads.
 * The transcript card carries the same fields on
 * `SerializedGoalStatusMessage`, so both render sites compose from this
 * shape.
 */
export interface GoalBudgetFields {
  limitKind?: string;
  tokenBudget?: number;
  turnBudget?: number;
  activeTimeBudgetMs?: number;
}

/** The i18n translator: function values take vars, missing keys fall back. */
export type TFunc = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

type BudgetLimitKind = 'token_budget' | 'turn_budget' | 'time_budget';
type UnitBase = 'token' | 'turn' | 'minute' | 'second';

const LOCALE_BY_LANGUAGE: Record<WebShellLanguage, string> = {
  en: 'en-US',
  'zh-CN': 'zh-CN',
  ru: 'ru-RU',
};

function ruForm(n: number): 'one' | 'few' | 'many' {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'one';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
  return 'many';
}

/**
 * Resolves the budget figure with the unit it is counted in. The
 * active-time branch mirrors core's `formatGoalActiveTimeBudget`:
 * whole minutes when the budget reaches a minute, otherwise seconds
 * with a floor of one.
 */
function budgetFigure(
  goal: GoalBudgetFields,
  kind: BudgetLimitKind,
): { n: number; base: UnitBase } | undefined {
  let base: UnitBase;
  let raw: number | undefined;
  if (kind === 'token_budget') {
    base = 'token';
    raw = goal.tokenBudget;
  } else if (kind === 'turn_budget') {
    base = 'turn';
    raw = goal.turnBudget;
  } else {
    base = 'minute';
    raw = goal.activeTimeBudgetMs;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return undefined;
  }
  let n: number;
  if (kind === 'time_budget') {
    const minutes = raw / 60_000;
    if (minutes >= 1) {
      n = Math.round(minutes);
    } else {
      base = 'second';
      n = Math.max(1, Math.round(raw / 1_000));
    }
  } else {
    n = raw;
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return undefined;
  }
  return { n, base };
}

/**
 * Composes the localized Goal budget stop-reason from the record's
 * `limitKind` and budget figure, so the rendered phrase follows the
 * client language. Returns undefined when the record is not a budget
 * stop, the figure is missing, or the locale lacks the keys — the
 * caller then falls back to the raw `lastReason`.
 */
export function composeGoalBudgetReason(
  goal: GoalBudgetFields,
  language: WebShellLanguage,
  t: TFunc,
): string | undefined {
  const kind = goal.limitKind;
  if (
    kind !== 'token_budget' &&
    kind !== 'turn_budget' &&
    kind !== 'time_budget'
  ) {
    return undefined;
  }
  const figure = budgetFigure(goal, kind);
  if (!figure) {
    return undefined;
  }
  const { n, base } = figure;
  const localeId = LOCALE_BY_LANGUAGE[language] ?? 'en-US';
  const form = language === 'ru' ? ruForm(n) : n === 1 ? 'one' : 'many';
  const unitKey = `goal.reason.unit.${base}.${form}`;
  const unit = t(unitKey);
  if (unit === unitKey) {
    return undefined;
  }
  const sentenceKey = `goal.reason.${kind}`;
  const sentence = t(sentenceKey, {
    count: n.toLocaleString(localeId),
    unit,
  });
  if (sentence === sentenceKey) {
    return undefined;
  }
  return sentence;
}
