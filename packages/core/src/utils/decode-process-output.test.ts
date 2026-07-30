import { describe, it, expect } from 'vitest';
import {
  getCachedEncodingForBuffer,
  decodeProcessOutput,
} from './systemEncoding.js';

// These tests verify the encoding detection logic that underpins the
// childProcessFallback fix: accumulating raw buffers and decoding the
// complete output via getCachedEncodingForBuffer() instead of per-chunk.
describe('buffered output encoding detection', () => {
  it('detects UTF-8 for pure ASCII buffer', () => {
    const buf = Buffer.from('Error: (none)\n');
    expect(getCachedEncodingForBuffer(buf)).toBe('utf-8');
  });

  it('detects UTF-8 for valid UTF-8 buffer with Cyrillic', () => {
    const buf = Buffer.from('Ошибка при создании файла', 'utf-8');
    expect(getCachedEncodingForBuffer(buf)).toBe('utf-8');
  });

  it('does NOT detect utf-8 for CP-866 bytes outside ASCII range', () => {
    // CP-866 "Ошибка" — bytes 0x80+ are not valid UTF-8
    const cp866Buf = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0, 0x20]);
    const encoding = getCachedEncodingForBuffer(cp866Buf);
    // Should NOT be utf-8 — these bytes are invalid UTF-8. chardet
    // deterministically detects a non-UTF-8 encoding (e.g. koi8-r/cp866)
    // on every platform, so this assertion is cross-platform safe.
    expect(encoding).not.toBe('utf-8');
    // The real decode path must not throw even when the detected encoding
    // is an unsupported OEM code page — a throw here would leave the
    // shell-execution promise unsettled.
    expect(() => decodeProcessOutput(cp866Buf)).not.toThrow();
  });

  it('decodes complete mixed buffer correctly (ASCII prefix + CP-866)', () => {
    // Simulates the bug scenario: first chunk is ASCII, second is CP-866.
    // The fix accumulates both into one buffer and decodes at the end.
    const asciiChunk = Buffer.from('Status: OK\n');
    const cp866Chunk = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0]);
    const fullBuffer = Buffer.concat([asciiChunk, cp866Chunk]);

    const decoded = decodeProcessOutput(fullBuffer);

    // The ASCII part should always be correct
    expect(decoded.startsWith('Status: OK\n')).toBe(true);
    // The decoded non-ASCII bytes must not become replacement characters
    expect(decoded).not.toContain('\uFFFD');
  });

  it('Buffer.concat of empty array does not throw', () => {
    // Guard: cleanup() checks stdoutChunks.length > 0 before concat
    expect(() => Buffer.concat([])).not.toThrow();
  });
});
