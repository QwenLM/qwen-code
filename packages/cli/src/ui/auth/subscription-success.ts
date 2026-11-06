/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SubscriptionUserInfo } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';
import { subscriptionModelUnavailable } from '@qwen-code/qwen-code-core/qwen/subscription-models.js';
import { t } from '../../i18n/index.js';

export function subscriptionSuccessMessage(
  info: SubscriptionUserInfo,
  model: string | undefined,
  authorizationUrl?: string,
  modelSelectionRequired = false,
): string {
  const plan =
    info.member_type.charAt(0).toUpperCase() +
    info.member_type.slice(1).toLowerCase();
  return [
    `✓ ${t('Signed in successfully · {{email}}', { email: info.email })}`,
    `✓ ${
      modelSelectionRequired
        ? subscriptionModelUnavailable(model ?? '')
        : t('Current plan: Qwen {{plan}}. Qwen Code is ready.', { plan })
    }`,
    ...(model && !modelSelectionRequired
      ? [
          `  ${t('Model: {{model}}. Run /upgrade to upgrade your plan, /usage to view usage, or /model to switch models.', { model })}`,
        ]
      : []),
    ...(authorizationUrl
      ? [
          `  ${t("If the browser didn't open, visit:")}`,
          `  ${authorizationUrl}`,
        ]
      : []),
    ...(model && !modelSelectionRequired
      ? [
          `  ${t('Common commands: /usage   /upgrade   /model   /status   /logout')}`,
        ]
      : []),
  ].join('\n');
}
