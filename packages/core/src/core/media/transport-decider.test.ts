/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { Config } from '../../config/config.js';
import type { MediaProbe } from '../../utils/media/types.js';
import { decideTransport } from './transport-decider.js';

const config = {} as Config;

function probe(sizeBytes: number): MediaProbe {
  return {
    path: '/tmp/a.png',
    hash: 'abc',
    modality: 'image',
    mimeType: 'image/png',
    sizeBytes,
  };
}

describe('transport-decider', () => {
  const original = process.env['QWEN_CODE_MAX_INLINE_MEDIA_BYTES'];
  afterEach(() => {
    if (original === undefined) {
      delete process.env['QWEN_CODE_MAX_INLINE_MEDIA_BYTES'];
    } else {
      process.env['QWEN_CODE_MAX_INLINE_MEDIA_BYTES'] = original;
    }
  });

  it('inlines media at or below the limit', () => {
    process.env['QWEN_CODE_MAX_INLINE_MEDIA_BYTES'] = '100';
    expect(decideTransport(probe(100), config).mode).toBe('inline');
    expect(decideTransport(probe(50), config).mode).toBe('inline');
  });

  it('requires upload above the limit', () => {
    process.env['QWEN_CODE_MAX_INLINE_MEDIA_BYTES'] = '100';
    const decision = decideTransport(probe(101), config);
    expect(decision.mode).toBe('upload');
    expect(decision.reason).toContain('upload required');
  });
});
