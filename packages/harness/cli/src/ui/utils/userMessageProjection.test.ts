/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { HistoryItemWithoutId } from '../types.js';
import { appendUserMessageToHistory } from './userMessageProjection.js';

describe('appendUserMessageToHistory', () => {
  it('preserves text and omits the images field for text-only input', () => {
    const history: HistoryItemWithoutId[] = [];
    appendUserMessageToHistory(
      { text: '  hello\nworld  ', images: [] },
      (item) => history.push(item),
    );
    expect(history).toEqual([{ type: 'user', text: '  hello\nworld  ' }]);
    expect(history[0]).not.toHaveProperty('images');
  });

  it('keeps image-only messages, image order and blob references', () => {
    const images = [
      { media_type: 'image/png', data: 'inline-image' },
      { media_type: 'image/jpeg', data: '', blob_id: 'blob-1' },
    ];
    const history: HistoryItemWithoutId[] = [];
    appendUserMessageToHistory({ text: '', images }, (item) =>
      history.push(item),
    );
    expect(history).toEqual([{ type: 'user', text: '', images }]);
  });

  it('uses the caller image data without changing the input', () => {
    const images = [{ media_type: 'image/png', data: 'inline-image' }];
    const content = { text: 'describe this', images };
    Object.freeze(content);
    Object.freeze(images[0]);
    Object.freeze(images);
    const history: HistoryItemWithoutId[] = [];
    appendUserMessageToHistory(content, (item) => history.push(item));
    expect(history).toEqual([{ type: 'user', text: 'describe this', images }]);
    expect(history[0]).toHaveProperty('images', images);
    expect(content).toEqual({ text: 'describe this', images });
  });
});
