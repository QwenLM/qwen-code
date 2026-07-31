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

let ffmpegAvailable: boolean | undefined;
let ffprobeAvailable: boolean | undefined;
let ffmpegAvailablePromise: Promise<boolean> | undefined;
let ffprobeAvailablePromise: Promise<boolean> | undefined;

async function probeBinary(
  binary: string,
  getCached: () => boolean | undefined,
  setCached: (v: boolean) => void,
  getInflight: () => Promise<boolean> | undefined,
  setInflight: (p: Promise<boolean> | undefined) => void,
): Promise<boolean> {
  const cached = getCached();
  if (cached !== undefined) return cached;
  const inflight = getInflight();
  if (inflight) return inflight;

  const probe = (async () => {
    try {
      const { code } = await execCommand(binary, ['-version'], {
        timeout: 5000,
      });
      return code === 0;
    } catch {
      return false;
    }
  })()
    .then((result) => {
      setCached(result);
      return result;
    })
    .finally(() => {
      setInflight(undefined);
    });

  setInflight(probe);
  return probe;
}

/**
 * Check whether `ffmpeg` is available on PATH. Cached for the process
 * lifetime; concurrent callers share one probe subprocess.
 */
export async function isFfmpegAvailable(): Promise<boolean> {
  return probeBinary(
    'ffmpeg',
    () => ffmpegAvailable,
    (v) => (ffmpegAvailable = v),
    () => ffmpegAvailablePromise,
    (p) => (ffmpegAvailablePromise = p),
  );
}

/**
 * Check whether `ffprobe` is available on PATH. Cached for the process
 * lifetime; concurrent callers share one probe subprocess.
 */
export async function isFfprobeAvailable(): Promise<boolean> {
  return probeBinary(
    'ffprobe',
    () => ffprobeAvailable,
    (v) => (ffprobeAvailable = v),
    () => ffprobeAvailablePromise,
    (p) => (ffprobeAvailablePromise = p),
  );
}

/** Reset availability caches. Used by tests only. */
export function resetFfmpegCachesForTests(): void {
  ffmpegAvailable = undefined;
  ffprobeAvailable = undefined;
  ffmpegAvailablePromise = undefined;
  ffprobeAvailablePromise = undefined;
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

/** Basic video metadata extracted via ffprobe. */
export interface VideoProbeResult {
  /** Container/format name reported by ffprobe (e.g. "mov,mp4,m4a,..."). */
  formatName?: string;
  /** Duration in milliseconds, when reported. */
  durationMs?: number;
  /** Width in pixels of the first video stream. */
  width?: number;
  /** Height in pixels of the first video stream. */
  height?: number;
  /** Average frame rate (frames per second) of the first video stream. */
  frameRate?: number;
  /** Codec name of the first video stream (e.g. "h264"). */
  codec?: string;
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
 * Probe a local video file with ffprobe. Throws on non-zero exit or
 * unparseable output — the omni pipeline treats a failed probe as a
 * recognition failure (fail closed), not as "probably fine". Error
 * messages carry the file's basename only (they can reach model-visible
 * content).
 */
export async function probeVideoMetadata(
  filePath: string,
  signal?: AbortSignal,
): Promise<VideoProbeResult> {
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
  const durationSeconds = Number(parsed.format?.duration);
  return {
    formatName: parsed.format?.format_name,
    durationMs:
      Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? Math.round(durationSeconds * 1000)
        : undefined,
    width: videoStream?.width,
    height: videoStream?.height,
    frameRate:
      parseFrameRate(videoStream?.avg_frame_rate) ??
      parseFrameRate(videoStream?.r_frame_rate),
    codec: videoStream?.codec_name,
  };
}
