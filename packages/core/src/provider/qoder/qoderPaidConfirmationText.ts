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

const PAID_CONFIRMATION_MESSAGE_EN =
  'Your complimentary credits have been used up, and the response has been paused. Continuing the response will use your paid credits.';
const PAID_CONFIRMATION_MESSAGE_ZH =
  '赠送的免费额度已用尽，回答已暂停。继续回答将消耗您的付费额度。';

export function isNewPaidConfirmationCode(
  code: string | number | undefined,
): boolean {
  return code !== undefined && NEW_PAID_CONFIRMATION_CODES.has(String(code));
}

export function getPaidConfirmationMessage(locale: UiLocale): string {
  return locale === 'zh-CN'
    ? PAID_CONFIRMATION_MESSAGE_ZH
    : PAID_CONFIRMATION_MESSAGE_EN;
}
