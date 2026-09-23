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
  return `tools / ${policy.requestedBackend ?? 'auto'} → bwrap / ${policy.filesystem} / command network: ${policy.network}`;
}
