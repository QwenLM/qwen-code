/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function isUtf8CompatibleEncoding(encoding: string): boolean {
  const lower = encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
  return lower === 'utf8' || lower === 'ascii' || lower === 'usascii';
}
