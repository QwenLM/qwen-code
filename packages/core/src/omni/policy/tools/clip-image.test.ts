/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaProbeResult } from '../../ffmpeg.js';
import type { ToolResult } from '../../../tools/tools.js';
import { OMNI_CLIP_IMAGE_TOOL_NAME, OmniClipImageTool } from './clip-image.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
  sharpCreate: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

vi.mock('sharp', () => ({
  default: (...args: unknown[]) => mocks.sharpCreate(...args),
}));

const INPUT_SIZE = 2 * 1024 ** 2; // "2MB"
const OUTPUT_SIZE = 100 * 1024; // "100KB"

describe('OmniClipImageTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  let toFile: ReturnType<typeof vi.fn>;
  let png: ReturnType<typeof vi.fn>;
  let extract: ReturnType<typeof vi.fn>;
  let rotate: ReturnType<typeof vi.fn>;
  let timeout: ReturnType<typeof vi.fn>;

  const tool = new OmniClipImageTool();

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const invocation = tool.build({
      inputPath,
      outputDir,
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      ...params,
    } as never);
    return invocation.execute(new AbortController().signal);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-clip-img-'));
    inputPath = path.join(root, 'photo.png');
    await fs.writeFile(inputPath, Buffer.alloc(INPUT_SIZE));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);

    toFile = vi
      .fn()
      .mockResolvedValue({ width: 300, height: 200, size: OUTPUT_SIZE });
    png = vi.fn(() => ({ toFile }));
    extract = vi.fn(() => ({ png }));
    rotate = vi.fn(() => ({ extract }));
    timeout = vi.fn(() => ({ rotate }));
    mocks.sharpCreate.mockReturnValue({
      timeout,
      metadata: vi.fn().mockResolvedValue({ pages: 1 }),
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor with a png media output', () => {
    expect(tool.name).toBe(OMNI_CLIP_IMAGE_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['image'],
      outputs: [
        {
          kind: 'media',
          mimeTypes: ['image/png'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
    });
  });

  it('crops the rectangle after baking in orientation', async () => {
    probe({ width: 1000, height: 800, frameCount: 1 });
    const result = await run();

    expect(rotate).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith({
      left: 10,
      top: 20,
      width: 300,
      height: 200,
    });
    expect(png).toHaveBeenCalledWith();
    expect(toFile).toHaveBeenCalledWith(
      path.join(outputDir, 'photo-clip-10x20+300x200.png'),
    );

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toEqual([
      {
        kind: 'image',
        storage: 'workspace',
        title: 'Clipped image',
        workspacePath: 'photo-clip-10x20+300x200.png',
        mimeType: 'image/png',
        sizeBytes: OUTPUT_SIZE,
        metadata: {
          omniDisclosure:
            '原 1000×800/2MB → 裁剪区域 (10,20) 300×200/100KB，区域外内容全部丢弃',
          omniRole: 'clip',
        },
      },
    ]);
  });

  it('refuses a rectangle exceeding the probed image bounds', async () => {
    probe({ width: 100, height: 100, frameCount: 1 });
    const result = await run();
    expect(result.error?.message).toMatch(/exceeds the image bounds/);
    expect(mocks.sharpCreate).not.toHaveBeenCalled();
  });

  it('refuses a full-image no-op crop', async () => {
    probe({ width: 320, height: 220, frameCount: 1 });
    const result = await run({ x: 0, y: 0, width: 320, height: 220 });
    expect(result.error?.message).toMatch(/no-op/);
    expect(mocks.sharpCreate).not.toHaveBeenCalled();
  });

  it('refuses animated images instead of cropping one frame', async () => {
    probe({ width: 1000, height: 800, frameCount: 7 });
    const result = await run();
    expect(result.error?.message).toMatch(
      /animated image \(7 frames\) is not supported/,
    );
    expect(mocks.sharpCreate).not.toHaveBeenCalled();
  });

  it('refuses animated images the probe missed via sharp page count', async () => {
    probe({ width: 1000, height: 800 });
    mocks.sharpCreate.mockReturnValue({
      metadata: vi.fn().mockResolvedValue({ pages: 3 }),
    });
    const result = await run();
    expect(result.error?.message).toMatch(
      /animated image \(3 frames\) is not supported/,
    );
  });

  it('returns an error result when the input file is missing', async () => {
    await fs.rm(inputPath);
    const result = await run();
    expect(result.error?.message).toMatch(/input file not found/);
  });

  it.each([
    ['missing x', { y: 1, width: 10, height: 10 }],
    ['negative x', { x: -1, y: 1, width: 10, height: 10 }],
    ['fractional width', { x: 1, y: 1, width: 10.5, height: 10 }],
    ['zero height', { x: 1, y: 1, width: 10, height: 0 }],
    ['unknown property', { x: 1, y: 1, width: 10, height: 10, extra: 1 }],
  ])('build rejects %s', (_label, rectangle) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...rectangle } as never),
    ).toThrow();
  });
});
