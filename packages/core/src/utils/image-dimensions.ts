/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parses pixel dimensions from the header of a raw image byte sequence
 * (PNG, JPEG, GIF, WebP). Header-only: no full decode, no dependencies.
 * Returns undefined for any format/shape it cannot resolve — callers must
 * treat that as "no dimensions", never guess (#17315).
 */
export function parseImageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.length < 16) return undefined;
  if (isPng(bytes)) return pngDimensions(bytes);
  if (isGif(bytes)) return gifDimensions(bytes);
  if (isJpeg(bytes)) return jpegDimensions(bytes);
  if (isWebp(bytes)) return webpDimensions(bytes);
  return undefined;
}

function isPng(b: Uint8Array): boolean {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

function pngDimensions(
  b: Uint8Array,
): { width: number; height: number } | undefined {
  // IHDR is required to be the first chunk: sig(8) + len(4) + 'IHDR'(4),
  // then big-endian width and height.
  if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44) {
    return undefined;
  }
  const width = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
  const height = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
  return positive(width, height);
}

function isGif(b: Uint8Array): boolean {
  // All 6 header bytes: 'GIF87a' or 'GIF89a' — matching only 'GIF' lets
  // arbitrary text through the dimension parser (#17321 F3).
  return (
    b.length > 6 &&
    b[0] === 0x47 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) &&
    b[5] === 0x61
  );
}

function gifDimensions(
  b: Uint8Array,
): { width: number; height: number } | undefined {
  // 'GIF8xa' then little-endian logical screen width/height.
  const width = b[6] | (b[7] << 8);
  const height = b[8] | (b[9] << 8);
  return positive(width, height);
}

function isJpeg(b: Uint8Array): boolean {
  return b[0] === 0xff && b[1] === 0xd8;
}

function jpegDimensions(
  b: Uint8Array,
): { width: number; height: number } | undefined {
  // Scan segment markers for a frame header (SOF0..SOF15 minus the
  // non-SOF markers that share the 0xC0-0xCF range).
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      i += 2; // standalone markers carry no length
      continue;
    }
    const length = (b[i + 2] << 8) | b[i + 3];
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      // segment: marker(2) length(2) precision(1) height(2BE) width(2BE)
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      return positive(width, height);
    }
    if (length < 2) return undefined;
    i += 2 + length;
  }
  return undefined;
}

function isWebp(b: Uint8Array): boolean {
  return (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // 'RIFF'
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // 'WEBP'
  );
}

function webpDimensions(
  b: Uint8Array,
): { width: number; height: number } | undefined {
  // The chunk FourCC occupies bytes 12-15 and the chunk PAYLOAD starts at
  // byte 20 (FourCC + 4-byte chunk size at 16-19): dimension fields live at
  // payload offsets, not RIFF-header offsets.
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (tag === 'VP8 ') {
    // Lossy: payload = frame tag(3) at 20-22, sync 0x9d 0x01 0x2a at
    // 23-25, then 14-bit little-endian width and height at 26-29.
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      return undefined;
    }
    const width = (b[26] | (b[27] << 8)) & 0x3fff;
    const height = (b[28] | (b[29] << 8)) & 0x3fff;
    return positive(width, height);
  }
  if (tag === 'VP8L') {
    // Lossless: payload = signature 0x2f at 20, then the bit stream at 21
    // whose first 14 bits are width-1 and next 14 bits are height-1.
    if (b[20] !== 0x2f || b.length < 25) return undefined;
    const bit = (p: number) => (b[21 + (p >> 3)] >> (p & 7)) & 1;
    const read = (from: number) => {
      let v = 0;
      for (let k = 0; k < 14; k++) v |= bit(from + k) << k;
      return v;
    };
    return positive(read(0) + 1, read(14) + 1);
  }
  if (tag === 'VP8X') {
    // Extended: 10 reserved bytes, then 24-bit little-endian width-1 and
    // height-1.
    if (b.length < 30) return undefined;
    const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return positive(width, height);
  }
  return undefined;
}

// Upper bound on any plausible image dimension — corrupted or hostile
// headers can produce absurd values that would dominate the context
// estimate (#17321 R4-1).
const MAX_PLAUSIBLE_DIMENSION = 100_000;

function positive(
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_PLAUSIBLE_DIMENSION &&
    height <= MAX_PLAUSIBLE_DIMENSION
    ? { width, height }
    : undefined;
}
