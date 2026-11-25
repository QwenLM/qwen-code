/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';

/**
 * Smallest valid PNG (1x1). Must stay a real PNG — image validation sniffs
 * magic bytes, so a placeholder string will not do.
 */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==';
export const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, 'base64');

export async function createPngBuffer(
  width: number,
  height: number,
  channels: 3 | 4 = 3,
): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const pixelCount = width * height * channels;
  const raw = randomBytes(pixelCount);
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

export async function createJpegBuffer(
  width: number,
  height: number,
): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const channels = 3;
  const raw = randomBytes(width * height * channels);
  return sharp(raw, { raw: { width, height, channels } }).jpeg().toBuffer();
}
