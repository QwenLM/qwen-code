/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';

export function formatExecutionSandbox(
  config?: Pick<Config, 'getShellExecutionSandbox'> | null,
): string | undefined {
  const policy = config?.getShellExecutionSandbox?.();
  if (!policy) return undefined;
  const effective = policy.effectiveBackend ?? 'unresolved';
  const enforcement = policy.enforcement
    ? ` (${policy.enforcement}${policy.landlockAbi ? `, ABI ${policy.landlockAbi}` : ''})`
    : '';
  return `tools / ${policy.requestedBackend ?? 'auto'} → ${effective}${enforcement} / ${policy.filesystem} / command network: ${policy.network}`;
}
