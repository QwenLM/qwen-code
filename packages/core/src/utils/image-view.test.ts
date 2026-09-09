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
  orientedSize,
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

describe('orientedSize', () => {
  it('prefers metadata.autoOrient when present (sharp >= 0.34)', () => {
    expect(
      orientedSize({
        width: 60,
        height: 100,
        autoOrient: { width: 100, height: 60 },
      }),
    ).toEqual({ width: 100, height: 60 });
  });

  it('keeps stored axes for orientations 1-4 when autoOrient is missing (sharp < 0.34)', () => {
    for (const orientation of [1, 2, 3, 4]) {
      expect(
        orientedSize({
          width: 100,
          height: 60,
          orientation,
        }),
      ).toEqual({ width: 100, height: 60 });
    }
  });

  it('swaps stored axes for orientations 5-8 when autoOrient is missing (sharp < 0.34)', () => {
    for (const orientation of [5, 6, 7, 8]) {
      expect(
        orientedSize({
          width: 100,
          height: 60,
          orientation,
        }),
      ).toEqual({ width: 60, height: 100 });
    }
  });

  it('falls back to stored size when neither autoOrient nor orientation is present', () => {
    expect(orientedSize({ width: 320, height: 240 })).toEqual({
      width: 320,
      height: 240,
    });
  });
});

describe('image views with EXIF orientation', () => {
  let root: string;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-view-exif-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // Stored pixels are 100x60 but EXIF orientation 6 rotates the displayed
  // image to 60x100. The view must be sized and cropped in oriented space.
  async function writeRotatedJpeg(name: string): Promise<string> {
    const filePath = path.join(root, name);
    await sharp({
      create: {
        width: 100,
        height: 60,
        channels: 3,
        background: '#306090',
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(filePath);
    return filePath;
  }

  it('reports oriented source size for an EXIF-rotated overview', async () => {
    const filePath = await writeRotatedJpeg('exif-overview.jpg');

    const view = await renderImageOverview(filePath, signal);

    expect(view).toMatchObject({
      sourceWidth: 60,
      sourceHeight: 100,
      selectedWidth: 60,
      selectedHeight: 100,
      outputWidth: 60,
      outputHeight: 100,
    });
  });

  it('crops an EXIF-rotated image in oriented coordinates', async () => {
    const filePath = await writeRotatedJpeg('exif-crop.jpg');

    // Oriented size is 60x100, so this selects the 30x50 top-left quadrant.
    const view = await renderNormalizedImageCrop(
      filePath,
      { x1: 0, y1: 0, x2: 500, y2: 500 },
      signal,
    );

    expect(view).toMatchObject({
      sourceWidth: 60,
      sourceHeight: 100,
      selectedWidth: 30,
      selectedHeight: 50,
      outputWidth: 240,
      outputHeight: 400,
    });
    const metadata = await sharp(view.bytes).metadata();
    expect(metadata).toMatchObject({ width: 240, height: 400 });
  });
});
