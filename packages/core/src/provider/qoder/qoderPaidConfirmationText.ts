/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UiLocale } from '../../utils/locale.js';

export const NEW_PAID_CONFIRMATION_CODES: ReadonlySet<string> = new Set([
  '145',
  '146',
  '147',
]);

const PAID_CONFIRMATION_MESSAGES: Readonly<
  Record<string, { readonly en: string; readonly zh: string }>
> = {
  '145': {
    en: "You've reached today's free usage limit for this model. You can upgrade your plan for more free uses, wait until your free usage resets at midnight (UTC+8), or continue with paid Credits.",
    zh: '您今日使用该模型的免费次数已用完。您可以升级套餐以获得更多免费使用次数，或等待免费次数于每日 00:00（UTC+8）重置，也可以使用付费 Credits 继续使用该模型。',
  },
  '146': {
    en: "You've reached today's free usage limit for this model. Free access will reset tomorrow. You can switch to another model, or continue with paid Credits.",
    zh: '您今日使用该模型的免费次数已用尽，明天可继续免费使用。您也可以切换其他模型，或使用付费 Credits 继续使用该模型。',
  },
  '147': {
    en: 'Your exclusive pack for this model is running low. Once it is depleted, continued use will consume your paid Credits.',
    zh: '当前模型的专属资源包即将用尽，用尽后将消耗您的付费 Credits。',
  },
};

const DEFAULT_PAID_CONFIRMATION_MESSAGE = {
  en: 'Your complimentary credits have been used up, and the response has been paused. Continuing the response will use your paid credits.',
  zh: '赠送的免费额度已用尽，回答已暂停。继续回答将消耗您的付费额度。',
};

export function isNewPaidConfirmationCode(
  code: string | number | undefined,
): boolean {
  return code !== undefined && NEW_PAID_CONFIRMATION_CODES.has(String(code));
}

export function getPaidConfirmationMessage(
  locale: UiLocale,
  code?: string | number,
): string {
  const messages =
    (code !== undefined ? PAID_CONFIRMATION_MESSAGES[String(code)] : undefined) ??
    DEFAULT_PAID_CONFIRMATION_MESSAGE;
  return locale === 'zh-CN' ? messages.zh : messages.en;
}
