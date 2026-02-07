/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { AuthMethod } from './schema.js';

export function buildAuthMethods(): AuthMethod[] {
  return [
    {
      id: AuthType.USE_OPENAI,
      name: 'Use OpenAI API key',
      description: 'Requires setting the `OPENAI_API_KEY` environment variable',
      type: 'terminal',
      args: ['--auth-type=openai'],
    },
    {
      id: AuthType.QWEN_OAUTH,
      name: 'Qwen OAuth',
      description:
        'OAuth authentication for Qwen models with free daily requests',
      type: 'terminal',
      args: ['--auth-type=qwen-oauth'],
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
