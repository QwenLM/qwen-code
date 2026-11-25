/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  parsePDFPageRange,
  isPDFSupported,
  isPDFExtension,
} from './pdfUtils.js';

describe('parsePDFPageRange', () => {
  it('parses single page', () => {
    expect(parsePDFPageRange('5')).toEqual({ firstPage: 5, lastPage: 5 });
  });

  it('parses page range', () => {
    expect(parsePDFPageRange('1-10')).toEqual({ firstPage: 1, lastPage: 10 });
  });

  it('parses open-ended range', () => {
    expect(parsePDFPageRange('3-')).toEqual({
      firstPage: 3,
      lastPage: Infinity,
    });
  });

  it('returns null for empty string', () => {
    expect(parsePDFPageRange('')).toBeNull();
  });

  it('returns null for whitespace', () => {
    expect(parsePDFPageRange('  ')).toBeNull();
  });

  it('returns null for zero page', () => {
    expect(parsePDFPageRange('0')).toBeNull();
  });

  it('returns null for negative page', () => {
    expect(parsePDFPageRange('-1')).toBeNull();
  });

  it('returns null for inverted range', () => {
    expect(parsePDFPageRange('10-5')).toBeNull();
  });

  it('returns null for non-numeric input', () => {
    expect(parsePDFPageRange('abc')).toBeNull();
  });

  it('trims whitespace before parsing', () => {
    expect(parsePDFPageRange('  3  ')).toEqual({ firstPage: 3, lastPage: 3 });
  });
});

describe('isPDFSupported', () => {
  // Native PDF reading via application/pdf inlineData is currently disabled.
  // All PDFs go through page extraction (pdftoppm → JPEG images).
  // See pdfUtils.ts for rationale and re-enablement instructions.

  it('returns false for all models (native PDF disabled)', () => {
    expect(isPDFSupported('gemini-2.5-pro')).toBe(false);
    expect(isPDFSupported('gemini-2.5-flash')).toBe(false);
    expect(isPDFSupported('gemini-3-pro')).toBe(false);
    expect(isPDFSupported('some-new-model-v3')).toBe(false);
    expect(isPDFSupported('')).toBe(false);
  });
});

describe('isPDFExtension', () => {
  it('recognizes .pdf extension', () => {
    expect(isPDFExtension('.pdf')).toBe(true);
    expect(isPDFExtension('pdf')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPDFExtension('.PDF')).toBe(true);
    expect(isPDFExtension('PDF')).toBe(true);
  });

  it('rejects non-PDF extensions', () => {
    expect(isPDFExtension('.txt')).toBe(false);
    expect(isPDFExtension('docx')).toBe(false);
  });
});
