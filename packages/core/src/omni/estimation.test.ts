/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { estimateRawResourceTokens } from './estimation.js';
import type { RecognizedMedia } from './recognition.js';

function media(
  modality: RecognizedMedia['modality'],
  metadata: RecognizedMedia['metadata'],
): RecognizedMedia {
  return {
    modality,
    sha256: 'a'.repeat(64),
    detectedMimeType: 'x/y',
    sizeBytes: 1,
    metadata,
  };
}

describe('estimateRawResourceTokens (raw-resource-v1)', () => {
  it('audio: ceil(seconds × 7)', () => {
    expect(
      estimateRawResourceTokens(media('audio', { durationMs: 5000 })),
    ).toEqual({
      estimatedTokenCount: 35,
      method: 'raw-resource-v1',
      status: 'ok',
    });
    // 5.1s → ceil(35.7) = 36
    expect(
      estimateRawResourceTokens(media('audio', { durationMs: 5100 }))
        .estimatedTokenCount,
    ).toBe(36);
  });

  it('image: ceil(w×h / (32×32×2)), frameCount 1', () => {
    const est = estimateRawResourceTokens(
      media('image', { width: 800, height: 600 }),
    );
    expect(est.estimatedTokenCount).toBe(Math.ceil((800 * 600) / 2048));
    expect(est.status).toBe('ok');
  });

  it('video: frameCount from duration × frameRate', () => {
    const est = estimateRawResourceTokens(
      media('video', {
        width: 852,
        height: 480,
        durationMs: 10_000,
        frameRate: 30,
      }),
    );
    expect(est.estimatedTokenCount).toBe(Math.ceil((852 * 480 * 300) / 2048));
    expect(est.method).toBe('raw-resource-v1');
  });

  it('missing required fields → unavailable, never guessed', () => {
    expect(estimateRawResourceTokens(media('audio', {})).status).toBe(
      'unavailable',
    );
    expect(
      estimateRawResourceTokens(media('image', { width: 100 })).status,
    ).toBe('unavailable');
    expect(
      estimateRawResourceTokens(
        media('video', { width: 100, height: 100, durationMs: 1000 }),
      ).status,
    ).toBe('unavailable');
  });
});
