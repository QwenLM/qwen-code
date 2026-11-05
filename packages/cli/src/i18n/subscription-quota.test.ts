/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSubscriptionQuotaDisplay } from '@qwen-code/qwen-code-core/utils/subscription-quota.js';
import { initializeI18n, setLanguageAsync, t } from './index.js';

const now = Date.parse('2026-11-04T00:00:00Z');

afterEach(async () => {
  vi.restoreAllMocks();
  await setLanguageAsync('en');
});

describe('subscription quota i18n', () => {
  it.each([
    [
      'en',
      "You've used up your weekly credits. Your credits are expected to reset in 1 day and 2 hours. You can wait or run /upgrade to get more credits.",
    ],
    [
      'zh',
      '周额度已用完，预计将于1天 2小时后恢复。您可以等待额度恢复，或运行 /upgrade 升级套餐以获取更多额度。',
    ],
    [
      'zh-TW',
      '週額度已用完，預計將於1天 2小時後恢復。您可以等待額度恢復，或執行 /upgrade 升級方案以取得更多額度。',
    ],
  ])(
    'uses the %s catalog for the complete notice',
    async (language, expected) => {
      await initializeI18n(language);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      expect(
        formatSubscriptionQuotaDisplay(
          {
            type: 'subscription_quota',
            memberType: 'plus',
            resetAt: now / 1000 + 26 * 3600,
          },
          t,
        ),
      ).toBe(expected);
    },
  );

  it.each([
    [
      'en',
      '1 hour',
      '2 days and 1 hour',
      "You've used up your credits. Please try again after the reset.",
    ],
    ['zh', '1小时', '2天 1小时', '额度已用完，请在额度恢复后重试。'],
    ['zh-TW', '1小時', '2天 1小時', '額度已用完，請在額度恢復後重試。'],
  ])(
    'translates units and the no-upgrade fallback in %s',
    async (language, hour, days, fallback) => {
      await initializeI18n(language);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const quota = { type: 'subscription_quota', memberType: 'pro' };
      for (const [hours, time] of [
        [1, hour],
        [49, days],
      ] as const) {
        const message = formatSubscriptionQuotaDisplay(
          {
            ...quota,
            resetAt: now / 1000 + hours * 3600,
          },
          t,
        );
        expect(message).toContain(time);
        expect(message).not.toContain('/upgrade');
        expect(message).not.toContain('{{');
      }
      expect(
        formatSubscriptionQuotaDisplay({ type: 'subscription_quota' }, t),
      ).toBe(fallback);
    },
  );
});
