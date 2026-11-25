/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const textEncoder = new TextEncoder();

export function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}
