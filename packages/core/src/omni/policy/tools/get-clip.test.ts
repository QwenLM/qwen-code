/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import type { MediaProbeResult } from '../../ffmpeg.js';
import type { ToolResult } from '../../../tools/tools.js';
import { ToolNames } from '../../../tools/tool-names.js';
import { GetClipTool } from './get-clip.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const MP4 = Buffer.alloc(3 * 1024 * 1024, 7);

describe('GetClipTool', () => {
  let root: string;
  let inputPath: string;

  const tool = new GetClipTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const writesClip = async (
    args: string[],
  ): Promise<{ code: number; stderr: string }> => {
    await fs.writeFile(args[args.length - 1], MP4);
    return { code: 0, stderr: '' };
  };

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const invocation = tool.build({
      inputPath,
      start: '00:10',
      end: '00:20',
      fps: 2,
      ...params,
    } as never);
    return invocation.execute(new AbortController().signal);
  };

  const summaryOf = (result: ToolResult): string =>
    ((result.llmContent as Part[])[0] as { text: string }).text;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-gc-'));
    inputPath = path.join(root, 'clip.mp4');
    await fs.writeFile(inputPath, Buffer.alloc(1024));
    probe({ durationMs: 600_000, width: 1920, height: 1080 });
    mocks.runFfmpeg.mockImplementation(writesClip);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares a media-policy descriptor that owns no output', () => {
    expect(tool.name).toBe(ToolNames.GET_CLIP);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      inputMediaTypes: ['video'],
      outputs: [],
    });
    expect(tool.schema.parametersJsonSchema).toMatchObject({
      required: ['start', 'end', 'fps'],
    });
    expect(
      (tool.schema.parametersJsonSchema as { properties: object }).properties,
    ).not.toHaveProperty('outputDir');
  });

  it('delivers the clip as one video part after one summary', async () => {
    const result = await run();
    const parts = result.llmContent as Part[];
    expect(parts).toHaveLength(2);
    expect(parts[1].inlineData?.mimeType).toBe('video/mp4');
    expect(parts[1].inlineData?.displayName).toMatch(/\.mp4$/);
    expect(parts[1].inlineData?.data).toBe(MP4.toString('base64'));
  });

  it('promises the audio track and anchors the clip timeline', async () => {
    // A clip is only worth its bytes if the model knows the sound came
    // with it and how to map a moment back onto the source.
    const summary = await run().then(summaryOf);
    expect(summary).toContain('with its audio track');
    expect(summary).toContain('at 2fps');
    expect(summary).toContain('a moment at t in the clip is 00:10+t');
  });

  it('never tells the model to read a file back', async () => {
    const result = await run();
    expect(summaryOf(result)).not.toContain('read_file');
    expect(result.returnDisplay).not.toContain('read_file');
  });

  it('reports the delivered size and byte count', async () => {
    const summary = await run({ resolution: '480p' }).then(summaryOf);
    expect(summary).toContain('854×480');
    expect(summary).toContain('3MB');
  });

  it('passes the fps and long edge through to the filter chain', async () => {
    await run({ fps: 4, resolution: '360p' });
    const filters = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(filters[filters.indexOf('-vf') + 1]).toContain('fps=4');
    expect(filters[filters.indexOf('-vf') + 1]).toContain('640');
  });

  it('says the window was cut short when the media ended first', async () => {
    probe({ durationMs: 15_000, width: 640, height: 480 });
    const summary = await run({ start: '00:10', end: '00:20' }).then(summaryOf);
    expect(summary).toContain('The media ends at 00:15');
    expect(summary).toContain('cut short of the requested 00:20');
  });

  it('leaves nothing behind on disk', async () => {
    await run();
    expect(await fs.readdir(root)).toEqual(['clip.mp4']);
  });

  it('reports an ffmpeg failure without leaking the scratch path', async () => {
    mocks.runFfmpeg.mockResolvedValue({ code: 1, stderr: 'x264 exploded' });
    const result = await run();
    expect(result.error?.message).toMatch(/clipping/);
    expect(result.error?.message).not.toContain(os.tmpdir());
  });

  it('fails without spawning ffmpeg when the input is missing', async () => {
    inputPath = path.join(root, 'gone.mp4');
    const result = await run();
    expect(result.error?.message).toMatch(/input file not found: gone\.mp4/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('rejects a backwards window at validation time', () => {
    expect(() =>
      tool.build({ inputPath, start: '00:20', end: '00:10', fps: 1 } as never),
    ).toThrow(/must be after start/);
    expect(mocks.probeMediaMetadata).not.toHaveBeenCalled();
  });
});
