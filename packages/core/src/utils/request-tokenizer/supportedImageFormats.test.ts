/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_IMAGE_MIME_TYPES,
  PIPELINE_IMAGE_MIME_TYPES,
  getSupportedImageFormatsString,
  getUnsupportedImageFormatWarning,
} from './supportedImageFormats.js';

describe('supportedImageFormats', () => {
  it('forwards only the provider-safe subset to model endpoints', () => {
    // Pin the exact pipeline set: negative-membership assertions alone
    // would still pass for an empty list, letting the advertised contract
    // silently regress to nothing (or drop a forwarded format) while the
    // suite stays green.
    expect([...PIPELINE_IMAGE_MIME_TYPES].sort()).toEqual(
      [
        'image/gif',
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
      ].sort(),
    );
    // The read-path omission gate (#9291) drops everything outside the
    // pipeline set, so the advertised contract must not include it.
    expect(PIPELINE_IMAGE_MIME_TYPES).not.toContain('image/heic');
    expect(PIPELINE_IMAGE_MIME_TYPES).not.toContain('image/bmp');
    expect(PIPELINE_IMAGE_MIME_TYPES).not.toContain('image/tiff');
    for (const type of PIPELINE_IMAGE_MIME_TYPES) {
      expect(SUPPORTED_IMAGE_MIME_TYPES).toContain(type);
    }
  });

  it('does not advertise formats the read path always omits', () => {
    const advertised = getSupportedImageFormatsString();
    expect(advertised).not.toMatch(/HEIC/);
    expect(advertised).not.toMatch(/BMP/);
    expect(advertised).not.toMatch(/TIFF/);
    expect(getUnsupportedImageFormatWarning()).toContain(advertised);
  });
});
