/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function chunkCrc(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[offset]) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Checks container integrity before a tolerant pixel decoder can preserve an
 * invalid PNG unchanged. The caller has already identified the PNG signature.
 * Pixel decoding and image limits remain the image processor's responsibility.
 */
export function pngStructureError(buffer: Buffer): string | undefined {
  let offset = 8;
  let hasHeader = false;
  let hasImageData = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return 'invalid chunk type';
    const end = offset + length + 12;
    if (end > buffer.length) return `incomplete ${type} chunk`;
    if (!hasHeader && type !== 'IHDR') return 'missing initial IHDR chunk';
    if (type === 'IHDR') {
      if (hasHeader || length !== 13) return 'invalid IHDR chunk';
      hasHeader = true;
    }
    if (
      chunkCrc(buffer, offset + 4, end - 4) !== buffer.readUInt32BE(end - 4)
    ) {
      return `CRC mismatch in ${type} chunk`;
    }
    if (type === 'IDAT') hasImageData = true;
    if (type === 'IEND') {
      if (length !== 0) return 'invalid IEND chunk';
      if (!hasImageData) return 'missing IDAT chunk';
      return end === buffer.length
        ? undefined
        : 'unexpected data after IEND chunk';
    }
    offset = end;
  }
  return hasHeader ? 'missing IEND chunk' : 'missing initial IHDR chunk';
}
