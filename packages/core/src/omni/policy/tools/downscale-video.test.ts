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
  DOWNSCALE_VIDEO_DEFAULTS,
  OMNI_DOWNSCALE_VIDEO_TOOL_NAME,
  OmniDownscaleVideoTool,
} from './downscale-video.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const INPUT_SIZE = 2 * 1024 ** 2; // "2MB"
const OUTPUT_SIZE = 300 * 1024; // "300KB"

describe('OmniDownscaleVideoTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;

  const tool = new OmniDownscaleVideoTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  /** ffmpeg success: writes the output file (last arg) and exits 0. */
  const ffmpegSucceeds = (): void => {
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args[args.length - 1], Buffer.alloc(OUTPUT_SIZE));
      return { code: 0, stderr: '' };
    });
  };

  const run = async (
    params: Record<string, unknown> = {},
    toolInstance: OmniDownscaleVideoTool = tool,
  ): Promise<{ result: ToolResult; signal: AbortSignal }> => {
    const invocation = toolInstance.build({
      inputPath,
      outputDir,
      ...params,
    } as never);
    const signal = new AbortController().signal;
    return { result: await invocation.execute(signal), signal };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-vid-'));
    inputPath = path.join(root, 'clip.mov');
    await fs.writeFile(inputPath, Buffer.alloc(INPUT_SIZE));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    ffmpegSucceeds();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and defaults', () => {
    expect(tool.name).toBe(OMNI_DOWNSCALE_VIDEO_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['video'],
      outputs: [
        {
          kind: 'media',
          mimeTypes: ['video/mp4'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
    });
    expect(DOWNSCALE_VIDEO_DEFAULTS).toEqual({
      maxHeight: 480,
      fps: 10,
      crf: 28,
      preset: 'veryfast',
    });
  });

  it("defaults to 'ask' permission: a model-origin call writes files and must confirm outside yolo", async () => {
    const invocation = tool.build({ inputPath, outputDir } as never);
    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
  });

  it('downscales with the fixed-call defaults, audio stream-copied', async () => {
    probe({ height: 1080, frameRate: 30 });
    const { result, signal } = await run();

    expect(mocks.probeMediaMetadata).toHaveBeenCalledWith(
      inputPath,
      'video',
      signal,
    );
    const outputPath = path.join(outputDir, 'clip-downscaled.mp4');
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      [
        '-y',
        '-i',
        inputPath,
        '-vf',
        'scale=-2:480,fps=10',
        '-c:v',
        'libx264',
        '-crf',
        '28',
        '-preset',
        'veryfast',
        '-c:a',
        'copy',
        outputPath,
      ],
      { signal, timeoutMs: DEFAULT_POLICY_TOOL_TIMEOUT_MS },
    );

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toEqual([
      {
        kind: 'video',
        storage: 'workspace',
        title: 'Downscaled video',
        workspacePath: 'clip-downscaled.mp4',
        mimeType: 'video/mp4',
        sizeBytes: OUTPUT_SIZE,
        metadata: {
          omniDisclosure:
            '原 1080p30/2MB → 480p10/300KB，分辨率与帧率下降，细节受损',
        },
      },
    ]);
  });

  it('never upscales and rounds the target height down to even', async () => {
    probe({ height: 359, frameRate: 24 });
    const { result } = await run();
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args).toContain('scale=-2:358,fps=10');
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 359p24/2MB → 358p10/300KB，分辨率与帧率下降，细节受损',
    );
  });

  it('discloses only the dimensions that actually dropped', async () => {
    // 360p@8fps against the 480p/10fps defaults: neither the height nor
    // the frame rate goes down — the loss clause must not claim it did.
    probe({ height: 360, frameRate: 8 });
    const { result } = await run();
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 360p8/2MB → 360p10/300KB，重新编码压缩，细节受损',
    );

    // Height drops, frame rate does not.
    probe({ height: 720, frameRate: 8 });
    const heightOnly = await run();
    expect(heightOnly.result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 720p8/2MB → 480p10/300KB，分辨率下降，细节受损',
    );

    // Frame rate drops, height does not.
    probe({ height: 360, frameRate: 30 });
    const rateOnly = await run();
    expect(rateOnly.result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 360p30/2MB → 360p10/300KB，帧率下降，细节受损',
    );
  });

  it('falls back to AAC 64k when audio stream copy fails', async () => {
    probe({ height: 720, frameRate: 25 });
    mocks.runFfmpeg
      .mockResolvedValueOnce({ code: 1, stderr: 'pcm in mp4 unsupported' })
      .mockImplementationOnce(async (args: string[]) => {
        await fs.writeFile(args[args.length - 1], Buffer.alloc(OUTPUT_SIZE));
        return { code: 0, stderr: '' };
      });

    const { result } = await run();
    expect(result.error).toBeUndefined();
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(2);
    const firstArgs = mocks.runFfmpeg.mock.calls[0][0] as string[];
    const secondArgs = mocks.runFfmpeg.mock.calls[1][0] as string[];
    expect(firstArgs).toContain('copy');
    expect(secondArgs).not.toContain('copy');
    expect(secondArgs.join(' ')).toContain('-c:a aac -b:a 64k');
  });

  it('charges the AAC fallback against the SAME wall-clock budget (no timeout doubling)', async () => {
    probe({ height: 720, frameRate: 25 });
    mocks.runFfmpeg
      .mockImplementationOnce(async () => {
        // Burn measurable wall-clock time in the failing copy pass.
        await new Promise((r) => setTimeout(r, 50));
        return { code: 1, stderr: 'pcm in mp4 unsupported' };
      })
      .mockImplementationOnce(async (args: string[]) => {
        await fs.writeFile(args[args.length - 1], Buffer.alloc(OUTPUT_SIZE));
        return { code: 0, stderr: '' };
      });

    const { result } = await run();
    expect(result.error).toBeUndefined();
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(2);
    const firstTimeout = (
      mocks.runFfmpeg.mock.calls[0][1] as { timeoutMs: number }
    ).timeoutMs;
    const secondTimeout = (
      mocks.runFfmpeg.mock.calls[1][1] as { timeoutMs: number }
    ).timeoutMs;
    expect(firstTimeout).toBe(DEFAULT_POLICY_TOOL_TIMEOUT_MS);
    // The fallback gets only what the copy pass left, never a fresh
    // full budget (timers never fire early, so ≥40ms must be gone).
    expect(secondTimeout).toBeLessThanOrEqual(
      DEFAULT_POLICY_TOOL_TIMEOUT_MS - 40,
    );
    expect(secondTimeout).toBeGreaterThan(0);
  });

  it('reports the ffmpeg error when both attempts fail', async () => {
    probe({ height: 720, frameRate: 25 });
    mocks.runFfmpeg.mockResolvedValue({
      code: 187,
      stderr: 'Conversion failed!',
    });
    const { result } = await run();
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(2);
    expect(result.error?.message).toMatch(/ffmpeg failed \(exit 187\)/);
    expect(result.error?.message).toContain('Conversion failed!');
    expect(result.artifacts).toBeUndefined();
  });

  it('threads policyTools.<tool>.runtime.timeoutMs into runFfmpeg', async () => {
    probe({ height: 720, frameRate: 25 });
    const configured = new OmniDownscaleVideoTool({
      getOmniPolicyToolsSettings: () => ({
        [OMNI_DOWNSCALE_VIDEO_TOOL_NAME]: {
          runtime: { timeoutMs: 120_000 },
        },
      }),
    });
    await run({}, configured);
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('threads tunable overrides into the ffmpeg args', async () => {
    probe({ height: 2160, frameRate: 60 });
    await run({ maxHeight: 720, fps: 15, crf: 32, preset: 'fast' });
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args).toContain('scale=-2:720,fps=15');
    expect(args.join(' ')).toContain('-crf 32 -preset fast');
  });

  it('reports an aborted run without attempting the audio fallback', async () => {
    probe({ height: 720, frameRate: 25 });
    const controller = new AbortController();
    mocks.runFfmpeg.mockImplementation(async () => {
      controller.abort();
      return { code: 1, stderr: '' };
    });
    const invocation = tool.build({ inputPath, outputDir });
    const result = await invocation.execute(controller.signal);
    expect(result.error?.message).toBe('video downscaling aborted');
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
  });

  it('errors when the probe cannot determine the video height', async () => {
    probe({ frameRate: 25 });
    const { result } = await run();
    expect(result.error?.message).toMatch(/could not determine video height/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('renders an unknown original frame rate as "?"', async () => {
    probe({ height: 480 });
    const { result } = await run();
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
      '原 480p?/',
    );
  });

  it.each([
    ['relative outputDir', { outputDir: 'staging' }],
    ['unknown property', { extra: 1 }],
    ['invalid preset', { preset: 'warp-speed' }],
    ['crf out of range', { crf: 99 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });
});
