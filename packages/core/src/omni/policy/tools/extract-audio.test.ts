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
  EXTRACT_AUDIO_DEFAULTS,
  OMNI_EXTRACT_AUDIO_TOOL_NAME,
  OmniExtractAudioTool,
} from './extract-audio.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const INPUT_SIZE = 2 * 1024 ** 2; // "2MB"
const OUTPUT_SIZE = 500 * 1024; // "500KB"

describe('OmniExtractAudioTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;

  const tool = new OmniExtractAudioTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const ffmpegSucceeds = (): void => {
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args[args.length - 1], Buffer.alloc(OUTPUT_SIZE));
      return { code: 0, stderr: '' };
    });
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
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-xa-'));
    inputPath = path.join(root, 'clip.mp4');
    await fs.writeFile(inputPath, Buffer.alloc(INPUT_SIZE));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    ffmpegSucceeds();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and defaults', () => {
    expect(tool.name).toBe(OMNI_EXTRACT_AUDIO_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['video'],
      outputs: [
        {
          kind: 'media',
          mimeTypes: ['audio/wav', 'audio/mpeg', 'audio/mp4'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
    });
    expect(EXTRACT_AUDIO_DEFAULTS).toEqual({
      format: 'wav',
      sampleRateHz: 16_000,
      channels: 1,
      bitrateKbps: 64,
    });
  });

  it('extracts a 16kHz mono WAV by default (ASR-recommended shape)', async () => {
    probe({ durationMs: 63_000 });
    const { result, signal } = await run();

    expect(mocks.probeMediaMetadata).toHaveBeenCalledWith(
      inputPath,
      'video',
      signal,
    );
    const outputPath = path.join(outputDir, 'clip-audio.wav');
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      [
        '-y',
        '-i',
        inputPath,
        '-vn',
        '-c:a',
        'pcm_s16le',
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
        title: 'Extracted audio track',
        workspacePath: 'clip-audio.wav',
        mimeType: 'audio/wav',
        sizeBytes: OUTPUT_SIZE,
        metadata: {
          omniDisclosure:
            '原视频 63s/2MB → 音轨 WAV/16kHz 单声道，视觉信息全部丢弃',
        },
      },
    ]);
  });

  it('encodes MP3 with the bit rate when format=mp3', async () => {
    probe({ durationMs: 63_000 });
    const { result } = await run({ format: 'mp3', bitrateKbps: 128 });
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args.join(' ')).toContain('-c:a libmp3lame -b:a 128k');
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'clip-audio.mp3',
      mimeType: 'audio/mpeg',
    });
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toContain(
      '音轨 MP3/',
    );
  });

  it('encodes AAC in m4a when format=m4a', async () => {
    probe({ durationMs: 63_000 });
    const { result } = await run({ format: 'm4a' });
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args.join(' ')).toContain('-c:a aac -b:a 64k');
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'clip-audio.m4a',
      mimeType: 'audio/mp4',
    });
  });

  it('omits the duration from the disclosure when the probe lacks it', async () => {
    probe({});
    const { result } = await run();
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原视频 2MB → 音轨 WAV/16kHz 单声道，视觉信息全部丢弃',
    );
  });

  it('reports the ffmpeg error (e.g. a video without an audio stream)', async () => {
    probe({ durationMs: 63_000 });
    mocks.runFfmpeg.mockResolvedValue({
      code: 1,
      stderr: 'Output file #0 does not contain any stream',
    });
    const { result } = await run();
    expect(result.error?.message).toMatch(/ffmpeg failed \(exit 1\)/);
    expect(result.error?.message).toContain('does not contain any stream');
    expect(result.artifacts).toBeUndefined();
  });

  it('reports an aborted run', async () => {
    probe({ durationMs: 63_000 });
    const controller = new AbortController();
    mocks.runFfmpeg.mockImplementation(async () => {
      controller.abort();
      return { code: 1, stderr: '' };
    });
    const invocation = tool.build({ inputPath, outputDir });
    const result = await invocation.execute(controller.signal);
    expect(result.error?.message).toBe('audio extraction aborted');
  });

  it('threads policyTools.<tool>.runtime.timeoutMs into runFfmpeg', async () => {
    probe({ durationMs: 63_000 });
    const configured = new OmniExtractAudioTool({
      getOmniPolicyToolsSettings: () => ({
        [OMNI_EXTRACT_AUDIO_TOOL_NAME]: {
          runtime: { timeoutMs: 45_000 },
        },
      }),
    });
    const invocation = configured.build({ inputPath, outputDir });
    await invocation.execute(new AbortController().signal);
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 45_000 }),
    );
  });

  it.each([
    ['relative outputDir', { outputDir: 'staging' }],
    ['unknown property', { extra: 1 }],
    ['unknown format', { format: 'flac' }],
    ['sample rate below floor', { sampleRateHz: 4000 }],
    ['too many channels', { channels: 6 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });
});
