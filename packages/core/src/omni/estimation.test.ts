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

  it('animated image: real frameCount from the probe, not 1', () => {
    // A 480×480 300-frame GIF at one frame would estimate ~113 tokens and
    // sail under any realistic guard threshold; the real estimate is ~33,750.
    const est = estimateRawResourceTokens(
      media('image', { width: 480, height: 480, frameCount: 300 }),
    );
    expect(est.estimatedTokenCount).toBe(Math.ceil((480 * 480 * 300) / 2048));
    expect(est.status).toBe('ok');
    // Degenerate frame counts fall back to the static single frame.
    expect(
      estimateRawResourceTokens(
        media('image', { width: 480, height: 480, frameCount: 0 }),
      ).estimatedTokenCount,
    ).toBe(Math.ceil((480 * 480) / 2048));
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

  it('degenerate present values → unavailable, never a 0-token ok', () => {
    // A truncated/still-being-written capture can probe as duration 0 —
    // an 'ok' 0-token estimate would sail under the transport guard while
    // violating the invariant that 'ok' means a real estimate.
    for (const metadata of [
      { width: 100, height: 100, durationMs: 0, frameRate: 30 },
      { width: 0, height: 100, durationMs: 1000, frameRate: 30 },
      { width: 100, height: 100, durationMs: 1000, frameRate: NaN },
      { width: 100, height: -1, durationMs: 1000, frameRate: 30 },
    ]) {
      expect(estimateRawResourceTokens(media('video', metadata)).status).toBe(
        'unavailable',
      );
    }
    expect(
      estimateRawResourceTokens(media('audio', { durationMs: 0 })).status,
    ).toBe('unavailable');
    expect(
      estimateRawResourceTokens(media('image', { width: 0, height: 50 }))
        .status,
    ).toBe('unavailable');
  });
});
