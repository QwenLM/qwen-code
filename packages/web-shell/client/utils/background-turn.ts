/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonBackgroundTurn } from '@qwen-code/sdk/daemon';

/**
 * Browser-safe runtime parser matching `parseDaemonBackgroundTurn` in
 * `@qwen-code/sdk/daemon` so shared message components do not pull daemon
 * runtime code into the managed-host bundle.
 */
export function parseBackgroundTurn(
  value: unknown,
): DaemonBackgroundTurn | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['turnId'] !== 'string' ||
    !record['turnId'] ||
    typeof record['taskId'] !== 'string' ||
    !record['taskId'] ||
    (record['kind'] !== 'agent' &&
      record['kind'] !== 'monitor' &&
      record['kind'] !== 'shell' &&
      record['kind'] !== 'workflow' &&
      record['kind'] !== 'peer') ||
    typeof record['startedAt'] !== 'number' ||
    !Number.isFinite(record['startedAt']) ||
    record['startedAt'] < 0 ||
    ['toolUseId', 'sourceTurnId', 'label'].some(
      (key) => record[key] !== undefined && typeof record[key] !== 'string',
    )
  ) {
    return undefined;
  }
  return value as DaemonBackgroundTurn;
}
