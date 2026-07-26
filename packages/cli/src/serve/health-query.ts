/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function isDeepHealthQuery(raw: unknown): boolean {
  return raw === '1' || raw === 'true' || raw === '';
}
