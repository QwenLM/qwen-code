/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientError } from '../clientError.js';

/** 正整数：用于毫秒预算、重试次数这类离散量。 */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** 校验正整数预算：未声明（undefined）跳过，非法值直接抛错。 */
export function validatePositiveInteger(
  value: number | undefined,
  key: string,
): void {
  if (value !== undefined && !isPositiveInteger(value)) {
    throw new ClientError(`${key} must be a positive integer`);
  }
}
