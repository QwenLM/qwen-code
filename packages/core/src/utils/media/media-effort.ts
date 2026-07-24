/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MediaEffort } from './types.js';

/**
 * P3 · Effort → implementation mapping (贯穿件的落实).
 *
 * P1 reserved an `effort` knob on the read params; this is where a knob value
 * turns into concrete "cheap-enough vs finer-and-costlier" implementation
 * choices. One ladder drives every reader: how many keyframes to sample, the
 * pixel cap per frame, how many segments a long video is split into, and the
 * image downscale multiplier. Higher effort = more detail, more tokens.
 *
 * The scaffold default is `medium` — a knob left unset never means "unbounded".
 */

export interface EffortBudget {
  /** Keyframes to sample per read/segment. */
  maxFrames: number;
  /** Longest-edge pixel cap for extracted frames. */
  frameLongEdge: number;
  /** Multiplier applied to the provider image long-edge cap (≤1 shrinks). */
  imageLongEdgeScale: number;
  /** Default number of segments per 30s of video for divide-and-conquer. */
  segmentsPer30s: number;
}

const LADDER: Record<MediaEffort, EffortBudget> = {
  low: {
    maxFrames: 4,
    frameLongEdge: 512,
    imageLongEdgeScale: 0.66,
    segmentsPer30s: 0.5,
  },
  medium: {
    maxFrames: 8,
    frameLongEdge: 768,
    imageLongEdgeScale: 1,
    segmentsPer30s: 1,
  },
  high: {
    maxFrames: 16,
    frameLongEdge: 1024,
    imageLongEdgeScale: 1,
    segmentsPer30s: 2,
  },
  xhigh: {
    maxFrames: 24,
    frameLongEdge: 1280,
    imageLongEdgeScale: 1,
    segmentsPer30s: 3,
  },
  max: {
    maxFrames: 32,
    frameLongEdge: 1568,
    imageLongEdgeScale: 1,
    segmentsPer30s: 4,
  },
};

export const DEFAULT_MEDIA_EFFORT: MediaEffort = 'medium';

/** Resolve an effort value (undefined → the scaffold default) to a budget. */
export function effortBudget(effort: MediaEffort | undefined): EffortBudget {
  return LADDER[effort ?? DEFAULT_MEDIA_EFFORT];
}
