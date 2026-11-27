/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeMediaMimeType,
  resolveAudioMimeAndFormat,
  stripBase64DataUriPrefix,
} from './media-mime.js';

describe('mediaMime', () => {
  it.each([
    ['audio/x-wav', 'audio/wav'],
    ['audio/x-wav; codecs=1', 'audio/wav'],
    [' AUDIO/WAVE ', 'audio/wav'],
    ['audio/vnd.wave', 'audio/wav'],
    ['audio/x-flac', 'audio/flac'],
    ['audio/x-aac', 'audio/aac'],
    ['audio/x-m4a', 'audio/m4a'],
    ['audio/webm;codecs=opus', 'audio/webm'],
    ['VIDEO/WEBM; codecs="vp9,opus"', 'video/webm'],
    ['image/JPEG; charset=utf-8', 'image/jpeg'],
    ['constructor', 'constructor'],
    ['toString', 'tostring'],
    [undefined, undefined],
    [null as unknown as string | undefined, undefined],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeMediaMimeType(input)).toBe(expected);
  });

  it('resolves canonical audio MIME and format safely without prototype lookups', () => {
    expect(resolveAudioMimeAndFormat('audio/x-wav; codecs=1')).toEqual({
      mimeType: 'audio/wav',
      format: 'wav',
    });
    expect(resolveAudioMimeAndFormat('audio/webm;codecs=opus')).toEqual({
      mimeType: 'audio/webm',
      format: 'webm',
    });
    expect(resolveAudioMimeAndFormat('constructor')).toBeUndefined();
    expect(resolveAudioMimeAndFormat('toString')).toBeUndefined();
    expect(resolveAudioMimeAndFormat('image/png')).toBeUndefined();
  });

  it('strips base64 data URI prefixes including RFC 2397 empty-MIME and preserves raw base64', () => {
    expect(stripBase64DataUriPrefix('data:audio/wav;base64,UklGRg==')).toBe(
      'UklGRg==',
    );
    expect(
      stripBase64DataUriPrefix('DATA:audio/mpeg;charset=utf-8;base64,SUQz'),
    ).toBe('SUQz');
    expect(stripBase64DataUriPrefix('data:;base64,UklGRg==')).toBe('UklGRg==');
    expect(stripBase64DataUriPrefix('UklGRg==')).toBe('UklGRg==');
  });
});
