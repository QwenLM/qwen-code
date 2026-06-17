/**
 * Tests for extractBase64Binary() Path B — strict canonicalization pipeline.
 * Regression suite for #344: false base64 detection on plain text.
 */
import { describe, it, expect } from 'bun:test';
import { extractBase64Binary } from '../binary-detection.ts';

// Helper: generate a real base64-encoded binary payload
function makeRealBase64(byteLength: number): string {
  const buf = Buffer.alloc(byteLength);
  // Fill with non-printable bytes to pass looksLikeBinary()
  for (let i = 0; i < byteLength; i++) {
    buf[i] = (i * 7 + 13) % 256; // deterministic pseudo-random, includes nulls
  }
  return buf.toString('base64');
}

describe('extractBase64Binary() — false positive regression (#344)', () => {
  it('rejects English prose paragraph', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    expect(extractBase64Binary(prose)).toBeNull();
  });

  it('rejects code snippet with operators and punctuation', () => {
    const code = `
      function processData(items: string[]): Map<string, number> {
        const result = new Map<string, number>();
        for (const item of items) {
          result.set(item, (result.get(item) ?? 0) + 1);
        }
        return result;
      }
    `.repeat(5);
    expect(extractBase64Binary(code)).toBeNull();
  });

  it('rejects log lines with timestamps and UUIDs', () => {
    const logs = Array.from({ length: 20 }, (_, i) =>
      `2024-01-${String(i + 1).padStart(2, '0')}T12:00:00Z [INFO] session=a1b2c3d4-e5f6-7890-abcd-ef1234567890 Processing request ${i}`
    ).join('\n');
    expect(extractBase64Binary(logs)).toBeNull();
  });

  it('rejects JSON string values', () => {
    const json = JSON.stringify({
      data: Array.from({ length: 30 }, (_, i) => ({
        id: `item_${i}`,
        name: `Test Item ${i}`,
        description: 'A moderately long description with various characters',
      })),
    });
    expect(extractBase64Binary(json)).toBeNull();
  });

  it('rejects non-English text (CJK)', () => {
    const cjk = '这是一段中文文本用于测试base64检测的误报问题。'.repeat(20);
    expect(extractBase64Binary(cjk)).toBeNull();
  });

  it('rejects URL-encoded strings', () => {
    const url = 'https://example.com/path?q=hello%20world&token=abc123def456ghi789jkl012mno345pqr678stu901vwx234yz'.repeat(5);
    expect(extractBase64Binary(url)).toBeNull();
  });

  it('rejects text with spaces (even if all other chars are base64-valid)', () => {
    // "Hello World" repeated — all alpha chars are valid base64, but spaces disqualify
    const spacey = 'Hello World Testing Base64 Detection '.repeat(20);
    expect(extractBase64Binary(spacey)).toBeNull();
  });
});

describe('extractBase64Binary() — true positives', () => {
  it('detects real base64-encoded binary (standard alphabet)', () => {
    const b64 = makeRealBase64(256);
    const result = extractBase64Binary(b64);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('raw-base64');
    expect(result!.buffer.length).toBe(256);
  });

  it('detects base64 with RFC 2045 line breaks (every 76 chars)', () => {
    const raw = makeRealBase64(512);
    // Insert CRLF every 76 characters (standard MIME line wrapping)
    const wrapped = raw.replace(/(.{76})/g, '$1\r\n');
    const result = extractBase64Binary(wrapped);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('raw-base64');
  });

  it('detects URL-safe base64-encoded binary', () => {
    const buf = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) buf[i] = (i * 7 + 13) % 256;
    // Convert to URL-safe: + → -, / → _
    const urlSafe = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const result = extractBase64Binary(urlSafe);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('raw-base64');
  });

  it('detects base64 with = padding', () => {
    // 253 bytes → ceil(253/3)*4 = 340 base64 chars with == padding
    const b64 = makeRealBase64(253);
    expect(b64).toContain('=');
    const result = extractBase64Binary(b64);
    expect(result).not.toBeNull();
  });

  it('detects base64 with trailing whitespace', () => {
    const b64 = '  ' + makeRealBase64(256) + '  \n';
    const result = extractBase64Binary(b64);
    expect(result).not.toBeNull();
  });
});

describe('extractBase64Binary() — edge cases', () => {
  it('rejects valid base64 that decodes to text (not binary)', () => {
    // Encode plain ASCII text as base64 — it should pass charset/roundtrip
    // but fail looksLikeBinary()
    const textPayload = 'Hello World, this is just plain text content. '.repeat(10);
    const b64 = Buffer.from(textPayload).toString('base64');
    expect(extractBase64Binary(b64)).toBeNull();
  });

  it('rejects strings shorter than MIN_BASE64_LENGTH', () => {
    const short = makeRealBase64(64); // 88 base64 chars, under 256
    expect(extractBase64Binary(short)).toBeNull();
  });

  it('rejects strings starting with { (JSON)', () => {
    // Even if the rest looks like base64
    const fake = '{' + makeRealBase64(256).slice(1);
    expect(extractBase64Binary(fake)).toBeNull();
  });

  it('preserves Path A (data URL) detection', () => {
    const buf = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) buf[i] = (i * 7 + 13) % 256;
    const dataUrl = `data:application/octet-stream;base64,${buf.toString('base64')}`;
    const result = extractBase64Binary(dataUrl);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('data-url');
    expect(result!.mimeType).toBe('application/octet-stream');
  });
});
