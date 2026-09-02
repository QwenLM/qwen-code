/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure-logic coverage for the live-turn driver: composer attachment folding
 * (unsupported/unreadable images must surface as notices, never vanish) and
 * the replay-batch fold (the transcript reset path for session switches).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { foldBatch, imagePathsToParts } from './live-turn.js';

describe('imagePathsToParts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opentui-live-turn-'));

  it('encodes a readable image as an inlineData part', () => {
    const path = join(dir, 'ok.png');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { parts, notices } = imagePathsToParts([path]);
    expect(notices).toEqual([]);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.inlineData?.mimeType).toBe('image/png');
    expect(parts[0]?.inlineData?.data).toBe(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    );
  });

  it('reports unsupported extensions as notices instead of parts', () => {
    const path = join(dir, 'notes.txt');
    writeFileSync(path, 'not an image');
    const { parts, notices } = imagePathsToParts([path]);
    expect(parts).toEqual([]);
    expect(notices).toEqual([`Unsupported image type: ${path}`]);
  });

  it('reports unreadable image paths as notices instead of parts', () => {
    const missing = join(dir, 'missing.jpg');
    const { parts, notices } = imagePathsToParts([missing]);
    expect(parts).toEqual([]);
    expect(notices).toEqual([`Could not read image: ${missing}`]);
  });
});

describe('foldBatch', () => {
  it('folds a replay batch into transcript items in order', () => {
    const items = foldBatch([
      { type: 'user', text: 'hello', sentToModel: true },
      { type: 'text', delta: 'hi ' },
      { type: 'text', delta: 'there' },
      { type: 'error', text: 'boom', hint: 'retry later' },
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      'user',
      'assistant',
      'error',
    ]);
    const assistant = items[1];
    // Consecutive text deltas merge into one streaming assistant row.
    expect(assistant && 'text' in assistant ? assistant.text : '').toBe(
      'hi there',
    );
  });

  it('returns an empty transcript for an empty batch', () => {
    expect(foldBatch([])).toEqual([]);
  });
});
