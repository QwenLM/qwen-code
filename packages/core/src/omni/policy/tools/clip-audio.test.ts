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
import { OMNI_CLIP_AUDIO_TOOL_NAME, OmniClipAudioTool } from './clip-audio.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

describe('OmniClipAudioTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;

  const tool = new OmniClipAudioTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const invocation = tool.build({
      inputPath,
      outputDir,
      startMs: 1500,
      durationMs: 4000,
      ...params,
    } as never);
    return invocation.execute(new AbortController().signal);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-clip-aud-'));
    inputPath = path.join(root, 'podcast.mp3');
    await fs.writeFile(inputPath, Buffer.alloc(1024 * 1024));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    // The ffmpeg mock must actually produce the output file the tool
    // stats afterwards.
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args[args.length - 1], Buffer.alloc(64 * 1024));
      return { code: 0, stderr: '' };
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor with audio outputs', () => {
    expect(tool.name).toBe(OMNI_CLIP_AUDIO_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['audio'],
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
  });

  it('cuts the span with input-side seek and an m4a re-encode by default', async () => {
    probe({ durationMs: 60_000 });
    const result = await run();

    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
    const [args] = mocks.runFfmpeg.mock.calls[0] as [string[], unknown];
    expect(args).toEqual([
      '-y',
      '-ss',
      '1.500',
      '-t',
      '4.000',
      '-i',
      inputPath,
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      path.join(outputDir, 'podcast-clip-1500ms+4000ms.m4a'),
    ]);

    expect(result.error).toBeUndefined();
    const artifact = result.artifacts?.[0];
    expect(artifact).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/mp4',
      workspacePath: 'podcast-clip-1500ms+4000ms.m4a',
      metadata: { omniRole: 'clip' },
    });
    expect(artifact?.metadata?.['omniDisclosure']).toBe(
      '原 60s → 片段 [1.5s–5.5s] 4s M4A，片段外内容全部丢弃',
    );
  });

  it('cuts to the end when durationMs is omitted', async () => {
    probe({ durationMs: 60_000 });
    const result = await run({ durationMs: undefined, startMs: 5000 });
    const [args] = mocks.runFfmpeg.mock.calls[0] as [string[], unknown];
    expect(args).toContain('-ss');
    expect(args).not.toContain('-t');
    expect(result.artifacts?.[0]?.workspacePath).toBe(
      'podcast-clip-5000ms-end.m4a',
    );
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 60s → 片段 [5s–60s] 55s M4A，片段外内容全部丢弃',
    );
  });

  it('honors the wav format (PCM, no bitrate args)', async () => {
    probe({ durationMs: 60_000 });
    const result = await run({ format: 'wav' });
    const [args] = mocks.runFfmpeg.mock.calls[0] as [string[], unknown];
    expect(args).toContain('pcm_s16le');
    expect(args.join(' ')).not.toContain('-b:a');
    expect(result.artifacts?.[0]?.workspacePath).toMatch(/\.wav$/);
  });

  it('rejects a start beyond the end of the audio', async () => {
    probe({ durationMs: 10_000 });
    const result = await run({ startMs: 10_000 });
    expect(result.error?.message).toMatch(/at or beyond the end/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('rejects a full-span no-op clip', async () => {
    probe({ durationMs: 5000 });
    const result = await run({ startMs: 0, durationMs: 5000 });
    expect(result.error?.message).toMatch(/no-op/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('surfaces ffmpeg failures with the stderr tail', async () => {
    probe({ durationMs: 60_000 });
    mocks.runFfmpeg.mockResolvedValue({ code: 1, stderr: 'boom'.repeat(200) });
    const result = await run();
    expect(result.error?.message).toMatch(/ffmpeg failed \(exit 1\) clipping/);
  });

  it('returns an error result when the input file is missing', async () => {
    await fs.rm(inputPath);
    const result = await run();
    expect(result.error?.message).toMatch(/input file not found/);
  });

  it.each([
    ['no span at all', { startMs: undefined, durationMs: undefined }],
    ['zero start without duration', { startMs: 0, durationMs: undefined }],
    ['sub-second duration', { durationMs: 500 }],
    ['unknown property', { extra: 1 }],
  ])('build rejects %s', (_label, overrides) => {
    const cleaned = Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    );
    expect(() =>
      tool.build({ inputPath, outputDir, ...cleaned } as never),
    ).toThrow();
  });
});
