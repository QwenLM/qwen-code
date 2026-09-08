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
import { GetAudioTool } from './get-audio.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const WAV = Buffer.alloc(320 * 1024, 3);

describe('GetAudioTool', () => {
  let root: string;
  let inputPath: string;

  const tool = new GetAudioTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  const writesWav = async (
    args: string[],
  ): Promise<{ code: number; stderr: string }> => {
    await fs.writeFile(args[args.length - 1], WAV);
    return { code: 0, stderr: '' };
  };

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const invocation = tool.build({
      inputPath,
      start: '00:10',
      end: '00:20',
      ...params,
    } as never);
    return invocation.execute(new AbortController().signal);
  };

  const summaryOf = (result: ToolResult): string =>
    ((result.llmContent as Part[])[0] as { text: string }).text;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-ga-'));
    inputPath = path.join(root, 'talk.mp4');
    await fs.writeFile(inputPath, Buffer.alloc(1024));
    probe({ durationMs: 600_000, hasAudioStream: true });
    mocks.runFfmpeg.mockImplementation(writesWav);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares a media-policy descriptor that owns no output', () => {
    expect(tool.name).toBe(ToolNames.GET_AUDIO);
    expect(tool.mediaPolicyDescriptor).toEqual({
      kind: 'media_policy',
      inputMediaTypes: ['video', 'audio'],
      outputs: [],
    });
    expect(tool.schema.parametersJsonSchema).toMatchObject({
      required: ['start', 'end'],
    });
    const properties = (
      tool.schema.parametersJsonSchema as { properties: object }
    ).properties;
    expect(properties).not.toHaveProperty('outputDir');
    // No quality knobs: the sample rate is fixed at what the audio encoder
    // expects, so there is nothing left for the model to get wrong.
    expect(properties).not.toHaveProperty('fps');
    expect(properties).not.toHaveProperty('resolution');
  });

  it('refuses a source with no audio track before any ffmpeg runs', async () => {
    // A silent file yields a valid silent WAV, and the model cannot tell
    // that apart from a segment where nobody happens to be speaking.
    probe({ durationMs: 600_000, hasAudioStream: false });
    const result = await run();
    expect(result.error?.message).toBe('talk.mp4 has no audio track');
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('proceeds when the probe reached no conclusion about the track', async () => {
    // `undefined` means the probe did not say, which is not the same as
    // "confirmed silent" — treating it as such would refuse valid files.
    probe({ durationMs: 600_000 });
    const result = await run();
    expect(result.error).toBeUndefined();
    expect(mocks.runFfmpeg).toHaveBeenCalledOnce();
  });

  it('delivers the segment as one audio part after one summary', async () => {
    const result = await run();
    const parts = result.llmContent as Part[];
    expect(parts).toHaveLength(2);
    expect(parts[1].inlineData?.mimeType).toBe('audio/wav');
    expect(parts[1].inlineData?.displayName).toMatch(/\.wav$/);
    expect(parts[1].inlineData?.data).toBe(WAV.toString('base64'));
  });

  it('names the encoding and anchors the segment timeline', async () => {
    const summary = await run().then(summaryOf);
    expect(summary).toContain('16kHz mono WAV');
    expect(summary).toContain('320KB');
    expect(summary).toContain('a moment at t in it is 00:10+t');
  });

  it('never tells the model to read a file back', async () => {
    const result = await run();
    expect(summaryOf(result)).not.toContain('read_file');
    expect(result.returnDisplay).not.toContain('read_file');
  });

  it('cuts exactly the requested span', async () => {
    await run({ start: '00:10', end: '00:20' });
    const args = mocks.runFfmpeg.mock.calls[0][0] as string[];
    expect(args[args.indexOf('-ss') + 1]).toBe('10.000');
    expect(args[args.indexOf('-t') + 1]).toBe('10.000');
  });

  it('says the window was cut short when the media ended first', async () => {
    probe({ durationMs: 15_000, hasAudioStream: true });
    const summary = await run({ start: '00:10', end: '00:20' }).then(summaryOf);
    expect(summary).toContain('The media ends at 00:15');
    expect(summary).toContain('cut short of the requested 00:20');
  });

  it('leaves nothing behind on disk', async () => {
    await run();
    expect(await fs.readdir(root)).toEqual(['talk.mp4']);
  });

  it('reports an ffmpeg failure without leaking the scratch path', async () => {
    mocks.runFfmpeg.mockResolvedValue({ code: 1, stderr: 'no such filter' });
    const result = await run();
    expect(result.error?.message).toMatch(/extracting audio from/);
    expect(result.error?.message).not.toContain(os.tmpdir());
  });

  it('fails without spawning ffmpeg when the input is missing', async () => {
    inputPath = path.join(root, 'gone.mp4');
    const result = await run();
    expect(result.error?.message).toMatch(/input file not found: gone\.mp4/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('rejects a malformed window at validation time', () => {
    expect(() =>
      tool.build({ inputPath, start: 'later', end: '00:20' } as never),
    ).toThrow(/invalid time/);
    expect(mocks.probeMediaMetadata).not.toHaveBeenCalled();
  });
});
