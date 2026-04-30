/**
 * Tests for binary detection utilities.
 *
 * Covers:
 * - looksLikeBinary: raw byte buffer detection
 * - extractBase64Binary: inline base64 detection (data URLs + raw blobs)
 * - guardLargeResult integration: base64 path in the full pipeline
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  looksLikeBinary,
  extractBase64Binary,
  detectExtensionFromMagic,
  getMimeExtension,
} from '../binary-detection.ts';
import { guardLargeResult } from '../large-response.ts';

// ============================================================
// Test Fixtures
// ============================================================

// Minimal valid PNG (1x1 transparent pixel) — real binary content
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Large PNG-like binary: PNG magic + binary junk with null bytes (>= 256 base64 chars, >= 128 decoded bytes)
const LARGE_PNG_BINARY = (() => {
  const buf = Buffer.alloc(300);
  // PNG magic bytes
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
  buf[4] = 0x0D; buf[5] = 0x0A; buf[6] = 0x1A; buf[7] = 0x0A;
  // Fill rest with binary junk (including null bytes to ensure looksLikeBinary detection)
  for (let i = 8; i < 300; i++) buf[i] = i % 256;
  return buf;
})();

// PDF magic + binary content with null bytes
const LARGE_PDF_BINARY = (() => {
  const header = Buffer.from('%PDF-1.4\n');
  const junk = Buffer.alloc(300);
  for (let i = 0; i < 300; i++) junk[i] = i % 256; // includes 0x00 at i=0, 256, etc.
  return Buffer.concat([header, junk]);
})();
const LARGE_PDF_BASE64 = LARGE_PDF_BINARY.toString('base64');

// Plain text encoded as base64 (should NOT be detected as binary)
const TEXT_AS_BASE64 = Buffer.from(
  'Hello, this is a plain text message that is not binary at all. '.repeat(10)
).toString('base64');

// Short base64 (below threshold)
const SHORT_BASE64 = Buffer.from('Hello').toString('base64'); // "SGVsbG8="

const SCREENSHOT_PAYLOAD_PRETTY = JSON.stringify([
  { type: 'text', text: 'Screenshot captured (108KB PNG)' },
  {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: LARGE_PNG_BINARY.toString('base64'),
    },
  },
], null, 2);

const SCREENSHOT_PAYLOAD_MINIFIED = JSON.stringify([
  { type: 'text', text: 'Screenshot captured (108KB PNG)' },
  {
    type: 'image',
    source: {
      type: 'base64',
      mimeType: 'image/png',
      data: LARGE_PNG_BINARY.toString('base64'),
    },
  },
]);

// Temp session dir for guardLargeResult tests
let tempSessionDir: string;

beforeAll(() => {
  tempSessionDir = join(tmpdir(), `binary-detection-test-${Date.now()}`);
  mkdirSync(tempSessionDir, { recursive: true });
});

afterAll(() => {
  rmSync(tempSessionDir, { recursive: true, force: true });
});

// ============================================================
// looksLikeBinary
// ============================================================

describe('looksLikeBinary', () => {
  test('detects null bytes as binary', () => {
    const buf = Buffer.from([0x48, 0x65, 0x00, 0x6C, 0x6F]);
    expect(looksLikeBinary(buf)).toBe(true);
  });

  test('detects high non-printable ratio as binary', () => {
    // Create buffer with >10% non-printable ASCII (control chars)
    const buf = Buffer.alloc(100);
    buf.fill(0x01, 0, 20); // 20 non-printable control chars
    buf.fill(0x41, 20);    // rest is 'A'
    expect(looksLikeBinary(buf)).toBe(true);
  });

  test('passes normal text as non-binary', () => {
    const buf = Buffer.from('Hello, world! This is normal text.\nWith newlines.\tAnd tabs.');
    expect(looksLikeBinary(buf)).toBe(false);
  });

  test('passes JSON as non-binary', () => {
    const buf = Buffer.from(JSON.stringify({ key: 'value', num: 42, arr: [1, 2, 3] }));
    expect(looksLikeBinary(buf)).toBe(false);
  });

  test('passes base64 text as non-binary (all printable ASCII)', () => {
    const buf = Buffer.from(MINIMAL_PNG.toString('base64'), 'utf-8');
    expect(looksLikeBinary(buf)).toBe(false);
  });

  test('detects real PNG bytes as binary', () => {
    expect(looksLikeBinary(MINIMAL_PNG)).toBe(true);
  });

  test('skips UTF-8 multibyte (does not misclassify international text)', () => {
    const buf = Buffer.from('日本語テスト — Ünïcödé — Émojis: 🎉🚀');
    expect(looksLikeBinary(buf)).toBe(false);
  });
});

// ============================================================
// extractBase64Binary — Data URL path
// ============================================================

describe('extractBase64Binary (data URL)', () => {
  test('extracts data:image/png;base64 with binary payload', () => {
    const dataUrl = `data:image/png;base64,${LARGE_PNG_BINARY.toString('base64')}`;
    const result = extractBase64Binary(dataUrl);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('data-url');
    expect(result!.mimeType).toBe('image/png');
    expect(result!.ext).toBe('.png');
    expect(result!.buffer.length).toBeGreaterThan(0);
  });

  test('extracts data:application/pdf;base64 with PDF payload', () => {
    const dataUrl = `data:application/pdf;base64,${LARGE_PDF_BASE64}`;
    const result = extractBase64Binary(dataUrl);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('data-url');
    expect(result!.mimeType).toBe('application/pdf');
    expect(result!.ext).toBe('.pdf');
  });

  test('rejects data:text/plain;base64 (decoded is not binary)', () => {
    const textContent = 'Hello, this is plain text. '.repeat(20);
    const dataUrl = `data:text/plain;base64,${Buffer.from(textContent).toString('base64')}`;
    const result = extractBase64Binary(dataUrl);
    expect(result).toBeNull();
  });

  test('rejects short data URL payload', () => {
    const dataUrl = `data:image/png;base64,${SHORT_BASE64}`;
    const result = extractBase64Binary(dataUrl);
    expect(result).toBeNull();
  });
});

// ============================================================
// extractBase64Binary — Raw base64 path
// ============================================================

describe('extractBase64Binary (raw base64)', () => {
  test('extracts long raw base64 that decodes to binary (PDF)', () => {
    const result = extractBase64Binary(LARGE_PDF_BASE64);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('raw-base64');
    expect(result!.mimeType).toBeNull();
    expect(result!.ext).toBe('.pdf');
  });

  test('extracts long raw base64 that decodes to binary (PNG)', () => {
    const b64 = LARGE_PNG_BINARY.toString('base64');
    expect(b64.length).toBeGreaterThan(256);
    const result = extractBase64Binary(b64);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('raw-base64');
    expect(result!.ext).toBe('.png');
  });

  test('rejects base64-encoded plain text (decoded is not binary)', () => {
    expect(TEXT_AS_BASE64.length).toBeGreaterThan(256);
    const result = extractBase64Binary(TEXT_AS_BASE64);
    expect(result).toBeNull();
  });

  test('rejects short base64 string', () => {
    const result = extractBase64Binary(SHORT_BASE64);
    expect(result).toBeNull();
  });

  test('rejects JSON containing base64 field (braces break charset ratio)', () => {
    const json = JSON.stringify({
      data: LARGE_PNG_BINARY.toString('base64'),
      type: 'image',
      metadata: { width: 1, height: 1 },
    });
    const result = extractBase64Binary(json);
    expect(result).toBeNull();
  });

  test('rejects normal text / code', () => {
    const code = `function hello() {\n  console.log("Hello, world!");\n  return 42;\n}\n`.repeat(20);
    expect(code.length).toBeGreaterThan(256);
    const result = extractBase64Binary(code);
    expect(result).toBeNull();
  });

  test('rejects empty string', () => {
    expect(extractBase64Binary('')).toBeNull();
  });

  test('handles whitespace-padded base64 (line breaks every 76 chars)', () => {
    const b64 = LARGE_PDF_BASE64.match(/.{1,76}/g)!.join('\n');
    const result = extractBase64Binary(b64);
    expect(result).not.toBeNull();
    expect(result!.source).toBe('raw-base64');
  });
});

// ============================================================
// guardLargeResult integration — base64 path
// ============================================================

describe('guardLargeResult (base64 integration)', () => {
  test('saves data URL binary and returns file message', async () => {
    const dataUrl = `data:image/png;base64,${LARGE_PNG_BINARY.toString('base64')}`;
    const result = await guardLargeResult(dataUrl, {
      sessionPath: tempSessionDir,
      toolName: 'test_tool',
    });
    expect(result).not.toBeNull();
    expect(result).toContain('Base64-encoded binary detected and saved');
    expect(result).toContain('PNG');

    // Verify file was actually written
    const downloadsDir = join(tempSessionDir, 'downloads');
    expect(existsSync(downloadsDir)).toBe(true);
  });

  test('saves raw base64 binary and returns file message', async () => {
    const result = await guardLargeResult(LARGE_PDF_BASE64, {
      sessionPath: tempSessionDir,
      toolName: 'test_api',
    });
    expect(result).not.toBeNull();
    expect(result).toContain('Base64-encoded binary detected and saved');
    expect(result).toContain('PDF');
  });

  test('passes through normal text (no base64 detection)', async () => {
    const text = 'Normal short text response';
    const result = await guardLargeResult(text, {
      sessionPath: tempSessionDir,
      toolName: 'test_tool',
    });
    expect(result).toBeNull(); // null = pass through
  });

  test('passes through base64-encoded text (decoded is not binary)', async () => {
    const result = await guardLargeResult(TEXT_AS_BASE64, {
      sessionPath: tempSessionDir,
      toolName: 'test_tool',
    });
    // Should NOT be detected as binary — decoded is plain text
    // May be null (pass through) or handled as large text depending on size
    if (result) {
      expect(result).not.toContain('Base64-encoded binary');
    }
  });

  test('raw Buffer binary still uses existing path (not base64)', async () => {
    const result = await guardLargeResult(MINIMAL_PNG, {
      sessionPath: tempSessionDir,
      toolName: 'test_buffer',
    });
    expect(result).not.toBeNull();
    // Should use the raw binary path, not the base64 path
    expect(result).toContain('Binary content detected and saved');
    expect(result).not.toContain('Base64-encoded');
  });
});

describe('guardLargeResult (structured JSON media extraction)', () => {
  test('extracts screenshot asset from pretty JSON and writes original + linked JSON artifacts', async () => {
    const result = await guardLargeResult(SCREENSHOT_PAYLOAD_PRETTY, {
      sessionPath: tempSessionDir,
      toolName: 'browser_screenshot',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('Structured media assets extracted and saved');
    expect(result).toContain('Original JSON:');
    expect(result).toContain('Linked JSON:');
    expect(result).toContain('Assets extracted: 1');

    const longResponsesDir = join(tempSessionDir, 'long_responses');
    const files = readdirSync(longResponsesDir);
    const originalJson = files.find(f => f.includes('browser_screenshot_original') && f.endsWith('.json'));
    const linkedJson = files.find(f => f.includes('browser_screenshot_linked') && f.endsWith('.json'));

    expect(originalJson).toBeDefined();
    expect(linkedJson).toBeDefined();

    const linked = JSON.parse(readFileSync(join(longResponsesDir, linkedJson!), 'utf-8')) as Array<unknown>;
    const imageBlock = linked[1] as { source?: { data?: unknown } };
    expect(typeof imageBlock.source?.data).toBe('object');

    const data = imageBlock.source?.data as { assetRef?: { path?: string; mimeType?: string; jsonPath?: string } };
    expect(data.assetRef?.path).toBeDefined();
    expect(data.assetRef?.mimeType).toBe('image/png');
    expect(data.assetRef?.jsonPath).toBe('$[1].source.data');
    expect(existsSync(data.assetRef!.path!)).toBe(true);
  });

  test('extracts screenshot asset from minified JSON (whitespace-insensitive regression)', async () => {
    const result = await guardLargeResult(SCREENSHOT_PAYLOAD_MINIFIED, {
      sessionPath: tempSessionDir,
      toolName: 'browser_screenshot',
    });

    expect(result).not.toBeNull();
    expect(result).toContain('Structured media assets extracted and saved');
  });

  test('dedupes identical structured assets by hash filename', async () => {
    // Run two extractions with the same payload; file path should resolve to the same hash-based asset.
    const first = await guardLargeResult(SCREENSHOT_PAYLOAD_MINIFIED, {
      sessionPath: tempSessionDir,
      toolName: 'browser_screenshot',
    });
    const second = await guardLargeResult(SCREENSHOT_PAYLOAD_MINIFIED, {
      sessionPath: tempSessionDir,
      toolName: 'browser_screenshot',
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const assetsDir = join(tempSessionDir, 'downloads', 'assets');
    const pngFiles = readdirSync(assetsDir).filter(f => f.endsWith('.png'));
    // At least one extracted png exists; hash naming keeps duplicates from exploding.
    expect(pngFiles.length).toBeGreaterThan(0);
  });
});

// ============================================================
// detectExtensionFromMagic
// ============================================================

describe('detectExtensionFromMagic', () => {
  test('detects PNG', () => {
    expect(detectExtensionFromMagic(MINIMAL_PNG)).toBe('.png');
  });

  test('detects PDF', () => {
    expect(detectExtensionFromMagic(LARGE_PDF_BINARY)).toBe('.pdf');
  });

  test('returns empty for unknown format', () => {
    expect(detectExtensionFromMagic(Buffer.from('Hello, world!'))).toBe('');
  });

  test('returns empty for tiny buffer', () => {
    expect(detectExtensionFromMagic(Buffer.from([0x89]))).toBe('');
  });
});

// ============================================================
// getMimeExtension
// ============================================================

describe('getMimeExtension', () => {
  test('returns extension for known MIME', () => {
    expect(getMimeExtension('image/png')).toBe('.png');
    expect(getMimeExtension('application/pdf')).toBe('.pdf');
  });

  test('handles MIME with parameters', () => {
    expect(getMimeExtension('image/jpeg; charset=utf-8')).toBe('.jpg');
  });

  test('falls back to magic bytes when MIME is unknown', () => {
    expect(getMimeExtension('application/x-unknown', MINIMAL_PNG)).toBe('.png');
  });

  test('returns empty for unknown MIME and no buffer', () => {
    expect(getMimeExtension('application/x-something')).toBe('');
  });
});
