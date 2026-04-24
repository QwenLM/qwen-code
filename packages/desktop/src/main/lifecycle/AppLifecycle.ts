/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function shouldQuitWhenWindowsClosed(
  platform = process.platform,
): boolean {
  return platform !== 'darwin';
}
