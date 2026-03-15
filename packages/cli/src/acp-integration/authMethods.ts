/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { AuthMethod } from '@agentclientprotocol/sdk';

export function buildAuthMethods(): AuthMethod[] {
  return [
    {
      id: AuthType.USE_OPENAI,
      name: 'Use OpenAI API key',
      description: 'Requires setting the `OPENAI_API_KEY` environment variable',
      _meta: {
        type: 'terminal',
        args: ['--auth-type=openai'],
      },
    },
    {
      id: AuthType.USE_LM_STUDIO,
      name: 'LM Studio',
      description:
        'Connect to LM Studio local models (requires LMSTUDIO_API_KEY or settings.security.auth.apiKey)',
      _meta: {
        type: 'terminal',
        args: ['--auth-type=lm-studio'],
      },
    },
    {
      id: AuthType.USE_OLLAMA,
      name: 'Ollama',
      description:
        'Connect to Ollama local models (defaults to http://localhost:11434/v1)',
      _meta: {
        type: 'terminal',
        args: ['--auth-type=ollama'],
      },
    },
    {
      id: AuthType.QWEN_OAUTH,
      name: 'Qwen OAuth',
      description:
        'OAuth authentication for Qwen models with free daily requests',
      _meta: {
        type: 'terminal',
        args: ['--auth-type=qwen-oauth'],
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
