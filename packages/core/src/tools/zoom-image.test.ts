/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { ToolErrorType } from './tool-error.js';
import { ZoomImageTool } from './zoom-image.js';

vi.mock('../telemetry/loggers.js', () => ({
  logFileOperation: vi.fn(),
}));

/** The whole image as a normalized region. */
const FULL = { x1: 0, y1: 0, x2: 1000, y2: 1000 };
type Region = typeof FULL;
const params = (file_path: string, region: Region = FULL) => ({
  file_path,
  ...region,
});

/** A solid-colour image to encode and write. */
const solid = (
  width: number,
  height: number,
  background: string | { r: number; g: number; b: number; alpha: number },
  channels: 3 | 4 = 3,
) => sharp({ create: { width, height, channels, background } });

/** Raw RGB pixels in four quadrants: red, green over blue, yellow. */
function quadrants(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const color =
        y < height / 2
          ? x < width / 2
            ? [255, 0, 0]
            : [0, 255, 0]
          : x < width / 2
            ? [0, 0, 255]
            : [255, 255, 0];
      pixels[offset] = color[0]!;
      pixels[offset + 1] = color[1]!;
      pixels[offset + 2] = color[2]!;
    }
  }
  return pixels;
}

/** The bytes of the image part a successful zoom returns. */
function returnedImage(result: { llmContent: unknown }) {
  const parts = result.llmContent as Array<{ inlineData?: { data: string } }>;
  return Buffer.from(parts[1]!.inlineData!.data, 'base64');
}

/** The first three channels of the returned image's centre pixel. */
async function centerPixel(result: { llmContent: unknown }) {
  const { data, info } = await sharp(returnedImage(result))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const center =
    (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
    info.channels;
  return Array.from(data.subarray(center, center + 3));
}

describe('ZoomImageTool', () => {
  let root: string;
  let tool: ZoomImageTool;

  /** Builds and executes a zoom on `zoomTool` (default: the suite's tool). */
  const zoom = (file: string, region?: Region, zoomTool = tool) =>
    zoomTool.build(params(file, region)).execute(new AbortController().signal);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'zoom-image-tool-'));
    const config = {
      getFileService: () => new FileDiscoveryService(root),
      getTargetDir: () => root,
      getEffectiveInputModalities: () => ({ image: true }),
      getPlansDir: () => path.join(root, '.plans'),
      getWorkspaceContext: () => createMockWorkspaceContext(root),
      storage: {
        getProjectTempDir: () => path.join(root, '.temp'),
        getProjectDir: () => path.join(root, '.project'),
        getWorkflowRunsDir: () => path.join(root, '.workflow-runs'),
        getUserSkillsDirs: () => [path.join(root, '.skills')],
      },
    } as unknown as Config;
    tool = new ZoomImageTool(config);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns a magnified crop from the selected normalized region', async () => {
    const imagePath = path.join(root, 'quadrants.png');
    await sharp(quadrants(400, 400), {
      raw: { width: 400, height: 400, channels: 3 },
    })
      .png()
      .toFile(imagePath);

    const result = await zoom(imagePath, { x1: 500, y1: 0, x2: 1000, y2: 500 });

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toEqual([
      {
        text: expect.stringContaining('normalized region (500,0)-(1000,500)'),
      },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: expect.any(String),
        },
      },
    ]);

    const [r, g, b] = await centerPixel(result);
    expect(r).toBeLessThan(20);
    expect(g).toBeGreaterThan(235);
    expect(b).toBeLessThan(20);
  });

  it('reports a missing source image as a file error', async () => {
    const result = await zoom(path.join(root, 'missing.png'));

    expect(result.error).toMatchObject({
      type: ToolErrorType.FILE_NOT_FOUND,
    });
    expect(result.llmContent).toMatch(/not found/i);
  });

  it('rejects a directory instead of passing it to the image decoder', async () => {
    const result = await zoom(root);

    expect(result.error).toMatchObject({
      type: ToolErrorType.TARGET_IS_DIRECTORY,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects non-regular files before decoding',
    async () => {
      const socketPath = path.join(root, 'image.sock');
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });

      try {
        const result = await zoom(socketPath);

        expect(result.error).toMatchObject({
          type: ToolErrorType.TARGET_NOT_REGULAR_FILE,
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
    },
  );

  it('rejects unsupported source formats with a recoverable tool error', async () => {
    const textPath = path.join(root, 'notes.txt');
    await fs.writeFile(textPath, 'not an image');

    const result = await zoom(textPath);

    expect(result.error).toMatchObject({
      type: ToolErrorType.READ_CONTENT_FAILURE,
    });
    expect(result.llmContent).toMatch(/PNG, JPEG, or WebP/i);
  });

  it('rejects source files larger than the bounded decode input', async () => {
    const largePath = path.join(root, 'large.png');
    const handle = await fs.open(largePath, 'w');
    await handle.truncate(100 * 1024 * 1024 + 1);
    await handle.close();

    const result = await zoom(largePath);

    expect(result.error).toMatchObject({
      type: ToolErrorType.FILE_TOO_LARGE,
    });
  });

  it('interprets coordinates in the EXIF-oriented image space', async () => {
    // Four distinct quadrants. Orientation 6 rotates the stored image 90deg
    // clockwise for display, moving the stored bottom-left quadrant (blue)
    // into the displayed top-left; a crop that ignores auto-orientation
    // reads the stored top-left (red) instead, so this pins the behavior.
    const imagePath = path.join(root, 'oriented.jpg');
    await sharp(quadrants(60, 40), {
      raw: { width: 60, height: 40, channels: 3 },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(imagePath);

    // Displayed (auto-oriented) size is 40x60; select its top-left quadrant.
    const result = await zoom(imagePath, { x1: 0, y1: 0, x2: 500, y2: 500 });

    expect(result.error).toBeUndefined();
    const [r, g, b] = await centerPixel(result);
    expect(r).toBeLessThan(20);
    expect(g).toBeLessThan(20);
    expect(b).toBeGreaterThan(235);
    expect(result.llmContent).toEqual(
      expect.arrayContaining([
        {
          text: expect.stringContaining('Oriented source: 40x60'),
        },
      ]),
    );
  });

  it('flattens transparent pixels onto white before returning JPEG', async () => {
    const imagePath = path.join(root, 'transparent.png');
    await solid(20, 20, { r: 0, g: 0, b: 0, alpha: 0 }, 4)
      .png()
      .toFile(imagePath);

    const result = await zoom(imagePath);

    expect(await centerPixel(result)).toEqual([255, 255, 255]);
  });

  it('bounds the returned view by edge, patch, and byte budgets', async () => {
    const imagePath = path.join(root, 'panorama.webp');
    await solid(2000, 500, '#804020').webp().toFile(imagePath);

    const bytes = returnedImage(await zoom(imagePath));
    const metadata = await sharp(bytes).metadata();

    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(1568);
    expect(
      Math.ceil(metadata.width / 28) * Math.ceil(metadata.height / 28),
    ).toBeLessThanOrEqual(1568);
    expect(bytes.length).toBeLessThanOrEqual(9 * 1024 * 1024);
  });

  it('rejects animated images instead of silently zooming one frame', async () => {
    const twoFrameGif = Buffer.from(
      '47494638396101000100800000000000ffffff21f90400010000002c000000000100010000020244010021f90400010000002c00000000010001000002024c01003b',
      'hex',
    );
    const imagePath = path.join(root, 'animated.webp');
    await sharp(twoFrameGif, { animated: true }).webp().toFile(imagePath);

    const result = await zoom(imagePath);

    expect(result.error).toMatchObject({
      type: ToolErrorType.READ_CONTENT_FAILURE,
    });
    expect(result.llmContent).toMatch(/static/i);
  });

  it('stops before reading when the tool call is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool
        .build(params(path.join(root, 'never-read.png')))
        .execute(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects invalid paths and normalized regions before execution', () => {
    const image = path.join(root, 'image.png');
    expect(() => tool.build(params('relative.png'))).toThrow(/absolute/i);
    expect(() =>
      tool.build(params(image, { x1: 500, y1: 0, x2: 500, y2: 1000 })),
    ).toThrow(/x1 must be less than x2/i);
    expect(() =>
      tool.build(params(image, { x1: 0, y1: 500, x2: 1000, y2: 500 })),
    ).toThrow(/y1 must be less than y2/i);
    expect(() =>
      tool.build(params(image, { x1: 0, y1: -1, x2: 1000, y2: 1000 })),
    ).toThrow(/>= 0/);
  });

  it('rejects a path matched by a .qwenignore pattern', async () => {
    await fs.writeFile(path.join(root, '.qwenignore'), 'secret-*.png\n');
    const ignoredPath = path.join(root, 'secret-image.png');
    await solid(20, 20, '#000000').png().toFile(ignoredPath);

    expect(() => tool.build(params(ignoredPath))).toThrow(
      /ignored by .qwenignore pattern/i,
    );
  });

  it('uses the read_file path permission boundary', async () => {
    const workspaceInvocation = tool.build(
      params(path.join(root, 'image.png')),
    );
    const clipboardInvocation = tool.build(
      params(path.join(Storage.getGlobalTempDir(), 'clipboard', 'p.png')),
    );
    const externalInvocation = tool.build(
      params(path.join(os.tmpdir(), 'external-image.png')),
    );

    await expect(workspaceInvocation.getDefaultPermission()).resolves.toBe(
      'allow',
    );
    await expect(clipboardInvocation.getDefaultPermission()).resolves.toBe(
      'allow',
    );
    await expect(externalInvocation.getDefaultPermission()).resolves.toBe(
      'ask',
    );
    expect(workspaceInvocation.toolLocations()).toEqual([
      { path: path.join(root, 'image.png') },
    ]);
  });

  it('returns a recoverable error when decoding fails after metadata', async () => {
    const complete = await solid(100, 100, '#123456').png().toBuffer();
    const imagePath = path.join(root, 'truncated.png');
    await fs.writeFile(imagePath, complete.subarray(0, complete.length / 2));

    const result = await zoom(imagePath);

    expect(result.error).toMatchObject({
      type: ToolErrorType.READ_CONTENT_FAILURE,
    });
  });

  it('returns a bounded error when the model does not accept image inputs', async () => {
    const textOnlyConfig = {
      getFileService: () => new FileDiscoveryService(root),
      getTargetDir: () => root,
      getEffectiveInputModalities: () => ({}),
    } as unknown as Config;
    const imagePath = path.join(root, 'gated.png');
    await solid(20, 20, '#000000').png().toFile(imagePath);

    const result = await zoom(
      imagePath,
      FULL,
      new ZoomImageTool(textOnlyConfig),
    );

    expect(result.error).toMatchObject({
      type: ToolErrorType.READ_CONTENT_FAILURE,
    });
    expect(result.llmContent).toMatch(
      /requires a model that accepts image inputs/i,
    );
  });

  it('caps the upscale factor instead of inflating a tiny crop to the budget', async () => {
    const imagePath = path.join(root, 'tiny-crop.png');
    await solid(400, 400, '#306090').png().toFile(imagePath);

    // Normalized (0,0)-(25,25) of a 400x400 source is a 10x10 pixel crop.
    const result = await zoom(imagePath, { x1: 0, y1: 0, x2: 25, y2: 25 });

    expect(result.error).toBeUndefined();
    const metadata = await sharp(returnedImage(result)).metadata();

    // The 8x cap bounds a 10x10 crop to 80x80 rather than the ~1092x1092 the
    // unconstrained visual budget would have produced.
    expect(metadata.width).toBeLessThanOrEqual(80);
    expect(metadata.height).toBeLessThanOrEqual(80);
  });

  it('rejects a sharp-decodable but unsupported format at the format guard', async () => {
    const imagePath = path.join(root, 'static.gif');
    await solid(20, 20, '#ff0000').gif().toFile(imagePath);

    const result = await zoom(imagePath);

    expect(result.error).toMatchObject({
      type: ToolErrorType.READ_CONTENT_FAILURE,
    });
    expect(result.llmContent).toMatch(/PNG, JPEG, or WebP/i);
  });

  it('emits a file_operation telemetry event on a successful zoom', async () => {
    const imagePath = path.join(root, 'telemetry.png');
    await solid(40, 40, '#00ff00').png().toFile(imagePath);
    vi.mocked(logFileOperation).mockClear();

    const result = await zoom(imagePath);

    expect(result.error).toBeUndefined();
    expect(logFileOperation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logFileOperation).mock.calls[0]![1]).toMatchObject({
      tool_name: 'zoom_image',
      operation: 'read',
    });
  });
});
