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
  EXTRACT_KEYFRAMES_DEFAULTS,
  OMNI_EXTRACT_KEYFRAMES_TOOL_NAME,
  OmniExtractKeyframesTool,
  parseShowinfoTimestamps,
} from './extract-keyframes.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const FRAME_SIZE = 42 * 1024;

/** Realistic showinfo stderr lines, one per kept frame. */
const showinfoStderr = (times: number[]): string =>
  times
    .map(
      (t, i) =>
        `[Parsed_showinfo_2 @ 0x600] n:${String(i).padStart(4, ' ')} pts:  ${Math.round(t * 12800)} pts_time:${t}    pos: 99 fmt:yuvj420p`,
    )
    .join('\n');

describe('OmniExtractKeyframesTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;

  const tool = new OmniExtractKeyframesTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  /** One ffmpeg run: writes `count` frames from the %04d pattern and
   * emits matching showinfo stderr. */
  const framesRun =
    (count: number, times: number[]) =>
    async (args: string[]): Promise<{ code: number; stderr: string }> => {
      const pattern = args[args.length - 1];
      for (let i = 1; i <= count; i++) {
        await fs.writeFile(
          pattern.replace('%04d', String(i).padStart(4, '0')),
          Buffer.alloc(FRAME_SIZE),
        );
      }
      return { code: 0, stderr: showinfoStderr(times) };
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
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-kf-'));
    inputPath = path.join(root, 'clip.mp4');
    await fs.writeFile(inputPath, Buffer.alloc(1024));
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor and defaults', () => {
    expect(tool.name).toBe(OMNI_EXTRACT_KEYFRAMES_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['video'],
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
    expect(EXTRACT_KEYFRAMES_DEFAULTS).toEqual({
      maxFrames: 8,
      sceneThreshold: 0.2,
      maxDimension: 768,
    });
  });

  it('extracts scene-detected frames as one multi-artifact batch with per-frame disclosures', async () => {
    probe({ durationMs: 63_000, width: 1920, height: 1080 });
    mocks.runFfmpeg.mockImplementation(framesRun(3, [0, 12.4, 47]));
    const { result, signal } = await run();

    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      [
        '-y',
        '-i',
        inputPath,
        '-vf',
        "select='eq(n,0)+gt(scene,0.2)'," +
          "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease," +
          'showinfo',
        '-vsync',
        'vfr',
        '-frames:v',
        '8',
        '-q:v',
        '4',
        path.join(outputDir, 'keyframe_%04d.jpg'),
      ],
      { signal, timeoutMs: DEFAULT_POLICY_TOOL_TIMEOUT_MS },
    );

    expect(result.error).toBeUndefined();
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts?.[1]).toEqual({
      kind: 'image',
      storage: 'workspace',
      title: 'Keyframe 2/3',
      workspacePath: 'keyframe_0002.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: FRAME_SIZE,
      metadata: {
        omniDisclosure:
          '原视频 63s/1920×1080 → 关键帧 2/3 @ 12.4s，静态抽帧，时间连续性丢失',
      },
    });
    // Every artifact carries its OWN disclosure — the orchestrator
    // validates each lossy artifact independently.
    for (const artifact of result.artifacts ?? []) {
      expect(artifact.metadata?.['omniDisclosure']).toContain('静态抽帧');
    }
  });

  it('falls back to uniform sampling when scene detection yields a single frame', async () => {
    probe({ durationMs: 10_000, width: 640, height: 360 });
    mocks.runFfmpeg
      .mockImplementationOnce(framesRun(1, [0]))
      .mockImplementationOnce(framesRun(4, [0, 2.5, 5, 7.5]));
    const { result } = await run({ maxFrames: 4 });

    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(2);
    const secondArgs = mocks.runFfmpeg.mock.calls[1][0] as string[];
    expect(secondArgs.join(' ')).toContain('fps=0.4,');
    expect(secondArgs).not.toContain('-vsync');
    expect(result.error).toBeUndefined();
    expect(result.artifacts).toHaveLength(4);
    expect(result.artifacts?.[3]?.metadata?.['omniDisclosure']).toContain(
      '关键帧 4/4 @ 7.5s',
    );
  });

  it('charges the uniform fallback against the SAME wall-clock budget (no timeout doubling)', async () => {
    probe({ durationMs: 10_000, width: 640, height: 360 });
    mocks.runFfmpeg
      .mockImplementationOnce(async (args: string[]) => {
        // Burn measurable wall-clock time in the scene pass before it
        // yields a single frame (which triggers the uniform fallback).
        await new Promise((r) => setTimeout(r, 50));
        return framesRun(1, [0])(args);
      })
      .mockImplementationOnce(framesRun(4, [0, 2.5, 5, 7.5]));
    const { result } = await run({ maxFrames: 4 });

    expect(result.error).toBeUndefined();
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(2);
    const firstTimeout = (
      mocks.runFfmpeg.mock.calls[0][1] as { timeoutMs: number }
    ).timeoutMs;
    const secondTimeout = (
      mocks.runFfmpeg.mock.calls[1][1] as { timeoutMs: number }
    ).timeoutMs;
    expect(firstTimeout).toBe(DEFAULT_POLICY_TOOL_TIMEOUT_MS);
    // The fallback gets only what the scene pass left, never a fresh
    // full budget (timers never fire early, so ≥40ms must be gone).
    expect(secondTimeout).toBeLessThanOrEqual(
      DEFAULT_POLICY_TOOL_TIMEOUT_MS - 40,
    );
    expect(secondTimeout).toBeGreaterThan(0);
  });

  it('does not fall back when a single frame was all that was asked for', async () => {
    probe({ durationMs: 10_000 });
    mocks.runFfmpeg.mockImplementation(framesRun(1, [0]));
    const { result } = await run({ maxFrames: 1 });
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
    expect(result.artifacts).toHaveLength(1);
  });

  it('errors when no frames could be extracted at all', async () => {
    probe({ durationMs: 10_000 });
    mocks.runFfmpeg.mockResolvedValue({ code: 0, stderr: '' });
    const { result } = await run();
    expect(result.error?.message).toMatch(/no keyframes could be extracted/);
    expect(result.artifacts).toBeUndefined();
  });

  it('threads tunable overrides into the scene-pass args', async () => {
    probe({ durationMs: 63_000 });
    mocks.runFfmpeg.mockImplementation(framesRun(2, [0, 5]));
    await run({ maxFrames: 16, sceneThreshold: 0.5, maxDimension: 512 });
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args.join(' ')).toContain('gt(scene,0.5)');
    expect(args.join(' ')).toContain("'min(512,iw)':'min(512,ih)'");
    expect(args).toContain('16');
  });

  it('reports the ffmpeg error on a failed scene pass', async () => {
    probe({ durationMs: 63_000 });
    mocks.runFfmpeg.mockResolvedValue({ code: 187, stderr: 'boom' });
    const { result } = await run();
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
    const invocation = tool.build({ inputPath, outputDir });
    const result = await invocation.execute(controller.signal);
    expect(result.error?.message).toBe('keyframe extraction aborted');
  });

  it('threads policyTools.<tool>.runtime.timeoutMs into runFfmpeg', async () => {
    probe({ durationMs: 63_000 });
    mocks.runFfmpeg.mockImplementation(framesRun(2, [0, 5]));
    const configured = new OmniExtractKeyframesTool({
      getOmniPolicyToolsSettings: () => ({
        [OMNI_EXTRACT_KEYFRAMES_TOOL_NAME]: {
          runtime: { timeoutMs: 90_000 },
        },
      }),
    });
    const invocation = configured.build({ inputPath, outputDir });
    await invocation.execute(new AbortController().signal);
    expect(mocks.runFfmpeg).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 90_000 }),
    );
  });

  it.each([
    ['relative outputDir', { outputDir: 'staging' }],
    ['unknown property', { extra: 1 }],
    ['maxFrames above cap', { maxFrames: 200 }],
    ['sceneThreshold out of range', { sceneThreshold: 1.5 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });
});

describe('parseShowinfoTimestamps', () => {
  it('parses pts_time per frame in output order', () => {
    expect(parseShowinfoTimestamps(showinfoStderr([0, 12.4, 47]))).toEqual([
      0, 12.4, 47,
    ]);
  });

  it('ignores unrelated stderr noise', () => {
    const stderr = [
      'frame=    3 fps=0.0 q=4.0 size=N/A',
      showinfoStderr([1.5]),
      '[out#0/image2 @ 0x600] video:126KiB',
    ].join('\n');
    expect(parseShowinfoTimestamps(stderr)).toEqual([1.5]);
  });

  it('returns an empty array when showinfo produced nothing', () => {
    expect(parseShowinfoTimestamps('Conversion failed!')).toEqual([]);
  });
});
