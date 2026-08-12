/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  daemonPromptImageToBlob,
  toDaemonPromptContent,
} from './promptContent.js';

describe('daemonPromptImageToBlob', () => {
  it('decodes raw base64 image data', async () => {
    const blob = daemonPromptImageToBlob({
      data: 'AQID',
      mimeType: 'image/png',
    });

    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.of(1, 2, 3),
    );
  });

  it('strips a data URI prefix before decoding', async () => {
    const blob = daemonPromptImageToBlob({
      data: 'data:image/jpeg;base64,BAUG',
      media_type: 'image/jpeg',
    });

    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      Uint8Array.of(4, 5, 6),
    );
  });
});

describe('toDaemonPromptContent', () => {
  it('keeps text prompts as the first daemon content block', () => {
    expect(toDaemonPromptContent('hello')).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('normalizes image aliases into daemon image content blocks', () => {
    expect(
      toDaemonPromptContent('look', [
        { data: 'a', mimeType: 'image/png' },
        { data: 'b', media_type: 'image/jpeg' },
      ]),
    ).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'a', mimeType: 'image/png' },
      { type: 'image', data: 'b', mimeType: 'image/jpeg' },
    ]);
  });

  it('preserves an image-only BMP prompt as canonical daemon content', () => {
    expect(
      toDaemonPromptContent('', [{ data: 'Qk0=', mimeType: 'image/bmp' }]),
    ).toEqual([
      { type: 'text', text: '' },
      { type: 'image', data: 'Qk0=', mimeType: 'image/bmp' },
    ]);
  });
});
