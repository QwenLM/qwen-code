/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import type { Config } from '../../config/config.js';
import { getResponseText } from '../partUtils.js';
import { getMediaMemory } from '../../memory/media/media-memory-store.js';
import { computeAutoLinks } from '../../memory/media/media-links.js';
import { extractKeyframes } from './keyframe-extractor.js';
import { probeMedia } from './probe.js';
import { MediaReadError } from './reader-registry.js';
import type { MediaProbe } from './types.js';

/**
 * media_dispatch — parallel time-segment understanding.
 *
 * A long video is split into time segments; each segment is understood
 * independently and in parallel by a lightweight one-shot understanding call
 * (keyframes for that range → the model describes them). Notes are aggregated
 * and recorded in cross-session media memory.
 *
 * This runs regardless of whether the *main* model is multimodal: the per-
 * segment understanding uses the main model itself when it can ingest images,
 * otherwise a configured vision model. So a multimodal main model still benefits
 * from parallel divide-and-conquer over a long video (U4 was "reuse existing
 * parallel primitives"; this is the explicit media-native version the caller
 * asked for).
 */

export interface DispatchOptions {
  /** Number of time segments; defaults to ~1 per 30s, clamped to [1, 12]. */
  segments?: number;
  /** Keyframes sampled per segment. */
  framesPerSegment?: number;
  /** Max concurrent segment understandings. */
  concurrency?: number;
  signal: AbortSignal;
}

export interface SegmentUnderstanding {
  index: number;
  range: [number, number];
  note: string;
  frameCount: number;
}

export interface DispatchResult {
  segments: SegmentUnderstanding[];
  model: string;
  durationSec: number;
  hash: string;
  path: string;
}

const DEFAULT_FRAMES_PER_SEGMENT = 6;
const DEFAULT_CONCURRENCY = 3;
const MAX_SEGMENTS = 12;

/** Pick an image-capable model: the main model when multimodal, else a vision model. */
function pickUnderstandingModel(config: Config): string | undefined {
  if (config.getEffectiveInputModalities().image === true) {
    return config.getModel();
  }
  return config.getDefaultVisionBridgeModel()?.id;
}

function segmentRanges(
  durationSec: number,
  count: number,
): Array<[number, number]> {
  const len = durationSec / count;
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const start = +(i * len).toFixed(3);
    const end = +Math.min((i + 1) * len, durationSec).toFixed(3);
    ranges.push([start, end]);
  }
  return ranges;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(pool);
  return results;
}

function segmentPrompt(range: [number, number], durationSec: number): string {
  return (
    `These keyframes are sampled from the video segment t=${range[0]}s–${range[1]}s ` +
    `(of a ${Math.round(durationSec)}s video). Describe concisely and factually what ` +
    `happens in this segment: key objects, actions, on-screen text, scene changes. ` +
    `Only describe what the frames actually show; do not speculate.`
  );
}

async function understandSegment(
  probe: MediaProbe,
  range: [number, number],
  index: number,
  model: string,
  framesPerSegment: number,
  config: Config,
  signal: AbortSignal,
): Promise<SegmentUnderstanding> {
  try {
    const frames = await extractKeyframes(probe, {
      range,
      maxFrames: framesPerSegment,
      signal,
    });
    const parts: Part[] = [
      ...frames.parts,
      { text: segmentPrompt(range, probe.durationSec ?? 0) },
    ];
    const contents: Content[] = [{ role: 'user', parts }];
    const response = await config
      .getGeminiClient()
      .generateContent(
        contents,
        {},
        signal,
        model,
        `media-dispatch-${probe.hash.slice(0, 8)}-seg${index}`,
      );
    const note =
      getResponseText(response)?.trim() || '(no description returned)';
    return { index, range, note, frameCount: frames.frameCount };
  } catch (err) {
    return {
      index,
      range,
      note: `(segment failed: ${err instanceof Error ? err.message : String(err)})`,
      frameCount: 0,
    };
  }
}

/** Run the parallel segment understanding and record the combined result in memory. */
export async function dispatchMediaSegments(
  filePath: string,
  config: Config,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const probe = await probeMedia(filePath);
  if (probe.modality !== 'video') {
    throw new MediaReadError(
      'unsupported-format',
      `media_dispatch handles video; ${filePath} is ${probe.modality}.`,
      'Use media_watch for a single image/audio file.',
    );
  }
  const durationSec = probe.durationSec;
  if (!durationSec || durationSec <= 0) {
    throw new MediaReadError(
      'no-capability',
      `Cannot determine the duration of ${filePath} (is ffprobe installed?).`,
      'Install ffmpeg/ffprobe so the video can be segmented, or use media_watch.',
    );
  }
  const model = pickUnderstandingModel(config);
  if (!model) {
    throw new MediaReadError(
      'no-capability',
      'No image-capable model is available to understand the video segments.',
      'Use a multimodal main model, or configure a vision model (visionModel setting).',
    );
  }

  const count = Math.max(
    1,
    Math.min(opts.segments ?? Math.ceil(durationSec / 30), MAX_SEGMENTS),
  );
  const framesPerSegment = opts.framesPerSegment ?? DEFAULT_FRAMES_PER_SEGMENT;
  const ranges = segmentRanges(durationSec, count);

  const segments = await mapWithConcurrency(
    ranges,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    (range, index) =>
      understandSegment(
        probe,
        range,
        index,
        model,
        framesPerSegment,
        config,
        opts.signal,
      ),
  );

  // Record the combined understanding in cross-session memory (增厚).
  try {
    const memory = getMediaMemory();
    const links = computeAutoLinks(
      { hash: probe.hash, path: probe.path },
      await memory.list(),
    );
    const body = segments
      .map(
        (s) =>
          `### Segment ${s.index + 1} · t=${s.range[0]}s–${s.range[1]}s (${s.frameCount} frames)\n${s.note}`,
      )
      .join('\n\n');
    await memory.put({
      hash: probe.hash,
      modality: 'video',
      path: probe.path,
      summary: `parallel understanding of ${count} segments over ${Math.round(durationSec)}s`,
      body,
      readerId: 'media-dispatch',
      cost: `${count} segment model calls`,
      params: { segments: count, model },
      links,
    });
  } catch {
    // Memory is best-effort; never fail the dispatch on a persistence hiccup.
  }

  return { segments, model, durationSec, hash: probe.hash, path: probe.path };
}
