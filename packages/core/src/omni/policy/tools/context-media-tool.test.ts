/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTEXT_MEDIA_VISUAL_SCHEMA_PROPERTIES,
  CONTEXT_MEDIA_WINDOW_SCHEMA_PROPERTIES,
  DEFAULT_CONTEXT_MEDIA_TIER,
  MAX_CONTEXT_MEDIA_FRAMES,
  formatClampNote,
  formatDeliveredDimensions,
  formatWindowLabel,
  inlineMediaPart,
  resolveContextMediaWindow,
  validateContextMediaParams,
  withContextMediaScratchDir,
} from './context-media-tool.js';
import { MEDIA_POLICY_IO_SCHEMA_PROPERTIES } from './media-policy-tool.js';

describe('context-media schema fragments', () => {
  it('declares no output directory anywhere', () => {
    // The whole point of these three tools: the model is never asked for
    // a staging path, so it cannot fail to create one.
    const properties = {
      ...CONTEXT_MEDIA_WINDOW_SCHEMA_PROPERTIES,
      ...CONTEXT_MEDIA_VISUAL_SCHEMA_PROPERTIES,
    };
    expect(properties).not.toHaveProperty('outputDir');
    expect(MEDIA_POLICY_IO_SCHEMA_PROPERTIES).toHaveProperty('outputDir');
  });

  it('bounds fps so one call cannot ask for an unbounded frame count', () => {
    expect(CONTEXT_MEDIA_VISUAL_SCHEMA_PROPERTIES.fps).toMatchObject({
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 10,
    });
  });

  it('keeps the frame cap and the default quality stable', () => {
    // MAX_CONTEXT_MEDIA_FRAMES is also the per-tool upload budget in
    // omni/tool-result-media.ts; the two must move together.
    expect(MAX_CONTEXT_MEDIA_FRAMES).toBe(64);
    expect(DEFAULT_CONTEXT_MEDIA_TIER).toBe('normal');
  });

  it('names the default the schema advertises', () => {
    // The description tells the model what omitting the parameter costs;
    // if the two drift apart the model is priced off a false number.
    expect(
      CONTEXT_MEDIA_VISUAL_SCHEMA_PROPERTIES.resolution.description,
    ).toContain(`Defaults to "${DEFAULT_CONTEXT_MEDIA_TIER}"`);
  });
});

describe('validateContextMediaParams', () => {
  it('accepts a window given in clock form', () => {
    expect(
      validateContextMediaParams({
        inputPath: '/a/in.mp4',
        start: '01:02:03',
        end: '01:02:13',
      }),
    ).toBeNull();
  });

  it('rejects a relative inputPath before looking at the window', () => {
    expect(
      validateContextMediaParams({
        inputPath: 'in.mp4',
        start: 'nonsense',
        end: '10',
      }),
    ).toMatch(/inputPath must be an absolute/);
  });

  it('reports the malformed timestamp it was handed', () => {
    expect(
      validateContextMediaParams({
        inputPath: '/a/in.mp4',
        start: '0:90',
        end: '10:00',
      }),
    ).toMatch(/under 60/);
  });

  it('refuses an empty or backwards window', () => {
    expect(
      validateContextMediaParams({
        inputPath: '/a/in.mp4',
        start: '02:00',
        end: '01:00',
      }),
    ).toBe('end (01:00) must be after start (02:00)');
    expect(
      validateContextMediaParams({
        inputPath: '/a/in.mp4',
        start: '02:00',
        end: '02:00',
      }),
    ).toMatch(/must be after start/);
  });

  it('validates resolution here rather than at ffmpeg time', () => {
    // A bad rung costs a validation error, not a probe plus a spawn.
    expect(
      validateContextMediaParams({
        inputPath: '/a/in.mp4',
        start: '0',
        end: '10',
        resolution: 'huge',
      }),
    ).toMatch(/resolution/);
    expect(
      validateContextMediaParams({
        inputPath: '/a/in.mp4',
        start: '0',
        end: '10',
        resolution: '720p',
      }),
    ).toBeNull();
  });
});

describe('resolveContextMediaWindow', () => {
  const params = (start: string, end: string) => ({
    inputPath: '/a/in.mp4',
    start,
    end,
  });

  it('returns the requested window when the media is long enough', () => {
    expect(resolveContextMediaWindow(params('01:00', '02:00'), 600)).toEqual({
      startSec: 60,
      endSec: 120,
      withHours: false,
    });
  });

  it('clamps the end to the media and records what was asked for', () => {
    const window = resolveContextMediaWindow(params('00:30', '10:00'), 90);
    expect(window).toEqual({
      startSec: 30,
      endSec: 90,
      withHours: false,
      requestedEndSec: 600,
    });
    expect(formatClampNote(window)).toContain('cut short');
    expect(formatClampNote(window)).toContain('01:30');
  });

  it('says nothing about clamping when nothing was clamped', () => {
    expect(
      formatClampNote(resolveContextMediaWindow(params('0', '10'), 600)),
    ).toBe('');
  });

  it('refuses a start at or past the end of the media', () => {
    expect(() =>
      resolveContextMediaWindow(params('10:00', '11:00'), 300),
    ).toThrow(/at or beyond the end of the media \(05:00\)/);
  });

  it('throws rather than resolve an empty window', () => {
    // validateContextMediaParams already rejects this shape; the throw is
    // what keeps a caller that skipped validation from getting back "some
    // other window" instead of an error.
    expect(() =>
      resolveContextMediaWindow(params('02:00', '01:00'), undefined),
    ).toThrow(/empty after clamping/);
  });

  it('takes the window at face value when the probe gave no duration', () => {
    expect(resolveContextMediaWindow(params('0', '10'), undefined)).toEqual({
      startSec: 0,
      endSec: 10,
      withHours: false,
    });
  });

  it('switches every label in the call to hours once the source is long', () => {
    const window = resolveContextMediaWindow(params('00:30', '01:30'), 3600);
    expect(window.withHours).toBe(true);
    expect(formatWindowLabel(window)).toBe('0:00:30–0:01:30');
  });

  it('uses hours when the REQUESTED end crosses an hour on an unprobed file', () => {
    // Otherwise the same call would print a 3661s label as "01:01".
    const window = resolveContextMediaWindow(
      params('01:00:00', '01:01:00'),
      undefined,
    );
    expect(formatWindowLabel(window)).toBe('1:00:00–1:01:00');
  });
});

describe('formatDeliveredDimensions', () => {
  it('reports what the fit-inside filter will actually produce', () => {
    expect(formatDeliveredDimensions(1920, 1080, 768)).toBe('768×432');
  });

  it('never enlarges a source smaller than the cap', () => {
    expect(formatDeliveredDimensions(320, 240, 768)).toBe('320×240');
  });

  it('stays silent when the probe reported no size', () => {
    // Claiming a number the box filter did not promise would be a guess.
    expect(formatDeliveredDimensions(undefined, 1080, 768)).toBe('');
    expect(formatDeliveredDimensions(1920, 0, 768)).toBe('');
  });
});

describe('withContextMediaScratchDir', () => {
  let seen: string;

  it('hands over a private directory and removes it on the way out', async () => {
    const bytes = await withContextMediaScratchDir(
      'omni-ctx-test-',
      async (dir) => {
        seen = dir;
        const filePath = path.join(dir, 'x.bin');
        await fs.writeFile(filePath, Buffer.alloc(3));
        return (await fs.stat(filePath)).size;
      },
    );
    expect(bytes).toBe(3);
    expect(seen.startsWith(os.tmpdir())).toBe(true);
    await expect(fs.stat(seen)).rejects.toThrow();
  });

  it('removes the directory even when the body throws', async () => {
    let dir = '';
    await expect(
      withContextMediaScratchDir('omni-ctx-test-', async (d) => {
        dir = d;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(fs.stat(dir)).rejects.toThrow();
  });
});

describe('inlineMediaPart', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-ctx-part-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('carries the bytes plus a display name for the upload hook', async () => {
    const filePath = path.join(root, 'frame.jpg');
    await fs.writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff]));
    expect(
      await inlineMediaPart(filePath, 'image/jpeg', 'frame-1.jpg'),
    ).toEqual({
      inlineData: {
        mimeType: 'image/jpeg',
        data: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
        displayName: 'frame-1.jpg',
      },
    });
  });
});
