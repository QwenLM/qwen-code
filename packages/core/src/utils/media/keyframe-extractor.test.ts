/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractKeyframes } from './keyframe-extractor.js';
import { probeMedia } from './probe.js';

let dir: string;
let videoPath: string;
let ffmpegOk = false;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kf-test-'));
  videoPath = path.join(dir, 'clip.mp4');
  ffmpegOk = await new Promise<boolean>((resolve) => {
    execFile(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=3:size=320x240:rate=10',
        '-pix_fmt',
        'yuv420p',
        videoPath,
      ],
      (err) => resolve(!err),
    );
  });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ffprobe + keyframe extraction (needs ffmpeg)', () => {
  it('probe fills duration/resolution via ffprobe', async () => {
    if (!ffmpegOk) return;
    const probe = await probeMedia(videoPath);
    expect(probe.modality).toBe('video');
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.durationSec).toBeGreaterThan(2);
    expect(probe.durationSec).toBeLessThan(4);
    // testsrc has no audio track.
    expect(probe.hasAudio).toBe(false);
  });

  it('extracts downscaled keyframes as inline image parts', async () => {
    if (!ffmpegOk) return;
    const probe = await probeMedia(videoPath);
    const result = await extractKeyframes(probe, {
      maxFrames: 4,
      longEdge: 160,
    });
    expect(result.frameCount).toBeGreaterThan(0);
    expect(result.frameCount).toBeLessThanOrEqual(4);
    for (const part of result.parts) {
      expect(part.inlineData?.mimeType).toBe('image/jpeg');
      expect((part.inlineData?.data ?? '').length).toBeGreaterThan(0);
    }
  });
});
