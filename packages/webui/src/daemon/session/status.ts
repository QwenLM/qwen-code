/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function isMissingSessionHttpStatus(
  status: number | undefined,
): boolean {
  return status === 404 || status === 410;
}
