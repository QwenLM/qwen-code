/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findMediaReferences } from './media-references.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-ref-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('findMediaReferences', () => {
  it('finds existing media files referenced relative to the base dir', async () => {
    await fs.writeFile(path.join(dir, 'diagram.png'), Buffer.from([1]));
    await fs.writeFile(path.join(dir, 'clip.mp4'), Buffer.from([1]));
    const text = 'See diagram.png and ./clip.mp4 for details. missing.jpg too.';
    const refs = await findMediaReferences(text, dir);
    const rels = refs.map((r) => r.relPath).sort();
    expect(rels).toEqual(['clip.mp4', 'diagram.png']);
    const png = refs.find((r) => r.relPath === 'diagram.png');
    expect(png?.modality).toBe('image');
    expect(refs.find((r) => r.relPath === 'clip.mp4')?.modality).toBe('video');
  });

  it('refuses references escaping the base dir', async () => {
    const outside = path.join(dir, '..', 'evil.png');
    await fs.writeFile(outside, Buffer.from([1])).catch(() => {});
    const refs = await findMediaReferences('../evil.png', dir);
    expect(refs).toEqual([]);
    await fs.rm(outside, { force: true }).catch(() => {});
  });

  it('ignores non-media extensions', async () => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
    const refs = await findMediaReferences('notes.txt', dir);
    expect(refs).toEqual([]);
  });
});
