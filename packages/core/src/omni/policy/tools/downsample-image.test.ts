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
import {
  DOWNSAMPLE_IMAGE_DEFAULTS,
  OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME,
  OmniDownsampleImageTool,
} from './downsample-image.js';

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
const OUTPUT_SIZE = 300 * 1024; // "300KB"

describe('OmniDownsampleImageTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  let toFile: ReturnType<typeof vi.fn>;
  let jpeg: ReturnType<typeof vi.fn>;
  let resize: ReturnType<typeof vi.fn>;
  let rotate: ReturnType<typeof vi.fn>;

  const tool = new OmniDownsampleImageTool();

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<{ result: ToolResult; signal: AbortSignal }> => {
    const invocation = tool.build({
      inputPath,
      outputDir,
      ...params,
    } as never);
    const signal = new AbortController().signal;
    return { result: await invocation.execute(signal), signal };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-img-'));
    inputPath = path.join(root, 'photo.png');
    await fs.writeFile(inputPath, Buffer.alloc(INPUT_SIZE));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);

    toFile = vi
      .fn()
      .mockResolvedValue({ width: 1568, height: 1176, size: OUTPUT_SIZE });
    jpeg = vi.fn(() => ({ toFile }));
    resize = vi.fn(() => ({ jpeg }));
    rotate = vi.fn(() => ({ resize }));
    mocks.sharpCreate.mockReturnValue({ rotate });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and tool name', () => {
    expect(tool.name).toBe(OMNI_DOWNSAMPLE_IMAGE_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      inputMediaTypes: ['image'],
      outputs: [
        {
          kind: 'media',
          mimeTypes: ['image/jpeg'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
    });
    expect(DOWNSAMPLE_IMAGE_DEFAULTS).toEqual({
      maxDimension: 1568,
      quality: 75,
    });
  });

  it('downsamples with the fixed-call defaults and disclosure (D8)', async () => {
    probe({ width: 4096, height: 3072, frameCount: 1 });
    const { result, signal } = await run();

    expect(mocks.probeMediaMetadata).toHaveBeenCalledWith(
      inputPath,
      'image',
      signal,
    );
    expect(mocks.sharpCreate).toHaveBeenCalledWith(inputPath, {
      failOn: 'error',
      limitInputPixels: true,
    });
    expect(rotate).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith({
      width: 1568,
      height: 1568,
      fit: 'inside',
      withoutEnlargement: true,
    });
    expect(jpeg).toHaveBeenCalledWith({ quality: 75 });
    expect(toFile).toHaveBeenCalledWith(
      path.join(outputDir, 'downsampled.jpg'),
    );

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toEqual([
      {
        kind: 'image',
        storage: 'workspace',
        title: 'Downsampled image',
        workspacePath: 'downsampled.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: OUTPUT_SIZE,
        metadata: {
          omniDisclosure:
            '原 4096×3072/2MB → 1568×1176/300KB，质量 75，细节与文字锐度受损',
        },
      },
    ]);
    expect(result.llmContent).toContain('Downsampled image');
  });

  it('threads tunable overrides into sharp', async () => {
    probe({ width: 4000, height: 3000, frameCount: 1 });
    await run({ maxDimension: 800, quality: 50 });
    expect(resize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 800, height: 800 }),
    );
    expect(jpeg).toHaveBeenCalledWith({ quality: 50 });
  });

  it('omits original dimensions from the disclosure when the probe lacks them', async () => {
    probe({ frameCount: 1 });
    const { result } = await run();
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 2MB → 1568×1176/300KB，质量 75，细节与文字锐度受损',
    );
  });

  it('refuses animated images instead of silently keeping one frame', async () => {
    probe({ width: 640, height: 480, frameCount: 12 });
    const { result } = await run();
    expect(result.error?.message).toMatch(
      /animated image \(12 frames\) is not supported/,
    );
    expect(mocks.sharpCreate).not.toHaveBeenCalled();
    expect(result.artifacts).toBeUndefined();
  });

  it('returns an error result when the input file is missing', async () => {
    await fs.rm(inputPath);
    const { result } = await run();
    expect(result.error?.message).toMatch(/input file not found/);
  });

  it.each([
    ['relative inputPath', { inputPath: 'rel.png' }],
    ['unknown property', { extra: true }],
    ['quality out of range', { quality: 150 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });

  it('returns an error result when sharp cannot be loaded (D9)', async () => {
    vi.resetModules();
    vi.doMock('sharp', () => {
      throw new Error("Cannot find module 'sharp'");
    });
    try {
      const { OmniDownsampleImageTool: FreshTool } = await import(
        './downsample-image.js'
      );
      probe({ width: 100, height: 100, frameCount: 1 });
      const invocation = new FreshTool().build({ inputPath, outputDir });
      const result = await invocation.execute(new AbortController().signal);
      expect(result.error?.message).toMatch(
        /"sharp" image module could not be loaded/,
      );
      expect(mocks.sharpCreate).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('sharp');
      vi.resetModules();
    }
  });
});
