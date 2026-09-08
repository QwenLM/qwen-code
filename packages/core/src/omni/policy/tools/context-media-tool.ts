/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';
import { getErrorMessage } from '../../../utils/errors.js';
import {
  formatClockLabel,
  parseClockTime,
  parseResolution,
} from '../../media-extraction.js';
import type { MediaPolicyInputParams } from './media-policy-tool.js';
import { validateMediaPolicyInputParams } from './media-policy-tool.js';

/**
 * Shared plumbing for the media-policy tools that deliver their result
 * straight INTO the model's context (sample_frames / get_audio /
 * get_clip), rather than writing a file the model has to read back.
 *
 * The three differ only in what ffmpeg they run; the window semantics,
 * the scratch directory and the inline-part hand-off must agree, so they
 * live here once.
 */

/** Window parameters all three take. Clock strings rather than seconds:
 * the model quotes timestamps in that form, and accepting only seconds
 * turned every call into an arithmetic step it could get wrong. */
export interface ContextMediaParams extends MediaPolicyInputParams {
  start: string;
  end: string;
}

/** Extra parameters the two visual tools take. */
export interface ContextMediaVisualParams extends ContextMediaParams {
  fps: number;
  resolution?: string;
}

export const CONTEXT_MEDIA_WINDOW_SCHEMA_PROPERTIES = {
  start: {
    type: 'string',
    description:
      'Window start as HH:MM:SS, MM:SS or plain seconds (e.g. "01:02:03", "02:03", "123", "12.5").',
  },
  end: {
    type: 'string',
    description:
      'Window end in the same format as start; must be after start. Clamped to the end of the media.',
  },
} as const;

export const CONTEXT_MEDIA_VISUAL_SCHEMA_PROPERTIES = {
  fps: {
    type: 'number',
    description:
      'Frames per second: 1.0 is one frame per second of the window.',
    exclusiveMinimum: 0,
    maximum: 10,
  },
  resolution: {
    type: 'string',
    description:
      'Picture quality: a cost tier ("low" ~64, "normal" ~128, "high" ~384 visual tokens per frame), a ladder rung (240p/360p/480p/720p/1080p), a long-edge pixel count ("768") or WxH ("1280x720"). Aspect ratio is always preserved and the media is never enlarged. Defaults to "normal".',
  },
} as const;

/** Quality used when `resolution` is omitted. A tier name rather than a
 * pixel count, so omitting the parameter costs exactly what the schema
 * says `"normal"` costs. */
export const DEFAULT_CONTEXT_MEDIA_TIER = 'normal';

/** Frames one call may deliver. Also the per-tool upload budget in
 * omni/tool-result-media.ts — a frame that cannot be uploaded is
 * withheld, so raising one without the other silently drops frames. */
export const MAX_CONTEXT_MEDIA_FRAMES = 64;

/**
 * Value-level validation shared by the three: the input locator plus the
 * window, and the quality knobs when the tool declares them. Parsing
 * happens here (not only at execute time) so a malformed timestamp costs
 * a validation error instead of a probe and an ffmpeg spawn.
 */
export function validateContextMediaParams(
  params: ContextMediaParams & { resolution?: string },
): string | null {
  const inputError = validateMediaPolicyInputParams(params);
  if (inputError) {
    return inputError;
  }
  let startSec: number;
  let endSec: number;
  try {
    startSec = parseClockTime(params.start);
    endSec = parseClockTime(params.end);
    if (params.resolution !== undefined) {
      parseResolution(params.resolution);
    }
  } catch (error) {
    return getErrorMessage(error);
  }
  if (endSec <= startSec) {
    return `end (${params.end}) must be after start (${params.start})`;
  }
  return null;
}

/** The window a call will actually cover, resolved against the media's
 * real duration. */
export interface ResolvedContextWindow {
  startSec: number;
  endSec: number;
  /** True once the source runs an hour or longer: clock labels then carry
   * hours for EVERY timestamp in the call, so the format is uniform. */
  withHours: boolean;
  /** The end the caller asked for, when the media ended before it. Kept
   * so the summary can say the window was cut short. */
  requestedEndSec?: number;
}

/**
 * Resolve `start`/`end` against the probed duration. Throws (the callers
 * already funnel throws into the uniform error result) — an empty or
 * out-of-range window must not silently become "some other window".
 */
export function resolveContextMediaWindow(
  params: ContextMediaParams,
  durationSeconds: number | undefined,
): ResolvedContextWindow {
  const startSec = parseClockTime(params.start);
  const requestedEndSec = parseClockTime(params.end);
  const withHours = Math.max(durationSeconds ?? 0, requestedEndSec) >= 3600;
  if (durationSeconds !== undefined && startSec >= durationSeconds) {
    throw new Error(
      `start ${params.start} is at or beyond the end of the media (${formatClockLabel(durationSeconds, withHours)})`,
    );
  }
  const endSec =
    durationSeconds !== undefined
      ? Math.min(requestedEndSec, durationSeconds)
      : requestedEndSec;
  if (endSec <= startSec) {
    throw new Error(
      `the window [${params.start}–${params.end}] is empty after clamping to the media's duration`,
    );
  }
  return {
    startSec,
    endSec,
    withHours,
    ...(endSec < requestedEndSec ? { requestedEndSec } : {}),
  };
}

/** `00:01:00–00:02:00` label for the resolved window. */
export function formatWindowLabel(window: ResolvedContextWindow): string {
  return `${formatClockLabel(window.startSec, window.withHours)}–${formatClockLabel(window.endSec, window.withHours)}`;
}

/** One sentence naming what the window did NOT cover, or '' when the
 * caller got exactly the span it asked for. */
export function formatClampNote(window: ResolvedContextWindow): string {
  return window.requestedEndSec === undefined
    ? ''
    : ` The media ends at ${formatClockLabel(window.endSec, window.withHours)}, so the window was cut short of the requested ${formatClockLabel(window.requestedEndSec, window.withHours)}.`;
}

/** Dimensions the fit-inside scale filter will actually deliver, or ''
 * when the probe reported no source size (the box filter's output is then
 * indeterminate and claiming a number would be a guess). */
export function formatDeliveredDimensions(
  width: number | undefined,
  height: number | undefined,
  maxDimension: number,
): string {
  if (!width || !height) return '';
  const factor = Math.min(1, maxDimension / Math.max(width, height));
  return `${Math.round(width * factor)}×${Math.round(height * factor)}`;
}

/**
 * Run `body` against a private scratch directory that is removed on the
 * way out. These tools own no output directory: their result travels in
 * the model's context, so the files are pure intermediates and any bytes
 * that must survive have to be read INSIDE the callback.
 */
export async function withContextMediaScratchDir<T>(
  prefix: string,
  body: (scratchDir: string) => Promise<T>,
): Promise<T> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await body(scratchDir);
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Read a produced file into an `inlineData` Part. The omni tool-result
 * hook uploads these and rewrites them into presigned `fileData` parts —
 * inline base64 is the transport of last resort, never the intent.
 */
export async function inlineMediaPart(
  filePath: string,
  mimeType: string,
  displayName: string,
): Promise<Part> {
  const bytes = await fs.readFile(filePath);
  return {
    inlineData: { mimeType, data: bytes.toString('base64'), displayName },
  };
}
