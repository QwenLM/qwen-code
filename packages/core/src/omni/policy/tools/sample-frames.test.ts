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
import { SampleFramesTool } from './sample-frames.js';

const mocks = vi.hoisted(() => ({
  probeMediaMetadata: vi.fn(),
  runFfmpeg: vi.fn(),
}));

vi.mock('../../ffmpeg.js', () => ({
  probeMediaMetadata: mocks.probeMediaMetadata,
  runFfmpeg: mocks.runFfmpeg,
}));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('SampleFramesTool', () => {
  let root: string;
  let inputPath: string;

  const tool = new SampleFramesTool({});

  const probe = (result: Partial<MediaProbeResult>): void => {
    mocks.probeMediaMetadata.mockResolvedValue(result as MediaProbeResult);
  };

  /** ffmpeg that writes a JPEG at the last arg (the output path). */
  const writesFrame = async (
    args: string[],
  ): Promise<{ code: number; stderr: string }> => {
    await fs.writeFile(args[args.length - 1], JPEG);
    return { code: 0, stderr: '' };
  };

  /** ffmpeg that fails for the seeks whose `-ss` value is in `at`. */
  const failsAt =
    (at: string[]) =>
    async (args: string[]): Promise<{ code: number; stderr: string }> => {
      const ss = args[args.indexOf('-ss') + 1];
      if (at.includes(ss)) return { code: 1, stderr: 'seek failed' };
      return writesFrame(args);
    };

  const run = async (
    params: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    const invocation = tool.build({
      inputPath,
      start: '00:10',
      end: '00:15',
      fps: 1,
      ...params,
    } as never);
    return invocation.execute(new AbortController().signal);
  };

  const partsOf = (result: ToolResult): Part[] =>
    (result.llmContent as Part[]).slice(1);

  const summaryOf = (result: ToolResult): string =>
    ((result.llmContent as Part[])[0] as { text: string }).text;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-sf-'));
    inputPath = path.join(root, 'clip.mp4');
    await fs.writeFile(inputPath, Buffer.alloc(1024));
    probe({ durationMs: 600_000, width: 1920, height: 1080 });
    mocks.runFfmpeg.mockImplementation(writesFrame);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('declares a media-policy descriptor that owns no output', () => {
    expect(tool.name).toBe(ToolNames.SAMPLE_FRAMES);
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

  it('delivers one media part per frame alongside one summary', async () => {
    const result = await run({ start: '00:10', end: '00:15', fps: 1 });
    const frames = partsOf(result).filter((p) => p.inlineData !== undefined);
    expect(frames).toHaveLength(5);
    for (const part of frames) {
      expect(part.inlineData?.mimeType).toBe('image/jpeg');
      expect(part.inlineData?.data).toBe(JPEG.toString('base64'));
      expect(part.inlineData?.displayName).toMatch(/\.jpg$/);
    }
    expect(summaryOf(result)).toContain('Sampled 5 frame(s) of clip.mp4');
  });

  it('puts each timestamp immediately before its own frame', async () => {
    // Adjacency is the binding the whole delivery path preserves; a label
    // that drifted away from its frame would be flattened into the summary
    // string and leave the picture anonymous. Samples sit at slice
    // midpoints, hence 10.5s…14.5s for a 5-frame 10–15s window.
    const result = await run({ start: '00:10', end: '00:15', fps: 1 });
    const parts = partsOf(result);
    expect(parts).toHaveLength(10);
    const labels = [
      '<00:10.5>',
      '<00:11.5>',
      '<00:12.5>',
      '<00:13.5>',
      '<00:14.5>',
    ];
    labels.forEach((label, index) => {
      expect(parts[index * 2]).toEqual({ text: label });
      expect(parts[index * 2 + 1].inlineData?.mimeType).toBe('image/jpeg');
    });
    // The summary carries no enumeration to join against — it says where
    // the timestamps are instead.
    expect(summaryOf(result)).not.toContain('00:10.5');
    expect(summaryOf(result)).toContain('tagged with its own <timestamp>');
  });

  it('never tells the model to read a file back', async () => {
    // The file-writing policy tools close with "Use read_file with this
    // absolute path"; inheriting that sentence here would be a bug.
    const result = await run();
    expect(summaryOf(result)).not.toContain('read_file');
    expect(result.returnDisplay).not.toContain('read_file');
  });

  it('reports the dimensions the scale filter actually produces', async () => {
    probe({ durationMs: 600_000, width: 1920, height: 1080 });
    expect(await run({ resolution: '360p' }).then(summaryOf)).toContain(
      'delivered at 640×360',
    );
  });

  it('defaults to the normal tier when no resolution was asked for', async () => {
    // ~128 visual tokens on a 16:9 source, which is what the schema
    // promises the omitted case costs.
    expect(await run().then(summaryOf)).toContain('delivered at 480×270');
  });

  it('spends a tier against the probed shape, not a fixed long edge', async () => {
    probe({ durationMs: 600_000, width: 1080, height: 1080 });
    expect(await run({ resolution: 'normal' }).then(summaryOf)).toContain(
      'delivered at 352×352',
    );
  });

  it('enumerates the frames that failed instead of dropping them', async () => {
    mocks.runFfmpeg.mockImplementation(failsAt(['12.500', '14.500']));
    const summary = await run({ start: '00:10', end: '00:15', fps: 1 }).then(
      summaryOf,
    );
    expect(summary).toContain('Sampled 3 frame(s)');
    expect(summary).toContain('2 of 5 frames failed and were not delivered');
    expect(summary).toContain('00:12.5 (ffmpeg exited 1)');
    expect(summary).toContain('00:14.5 (ffmpeg exited 1)');
  });

  it('labels the surviving frames with their own timestamps after a failure', async () => {
    mocks.runFfmpeg.mockImplementation(failsAt(['12.500', '14.500']));
    const parts = partsOf(await run({ start: '00:10', end: '00:15', fps: 1 }));
    // A missing frame takes its label with it: what is delivered stays
    // correctly paired instead of shifting onto the wrong picture.
    expect(
      parts.filter((p) => p.text !== undefined).map((p) => p.text),
    ).toEqual(['<00:10.5>', '<00:11.5>', '<00:13.5>']);
  });

  it('says the window was cut short when the media ended first', async () => {
    probe({ durationMs: 12_000, width: 640, height: 480 });
    const summary = await run({ start: '00:10', end: '00:20', fps: 1 }).then(
      summaryOf,
    );
    expect(summary).toContain('The media ends at 00:12');
    expect(summary).toContain('cut short of the requested 00:20');
  });

  it('caps the frame count instead of honouring a huge window', async () => {
    const result = await run({ start: '0', end: '600', fps: 1 });
    const parts = partsOf(result);
    expect(parts.filter((p) => p.inlineData !== undefined)).toHaveLength(64);
    expect(parts).toHaveLength(128);
  });

  it('leaves nothing behind on disk', async () => {
    await run();
    // Every produced file lived in a scratch dir removed before the call
    // returned; the tool owns no output directory at all.
    expect(await fs.readdir(root)).toEqual(['clip.mp4']);
  });

  it('fails without spawning ffmpeg when the input is missing', async () => {
    inputPath = path.join(root, 'gone.mp4');
    const result = await run();
    expect(result.error?.message).toMatch(/input file not found: gone\.mp4/);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('reports an out-of-range window without leaking the path', async () => {
    probe({ durationMs: 5_000 });
    const result = await run({ start: '00:10', end: '00:15' });
    expect(result.error?.message).toMatch(/at or beyond the end of the media/);
    expect(result.error?.message).not.toContain(root);
    expect(mocks.runFfmpeg).not.toHaveBeenCalled();
  });

  it('reports why no frame could be produced', async () => {
    mocks.runFfmpeg.mockResolvedValue({ code: 1, stderr: 'boom' });
    const result = await run();
    expect(result.error?.message).toMatch(
      /no frames could be sampled from clip\.mp4 .*ffmpeg exited 1/,
    );
  });

  it('rejects a malformed window at validation time', () => {
    expect(() =>
      tool.build({ inputPath, start: '0:90', end: '02:00', fps: 1 } as never),
    ).toThrow(/under 60/);
    expect(mocks.probeMediaMetadata).not.toHaveBeenCalled();
  });
});
