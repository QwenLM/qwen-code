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
  CLIP_VIDEO_DEFAULTS,
  OMNI_CLIP_VIDEO_TOOL_NAME,
  OmniClipVideoTool,
} from './clip-video.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const OUTPUT_SIZE = 900 * 1024;

describe('OmniClipVideoTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;

  const tool = new OmniClipVideoTool({});

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
    params: Record<string, unknown>,
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
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-cv-'));
    inputPath = path.join(root, 'clip.mp4');
    await fs.writeFile(inputPath, Buffer.alloc(1024));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
    ffmpegSucceeds();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and defaults', () => {
    expect(tool.name).toBe(OMNI_CLIP_VIDEO_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      // Bumped because clips now retain their source audio.
      version: '3',
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
      operatorOnlyParams: ['softClipBudget'],
    });
    expect(CLIP_VIDEO_DEFAULTS).toEqual({
      crf: 23,
      preset: 'veryfast',
    });
  });

  it('cuts [startSec, startSec+durationSec] with a frame-accurate re-encode', async () => {
    probe({ durationMs: 63_000 });
    const { result, signal } = await run({ startSec: 10, durationSec: 15 });

    expect(mocks.probeMediaMetadata).toHaveBeenCalledWith(
      inputPath,
      'video',
      signal,
    );
    const outputPath = path.join(outputDir, 'clip-clip-10s+15s.mp4');
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      [
        '-y',
        '-ss',
        '10',
        '-t',
        '15',
        '-i',
        inputPath,
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libx264',
        '-crf',
        '23',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outputPath,
      ],
      { signal, timeoutMs: DEFAULT_POLICY_TOOL_TIMEOUT_MS },
    );

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain(`Output file: ${outputPath}`);
    expect(result.llmContent).toContain('Use read_file');
    expect(result.artifacts).toEqual([
      {
        kind: 'video',
        storage: 'workspace',
        title: 'Clipped video',
        workspacePath: 'clip-clip-10s+15s.mp4',
        mimeType: 'video/mp4',
        sizeBytes: OUTPUT_SIZE,
        metadata: {
          omniDisclosure:
            '原 63s → 片段 [10s–25s] 15s，保留画面，源音轨如存在则一并保留，片段外内容全部丢弃',
          omniRole: 'clip',
        },
      },
    ]);
  });

  it('clips from startSec to the end when durationSec is absent', async () => {
    probe({ durationMs: 63_000 });
    const { result } = await run({ startSec: 10 });
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args).not.toContain('-t');
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 63s → 片段 [10s–63s] 53s，保留画面，源音轨如存在则一并保留，片段外内容全部丢弃',
    );
  });

  it('clamps the disclosed end to the video length', async () => {
    probe({ durationMs: 63_000 });
    const { result } = await run({ startSec: 50, durationSec: 100 });
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 63s → 片段 [50s–63s] 13s，保留画面，源音轨如存在则一并保留，片段外内容全部丢弃',
    );
  });

  it('discloses an unknown original duration without clamping', async () => {
    probe({});
    const { result } = await run({ startSec: 10, durationSec: 15 });
    expect(result.artifacts?.[0]?.metadata?.['omniDisclosure']).toBe(
      '原 未知时长 → 片段 [10s–25s] 15s，保留画面，源音轨如存在则一并保留，片段外内容全部丢弃',
    );
  });

  it('rejects a start at or beyond the end of the video without transcoding', async () => {
    probe({ durationMs: 63_000 });
    const { result } = await run({ startSec: 63 });
    expect(result.error?.message).toBe(
      'startSec (63s) is at or beyond the end of the video (63s)',
    );
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('reports the ffmpeg error', async () => {
    probe({ durationMs: 63_000 });
    mocks.runFfmpeg.mockResolvedValue({ code: 187, stderr: 'boom' });
    const { result } = await run({ startSec: 10 });
    expect(result.error?.message).toMatch(/ffmpeg failed \(exit 187\)/);
    expect(result.error?.message).toContain('boom');
  });

  it('reports an aborted run', async () => {
    probe({ durationMs: 63_000 });
    const controller = new AbortController();
    mocks.runFfmpeg.mockImplementation(async () => {
      controller.abort();
      return { code: 0, stderr: '' };
    });
    const invocation = tool.build({ inputPath, outputDir, startSec: 10 });
    const result = await invocation.execute(controller.signal);
    expect(result.error?.message).toBe('video clipping aborted');
  });

  it('threads policyTools.<tool>.runtime.timeoutMs into runFfmpeg', async () => {
    probe({ durationMs: 63_000 });
    const configured = new OmniClipVideoTool({
      getOmniPolicyToolsSettings: () => ({
        [OMNI_CLIP_VIDEO_TOOL_NAME]: {
          runtime: { timeoutMs: 120_000 },
        },
      }),
    });
    const invocation = configured.build({
      inputPath,
      outputDir,
      startSec: 10,
    });
    await invocation.execute(new AbortController().signal);
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('defaults a missing outputDir to the source video directory', async () => {
    probe({ durationMs: 63_000 });
    // No outputDir supplied — the model should not have to invent one.
    const invocation = tool.build({
      inputPath,
      startSec: 10,
      durationSec: 15,
    } as never);
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    // Written next to the source (root), NOT the staging dir the run() helper
    // would otherwise inject.
    const expectedPath = path.join(
      path.dirname(inputPath),
      'clip-clip-10s+15s.mp4',
    );
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      expect.arrayContaining([expectedPath]),
      expect.anything(),
    );
    expect(result.artifacts?.[0]).toMatchObject({
      workspacePath: 'clip-clip-10s+15s.mp4',
    });
  });

  it.each([
    ['both startSec and durationSec absent', {}],
    ['explicit startSec 0 without durationSec (no-op clip)', { startSec: 0 }],
    ['negative startSec', { startSec: -1 }],
    ['zero durationSec', { durationSec: 0 }],
    ['relative outputDir', { startSec: 10, outputDir: 'staging' }],
    ['unknown property', { startSec: 10, extra: 1 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });

  it('appends a clip-budget brake once the source hits the soft budget', async () => {
    probe({ durationMs: 630_000 });
    // Two clips of this source already on disk (same `<stem>-clip-` prefix);
    // the run below is the third, hitting the default budget of 3.
    await fs.writeFile(path.join(outputDir, 'clip-clip-1s+2s.mp4'), '');
    await fs.writeFile(path.join(outputDir, 'clip-clip-3s+4s.mp4'), '');
    const { result } = await run({ startSec: 300, durationSec: 15 });
    expect(result.error).toBeUndefined();
    expect(String(result.llmContent)).toContain('已对该视频切了 3 段');
    // The brake steers toward densify-locate, not more trial clips.
    expect(String(result.llmContent)).toContain('omni_extract_keyframes');
  });

  it('does not brake below the soft budget', async () => {
    probe({ durationMs: 630_000 });
    const { result } = await run({ startSec: 300, durationSec: 15 });
    expect(String(result.llmContent)).not.toContain('已对该视频切了');
  });

  it('honors an operator-provided soft clip budget', async () => {
    probe({ durationMs: 630_000 });
    const { result } = await run({
      startSec: 300,
      durationSec: 15,
      softClipBudget: 1,
    });
    expect(String(result.llmContent)).toContain('已对该视频切了 1 段');
  });

  it('rejects a probed full-span request without transcoding', async () => {
    // startSec 0 + a duration covering the whole video is a no-op clip:
    // nothing outside the span exists to discard, only re-encode damage.
    probe({ durationMs: 63_000 });
    const { result } = await run({ startSec: 0, durationSec: 63 });
    expect(result.error?.message).toMatch(/covers the entire video/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });
});
