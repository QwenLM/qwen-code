/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  assertWithinByteLimit,
  assertWithinTokenLimit,
  effectiveMaxUploadFileBytes,
  OmniTransportGuardError,
} from './guard.js';
import type { RecognizedMedia } from './recognition.js';

function cfg(overrides: { maxBytes?: number; maxTokens?: number }): Config {
  return {
    getOmniUploadMaxFileBytes: vi.fn().mockReturnValue(overrides.maxBytes),
    getOmniMaxEstimatedTokens: vi.fn().mockReturnValue(overrides.maxTokens),
  } as unknown as Config;
}

const AUDIO_5S: RecognizedMedia = {
  modality: 'audio',
  detectedMimeType: 'audio/mpeg',
  sizeBytes: 40_000,
  metadata: { durationMs: 5000 },
};

const VIDEO_8MIN: RecognizedMedia = {
  modality: 'video',
  detectedMimeType: 'video/mp4',
  sizeBytes: 36_000_000,
  metadata: { width: 852, height: 480, durationMs: 506_000, frameRate: 30 },
};

describe('byte guard', () => {
  it('uses the default 1 GiB when unset or non-positive', () => {
    // Assert the literal, not the exported constant: settingsSchema.ts
    // hardcodes 1073741824 as the documented default (the DashScope
    // temporary-upload per-file cap), so a drifted constant must fail here
    // rather than ship green by comparing the implementation to itself.
    expect(effectiveMaxUploadFileBytes(cfg({}))).toBe(1024 * 1024 * 1024);
    expect(effectiveMaxUploadFileBytes(cfg({ maxBytes: 0 }))).toBe(
      1024 * 1024 * 1024,
    );
    expect(effectiveMaxUploadFileBytes(cfg({ maxBytes: -5 }))).toBe(
      1024 * 1024 * 1024,
    );
  });

  it('rejects above the configured limit with an explanatory message', () => {
    expect(() =>
      assertWithinByteLimit(cfg({ maxBytes: 1000 }), 2000, 'clip.mp4'),
    ).toThrow(/clip\.mp4.*2000 bytes > 1000 bytes.*omni\.upload\.maxFileBytes/);
  });

  it('passes at or below the limit', () => {
    expect(() =>
      assertWithinByteLimit(cfg({ maxBytes: 1000 }), 1000, 'clip.mp4'),
    ).not.toThrow();
  });
});

describe('token guard', () => {
  it('disabled (unset/0) attaches the estimate but never rejects', () => {
    const est = assertWithinTokenLimit(cfg({}), VIDEO_8MIN, 'p3.mp4');
    expect(est.status).toBe('ok');
    expect(est.estimatedTokenCount).toBeGreaterThan(196_608);
    expect(
      assertWithinTokenLimit(cfg({ maxTokens: 0 }), VIDEO_8MIN, 'p3.mp4')
        .status,
    ).toBe('ok');
  });

  it('enabled: rejects above threshold with estimate, threshold, and setting name', () => {
    expect(() =>
      assertWithinTokenLimit(cfg({ maxTokens: 196_608 }), VIDEO_8MIN, 'p3.mp4'),
    ).toThrow(OmniTransportGuardError);
    expect(() =>
      assertWithinTokenLimit(cfg({ maxTokens: 196_608 }), VIDEO_8MIN, 'p3.mp4'),
    ).toThrow(
      /p3\.mp4.*raw-resource-v1.*196608.*omni\.transport\.maxEstimatedTokens/,
    );
  });

  it('enabled: passes small inputs (5s audio ≈ 35 tokens)', () => {
    const est = assertWithinTokenLimit(
      cfg({ maxTokens: 196_608 }),
      AUDIO_5S,
      'tone.mp3',
    );
    expect(est.estimatedTokenCount).toBe(35);
  });

  it('unavailable estimates never reject', () => {
    const noMeta: RecognizedMedia = { ...AUDIO_5S, metadata: {} };
    const est = assertWithinTokenLimit(
      cfg({ maxTokens: 10 }),
      noMeta,
      'tone.mp3',
    );
    expect(est.status).toBe('unavailable');
  });
});
