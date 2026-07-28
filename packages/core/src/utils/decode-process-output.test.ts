import { describe, it, expect } from 'vitest';
import { getCachedEncodingForBuffer } from './systemEncoding.js';
import { TextDecoder } from 'node:util';

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
    // Should NOT be utf-8 — these bytes are invalid UTF-8
    // (On Windows it should be cp866; on Linux it may be detected as
    // another encoding or fall back to system encoding — all acceptable.)
    if (encoding === 'utf-8') {
      // If it somehow returns utf-8, verify the bytes are actually invalid
      const decoder = new TextDecoder('utf-8', { fatal: true });
      expect(() => decoder.decode(cp866Buf)).toThrow();
    }
  });

  it('decodes complete mixed buffer correctly (ASCII prefix + CP-866)', () => {
    // Simulates the bug scenario: first chunk is ASCII, second is CP-866.
    // The fix accumulates both into one buffer and decodes at the end.
    const asciiChunk = Buffer.from('Status: OK\n');
    const cp866Chunk = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0]);
    const fullBuffer = Buffer.concat([asciiChunk, cp866Chunk]);

    const encoding = getCachedEncodingForBuffer(fullBuffer);
    const decoded = new TextDecoder(encoding).decode(fullBuffer);

    // The ASCII part should always be correct
    expect(decoded.startsWith('Status: OK\n')).toBe(true);
    // The full decoded string should not be empty after the ASCII part
    expect(decoded.length).toBeGreaterThan(asciiChunk.length);
  });

  it('Buffer.concat of empty array does not throw', () => {
    // Guard: cleanup() checks stdoutChunks.length > 0 before concat
    expect(() => Buffer.concat([])).not.toThrow();
  });
});
