/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { MediaProbe } from './types.js';

/**
 * ffmpeg-based keyframe extraction — the local fallback that makes an oversized
 * video processable without an upload backend (P4 "too big → explicit
 * extraction" trigger). It downsamples the video to a handful of small JPEG
 * frames that fit inline, so a multimodal model can still see the video's
 * content. This is deliberately lossy and the caller must declare that in the
 * C10 precision note.
 */

export interface KeyframeOptions {
  /** Max frames to emit. */
  maxFrames?: number;
  /** Longest-edge pixel cap per frame. */
  longEdge?: number;
  /** Optional [startSeconds, endSeconds] window. */
  range?: [number, number];
  signal?: AbortSignal;
}

export interface KeyframeResult {
  parts: Part[];
  frameCount: number;
  longEdge: number;
  /** Seconds between sampled frames, when derivable. */
  intervalSec?: number;
}

const DEFAULT_MAX_FRAMES = 12;
const DEFAULT_LONG_EDGE = 768;

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      'ffmpeg',
      args,
      { signal, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.toString().trim() || err.message));
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Extract evenly-spaced, downscaled keyframes as inline JPEG Parts. Throws if
 * ffmpeg is missing/fails or no frames are produced — callers translate that
 * into a fail-closed media error.
 */
export async function extractKeyframes(
  probe: MediaProbe,
  opts: KeyframeOptions = {},
): Promise<KeyframeResult> {
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const longEdge = opts.longEdge ?? DEFAULT_LONG_EDGE;

  // Choose a sampling rate that yields ~maxFrames across the (windowed)
  // duration. Fall back to one frame / 10s when duration is unknown.
  const start = opts.range?.[0];
  const end = opts.range?.[1];
  const windowSec =
    start !== undefined && end !== undefined
      ? Math.max(end - start, 0.001)
      : probe.durationSec;
  const fps =
    windowSec && windowSec > 0 ? Math.min(maxFrames / windowSec, 30) : 0.1;
  const intervalSec = fps > 0 ? 1 / fps : undefined;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-kf-'));
  try {
    const args: string[] = ['-hide_banner', '-loglevel', 'error'];
    if (start !== undefined) args.push('-ss', String(start));
    if (end !== undefined) args.push('-to', String(end));
    args.push(
      '-i',
      probe.path,
      '-vf',
      `fps=${fps},scale=w=${longEdge}:h=${longEdge}:force_original_aspect_ratio=decrease`,
      '-frames:v',
      String(maxFrames),
      '-q:v',
      '3',
      path.join(dir, 'frame_%03d.jpg'),
    );
    await runFfmpeg(args, opts.signal);

    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.jpg'))
      .sort();
    if (files.length === 0) {
      throw new Error('ffmpeg produced no keyframes');
    }
    const parts: Part[] = [];
    for (const file of files) {
      const bytes = await fs.readFile(path.join(dir, file));
      parts.push({
        inlineData: {
          data: bytes.toString('base64'),
          mimeType: 'image/jpeg',
          displayName: `${path.basename(probe.path)} · ${file}`,
        },
      });
    }
    return {
      parts,
      frameCount: parts.length,
      longEdge,
      ...(intervalSec !== undefined && { intervalSec }),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
