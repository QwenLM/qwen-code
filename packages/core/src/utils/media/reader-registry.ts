/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import type { Config } from '../../config/config.js';
import type {
  CostEstimate,
  MediaEffort,
  MediaProbe,
  Modality,
} from './types.js';
import type { MediaErrorKind } from './media-result.js';

/**
 * P1 · Reader Registry (Seam A) — the socket for reading implementations.
 *
 * The skeleton locks two things only, and they rarely change:
 *  1. The `MediaReader` interface + registry API (the socket shape).
 *  2. Two generic executors, one per `ReaderKind`:
 *     - `native`   — emits native Parts straight into the model's view.
 *     - `delegated`— hands the understanding task to an externally-declared
 *                    capability (subagent / mcp / command) and returns notes.
 *
 * OCR / ASR / dense-caption / watcher are all `delegated` — they differ only by
 * declaration, never by a new core class. Swapping the model behind a delegated
 * reader is a config/`.md` edit; core does not move (信念三).
 */

export type ReaderKind = 'native' | 'delegated';

/** Parameters a reader may act on. Which of these the model can set is decided
 *  by the decision policy (see decision-policy.ts); scaffold fills the rest. */
export interface MediaReadParams {
  /** Time range in seconds [start, end] for audio/video. */
  range?: [number, number];
  /** Frames per second to sample for video. */
  fps?: number;
  /** Crop region [x, y, width, height] in pixels for image. */
  region?: [number, number, number, number];
  /** Downscale factor (0,1] for image. */
  scale?: number;
  /** Effort / precision knob for this read. */
  effort?: MediaEffort;
  /** Free-form intent forwarded to delegated backends. */
  intent?: string;
}

export interface MediaReadContext {
  config: Config;
  signal: AbortSignal;
}

export interface MediaReadResult {
  /** Native media Parts and/or delegated text notes to hand back to the model. */
  content: PartListUnion;
  /** What was delivered this turn (feeds C10 `scope`). */
  scope: string;
  /** Fidelity note (feeds C10 `precision`; must state any lossy step). */
  precision: string;
  cost?: CostEstimate;
  /** How to obtain more detail (feeds C10 `readMore`). */
  readMore?: string;
}

export interface MediaReader {
  id: string;
  kind: ReaderKind;
  modalities: Modality[];
  /** Deterministic capability gate. Returns false => this reader can't run now. */
  isAvailable(probe: MediaProbe, ctx: MediaReadContext): boolean;
  estimateCost(probe: MediaProbe, params: MediaReadParams): CostEstimate;
  read(
    probe: MediaProbe,
    params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<MediaReadResult>;
}

/**
 * A `delegated` reader's backend, given as a declaration (data), kept out of
 * core — mirrors the skills/agents "file is the definition" pattern. Changing
 * the OCR/ASR model is editing `model`/`ref` here, never a core class.
 */
export interface ReaderBackendSpec {
  id: string;
  via: 'subagent' | 'mcp' | 'command';
  /** subagent `.md` name / MCP tool name / command template. */
  ref: string;
  /** Model override — the one line you change to swap models. */
  model?: string;
  modalities?: Modality[];
}

export interface ReaderRegistry {
  register(reader: MediaReader): void;
  /** All readers that can currently run for this modality (capability-gated). */
  available(
    modality: Modality,
    probe: MediaProbe,
    ctx: MediaReadContext,
  ): MediaReader[];
  /** Pick one reader; undefined means the capability gate is closed. */
  pick(
    modality: Modality,
    probe: MediaProbe,
    ctx: MediaReadContext,
    preferredId?: string,
  ): MediaReader | undefined;
}

/**
 * A fail-closed error a reader throws when it cannot deliver. Tools catch it and
 * render a C10 error (with remedy). Never swallow this into a bare result.
 */
export class MediaReadError extends Error {
  constructor(
    readonly kind: MediaErrorKind,
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = 'MediaReadError';
  }
}

class DefaultReaderRegistry implements ReaderRegistry {
  private readonly readers: MediaReader[] = [];

  register(reader: MediaReader): void {
    // Last registration for an id wins, so config can override a built-in.
    const existing = this.readers.findIndex((r) => r.id === reader.id);
    if (existing >= 0) {
      this.readers[existing] = reader;
    } else {
      this.readers.push(reader);
    }
  }

  available(
    modality: Modality,
    probe: MediaProbe,
    ctx: MediaReadContext,
  ): MediaReader[] {
    return this.readers.filter(
      (r) => r.modalities.includes(modality) && r.isAvailable(probe, ctx),
    );
  }

  pick(
    modality: Modality,
    probe: MediaProbe,
    ctx: MediaReadContext,
    preferredId?: string,
  ): MediaReader | undefined {
    const candidates = this.available(modality, probe, ctx);
    if (preferredId) {
      const preferred = candidates.find((r) => r.id === preferredId);
      if (preferred) return preferred;
    }
    // Prefer native (the model seeing bytes directly) when it is available;
    // otherwise fall back to the first available delegated reader.
    return (
      candidates.find((r) => r.kind === 'native') ?? candidates[0] ?? undefined
    );
  }
}

export function createReaderRegistry(): ReaderRegistry {
  return new DefaultReaderRegistry();
}
