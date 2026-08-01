/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonHttpError } from '@qwen-code/sdk/daemon';

export function extractHttpStatus(error: unknown): number | undefined {
  if (error instanceof DaemonHttpError) return error.status;
  if (isRecord(error) && typeof error['status'] === 'number') {
    return error['status'];
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
