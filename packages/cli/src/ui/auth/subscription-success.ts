/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubscriptionUserInfo } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { t } from '../../i18n/index.js';

export function subscriptionSuccessMessage(
  info: SubscriptionUserInfo,
  model: string,
): string {
  return [
    `✓ ${t('Signed in as {{email}}', { email: info.email })}`,
    `✓ ${t('Qwen {{plan}} is active · usage is included with your plan', {
      plan:
        info.member_type.charAt(0).toUpperCase() +
        info.member_type.slice(1).toLowerCase(),
    })}`,
    `  ${t('Model: {{model}} · Run /usage to see your plan usage', { model })}`,
  ].join('\n');
}
