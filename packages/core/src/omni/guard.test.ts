/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  assertWithinByteLimit,
  assertWithinDurationLimit,
  assertWithinTokenLimit,
  effectiveMaxUploadFileBytes,
  OmniTransportGuardError,
} from './guard.js';
import type { RecognizedMedia } from './recognition.js';

function cfg(overrides: {
  maxBytes?: number;
  maxTokens?: number;
  maxDurationSeconds?: number;
}): Config {
  return {
    getOmniMaxUploadFileBytes: vi.fn().mockReturnValue(overrides.maxBytes),
    getOmniMaxEstimatedTokens: vi.fn().mockReturnValue(overrides.maxTokens),
    getOmniMaxDurationSeconds: vi
      .fn()
      .mockReturnValue(overrides.maxDurationSeconds),
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
    ).toThrow(
      /clip\.mp4.*2000 bytes > 1000 bytes.*omni\.processing\.transportGuard\.maxUploadFileBytes/,
    );
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
      /p3\.mp4.*raw-resource-v1.*196608.*omni\.processing\.transportGuard\.maxEstimatedTokens/,
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

describe('duration guard', () => {
  const FILM_98MIN: RecognizedMedia = {
    modality: 'video',
    detectedMimeType: 'video/mp4',
    sizeBytes: 474_864_706,
    metadata: { width: 1920, height: 1040, durationMs: 5_895_767 },
  };

  it('is disabled when unset or non-positive', () => {
    for (const c of [cfg({}), cfg({ maxDurationSeconds: 0 })]) {
      expect(() =>
        assertWithinDurationLimit(c, FILM_98MIN, 'film'),
      ).not.toThrow();
    }
  });

  it('rejects a file that clears the byte limit but is still too long', () => {
    // The real failure this guard exists for: 2.44 GB downscaled to 474 MB
    // passes a 1 GiB byte ceiling, uploads, and is then refused by the
    // provider for duration — after paying for the transcode.
    const config = cfg({ maxDurationSeconds: 3600 });
    expect(() =>
      assertWithinByteLimit(config, FILM_98MIN.sizeBytes, 'film'),
    ).not.toThrow();
    expect(() => assertWithinDurationLimit(config, FILM_98MIN, 'film')).toThrow(
      OmniTransportGuardError,
    );
  });

  it('names duration as the reason and says downscaling will not help', () => {
    try {
      assertWithinDurationLimit(
        cfg({ maxDurationSeconds: 3600 }),
        FILM_98MIN,
        'film',
      );
      throw new Error('expected a guard rejection');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('duration limit');
      expect(message).toContain('5896s > 3600s');
      expect(message).toMatch(/Clip a shorter span/);
    }
  });

  it('accepts media within the limit', () => {
    expect(() =>
      assertWithinDurationLimit(
        cfg({ maxDurationSeconds: 3600 }),
        VIDEO_8MIN,
        'clip',
      ),
    ).not.toThrow();
  });

  it('never rejects when the probe reported no duration', () => {
    const noDuration: RecognizedMedia = {
      modality: 'video',
      detectedMimeType: 'video/mp4',
      sizeBytes: 10,
      metadata: {},
    };
    expect(() =>
      assertWithinDurationLimit(
        cfg({ maxDurationSeconds: 1 }),
        noDuration,
        'x',
      ),
    ).not.toThrow();
  });
});
