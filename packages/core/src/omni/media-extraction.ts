/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, type FfmpegRunResult } from './ffmpeg.js';
import { smartResize } from './smart-resize.js';

/**
 * Shared media-extraction primitives: clock/resolution parsing plus the
 * three ffmpeg operations (uniform frame sampling, audio segment, video
 * clip). Leaf module — depends only on ffmpeg.ts, so it stays unit
 * testable without a Config or an upload channel.
 */

/** Seconds formatted for ffmpeg `-ss`/`-t`: fixed-point (never scientific
 * notation), millisecond precision. */
export function formatFfmpegSeconds(seconds: number): string {
  return seconds.toFixed(3);
}

/**
 * `MM:SS` (or `H:MM:SS` when `withHours`) clock label for model-facing text,
 * carrying a tenths digit when the instant is not on a whole second.
 *
 * Rounding to the nearest second would name a second the frame does not show:
 * a frame sampled at the midpoint of a one-second slice sits on `.5`, and the
 * model can read the true instant off the picture.
 */
export function formatClockLabel(
  totalSeconds: number,
  withHours: boolean,
): string {
  const tenths = Math.max(0, Math.round(totalSeconds * 10));
  const s = Math.floor(tenths / 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = String(m).padStart(2, '0');
  const tenth = tenths % 10;
  const ss = `${String(s % 60).padStart(2, '0')}${tenth ? `.${tenth}` : ''}`;
  return withHours ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Parse `HH:MM:SS`, `MM:SS` or plain seconds (the last field may carry a
 * `.mmm` fraction) into seconds. Strict on purpose: `0:90` is rejected
 * rather than read as 90s, because guessing which reading was meant would
 * put a silently wrong window into the model's context.
 */
export function parseClockTime(raw: string): number {
  const text = String(raw ?? '').trim();
  const parts = text.split(':');
  const shapeOk =
    parts.length <= 3 &&
    parts.every((p, i) =>
      i === parts.length - 1 ? /^\d+(\.\d+)?$/.test(p) : /^\d+$/.test(p),
    );
  if (!shapeOk) {
    throw new Error(
      `invalid time "${raw}" — use HH:MM:SS, MM:SS or seconds (e.g. "01:02:03", "02:03", "123", "12.5")`,
    );
  }
  const values = parts.map(Number);
  if (values.slice(1).some((v) => v >= 60)) {
    throw new Error(
      `invalid time "${raw}" — minutes and seconds must be under 60 in colon form; write plain seconds instead (e.g. "90")`,
    );
  }
  return values.reduce((total, value) => total * 60 + value, 0);
}

/** Smallest / largest long-edge this module will hand to ffmpeg. Guards a
 * typo'd resolution from producing a frame nobody can afford. */
const MIN_MAX_DIMENSION = 64;
const MAX_MAX_DIMENSION = 4096;

const RESOLUTION_LADDER: Record<string, number> = {
  '144p': 256,
  '240p': 426,
  '360p': 640,
  '480p': 854,
  '720p': 1280,
  '1080p': 1920,
  '1440p': 2560,
  '2160p': 3840,
};

/** Per-frame visual-token budget each cost tier promises. Resolved against
 * the source's own aspect ratio, because the price is area — a long-edge cap
 * alone cannot hold a token promise across shapes. */
const RESOLUTION_TIER_TOKENS: Record<string, number> = {
  low: 64,
  normal: 128,
  high: 384,
};

/** Pixels one visual token covers on the omni endpoints these tools feed.
 * Measured against a served model; the VL-family grid in smart-resize.ts
 * is a different number and does not describe them. */
const TIER_GRID_FACTOR = 32;

/** Stand-in source shape for tier math before the media has been probed —
 * only its ratio is read. */
const TIER_FALLBACK_SHAPE = { width: 16, height: 9 };

/** Long edge that spends `tokens` visual tokens at the source's aspect
 * ratio. Clamped rather than rejected: a tier is valid by construction, so
 * an extreme source shape must not turn into a parameter error. */
function tierLongEdge(
  tokens: number,
  source?: { width?: number; height?: number },
): number {
  const shape =
    source?.width && source?.height
      ? { width: source.width, height: source.height }
      : TIER_FALLBACK_SHAPE;
  const budget = tokens * TIER_GRID_FACTOR * TIER_GRID_FACTOR;
  const fit = smartResize(shape.width, shape.height, {
    minPixels: budget,
    maxPixels: budget,
    factor: TIER_GRID_FACTOR,
  });
  return Math.min(
    MAX_MAX_DIMENSION,
    Math.max(MIN_MAX_DIMENSION, Math.max(fit.width, fit.height)),
  );
}

/**
 * Parse a resolution request into a long-edge pixel cap. Accepts a cost
 * tier (`low`), a ladder rung (`720p`), a bare long edge (`768`) or `WxH`
 * (`1280x720`, whose larger side is used). Aspect ratio is always
 * preserved, so the caller must report the dimensions actually
 * delivered — not the rung asked for. Pass the probed source dimensions
 * whenever they are known: the tier names need them to hit their budget.
 */
export function parseResolution(
  raw: string,
  source?: { width?: number; height?: number },
): number {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase();
  const tierTokens = RESOLUTION_TIER_TOKENS[text];
  if (tierTokens !== undefined) {
    return tierLongEdge(tierTokens, source);
  }
  const pair = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(text);
  const value =
    RESOLUTION_LADDER[text] ??
    (pair
      ? Math.max(Number(pair[1]), Number(pair[2]))
      : /^\d+$/.test(text)
        ? Number(text)
        : undefined);
  if (value === undefined) {
    throw new Error(
      `invalid resolution "${raw}" — use low/normal/high, 240p/360p/480p/720p/1080p, a long-edge pixel count (e.g. "768"), or WxH (e.g. "1280x720")`,
    );
  }
  const maxDimension = Math.round(value);
  if (maxDimension < MIN_MAX_DIMENSION || maxDimension > MAX_MAX_DIMENSION) {
    throw new Error(
      `resolution "${raw}" is out of range — the long edge must be ${MIN_MAX_DIMENSION}–${MAX_MAX_DIMENSION} pixels`,
    );
  }
  return maxDimension;
}

/** `-vf` expression that fits the frame inside a `maxDimension` box
 * without changing its aspect ratio (never upscales). */
export function scaleFilter(maxDimension: number): string {
  return (
    `scale='min(${maxDimension},iw)':'min(${maxDimension},ih)'` +
    `:force_original_aspect_ratio=decrease`
  );
}

/** libx264 rejects odd dimensions; chained after any scale expression. */
const EVEN_DIMENSIONS_FILTER = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** One frame that made it to disk. */
export interface FrameSample {
  /** 1-based position in the requested sequence. */
  index: number;
  fileName: string;
  filePath: string;
  timeSeconds: number;
}

/** One frame that did not. Reported, never dropped — a summary that lists
 * 10 frames while 12 were requested has to say which 2 are missing. */
export interface FrameFailure {
  index: number;
  timeSeconds: number;
  /** Short, path-free reason (the enumeration is model-facing). */
  reason: string;
}

export interface SampleFramesResult {
  frames: FrameSample[];
  failures: FrameFailure[];
  /** How many frames the window/fps/cap combination asked for. */
  requested: number;
  aborted: boolean;
}

/** How many uniform-strategy seek extractions run concurrently. */
const SEEK_CONCURRENCY = 4;

export interface SampleFramesOptions {
  inputPath: string;
  outputDir: string;
  /** Sampling window, already clamped to the media duration by the caller. */
  windowStartSec: number;
  windowEndSec: number;
  /** Frames per second requested; the count is floored and capped. */
  fps: number;
  maxFrames: number;
  /** Precomputed `-vf` scale expression (see {@link scaleFilter}). */
  scaleVf: string;
  /** File name for the 1-based frame index — keeps naming policy with the
   * caller so this module needs nothing from the policy-tool layer. */
  fileNameFor: (index: number) => string;
  /** Remaining budget for the whole run; consulted before each seek. */
  remainingTimeoutMs: () => number;
  signal: AbortSignal;
  concurrency?: number;
}

/**
 * Sample evenly spaced frames across the window, one input-side seek per
 * timestamp (`-ss` before `-i`: the preceding footage is never decoded).
 * The frame count adapts to the window — clamp(window × fps, 1, maxFrames)
 * — so a long window thins out instead of exploding.
 */
export async function sampleFramesUniform(
  options: SampleFramesOptions,
): Promise<SampleFramesResult> {
  const {
    inputPath,
    outputDir,
    windowStartSec,
    windowEndSec,
    fps,
    maxFrames,
    scaleVf,
    fileNameFor,
    remainingTimeoutMs,
    signal,
  } = options;
  const windowSeconds = windowEndSec - windowStartSec;
  const nframes = Math.max(
    1,
    Math.min(maxFrames, Math.floor(windowSeconds * fps)),
  );
  // Midpoints of equal slices: the sample set covers the window
  // symmetrically instead of pinning the first frame to t=start.
  const slice = windowSeconds / nframes;
  const timestamps = Array.from(
    { length: nframes },
    (_, i) => windowStartSec + (i + 0.5) * slice,
  );

  const samples: Array<FrameSample | undefined> = new Array(nframes);
  const reasons: Array<string | undefined> = new Array(nframes);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = nextIndex++;
      if (index >= nframes) return;
      if (remainingTimeoutMs() <= 1) {
        reasons[index] = 'time budget exhausted';
        return;
      }
      const timestamp = timestamps[index];
      const fileName = fileNameFor(index + 1);
      const filePath = path.join(outputDir, fileName);
      const run = await runFfmpeg(
        [
          '-y',
          '-ss',
          formatFfmpegSeconds(timestamp),
          '-i',
          inputPath,
          '-vf',
          scaleVf,
          '-frames:v',
          '1',
          '-q:v',
          '4',
          '-update',
          '1',
          filePath,
        ],
        { signal, timeoutMs: remainingTimeoutMs() },
      );
      if (signal.aborted) return;
      if (run.code !== 0) {
        reasons[index] = `ffmpeg exited ${run.code}`;
        continue;
      }
      if (!(await fileExists(filePath))) {
        reasons[index] = 'ffmpeg wrote no output';
        continue;
      }
      samples[index] = {
        index: index + 1,
        fileName,
        filePath,
        timeSeconds: timestamp,
      };
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency ?? SEEK_CONCURRENCY, nframes) },
      worker,
    ),
  );

  const frames: FrameSample[] = [];
  const failures: FrameFailure[] = [];
  for (let i = 0; i < nframes; i++) {
    const sample = samples[i];
    if (sample) {
      frames.push(sample);
      continue;
    }
    failures.push({
      index: i + 1,
      timeSeconds: timestamps[i],
      reason: reasons[i] ?? 'not attempted',
    });
  }
  return { frames, failures, requested: nframes, aborted: signal.aborted };
}

/** A single-file extraction that reached disk. */
export interface SegmentResult {
  filePath: string;
  bytes: number;
  startSec: number;
  endSec: number;
}

/**
 * Outcome of a segment extraction. `run` is always present so the caller
 * can build the repo-standard ffmpeg failure message; `segment` is present
 * only on success.
 */
export interface SegmentOutcome {
  run: FfmpegRunResult;
  aborted: boolean;
  segment?: SegmentResult;
}

export interface SegmentOptions {
  inputPath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  signal: AbortSignal;
  timeoutMs: number;
}

async function runSegment(
  args: string[],
  options: SegmentOptions,
): Promise<SegmentOutcome> {
  const run = await runFfmpeg(args, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (options.signal.aborted) return { run, aborted: true };
  if (run.code !== 0 || !(await fileExists(options.outputPath))) {
    return { run, aborted: false };
  }
  const { size } = await fs.stat(options.outputPath);
  return {
    run,
    aborted: false,
    segment: {
      filePath: options.outputPath,
      bytes: size,
      startSec: options.startSec,
      endSec: options.endSec,
    },
  };
}

/** 16 kHz mono WAV — the ASR-recommended input shape, matching what
 * omni_extract_audio produces by default. */
export const AUDIO_SEGMENT_DEFAULTS = {
  sampleRateHz: 16_000,
  channels: 1,
} as const;

/** Cut `[start, end]` out of the input's audio track as 16 kHz mono WAV. */
export function extractAudioSegment(
  options: SegmentOptions,
): Promise<SegmentOutcome> {
  return runSegment(
    [
      '-y',
      '-ss',
      formatFfmpegSeconds(options.startSec),
      '-t',
      formatFfmpegSeconds(options.endSec - options.startSec),
      '-i',
      options.inputPath,
      '-vn',
      '-c:a',
      'pcm_s16le',
      '-ar',
      String(AUDIO_SEGMENT_DEFAULTS.sampleRateHz),
      '-ac',
      String(AUDIO_SEGMENT_DEFAULTS.channels),
      options.outputPath,
    ],
    options,
  );
}

/** Encode parameters for a clip: a time-axis cut plus the requested frame
 * rate / long edge. crf 23 keeps quality where the caller did not ask for
 * less. */
export const CLIP_SEGMENT_DEFAULTS = {
  crf: 23,
  preset: 'veryfast',
  audioBitrate: '128k',
} as const;

export interface ClipSegmentOptions extends SegmentOptions {
  /** Output frame rate. */
  fps: number;
  /** Long-edge cap in pixels (see {@link parseResolution}). */
  maxDimension: number;
}

/**
 * Cut `[start, end]` out of the input with its audio track intact,
 * re-encoded at the requested fps and long edge. Input-side `-ss`/`-t`
 * plus a full re-encode gives a frame-accurate cut (`-c copy` would snap
 * to keyframes).
 */
export function extractClipSegment(
  options: ClipSegmentOptions,
): Promise<SegmentOutcome> {
  const filters = [
    `fps=${options.fps}`,
    scaleFilter(options.maxDimension),
    EVEN_DIMENSIONS_FILTER,
  ].join(',');
  return runSegment(
    [
      '-y',
      '-ss',
      formatFfmpegSeconds(options.startSec),
      '-t',
      formatFfmpegSeconds(options.endSec - options.startSec),
      '-i',
      options.inputPath,
      '-vf',
      filters,
      '-c:v',
      'libx264',
      '-crf',
      String(CLIP_SEGMENT_DEFAULTS.crf),
      '-preset',
      CLIP_SEGMENT_DEFAULTS.preset,
      '-c:a',
      'aac',
      '-b:a',
      CLIP_SEGMENT_DEFAULTS.audioBitrate,
      '-movflags',
      '+faststart',
      options.outputPath,
    ],
    options,
  );
}
