/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import type { LoadedSettings } from '../../config/settings.js';

export function modelAuthPolicyError(
  settings: LoadedSettings | undefined,
  authType: AuthType | undefined,
): string | undefined {
  const enforcedType = settings?.merged?.security?.auth?.enforcedType;
  if (enforcedType && authType && enforcedType !== authType) {
    return 'Authentication is restricted by policy.';
  }
  return undefined;
}

export async function switchPrimaryModel(
  config: Config,
  settings: LoadedSettings,
  authType: AuthType,
  modelId: string,
  options?: Parameters<Config['switchModel']>[2],
): Promise<void> {
  const policyError = modelAuthPolicyError(settings, authType);
  if (policyError) throw new Error(policyError);
  await config.switchModel(authType, modelId, {
    ...options,
    initializeIfNeeded: true,
  });
}
