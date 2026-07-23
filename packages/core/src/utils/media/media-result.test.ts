/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Part } from '@google/genai';
import {
  buildMediaDelivery,
  buildMediaError,
  formatDeliveryNote,
} from './media-result.js';

describe('media-result contract', () => {
  it('formats a self-describing delivery note with scope, precision and read-more', () => {
    const note = formatDeliveryNote({
      path: '/tmp/a.png',
      hash: 'abcdef0123456789',
      modality: 'image',
      scope: 'full image (native)',
      precision: 'original fidelity',
      cost: { tokens: 1200, note: '≈1200 tokens' },
      readMore: 'ask for a region crop',
    });
    expect(note).toContain('scope: full image (native)');
    expect(note).toContain('precision: original fidelity');
    expect(note).toContain('read_more: ask for a region crop');
    expect(note).toContain('cost: ≈1200 tokens');
    // Hash is truncated in the note for readability.
    expect(note).toContain('hash="abcdef012345"');
  });

  it('appends the delivery note as a trailing text part', () => {
    const media: Part = { inlineData: { data: 'AAA', mimeType: 'image/png' } };
    const result = buildMediaDelivery(media, {
      path: '/tmp/a.png',
      hash: 'deadbeef',
      modality: 'image',
      scope: 'full image',
      precision: 'original fidelity',
    });
    const parts = result.llmContent as Part[];
    expect(parts).toHaveLength(2);
    expect(parts[0].inlineData?.data).toBe('AAA');
    expect(parts[1].text).toContain('scope: full image');
    expect(result.resultFilePaths).toEqual(['/tmp/a.png']);
  });

  it('builds a fail-closed error carrying a remedy in llmContent', () => {
    const result = buildMediaError({
      kind: 'over-budget',
      message: 'file too large',
      remedy: 'read a smaller range',
    });
    expect(result.error?.type).toBe('file_too_large');
    expect(result.llmContent).toContain('read a smaller range');
    expect(result.llmContent).toContain('over-budget');
  });
});
