/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderImageOverview,
  renderNormalizedImageCrop,
} from './image-view.js';

describe('image views', () => {
  let root: string;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-view-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps a small overview at its oriented source size', async () => {
    const filePath = path.join(root, 'small.png');
    await sharp({
      create: {
        width: 20,
        height: 10,
        channels: 3,
        background: '#306090',
      },
    })
      .png()
      .toFile(filePath);

    const view = await renderImageOverview(filePath, signal);
    const metadata = await sharp(view.bytes).metadata();

    expect(view).toMatchObject({
      mimeType: 'image/jpeg',
      sourceWidth: 20,
      sourceHeight: 10,
      selectedWidth: 20,
      selectedHeight: 10,
      outputWidth: 20,
      outputHeight: 10,
    });
    expect(metadata).toMatchObject({ width: 20, height: 10, format: 'jpeg' });
  });

  it('bounds a large overview by the shared edge and patch budget', async () => {
    const filePath = path.join(root, 'large.png');
    await sharp({
      create: {
        width: 4000,
        height: 2000,
        channels: 3,
        background: '#804020',
      },
    })
      .png()
      .toFile(filePath);

    const view = await renderImageOverview(filePath, signal);

    expect(Math.max(view.outputWidth, view.outputHeight)).toBeLessThanOrEqual(
      1568,
    );
    expect(
      Math.ceil(view.outputWidth / 28) * Math.ceil(view.outputHeight / 28),
    ).toBeLessThanOrEqual(1568);
    expect(view.bytes.length).toBeLessThanOrEqual(9 * 1024 * 1024);
  });

  it('may magnify a normalized crop while preserving its source dimensions', async () => {
    const filePath = path.join(root, 'crop.png');
    await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: '#306090',
      },
    })
      .png()
      .toFile(filePath);

    const view = await renderNormalizedImageCrop(
      filePath,
      { x1: 0, y1: 0, x2: 25, y2: 25 },
      signal,
    );
    const metadata = await sharp(view.bytes).metadata();

    expect(view).toMatchObject({
      mimeType: 'image/jpeg',
      sourceWidth: 400,
      sourceHeight: 400,
      selectedWidth: 10,
      selectedHeight: 10,
      outputWidth: 80,
      outputHeight: 80,
    });
    expect(metadata).toMatchObject({ width: 80, height: 80, format: 'jpeg' });
    expect(view.bytes.length).toBeLessThanOrEqual(9 * 1024 * 1024);
  });

  it('reports decode_failed for a corrupt canonical image', async () => {
    const filePath = path.join(root, 'corrupt.png');
    await fs.writeFile(filePath, 'not a real png');

    await expect(renderImageOverview(filePath, signal)).rejects.toMatchObject({
      code: 'decode_failed',
    });
  });
});
