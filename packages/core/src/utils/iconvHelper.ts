/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helper module to bridge iconv-lite CJS module with our ESM codebase.
 * iconv-lite v0.6.x uses ambient `declare module` type declarations
 * that are incompatible with NodeNext module resolution.
 * This module provides properly-typed wrappers.
 */

interface IconvLite {
  decode(buffer: Buffer, encoding: string): string;
  encode(content: string, encoding: string): Buffer;
  encodingExists(encoding: string): boolean;
}

// iconv-lite is a CJS module. Under NodeNext resolution, its ambient type
// declarations don't map correctly. We import the default export (which is
// the CJS module.exports object) and cast it to a proper interface.
import iconvModule from 'iconv-lite';
const iconvLite: IconvLite = iconvModule as unknown as IconvLite;

/**
 * Decode a buffer using the specified encoding.
 * @param buffer The buffer to decode
 * @param encoding The encoding to use (e.g. 'gbk', 'big5', 'shift_jis')
 * @returns The decoded string
 */
export function iconvDecode(buffer: Buffer, encoding: string): string {
  return iconvLite.decode(buffer, encoding);
}

/**
 * Encode a string to a buffer using the specified encoding.
 * @param content The string to encode
 * @param encoding The encoding to use (e.g. 'gbk', 'big5', 'shift_jis')
 * @returns The encoded buffer
 */
export function iconvEncode(content: string, encoding: string): Buffer {
  return iconvLite.encode(content, encoding);
}

/**
 * Check if an encoding is supported by iconv-lite.
 * @param encoding The encoding name to check
 * @returns True if the encoding is supported
 */
export function iconvEncodingExists(encoding: string): boolean {
  return iconvLite.encodingExists(encoding);
}

/**
 * Check whether an encoding name represents a UTF-8 compatible encoding
 * that Node's Buffer can handle natively without iconv-lite.
 * Normalizes encoding names (e.g. 'utf-8', 'UTF8', 'us-ascii' all match).
 * @param encoding The encoding name to check
 * @returns True if the encoding is UTF-8 or ASCII compatible
 */
export function isUtf8CompatibleEncoding(encoding: string): boolean {
  const lower = encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
  return lower === 'utf8' || lower === 'ascii' || lower === 'usascii';
}
