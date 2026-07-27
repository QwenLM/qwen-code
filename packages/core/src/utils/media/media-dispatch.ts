/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { Config } from '../../config/config.js';
import { getResponseText } from '../partUtils.js';
import { getMediaMemory } from '../../memory/media/media-memory-store.js';
import { computeAutoLinks } from '../../memory/media/media-links.js';
import { effortBudget } from './media-effort.js';
import { MediaReadError } from './reader-registry.js';
import { resolveAndProbe } from './media-source.js';
import { readMediaParts } from './media-orchestrator.js';
import type { MediaEffort, MediaProbe } from './types.js';

/**
 * media_dispatch — parallel time-segment understanding (strategy S2).
 *
 * Pure orchestration ABOVE the Seam A read trunk: a long video is split into
 * time segments, each segment's media is acquired through the shared trunk
 * (`readMediaParts` → probe→registry.pick→reader.read, so a capable model gets
 * the segment 原生全保真 and others get keyframes — the trunk decides, dispatch
 * does not reinvent it), each is understood by a one-shot model call, and the
 * notes are reduced and recorded in cross-session media memory.
 *
 * Runs regardless of whether the *main* model is multimodal: the per-segment
 * understanding uses the main model when it can ingest images, otherwise a
 * configured vision model (the trunk is read under that model's capabilities).
 */

export interface DispatchOptions {
  /** Number of time segments; defaults to ~1 per 30s, clamped to [1, 12]. */
  segments?: number;
  /** Keyframes sampled per segment. */
  framesPerSegment?: number;
  /** Max concurrent segment understandings. */
  concurrency?: number;
  /**
   * What to extract per segment (the understanding instruction). Defaults to a
   * generic factual description; set it to target specific information
   * (e.g. "identify any team/brand/studio/logo/credits shown"). Caching is
   * keyed by (file, prompt): the same prompt is recalled instantly, a new
   * prompt runs a fresh targeted analysis that accumulates into memory.
   */
  prompt?: string;
  /** Re-analyze even if a prior understanding for this prompt exists. */
  force?: boolean;
  /** Detail/cost tradeoff: scales segment count and frames per segment. */
  effort?: MediaEffort;
  signal: AbortSignal;
}

export interface SegmentUnderstanding {
  index: number;
  range: [number, number];
  note: string;
  /** Media parts shown for this segment (keyframes → N frames; native clip → 1). */
  frameCount: number;
}

export interface DispatchResult {
  segments: SegmentUnderstanding[];
  model: string;
  durationSec: number;
  hash: string;
  path: string;
  /** True when the result was recalled from media memory (no re-analysis). */
  fromMemory?: boolean;
  /** The accumulated understanding text, when recalled from memory. */
  memoryBody?: string;
}

const DEFAULT_CONCURRENCY = 3;
const MAX_SEGMENTS = 12;
const DEFAULT_FOCUS_KEY = 'overview';

/** Normalize a prompt into a stable cache key (per-file, per-question). */
function focusKeyOf(prompt: string | undefined): string {
  const t = (prompt ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return t.length > 0 ? t.slice(0, 80) : DEFAULT_FOCUS_KEY;
}

/** Pick an image-capable model: the main model when multimodal, else a vision model. */
function pickUnderstandingModel(config: Config): string | undefined {
  if (config.getEffectiveInputModalities().image === true) {
    return config.getModel();
  }
  return config.getDefaultVisionBridgeModel()?.id;
}

/**
 * A capability view of the config for reading segments under the *understanding*
 * model. When the main model can ingest images we read under the real config (so
 * an omni main model yields native clips, an image-only one yields keyframes —
 * the trunk decides). When we bridge to a vision model, we present an
 * image-capable view so the trunk serves keyframes for that vision model.
 */
function understandingConfigView(
  config: Config,
  model: string,
  mainImageCapable: boolean,
): Config {
  if (mainImageCapable) return config;
  return new Proxy(config, {
    get(target, prop, receiver) {
      if (prop === 'getEffectiveInputModalities') {
        return () => ({ image: true });
      }
      if (prop === 'getModel') return () => model;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Config;
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

function segmentPrompt(
  range: [number, number],
  durationSec: number,
  focus: string,
): string {
  const base = `This is the video segment t=${range[0]}s–${range[1]}s (of a ${Math.round(durationSec)}s video).`;
  const instruction =
    focus.length > 0
      ? focus
      : 'Describe concisely and factually what happens in this segment: key objects, actions, on-screen text, scene changes.';
  return `${base} ${instruction} Only describe what is actually shown; do not speculate.`;
}

async function understandSegment(
  probe: MediaProbe,
  range: [number, number],
  index: number,
  model: string,
  readConfig: Config,
  focus: string,
  effort: MediaEffort | undefined,
  config: Config,
  signal: AbortSignal,
): Promise<SegmentUnderstanding> {
  try {
    // Segment media comes from the trunk: native clip when the model can watch
    // video, keyframes otherwise — decided in one place, not here.
    const mediaParts = await readMediaParts(
      probe,
      { range, ...(effort ? { effort } : {}) },
      readConfig,
      signal,
    );
    const frameCount = mediaParts.filter(
      (p) => p.inlineData || p.fileData,
    ).length;
    const parts: Part[] = [
      ...mediaParts,
      { text: segmentPrompt(range, probe.durationSec ?? 0, focus) },
    ];
    const response = await config
      .getGeminiClient()
      .generateContent(
        [{ role: 'user', parts }],
        {},
        signal,
        model,
        `media-dispatch-${probe.hash.slice(0, 8)}-seg${index}`,
      );
    const note =
      getResponseText(response)?.trim() || '(no description returned)';
    return { index, range, note, frameCount };
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
  // Resolve (URL/file:// → local) and probe through the shared trunk entry.
  const { probe } = await resolveAndProbe(filePath, opts.signal);
  if (probe.modality !== 'video') {
    throw new MediaReadError(
      'unsupported-format',
      `media_dispatch handles video; ${filePath} is ${probe.modality}.`,
      'Use media_watch for a single image/audio file.',
    );
  }

  const focus = (opts.prompt ?? '').trim();
  const focusKey = focusKeyOf(opts.prompt);
  const budget = effortBudget(opts.effort);

  // Cache-first, keyed by (content hash, prompt): a prior understanding for THIS
  // question is returned instantly so a new session does not redo it. A new/
  // different prompt is a cache miss and runs a fresh targeted analysis that
  // accumulates into the same file's memory. Pass force to always re-analyze.
  if (!opts.force) {
    const prior = await getMediaMemory()
      .get(probe.hash)
      .catch(() => undefined);
    if (prior?.body?.includes(`[dispatch-focus] ${focusKey}`)) {
      return {
        segments: [],
        model: '(recalled from memory)',
        durationSec: probe.durationSec ?? 0,
        hash: probe.hash,
        path: probe.path,
        fromMemory: true,
        memoryBody: prior.body,
      };
    }
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
    Math.min(
      opts.segments ?? Math.ceil((durationSec / 30) * budget.segmentsPer30s),
      MAX_SEGMENTS,
    ),
  );
  const ranges = segmentRanges(durationSec, count);
  const mainImageCapable = config.getEffectiveInputModalities().image === true;
  const readConfig = understandingConfigView(config, model, mainImageCapable);

  const segments = await mapWithConcurrency(
    ranges,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    (range, index) =>
      understandSegment(
        probe,
        range,
        index,
        model,
        readConfig,
        focus,
        opts.effort,
        config,
        opts.signal,
      ),
  );

  // Record the combined understanding in cross-session memory (增厚). The
  // `[dispatch-focus]` marker keys this analysis to its prompt so the same
  // question can be recalled without re-work while new questions still run.
  try {
    const memory = getMediaMemory();
    const links = computeAutoLinks(
      { hash: probe.hash, path: probe.path },
      await memory.list(),
    );
    const header = `[dispatch-focus] ${focusKey}\nquestion: ${focus || '(general overview)'}`;
    const body =
      header +
      '\n\n' +
      segments
        .map(
          (s) =>
            `### Segment ${s.index + 1} · t=${s.range[0]}s–${s.range[1]}s (${s.frameCount} part(s))\n${s.note}`,
        )
        .join('\n\n');
    await memory.put({
      hash: probe.hash,
      modality: 'video',
      path: probe.path,
      summary: `${focus || 'overview'} — ${count} segments over ${Math.round(durationSec)}s`,
      body,
      readerId: 'media-dispatch',
      cost: `${count} segment model calls`,
      params: { segments: count, model, focus: focusKey },
      links,
    });
  } catch {
    // Memory is best-effort; never fail the dispatch on a persistence hiccup.
  }

  return { segments, model, durationSec, hash: probe.hash, path: probe.path };
}
