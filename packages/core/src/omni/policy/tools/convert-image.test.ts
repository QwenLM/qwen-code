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
import { DEFAULT_POLICY_TOOL_TIMEOUT_MS } from './media-policy-tool.js';
import {
  CONVERT_IMAGE_DEFAULTS,
  OMNI_CONVERT_IMAGE_TOOL_NAME,
  OmniConvertImageTool,
} from './convert-image.js';

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

describe('OmniConvertImageTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  let toFile: ReturnType<typeof vi.fn>;
  let jpeg: ReturnType<typeof vi.fn>;
  let png: ReturnType<typeof vi.fn>;
  let webp: ReturnType<typeof vi.fn>;
  let rotate: ReturnType<typeof vi.fn>;
  let timeout: ReturnType<typeof vi.fn>;

  const tool = new OmniConvertImageTool();

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
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-ci-'));
    inputPath = path.join(root, 'photo.png');
    await fs.writeFile(inputPath, Buffer.alloc(INPUT_SIZE));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);

    toFile = vi
      .fn()
      .mockResolvedValue({ width: 800, height: 600, size: OUTPUT_SIZE });
    jpeg = vi.fn(() => ({ toFile }));
    png = vi.fn(() => ({ toFile }));
    webp = vi.fn(() => ({ toFile }));
    rotate = vi.fn(() => ({ jpeg, png, webp }));
    timeout = vi.fn(() => ({ rotate }));
    mocks.sharpCreate.mockReturnValue({ timeout });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and defaults', () => {
    expect(tool.name).toBe(OMNI_CONVERT_IMAGE_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['image'],
      outputs: [
        {
          kind: 'media',
          mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
    });
    expect(CONVERT_IMAGE_DEFAULTS).toEqual({ format: 'jpeg', quality: 90 });
  });

  it('converts to JPEG by default with orientation baked in', async () => {
    probe({ codec: 'png', frameCount: 1 });
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
    expect(jpeg).toHaveBeenCalledWith({ quality: 90 });
    expect(toFile).toHaveBeenCalledWith(path.join(outputDir, 'converted.jpg'));

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toEqual([
      {
        kind: 'image',
        storage: 'workspace',
        title: 'Converted image',
        workspacePath: 'converted.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: OUTPUT_SIZE,
        metadata: {
          omniDisclosure:
            '原 PNG/2MB → JPEG 质量 90/300KB，透明通道与元数据丢弃',
        },
      },
    ]);
  });

  it('converts to PNG without a quality clause', async () => {
    probe({ codec: 'mjpeg', frameCount: 1 });
    const { result } = await run({ format: 'png' });
    expect(png).toHaveBeenCalledWith();
    expect(jpeg).not.toHaveBeenCalled();
    expect(toFile).toHaveBeenCalledWith(path.join(outputDir, 'converted.png'));
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'converted.png',
      mimeType: 'image/png',
    });
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 JPEG/2MB → PNG/300KB，元数据丢弃',
    );
  });

  it('converts to WEBP with the quality override', async () => {
    probe({ codec: 'png', frameCount: 1 });
    const { result } = await run({ format: 'webp', quality: 60 });
    expect(webp).toHaveBeenCalledWith({ quality: 60 });
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'converted.webp',
      mimeType: 'image/webp',
    });
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 PNG/2MB → WEBP 质量 60/300KB，元数据丢弃',
    );
  });

  it('bounds sharp processing with the default timeout (whole seconds)', async () => {
    probe({ codec: 'png', frameCount: 1 });
    await run();
    expect(timeout).toHaveBeenCalledWith({
      seconds: DEFAULT_POLICY_TOOL_TIMEOUT_MS / 1000,
    });
  });

  it('threads policyTools.<tool>.runtime.timeoutMs into sharp, rounded up to seconds', async () => {
    probe({ codec: 'png', frameCount: 1 });
    const configured = new OmniConvertImageTool({
      getOmniPolicyToolsSettings: () => ({
        [OMNI_CONVERT_IMAGE_TOOL_NAME]: {
          runtime: { timeoutMs: 90_500 },
        },
      }),
    });
    const invocation = configured.build({ inputPath, outputDir } as never);
    await invocation.execute(new AbortController().signal);
    expect(timeout).toHaveBeenCalledWith({ seconds: 91 });
  });

  it('falls back to the upper-cased codec, then 未知格式, for unmapped codecs', async () => {
    probe({ codec: 'jp2', frameCount: 1 });
    const first = await run();
    expect(first.result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
      '原 JP2/',
    );

    probe({ frameCount: 1 });
    const second = await run();
    expect(
      second.result.artifacts?.[0]?.metadata?.['omniDisclosure'],
    ).toContain('原 未知格式/');
  });

  it('refuses animated images instead of silently keeping one frame', async () => {
    probe({ codec: 'gif', frameCount: 12 });
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
    ['relative outputDir', { outputDir: 'staging' }],
    ['unknown property', { extra: 1 }],
    ['unknown format', { format: 'avif' }],
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
      const { OmniConvertImageTool: FreshTool } = await import(
        './convert-image.js'
      );
      probe({ codec: 'png', frameCount: 1 });
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
