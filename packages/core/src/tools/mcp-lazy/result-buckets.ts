/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type McpListResultCountBucket =
  | '0'
  | '1'
  | '2_5'
  | '6_10'
  | '11_25'
  | '26_50'
  | '51_plus';

export function bucketMcpListResultCount(
  count: number,
): McpListResultCountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 10) return '6_10';
  if (count <= 25) return '11_25';
  if (count <= 50) return '26_50';
  return '51_plus';
}
