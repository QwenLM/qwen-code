/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { AuthMethod } from '@agentclientprotocol/sdk';
import { t } from '../i18n/index.js';

export function buildAuthMethods(): AuthMethod[] {
  return [
    {
      id: AuthType.QWEN_OAUTH,
      name: 'Qwen OAuth',
      description: t(
        'OAuth authentication for Qwen models with free daily requests',
      ),
      _meta: {
        type: 'terminal',
        args: ['--auth-type=qwen-oauth'],
      },
    },
    {
      id: AuthType.CODING_PLAN,
      name: t('Alibaba Cloud Coding Plan'),
      description: t(
        'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models',
      ),
      _meta: {
        type: 'terminal',
        args: ['--auth-type=coding-plan'],
      },
    },
    {
      id: AuthType.USE_OPENAI,
      name: t('Bring your own API key'),
      description: t(
        'Use coding plan credentials or your own api-keys/providers.',
      ),
      _meta: {
        type: 'terminal',
        args: ['--auth-type=openai'],
      },
    },
  ];
}

export function filterAuthMethodsById(
  authMethods: AuthMethod[],
  authMethodId: string,
): AuthMethod[] {
  return authMethods.filter((method) => method.id === authMethodId);
}

export function pickAuthMethodsForDetails(details?: string): AuthMethod[] {
  const authMethods = buildAuthMethods();
  if (!details) {
    return authMethods;
  }
  if (details.includes('qwen-oauth') || details.includes('Qwen OAuth')) {
    const narrowed = filterAuthMethodsById(authMethods, AuthType.QWEN_OAUTH);
    return narrowed.length ? narrowed : authMethods;
  }
  return authMethods;
}
