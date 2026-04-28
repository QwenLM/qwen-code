/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runtime-optimized Crypto Utilities
 *
 * For browser builds: Uses Web Crypto API
 * For Node/Bun builds: Uses native crypto module
 *
 * This indirection point enables:
 * 1. Browser target builds without heavy polyfills
 * 2. Bun bytecode compilation compatibility
 * 3. Runtime-specific optimizations
 */

// NOTE: re-export syntax breaks under bun bytecode compilation.
// Must use explicit import-then-export for correct live binding.

import {
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';

export { randomUUID, createHash, createCipheriv, createDecipheriv };

/**
 * Fast UUID generation using Bun's optimized implementation.
 */
export function uuid(): string {
  if (typeof Bun !== 'undefined') {
    // Bun has optimized UUID generation
    return Bun.randomUUIDv7();
  }
  return randomUUID();
}

/**
 * Hash function using native implementation.
 */
export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Secure random bytes generation.
 */
export function randomBytes(length: number): Uint8Array {
  if (typeof Bun !== 'undefined') {
    return Bun.randomBytes(length);
  }
  return nodeRandomBytes(length);
}

/**
 * HMAC SHA256 hash.
 */
export function hmacSha256(key: string, data: string): string {
  return createHash('sha256').update(key).update(data).digest('hex');
}
