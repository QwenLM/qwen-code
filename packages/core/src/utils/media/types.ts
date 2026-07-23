/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReasoningEffort } from '../../core/reasoning-effort.js';

/**
 * Shared skeleton types for the unified multimodal layer.
 *
 * These are A-class (必备基建): the shape of a "look/listen" primitive does not
 * change when the concrete implementation behind it changes. Everything that
 * varies by model/provider/method is pushed out to config-selected plugins.
 */

/** Modalities the media layer reasons about. */
export type Modality = 'image' | 'audio' | 'video';

/**
 * The effort / precision knob is the same ladder the rest of the harness uses
 * for reasoning effort — one knob for the "cheap-enough vs finer-and-costlier"
 * tradeoff (信念三). Re-exported so media callers do not import from `core/`.
 */
export type MediaEffort = ReasoningEffort;

/** Deterministic facts about a media file, produced by probe (模型无感). */
export interface MediaProbe {
  /** Absolute, resolved path to the source file. */
  path: string;
  /** Content-addressed identity (sha256 hex). Same bytes => same hash. */
  hash: string;
  modality: Modality;
  mimeType: string;
  /** Size of the source file in bytes. */
  sizeBytes: number;
  /** Duration in seconds for audio/video, when known. */
  durationSec?: number;
  /** Pixel dimensions for image/video, when known. */
  width?: number;
  height?: number;
  /** Whether a video carries an audio track, when known. */
  hasAudio?: boolean;
}

/** Rough cost estimate for a read, used by capability gating and effort. */
export interface CostEstimate {
  /** Estimated model tokens this delivery would consume. */
  tokens: number;
  /** Human-readable note, e.g. "≈1.2k tokens (native inline)". */
  note: string;
}
