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
  OMNI_UNDERSTAND_VIDEO_SEGMENTS_TOOL_NAME,
  OmniUnderstandVideoSegmentsTool,
  UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS,
} from './understand-video-segments.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

/** ISO BMFF header (ftypisom) — sniffs as video/mp4. */
const MP4_BYTES = Buffer.concat([
  Buffer.alloc(4),
  Buffer.from('ftypisom', 'latin1'),
  Buffer.alloc(1024),
]);

const sse = (...contents: string[]): string =>
  contents
    .map(
      (c) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`,
    )
    .concat(['data: [DONE]'])
    .join('\n\n') + '\n';

describe('OmniUnderstandVideoSegmentsTool', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let savedKey: string | undefined;

  const tool = new OmniUnderstandVideoSegmentsTool();

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const fetchReturnsSse = (...contents: string[]): void => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(sse(...contents)),
    });
  };

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const invocation = tool.build({ inputPath, outputDir, ...params } as never);
    return invocation.execute(new AbortController().signal);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchReturnsSse('一名男子在厨房切菜。');
    savedKey = process.env[UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.apiKeyEnv];
    process.env[UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.apiKeyEnv] = 'test-key';

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-uvs-'));
    inputPath = path.join(root, 'movie.mp4');
    await fs.writeFile(inputPath, MP4_BYTES);
    outputDir = path.join(root, 'staging');
    await fs.mkdir(outputDir);

    // The ffmpeg mock must actually produce the segment file the tool
    // reads afterwards.
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args[args.length - 1], Buffer.alloc(64 * 1024));
      return { code: 0, stderr: '' };
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) {
      delete process.env[UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.apiKeyEnv];
    } else {
      process.env[UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.apiKeyEnv] = savedKey;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares the media-policy descriptor with a summary text output', () => {
    expect(tool.name).toBe(OMNI_UNDERSTAND_VIDEO_SEGMENTS_TOOL_NAME);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      version: '1',
      inputMediaTypes: ['video'],
      outputs: [
        {
          kind: 'file',
          role: 'summary',
          mimeTypes: ['text/plain'],
          required: true,
          lossy: true,
        },
        { kind: 'text', role: 'disclosure', required: true },
      ],
      settingsSchema: expect.objectContaining({ type: 'object' }),
      operatorOnlyParams: ['baseUrl', 'apiKeyEnv'],
    });
  });

  it('understands a short video as one segment with a video_url part', async () => {
    probe({ durationMs: 12_000 });
    const result = await run();

    // One cut, one request. The single segment is also the FINAL one,
    // so its length is clamped to the probed duration (+ slack).
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(1);
    const [cutArgs] = mocks.runFfmpeg.mock.calls[0] as [string[], unknown];
    expect(cutArgs[1]).toBe('-ss');
    expect(cutArgs[2]).toBe('0.000');
    expect(cutArgs[4]).toBe('12.250');
    expect(cutArgs.join(' ')).toContain('libx264');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    const content = body.messages[0].content;
    expect(content[0].type).toBe('video_url');
    expect(content[0].video_url.url).toMatch(/^data:video\/mp4;base64,/);
    expect(content[1].text).toBe(UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.prompt);

    expect(result.error).toBeUndefined();
    const artifact = result.artifacts?.[0];
    expect(artifact).toMatchObject({
      kind: 'file',
      mimeType: 'text/plain',
      metadata: { omniRole: 'summary' },
    });
    const written = await fs.readFile(
      path.join(outputDir, artifact?.workspacePath as string),
      'utf-8',
    );
    expect(written).toBe('[00:00-00:12] 一名男子在厨房切菜。');
    expect(artifact?.metadata?.['omniDisclosure']).toContain('分 1 段');
  });

  it('splits long videos into fixed-length segments with time labels', async () => {
    probe({ durationMs: 75_000 });
    const result = await run({ segmentSeconds: 30 });

    // ceil(75/30) = 3 segments: [0-30) [30-60) [60-75].
    expect(mocks.runFfmpeg).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const secondCut = mocks.runFfmpeg.mock.calls[1] as [string[], unknown];
    expect(secondCut[0][2]).toBe('30.000');
    // Final segment is clamped to the probed duration (+ slack).
    const thirdCut = mocks.runFfmpeg.mock.calls[2] as [string[], unknown];
    expect(thirdCut[0][2]).toBe('60.000');
    expect(thirdCut[0][4]).toBe('15.250');

    const artifact = result.artifacts?.[0];
    const written = await fs.readFile(
      path.join(outputDir, artifact?.workspacePath as string),
      'utf-8',
    );
    expect(written.split('\n')).toEqual([
      '[00:00-00:30] 一名男子在厨房切菜。',
      '[00:30-01:00] 一名男子在厨房切菜。',
      '[01:00-01:15] 一名男子在厨房切菜。',
    ]);
  });

  it('marks failed segments inline instead of failing the run', async () => {
    probe({ durationMs: 75_000 });
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('secret-trace'),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(sse('好。')),
      });
    const result = await run({ segmentSeconds: 30, maxParallelSegments: 1 });

    expect(result.error).toBeUndefined();
    const artifact = result.artifacts?.[0];
    const written = await fs.readFile(
      path.join(outputDir, artifact?.workspacePath as string),
      'utf-8',
    );
    expect(written).toContain('（该段理解失败：HTTP 500）');
    expect(written).not.toContain('secret-trace');
    expect(artifact?.metadata?.['omniDisclosure']).toContain('1 段失败');
  });

  it('fails the run when every segment fails', async () => {
    probe({ durationMs: 40_000 });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(''),
    });
    const result = await run({ segmentSeconds: 30 });
    expect(result.error?.message).toMatch(/failed for all 2 segments/);
  });

  it('marks segments exceeding the byte ceiling as failed', async () => {
    probe({ durationMs: 40_000 });
    // Two segments; the second re-encodes small enough to pass the
    // ceiling, so the run succeeds with the first segment marked inline.
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      const out = args[args.length - 1];
      const small = out.includes('segment_0002');
      await fs.writeFile(out, Buffer.alloc(small ? 512 : 64 * 1024));
      return { code: 0, stderr: '' };
    });
    const result = await run({ segmentSeconds: 30, maxSegmentBytes: 1024 });
    expect(result.error).toBeUndefined();
    const artifact = result.artifacts?.[0];
    const written = await fs.readFile(
      path.join(outputDir, artifact?.workspacePath as string),
      'utf-8',
    );
    expect(written).toContain('超过 1024 上限');
    expect(written).toContain('一名男子在厨房切菜。');
    // Only the passing segment hit the model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('errors when the duration cannot be determined', async () => {
    probe({});
    const result = await run();
    expect(result.error?.message).toMatch(/duration could not be determined/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('fails closed on an implausible claimed duration', async () => {
    probe({ durationMs: 512 * 30 * 1000 + 1 });
    const result = await run({ segmentSeconds: 30 });
    expect(result.error?.message).toMatch(/segment ceiling/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('errors when the API key env var is unset', async () => {
    delete process.env[UNDERSTAND_VIDEO_SEGMENTS_DEFAULTS.apiKeyEnv];
    const result = await run();
    expect(result.error?.message).toMatch(/DASHSCOPE_API_KEY is not set/);
  });

  it.each([
    ['relative outputDir', { outputDir: 'staging' }],
    ['unknown property', { extra: 1 }],
    ['segmentSeconds below the design floor', { segmentSeconds: 4 }],
    ['segmentSeconds above the design ceiling', { segmentSeconds: 61 }],
    ['maxParallelSegments over the locked cap', { maxParallelSegments: 9 }],
  ])('build rejects %s', (_label, overrides) => {
    expect(() =>
      tool.build({ inputPath, outputDir, ...overrides } as never),
    ).toThrow();
  });
});
