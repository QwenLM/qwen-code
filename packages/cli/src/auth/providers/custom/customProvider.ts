/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';

export const CUSTOM_API_KEY_ENV_PREFIX = 'QWEN_CUSTOM_API_KEY_';

export function generateCustomEnvKey(
  protocol: AuthType,
  baseUrl: string,
): string {
  const hash = createHash('sha256')
    .update(`${protocol}\0${baseUrl}`)
    .digest('hex')
    .slice(0, 16);
  return `${CUSTOM_API_KEY_ENV_PREFIX}${hash.toUpperCase()}`;
}

export const customProvider: ProviderConfig = {
  id: 'custom-openai-compatible',
  label: 'Custom Provider',
  description:
    'Manually connect a local server, proxy, or unsupported provider',
  protocol: AuthType.USE_OPENAI,
  protocolOptions: [
    AuthType.USE_OPENAI,
    AuthType.USE_ANTHROPIC,
    AuthType.USE_GEMINI,
  ],
  baseUrl: undefined,
  envKey: generateCustomEnvKey,
  authMethod: 'input',
  models: undefined,
  modelNamePrefix: '',
  showAdvancedConfig: true,
  ownsModel: (model) =>
    typeof model.envKey === 'string' &&
    model.envKey.startsWith(CUSTOM_API_KEY_ENV_PREFIX),
  uiGroup: 'custom',
};
