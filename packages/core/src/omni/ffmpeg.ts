/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import path from 'node:path';
import { FatalConfigError } from '../utils/errors.js';

/**
 * Lightweight wrapper around execFile mirroring utils/pdf.ts execCommand.
 * Kept local to avoid exporting pdf.ts internals or importing shell-utils
 * (circular dependency risk in vitest mock environments).
 */
function execCommand(
  command: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', ...options },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: typeof error.code === 'number' ? error.code : 1,
          });
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: 0,
        });
      },
    );
  });
}

/** Availability cache: binary name → settled result or in-flight probe.
 * Concurrent callers share one probe subprocess per binary. */
const availabilityCache = new Map<string, boolean | Promise<boolean>>();

async function probeBinary(binary: string): Promise<boolean> {
  const cached = availabilityCache.get(binary);
  if (typeof cached === 'boolean') return cached;
  if (cached) return cached;

  const probe = (async () => {
    try {
      const { code } = await execCommand(binary, ['-version'], {
        timeout: 5000,
      });
      return code === 0;
    } catch {
      return false;
    }
  })().then(
    (result) => {
      availabilityCache.set(binary, result);
      return result;
    },
    () => {
      // Never cache a rejection — allow the next caller to retry.
      availabilityCache.delete(binary);
      return false;
    },
  );

  availabilityCache.set(binary, probe);
  return probe;
}

/**
 * Check whether `ffmpeg` is available on PATH. Cached for the process
 * lifetime; concurrent callers share one probe subprocess.
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  return probeBinary('ffmpeg');
}

/**
 * Check whether `ffprobe` is available on PATH. Cached for the process
 * lifetime; concurrent callers share one probe subprocess.
 */
export async function isFfprobeAvailable(): Promise<boolean> {
  return probeBinary('ffprobe');
}

/** Reset availability caches. Used by tests only. */
export function resetFfmpegCachesForTests(): void {
  availabilityCache.clear();
}

/**
 * Omni runtime hard prerequisite: ffmpeg AND ffprobe must both be present
 * when the omni pipeline is enabled. Throws FatalConfigError with an
 * actionable message so startup fails fast instead of erroring midway
 * through the first video interaction.
 */
export async function assertOmniRuntimeDependencies(): Promise<void> {
  const [ffmpeg, ffprobe] = await Promise.all([
    isFfmpegAvailable(),
    isFfprobeAvailable(),
  ]);
  if (ffmpeg && ffprobe) return;
  const missing = [
    ...(ffmpeg ? [] : ['ffmpeg']),
    ...(ffprobe ? [] : ['ffprobe']),
  ].join(' and ');
  throw new FatalConfigError(
    `Omni multimodal support is enabled (omni.enabled / QWEN_CODE_ENABLE_OMNI=1) ` +
      `but ${missing} was not found on PATH. Install ffmpeg (e.g. ` +
      `"brew install ffmpeg" on macOS, "apt-get install ffmpeg" on Debian/Ubuntu) ` +
      `or disable omni support.`,
  );
}

/** Media metadata extracted via ffprobe (fields populated per modality). */
export interface MediaProbeResult {
  /** Container/format name reported by ffprobe (e.g. "mov,mp4,m4a,..."). */
  formatName?: string;
  /** Duration in milliseconds (video/audio), when reported. */
  durationMs?: number;
  /** Width in pixels (video: first video stream; image: the image). */
  width?: number;
  /** Height in pixels. */
  height?: number;
  /** Average frame rate (fps) of the first video stream (video only). */
  frameRate?: number;
  /** Codec name of the primary stream for the modality. */
  codec?: string;
  /** Frame count of the primary video stream (image: >1 means animated —
   * GIF/APNG/animated WebP; absent when the container does not report it). */
  frameCount?: number;
}

/** Parse an ffprobe rational like "30000/1001" (or plain "25") into fps. */
function parseFrameRate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parts = raw.split('/');
  const num = Number(parts[0]);
  const den = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return undefined;
  }
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : undefined;
}

/**
 * Probe a local media file with ffprobe. Throws on non-zero exit or
 * unparseable output — the omni pipeline treats a failed probe as a
 * recognition failure (fail closed), not as "probably fine". Error
 * messages carry the file's basename only (they can reach model-visible
 * content). ffprobe handles images too (single video stream, no duration),
 * so the omni path needs no sharp dependency.
 */
export async function probeMediaMetadata(
  filePath: string,
  modality: 'image' | 'audio' | 'video',
  signal?: AbortSignal,
): Promise<MediaProbeResult> {
  const { stdout, code, stderr } = await execCommand(
    'ffprobe',
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, ...(signal && { signal }) },
  );
  if (signal?.aborted) {
    throw new Error(`ffprobe aborted for ${path.basename(filePath)}`);
  }
  if (code !== 0) {
    throw new Error(
      `ffprobe failed (exit ${code}) for ${path.basename(filePath)}: ${stderr.slice(0, 300)}`,
    );
  }
  let parsed: {
    format?: { format_name?: string; duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      nb_frames?: string;
    }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `ffprobe produced unparseable output for ${path.basename(filePath)}`,
    );
  }
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration);
  const durationMs =
    Number.isFinite(durationSeconds) && durationSeconds >= 0
      ? Math.round(durationSeconds * 1000)
      : undefined;

  const base: MediaProbeResult = { formatName: parsed.format?.format_name };
  switch (modality) {
    case 'image': {
      // Animated images (GIF/APNG/animated WebP) report nb_frames on their
      // video stream; a single-frame image reports 1 or omits it. The token
      // estimator needs the real count — an animated GIF estimated as one
      // frame sails under the transport guard at ~1/300 of its real cost.
      const nbFrames = Number(videoStream?.nb_frames);
      return {
        ...base,
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        ...(Number.isFinite(nbFrames) && nbFrames > 0
          ? { frameCount: nbFrames }
          : {}),
      };
    }
    case 'audio':
      return {
        ...base,
        durationMs,
        codec: audioStream?.codec_name,
      };
    case 'video':
    default:
      return {
        ...base,
        durationMs,
        width: videoStream?.width,
        height: videoStream?.height,
        frameRate:
          parseFrameRate(videoStream?.avg_frame_rate) ??
          parseFrameRate(videoStream?.r_frame_rate),
        codec: videoStream?.codec_name,
      };
  }
}
