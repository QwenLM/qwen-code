/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Part } from '@google/genai';
import {
  collectText,
  hasImageParts,
  isImagePart,
  normalizeParts,
  replaceImagesWithText,
  splitImageParts,
  isUsableImagePart,
} from './image-part-utils.js';

const imagePart: Part = {
  inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' },
};
const audioPart: Part = {
  inlineData: { mimeType: 'audio/mpeg', data: 'aGVsbG8=' },
};
const textPart: Part = { text: 'hello' };

describe('normalizeParts', () => {
  it('wraps a bare string as a text part', () => {
    expect(normalizeParts('hi')).toEqual([{ text: 'hi' }]);
  });

  it('wraps a single Part into an array', () => {
    expect(normalizeParts(imagePart)).toEqual([imagePart]);
  });

  it('normalizes a mixed array of strings and parts', () => {
    expect(normalizeParts(['a', imagePart])).toEqual([
      { text: 'a' },
      imagePart,
    ]);
  });
});

describe('isImagePart', () => {
  it('accepts an inline image with data', () => {
    expect(isImagePart(imagePart)).toBe(true);
  });

  it('rejects non-image inlineData (audio)', () => {
    expect(isImagePart(audioPart)).toBe(false);
  });

  it('rejects an image part with empty data', () => {
    expect(
      isImagePart({ inlineData: { mimeType: 'image/png', data: '' } }),
    ).toBe(false);
  });

  it('rejects a text part', () => {
    expect(isImagePart(textPart)).toBe(false);
  });
});

describe('hasImageParts', () => {
  it('is false for a plain string', () => {
    expect(hasImageParts('no images here')).toBe(false);
  });

  it('is true when an image part is present', () => {
    expect(hasImageParts([textPart, imagePart])).toBe(true);
  });
});

describe('splitImageParts', () => {
  it('separates image and non-image parts preserving order', () => {
    const { imageParts, nonImageParts } = splitImageParts([
      textPart,
      imagePart,
      audioPart,
    ]);
    expect(imageParts).toEqual([imagePart]);
    expect(nonImageParts).toEqual([textPart, audioPart]);
  });
});

describe('isUsableImagePart', () => {
  it('accepts a valid image', () => {
    expect(isUsableImagePart(imagePart)).toBe(true);
  });

  it('rejects empty data', () => {
    expect(
      isUsableImagePart({ inlineData: { mimeType: 'image/png', data: '' } }),
    ).toBe(false);
  });

  it('rejects oversized data', () => {
    const huge = 'a'.repeat(11 * 1024 * 1024);
    expect(
      isUsableImagePart({ inlineData: { mimeType: 'image/png', data: huge } }),
    ).toBe(false);
  });
});

describe('collectText', () => {
  it('joins and trims text from parts, ignoring non-text', () => {
    expect(collectText([textPart, imagePart, { text: 'world' }])).toBe(
      'hello\nworld',
    );
  });

  it('returns empty string when there is no text', () => {
    expect(collectText([imagePart])).toBe('');
  });
});

describe('replaceImagesWithText', () => {
  it('replaces the image in place, keeping surrounding parts in order', () => {
    // Mirrors the real shape: a "Content from <file>:" prefix, the image, then
    // trailing text. The transcript must land between them, not at the end.
    expect(
      replaceImagesWithText(
        [{ text: 'Content from a.png:' }, imagePart, { text: 'trailer' }],
        'TRANSCRIPT',
      ),
    ).toEqual([
      { text: 'Content from a.png:' },
      { text: 'TRANSCRIPT' },
      { text: 'trailer' },
    ]);
  });

  it('collapses multiple images into the first slot and drops the rest', () => {
    expect(
      replaceImagesWithText(['p', imagePart, 'q', imagePart], 'T'),
    ).toEqual([{ text: 'p' }, { text: 'T' }, { text: 'q' }]);
  });

  it('appends the text when there is no image part', () => {
    expect(replaceImagesWithText(['just text'], 'T')).toEqual([
      { text: 'just text' },
      { text: 'T' },
    ]);
  });
});
