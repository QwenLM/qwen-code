/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';

export const CUSTOM_API_KEY_ENV_PREFIX = 'QWEN_CUSTOM_API_KEY_';

export function generateCustomEnvKey(
  protocol: AuthType,
  baseUrl: string,
): string {
  const normalize = (value: string) =>
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

  return `${CUSTOM_API_KEY_ENV_PREFIX}${normalize(protocol)}_${normalize(baseUrl)}`;
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
  uiGroup: 'custom',
};
