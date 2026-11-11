/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** 仅在不存在大小写等价的 HTTP 标头时写入。 */
export function setHeaderIfMissing(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const lowerName = name.toLowerCase();
  if (!Object.keys(headers).some((key) => key.toLowerCase() === lowerName)) {
    headers[name] = value;
  }
}
