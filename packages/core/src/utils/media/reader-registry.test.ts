/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  createReaderRegistry,
  MediaReadError,
  type MediaReadContext,
  type MediaReader,
} from './reader-registry.js';
import type { MediaProbe, Modality } from './types.js';

const probe: MediaProbe = {
  path: '/tmp/a.png',
  hash: 'abc',
  modality: 'image',
  mimeType: 'image/png',
  sizeBytes: 10,
};

const ctx = {} as MediaReadContext;

function fakeReader(
  id: string,
  kind: 'native' | 'delegated',
  available = true,
  modalities: Modality[] = ['image'],
): MediaReader {
  return {
    id,
    kind,
    modalities,
    isAvailable: () => available,
    estimateCost: () => ({ tokens: 1, note: id }),
    read: async () => ({ content: { text: id }, scope: 's', precision: 'p' }),
  };
}

describe('reader registry', () => {
  it('lists only available readers for the modality', () => {
    const reg = createReaderRegistry();
    reg.register(fakeReader('native', 'native'));
    reg.register(fakeReader('gone', 'delegated', false));
    reg.register(fakeReader('audio-only', 'delegated', true, ['audio']));
    const available = reg.available('image', probe, ctx);
    expect(available.map((r) => r.id)).toEqual(['native']);
  });

  it('prefers native, then falls back to delegated', () => {
    const reg = createReaderRegistry();
    reg.register(fakeReader('deleg', 'delegated'));
    reg.register(fakeReader('native', 'native'));
    expect(reg.pick('image', probe, ctx)?.id).toBe('native');

    const reg2 = createReaderRegistry();
    reg2.register(fakeReader('deleg', 'delegated'));
    expect(reg2.pick('image', probe, ctx)?.id).toBe('deleg');
  });

  it('honors a preferred id when available', () => {
    const reg = createReaderRegistry();
    reg.register(fakeReader('native', 'native'));
    reg.register(fakeReader('ocr', 'delegated'));
    expect(reg.pick('image', probe, ctx, 'ocr')?.id).toBe('ocr');
  });

  it('returns undefined when the capability gate is closed', () => {
    const reg = createReaderRegistry();
    reg.register(fakeReader('native', 'native', false));
    expect(reg.pick('image', probe, ctx)).toBeUndefined();
  });

  it('last registration for an id wins (config override)', () => {
    const reg = createReaderRegistry();
    reg.register(fakeReader('r', 'native', true, ['image']));
    reg.register(fakeReader('r', 'delegated', true, ['image']));
    const all = reg.available('image', probe, ctx);
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('delegated');
  });

  it('MediaReadError carries kind and remedy', () => {
    const err = new MediaReadError('over-budget', 'too big', 'read less');
    expect(err.kind).toBe('over-budget');
    expect(err.remedy).toBe('read less');
  });
});
