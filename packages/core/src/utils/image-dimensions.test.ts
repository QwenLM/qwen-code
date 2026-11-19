/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseImageDimensions } from './image-dimensions.js';

/** Minimal synthetic PNG header: sig + IHDR with the given dimensions. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b[8] = 0;
  b[9] = 0;
  b[10] = 0;
  b[11] = 13; // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  b[16] = (width >>> 24) & 0xff;
  b[17] = (width >>> 16) & 0xff;
  b[18] = (width >>> 8) & 0xff;
  b[19] = width & 0xff;
  b[20] = (height >>> 24) & 0xff;
  b[21] = (height >>> 16) & 0xff;
  b[22] = (height >>> 8) & 0xff;
  b[23] = height & 0xff;
  return b;
}

/** Minimal synthetic GIF header with little-endian screen dimensions. */
function gif(width: number, height: number): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // 'GIF89a'
  b[6] = width & 0xff;
  b[7] = (width >> 8) & 0xff;
  b[8] = height & 0xff;
  b[9] = (height >> 8) & 0xff;
  return b;
}

/** Minimal synthetic JPEG: SOI, one APP0 segment, then SOF0. */
function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0xff, 0xd8], 0); // SOI
  b.set([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 2); // APP0, length 4
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 8); // SOF0, length 17, precision 8
  b[13] = (height >> 8) & 0xff;
  b[14] = height & 0xff;
  b[15] = (width >> 8) & 0xff;
  b[16] = width & 0xff;
  return b;
}

/** Minimal synthetic WebP with a VP8X chunk carrying canvas dimensions. */
function webpVp8x(width: number, height: number): Uint8Array {
  const b = new Uint8Array(34);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  b.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  b.set([0x56, 0x50, 0x38, 0x58], 12); // 'VP8X'
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff;
  b[25] = (w >> 8) & 0xff;
  b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff;
  b[28] = (h >> 8) & 0xff;
  b[29] = (h >> 16) & 0xff;
  return b;
}

describe('parseImageDimensions', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(parseImageDimensions(png(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(parseImageDimensions(png(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it('rejects dimensions beyond the plausibility cap (#17321 F5)', () => {
    // MAX_PLAUSIBLE_DIMENSION (100 000) is a sanity bound on hostile or
    // corrupt headers: a PNG claiming a 2 000 000 000-pixel column must not
    // reach the token formula even though the 32-bit IHDR field holds it.
    expect(parseImageDimensions(png(2_000_000_000, 1080))).toBeUndefined();
    expect(parseImageDimensions(png(1920, 2_000_000_000))).toBeUndefined();
  });

  it('reads GIF logical-screen dimensions', () => {
    expect(parseImageDimensions(gif(800, 600))).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('skips JPEG segments to find the SOF frame header', () => {
    expect(parseImageDimensions(jpeg(2048, 1536))).toEqual({
      width: 2048,
      height: 1536,
    });
  });

  it('reads WebP VP8X canvas dimensions', () => {
    expect(parseImageDimensions(webpVp8x(4096, 2160))).toEqual({
      width: 4096,
      height: 2160,
    });
  });

  /** Lossy WebP: RIFF header + VP8 chunk with sync code and 14-bit dims. */
  function webpVp8(width: number, height: number): Uint8Array {
    const b = new Uint8Array(34);
    b.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
    b.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
    b.set([0x56, 0x50, 0x38, 0x20], 12); // 'VP8 '
    b[16] = 30;
    b[17] = 0;
    b[18] = 0;
    b[19] = 0; // chunk size
    b[20] = 0x30;
    b[21] = 0x01;
    b[22] = 0x00; // frame tag (keyframe)
    b[23] = 0x9d;
    b[24] = 0x01;
    b[25] = 0x2a; // sync code
    b[26] = width & 0xff;
    b[27] = (width >> 8) & 0x3f;
    b[28] = height & 0xff;
    b[29] = (height >> 8) & 0x3f;
    return b;
  }

  /** Lossless WebP: VP8L chunk with 0x2f signature and bitstream dims. */
  function webpVp8l(width: number, height: number): Uint8Array {
    const b = new Uint8Array(30);
    b.set([0x52, 0x49, 0x46, 0x46], 0);
    b.set([0x57, 0x45, 0x42, 0x50], 8);
    b.set([0x56, 0x50, 0x38, 0x4c], 12); // 'VP8L'
    b[16] = 10;
    b[17] = 0;
    b[18] = 0;
    b[19] = 0;
    b[20] = 0x2f; // signature
    // width-1 in bits 0-13, height-1 in bits 14-27, from byte 21.
    const wm1 = width - 1;
    const hm1 = height - 1;
    let bits = 0;
    bits |= wm1 & 0x3fff;
    bits |= (hm1 & 0x3fff) << 14;
    for (let i = 0; i < 28; i++) {
      const bit = (bits >> i) & 1;
      b[21 + (i >> 3)] |= bit << (i & 7);
    }
    return b;
  }

  it('reads lossy WebP VP8 frame dimensions (#17320 C1)', () => {
    expect(parseImageDimensions(webpVp8(550, 368))).toEqual({
      width: 550,
      height: 368,
    });
  });

  it('reads lossless WebP VP8L dimensions (#17320 C1)', () => {
    expect(parseImageDimensions(webpVp8l(800, 600))).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('returns undefined for unknown or truncated payloads', () => {
    expect(parseImageDimensions(new Uint8Array(20))).toBeUndefined();
    expect(parseImageDimensions(new Uint8Array(8))).toBeUndefined();
    const truncatedPng = png(100, 50).subarray(0, 14);
    expect(parseImageDimensions(truncatedPng)).toBeUndefined();
  });
});
