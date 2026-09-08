/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_SEGMENT_DEFAULTS,
  CLIP_SEGMENT_DEFAULTS,
  extractAudioSegment,
  extractClipSegment,
  formatClockLabel,
  formatFfmpegSeconds,
  parseClockTime,
  parseResolution,
  sampleFramesUniform,
  scaleFilter,
} from './media-extraction.js';

const mocks = vi.hoisted(() => ({
  runFfmpeg: vi.fn(),
}));

vi.mock('./ffmpeg.js', () => ({
  runFfmpeg: mocks.runFfmpeg,
}));

describe('parseClockTime', () => {
  it.each([
    ['0', 0],
    ['123', 123],
    ['12.5', 12.5],
    ['02:03', 123],
    ['2:03.250', 123.25],
    ['01:02:03', 3723],
    ['0:00:07', 7],
  ])('parses %s', (raw, expected) => {
    expect(parseClockTime(raw)).toBeCloseTo(expected, 6);
  });

  it('accepts surrounding whitespace', () => {
    expect(parseClockTime('  01:00  ')).toBe(60);
  });

  it.each(['', 'abc', '1:2:3:4', '-5', '1:2.5:3', '01:xx', '1e3'])(
    'rejects %s',
    (raw) => {
      expect(() => parseClockTime(raw)).toThrow(/invalid time/);
    },
  );

  it('rejects an out-of-range field in colon form instead of guessing', () => {
    expect(() => parseClockTime('0:90')).toThrow(/under 60/);
    expect(() => parseClockTime('1:75:00')).toThrow(/under 60/);
  });

  it('echoes the value it received', () => {
    expect(() => parseClockTime('half past two')).toThrow(/"half past two"/);
  });
});

describe('parseResolution', () => {
  it.each([
    ['low', 320],
    ['normal', 480],
    ['high', 832],
    ['HIGH', 832],
    ['240p', 426],
    ['360p', 640],
    ['480p', 854],
    ['720p', 1280],
    ['1080p', 1920],
    ['720P', 1280],
    ['768', 768],
    ['1280x720', 1280],
    ['720x1280', 1280],
    ['1280 × 720', 1280],
  ])('parses %s', (raw, expected) => {
    expect(parseResolution(raw)).toBe(expected);
  });

  it.each(['', 'small', 'tiny p', '720p HD', 'x720'])('rejects %s', (raw) => {
    expect(() => parseResolution(raw)).toThrow(/invalid resolution/);
  });

  it.each(['16', '0x10', '99999'])('rejects out-of-range %s', (raw) => {
    expect(() => parseResolution(raw)).toThrow(/out of range/);
  });

  it('rejects an unknown ladder rung rather than reading it as a number', () => {
    expect(() => parseResolution('4320p')).toThrow(/invalid resolution/);
  });

  // A tier promises a per-frame token count, and tokens are area — so the
  // long edge that spends the budget has to follow the source's shape. A
  // fixed number per tier would overspend on wide sources and underspend on
  // tall ones, which is exactly what the tool description would then be
  // lying about.
  it.each([
    ['low', 1920, 1080, 320],
    ['normal', 1920, 1080, 480],
    ['high', 1920, 1080, 832],
    ['low', 720, 720, 256],
    ['normal', 720, 720, 352],
    ['high', 720, 720, 640],
    ['normal', 640, 480, 416],
  ])('spends %s on a %ix%i source', (raw, width, height, expected) => {
    expect(parseResolution(String(raw), { width, height })).toBe(expected);
  });

  it('holds the token budget across aspect ratios', () => {
    const tokens = (longEdge: number, width: number, height: number) => {
      const factor = Math.min(1, longEdge / Math.max(width, height));
      return Math.round(
        (Math.round(width * factor) * Math.round(height * factor)) / 1024,
      );
    };
    for (const [width, height] of [
      [1920, 1080],
      [720, 720],
      [640, 480],
      [1080, 1920],
    ]) {
      const source = { width, height };
      expect(
        tokens(parseResolution('normal', source), width, height),
      ).toBeGreaterThan(96);
      expect(
        tokens(parseResolution('normal', source), width, height),
      ).toBeLessThan(160);
    }
  });

  it('falls back to a 16:9 shape when the source was not probed', () => {
    expect(parseResolution('normal', { width: undefined })).toBe(480);
    expect(parseResolution('normal')).toBe(480);
  });
});

describe('formatting helpers', () => {
  it('formats ffmpeg seconds as fixed point', () => {
    expect(formatFfmpegSeconds(0.0000001)).toBe('0.000');
    expect(formatFfmpegSeconds(1234.5678)).toBe('1234.568');
  });

  it('formats clock labels', () => {
    expect(formatClockLabel(62, false)).toBe('01:02');
    expect(formatClockLabel(3723, true)).toBe('1:02:03');
    expect(formatClockLabel(-1, false)).toBe('00:00');
  });

  it('keeps a fractional instant out of the neighbouring second', () => {
    expect(formatClockLabel(10.5, false)).toBe('00:10.5');
    expect(formatClockLabel(10.53, false)).toBe('00:10.5');
    expect(formatClockLabel(59.97, false)).toBe('01:00');
    expect(formatClockLabel(3599.95, true)).toBe('1:00:00');
  });

  it('never upscales in the scale filter', () => {
    expect(scaleFilter(768)).toBe(
      "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
    );
  });
});

describe('sampleFramesUniform', () => {
  let root: string;
  let inputPath: string;
  let outputDir: string;

  const options = (overrides: Record<string, unknown> = {}) => ({
    inputPath,
    outputDir,
    windowStartSec: 0,
    windowEndSec: 12,
    fps: 1,
    maxFrames: 64,
    scaleVf: scaleFilter(768),
    fileNameFor: (index: number) =>
      `frame-${String(index).padStart(4, '0')}.jpg`,
    remainingTimeoutMs: () => 60_000,
    signal: new AbortController().signal,
    ...overrides,
  });

  /** Mock ffmpeg: writes the file named by the last argument. */
  const writesOutput = () => {
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args[args.length - 1], 'jpg');
      return { code: 0, stderr: '' };
    });
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-extraction-'));
    inputPath = path.join(root, 'clip.mp4');
    outputDir = path.join(root, 'out');
    await fs.writeFile(inputPath, 'mp4');
    await fs.mkdir(outputDir);
    mocks.runFfmpeg.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('samples window × fps frames at slice midpoints', async () => {
    writesOutput();
    const result = await sampleFramesUniform(options());
    expect(result.requested).toBe(12);
    expect(result.failures).toEqual([]);
    expect(result.frames.map((f) => f.index)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(result.frames.map((f) => f.timeSeconds)).toEqual([
      0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5,
    ]);
    expect(result.frames[0].filePath).toBe(
      path.join(outputDir, 'frame-0001.jpg'),
    );
  });

  it('floors the frame count and clamps it to maxFrames', async () => {
    writesOutput();
    expect((await sampleFramesUniform(options({ fps: 0.7 }))).requested).toBe(
      8,
    );
    expect(
      (await sampleFramesUniform(options({ fps: 4, maxFrames: 6 }))).requested,
    ).toBe(6);
  });

  it('always asks for at least one frame', async () => {
    writesOutput();
    const result = await sampleFramesUniform(
      options({ windowEndSec: 0.4, fps: 1 }),
    );
    expect(result.requested).toBe(1);
    expect(result.frames).toHaveLength(1);
  });

  it('seeks inside the window only', async () => {
    writesOutput();
    await sampleFramesUniform(
      options({ windowStartSec: 100, windowEndSec: 102, fps: 1 }),
    );
    const seeks = mocks.runFfmpeg.mock.calls.map(
      (call) => (call[0] as string[])[2],
    );
    expect(seeks).toEqual(['100.500', '101.500']);
  });

  it('reports failed frames instead of dropping them', async () => {
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      const outputPath = args[args.length - 1];
      if (outputPath.endsWith('0002.jpg')) return { code: 1, stderr: 'boom' };
      if (outputPath.endsWith('0003.jpg')) return { code: 0, stderr: '' };
      await fs.writeFile(outputPath, 'jpg');
      return { code: 0, stderr: '' };
    });
    const result = await sampleFramesUniform(options({ windowEndSec: 4 }));
    expect(result.requested).toBe(4);
    expect(result.frames.map((f) => f.index)).toEqual([1, 4]);
    expect(result.failures).toEqual([
      { index: 2, timeSeconds: 1.5, reason: 'ffmpeg exited 1' },
      { index: 3, timeSeconds: 2.5, reason: 'ffmpeg wrote no output' },
    ]);
  });

  it('keeps failure reasons free of ffmpeg stderr and absolute paths', async () => {
    mocks.runFfmpeg.mockResolvedValue({
      code: 1,
      stderr: `${inputPath}: No such file or directory`,
    });
    const result = await sampleFramesUniform(options({ windowEndSec: 2 }));
    for (const failure of result.failures) {
      expect(failure.reason).not.toContain(inputPath);
      expect(failure.reason).not.toContain('No such file');
    }
  });

  it('records the remaining frames when the time budget runs out', async () => {
    writesOutput();
    let calls = 0;
    const result = await sampleFramesUniform(
      options({
        windowEndSec: 8,
        concurrency: 1,
        remainingTimeoutMs: () => (calls++ < 4 ? 60_000 : 0),
      }),
    );
    expect(result.frames).toHaveLength(2);
    expect(result.failures).toHaveLength(6);
    expect(result.failures[0]).toMatchObject({
      index: 3,
      reason: 'time budget exhausted',
    });
    expect(result.failures[1]).toMatchObject({
      index: 4,
      reason: 'not attempted',
    });
  });

  it('surfaces abort rather than reporting frames as failed silently', async () => {
    const controller = new AbortController();
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      controller.abort();
      await fs.writeFile(args[args.length - 1], 'jpg');
      return { code: 0, stderr: '' };
    });
    const result = await sampleFramesUniform(
      options({ signal: controller.signal, concurrency: 1 }),
    );
    expect(result.aborted).toBe(true);
    expect(result.frames).toHaveLength(0);
    expect(result.failures).toHaveLength(12);
  });
});

describe('segment extraction', () => {
  let root: string;
  let inputPath: string;
  let outputPath: string;

  const base = () => ({
    inputPath,
    outputPath,
    startSec: 10,
    endSec: 25.5,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
  });

  const writesOutput = (bytes = 4096) => {
    mocks.runFfmpeg.mockImplementation(async (args: string[]) => {
      await fs.writeFile(args[args.length - 1], Buffer.alloc(bytes));
      return { code: 0, stderr: '' };
    });
  };

  const lastArgs = (): string[] => mocks.runFfmpeg.mock.calls[0][0] as string[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-extraction-seg-'));
    inputPath = path.join(root, 'clip.mp4');
    outputPath = path.join(root, 'out.bin');
    await fs.writeFile(inputPath, 'mp4');
    mocks.runFfmpeg.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('cuts audio as 16 kHz mono WAV with an input-side seek', async () => {
    writesOutput(2048);
    const outcome = await extractAudioSegment(base());
    expect(outcome.segment).toEqual({
      filePath: outputPath,
      bytes: 2048,
      startSec: 10,
      endSec: 25.5,
    });
    const args = lastArgs();
    expect(args.slice(0, 6)).toEqual([
      '-y',
      '-ss',
      '10.000',
      '-t',
      '15.500',
      '-i',
    ]);
    expect(args.indexOf('-i')).toBeLessThan(args.indexOf(inputPath));
    expect(args).toContain('-vn');
    expect(args).toContain('pcm_s16le');
    expect(args[args.indexOf('-ar') + 1]).toBe(
      String(AUDIO_SEGMENT_DEFAULTS.sampleRateHz),
    );
    expect(args[args.indexOf('-ac') + 1]).toBe(
      String(AUDIO_SEGMENT_DEFAULTS.channels),
    );
  });

  it('keeps the audio track when cutting a clip', async () => {
    writesOutput();
    const outcome = await extractClipSegment({
      ...base(),
      fps: 2,
      maxDimension: 640,
    });
    expect(outcome.segment?.bytes).toBe(4096);
    const args = lastArgs();
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-b:a') + 1]).toBe(
      CLIP_SEGMENT_DEFAULTS.audioBitrate,
    );
    expect(args).not.toContain('-an');
  });

  it('applies fps, the long-edge cap and an even-dimension pass', async () => {
    writesOutput();
    await extractClipSegment({ ...base(), fps: 2, maxDimension: 640 });
    const filters = lastArgs()[lastArgs().indexOf('-vf') + 1];
    expect(filters).toBe(
      `fps=2,${scaleFilter(640)},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    );
  });

  it('reports a non-zero exit with the run attached', async () => {
    mocks.runFfmpeg.mockResolvedValue({ code: 1, stderr: 'Invalid data' });
    const outcome = await extractAudioSegment(base());
    expect(outcome.segment).toBeUndefined();
    expect(outcome.aborted).toBe(false);
    expect(outcome.run).toEqual({ code: 1, stderr: 'Invalid data' });
  });

  it('reports a missing output as a failure, not a success', async () => {
    mocks.runFfmpeg.mockResolvedValue({ code: 0, stderr: '' });
    const outcome = await extractAudioSegment(base());
    expect(outcome.segment).toBeUndefined();
  });

  it('distinguishes abort from failure', async () => {
    const controller = new AbortController();
    mocks.runFfmpeg.mockImplementation(async () => {
      controller.abort();
      return { code: 255, stderr: '' };
    });
    const outcome = await extractAudioSegment({
      ...base(),
      signal: controller.signal,
    });
    expect(outcome.aborted).toBe(true);
    expect(outcome.segment).toBeUndefined();
  });
});
