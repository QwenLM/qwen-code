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
  DOWNSAMPLE_AUDIO_DEFAULTS,
  OMNI_DOWNSAMPLE_AUDIO_TOOL_NAME,
  OmniDownsampleAudioTool,
} from './downsample-audio.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const INPUT_SIZE = 1024 ** 2; // "1MB"
const OUTPUT_SIZE = 120 * 1024; // "120KB"

describe('OmniDownsampleAudioTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;

  const tool = new OmniDownsampleAudioTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const run = async (
    params: Record<string, unknown> = {},
    toolInstance: OmniDownsampleAudioTool = tool,
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
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-aud-'));
    inputPath = path.join(root, 'track.wav');
    await fs.writeFile(inputPath, Buffer.alloc(INPUT_SIZE));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args[args.length - 1], Buffer.alloc(OUTPUT_SIZE));
      return { code: 0, stderr: '' };
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and defaults', () => {
    expect(tool.name).toBe(OMNI_DOWNSAMPLE_AUDIO_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['audio'],
      outputs: [
        {
          kind: 'media',
          mimeTypes: ['audio/mp4'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
    });
    expect(DOWNSAMPLE_AUDIO_DEFAULTS).toEqual({
      bitrateKbps: 64,
      sampleRateHz: 16_000,
      channels: 1,
    });
  });

  it("defaults to 'ask' permission: a model-origin call writes files and must confirm outside yolo", async () => {
    const invocation = tool.build({ inputPath, outputDir } as never);
    await expect(invocation.getDefaultPermission()).resolves.toBe('ask');
  });

  it('downsamples with the fixed-call defaults and disclosure (D8)', async () => {
    probe({ bitRate: 320_000, sampleRateHz: 48_000, channels: 2 });
    const { result, signal } = await run();

    expect(mocks.probeMediaMetadata).toHaveBeenCalledWith(
      inputPath,
      'audio',
      signal,
    );
    const outputPath = path.join(outputDir, 'track-downsampled.m4a');
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      [
        '-y',
        '-i',
        inputPath,
        '-vn',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-ar',
        '16000',
        '-ac',
        '1',
        outputPath,
      ],
      { signal, timeoutMs: DEFAULT_POLICY_TOOL_TIMEOUT_MS },
    );

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toEqual([
      {
        kind: 'audio',
        storage: 'workspace',
        title: 'Downsampled audio',
        workspacePath: 'track-downsampled.m4a',
        mimeType: 'audio/mp4',
        sizeBytes: OUTPUT_SIZE,
        metadata: {
          omniDisclosure:
            '原 320kbps/48kHz 立体声 → 64kbps/16kHz 单声道，高频细节丢失，声道合并',
        },
      },
    ]);
  });

  it('falls back to input byte size when the probe lacks a bit rate', async () => {
    probe({ sampleRateHz: 44_100 });
    const { result } = await run();
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 1MB/44kHz → 64kbps/16kHz 单声道，高频细节丢失',
    );
  });

  it('threads tunable overrides into the ffmpeg args and disclosure', async () => {
    probe({ bitRate: 256_000, sampleRateHz: 48_000, channels: 6 });
    const { result } = await run({
      bitrateKbps: 96,
      sampleRateHz: 24_000,
      channels: 2,
    });
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args.join(' ')).toContain('-b:a 96k -ar 24000 -ac 2');
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 256kbps/48kHz 6声道 → 96kbps/24kHz 立体声，高频细节丢失，声道合并',
    );
  });

  it('clamps every target to the probed source (never "upsamples") and discloses only the re-encode', async () => {
    // Source already below every default: 24kbps/8kHz/mono.
    probe({ bitRate: 24_000, sampleRateHz: 8000, channels: 1 });
    const { result } = await run();
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args.join(' ')).toContain('-b:a 24k -ar 8000 -ac 1');
    // No frequency content above the source's own Nyquist was lost —
    // claiming 高频细节丢失 here would be a false disclosure (D8).
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 24kbps/8kHz 单声道 → 24kbps/8kHz 单声道，重新编码压缩',
    );
  });

  it('discloses 声道合并 (not 高频细节丢失) when only the channel count drops', async () => {
    probe({ bitRate: 48_000, sampleRateHz: 16_000, channels: 2 });
    const { result } = await run();
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args.join(' ')).toContain('-b:a 48k -ar 16000 -ac 1');
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 48kbps/16kHz 立体声 → 48kbps/16kHz 单声道，声道合并',
    );
  });

  it('threads policyTools.<tool>.runtime.timeoutMs into runFfmpeg', async () => {
    probe({ bitRate: 128_000 });
    const configured = new OmniDownsampleAudioTool({
      getOmniPolicyToolsSettings: () => ({
        [OMNI_DOWNSAMPLE_AUDIO_TOOL_NAME]: {
          runtime: { timeoutMs: 90_000 },
        },
      }),
    });
    await run({}, configured);
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 90_000 }),
    );
  });

  it('reports the ffmpeg error on a non-zero exit', async () => {
    probe({ bitRate: 128_000 });
    mocks.runFfmpeg.mockResolvedValue({
      code: 1,
      stderr: 'Invalid data found when processing input',
    });
    const { result } = await run();
    expect(result.error?.message).toMatch(/ffmpeg failed \(exit 1\)/);
    expect(result.error?.message).toContain('Invalid data found');
    expect(result.artifacts).toBeUndefined();
  });

  it('reports an aborted run', async () => {
    probe({ bitRate: 128_000 });
    const controller = new AbortController();
    mocks.runFfmpeg.mockImplementation(async () => {
      controller.abort();
      return { code: 1, stderr: '' };
    });
    const invocation = tool.build({ inputPath, outputDir });
    const result = await invocation.execute(controller.signal);
    expect(result.error?.message).toBe('audio downsampling aborted');
  });

  it('returns an error result when the input is a symlink', async () => {
    const link = path.join(root, 'link.wav');
    await fs.symlink(inputPath, link);
    const { result } = await run({ inputPath: link });
    expect(result.error?.message).toMatch(/not a regular file/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it.each([
    ['relative inputPath', { inputPath: 'track.wav' }],
    ['unknown property', { loudness: 5 }],
    ['channels out of range', { channels: 3 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });
});
