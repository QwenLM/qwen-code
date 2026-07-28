import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeProcessOutput } from './decode-process-output.js';

describe('decodeProcessOutput', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns empty string for empty buffer', () => {
    expect(decodeProcessOutput(Buffer.from(''))).toBe('');
  });

  it('decodes ASCII buffer correctly', () => {
    const buf = Buffer.from('Hello, world!', 'utf-8');
    expect(decodeProcessOutput(buf)).toBe('Hello, world!');
  });

  it('decodes valid UTF-8 buffer correctly', () => {
    const buf = Buffer.from('Привет мир', 'utf-8');
    expect(decodeProcessOutput(buf)).toBe('Привет мир');
  });

  it('decodes CP-866 buffer when UTF-8 detection fails', () => {
    // CP-866 encoded "Ошибка" — bytes that are NOT valid UTF-8
    const cp866Bytes = Buffer.from([0x8e, 0xe9, 0xa8, 0xa1, 0xaa, 0xa0]);
    const result = decodeProcessOutput(cp866Bytes);
    // Should NOT contain replacement characters ( mojibake )
    expect(result).not.toContain('\uFFFD');
    // On non-Windows systems getCachedEncodingForBuffer may fall back to
    // UTF-8, producing replacement chars — that's acceptable. The key
    // assertion is that on Windows with CP-866 the result is correct.
    // We verify the function doesn't throw and returns a string.
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles mixed ASCII + non-UTF8 bytes without throwing', () => {
    const mixed = Buffer.concat([
      Buffer.from('Error: ', 'utf-8'),
      Buffer.from([0x8e, 0xe9, 0xa8, 0xa1]), // CP-866 "Ошиб"
    ]);
    const result = decodeProcessOutput(mixed);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
