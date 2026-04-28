/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser-compatible Crypto Implementation
 * Uses Web Crypto API instead of Node.js crypto module.
 */

/**
 * Web Crypto API UUID generation
 */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Fast UUID generation
 */
export function uuid(): string {
  return randomUUID();
}

/**
 * SHA-256 hash using Web Crypto API
 */
export async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await globalThis.crypto.subtle.digest(
    'SHA-256',
    dataBuffer,
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Secure random bytes generation
 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Stub: createHash not available in browser
 */
export function createHash(): never {
  throw new Error('createHash not available in browser environment');
}

/**
 * Stub: createCipheriv not available in browser
 */
export function createCipheriv(): never {
  throw new Error('createCipheriv not available in browser environment');
}

/**
 * Stub: createDecipheriv not available in browser
 */
export function createDecipheriv(): never {
  throw new Error('createDecipheriv not available in browser environment');
}

/**
 * Stub: hmacSha256 not available in browser without additional implementation
 */
export function hmacSha256(): never {
  throw new Error('hmacSha256 not available in browser environment');
}
