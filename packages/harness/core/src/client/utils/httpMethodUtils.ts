/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 只认无副作用的方法。PUT/DELETE 按 RFC 幂等，但实际对端常带版本号或
 * 计数副作用，重发并不安全，所以不列入默认幂等。
 */
export function isIdempotentMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return (
    normalized === 'GET' ||
    normalized === 'HEAD' ||
    normalized === 'OPTIONS' ||
    normalized === 'TRACE'
  );
}
