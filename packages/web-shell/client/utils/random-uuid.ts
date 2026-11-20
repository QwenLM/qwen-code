/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// crypto.randomUUID is only exposed in secure contexts (HTTPS or loopback).
// The shell is also served over plain HTTP from remote hosts, so id minting
// must fall back to getRandomValues, which non-secure contexts still expose.
// Realms without the crypto global at all (stubbed in provider tests) get a
// last-resort id, matching the contract of the guarded factories this helper
// consolidates.
export function randomUUID(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10, 16).join(''),
    ].join('-');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
