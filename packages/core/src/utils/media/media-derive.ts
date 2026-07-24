/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { Config } from '../../config/config.js';
import type { ToolResult } from '../../tools/tools.js';
import { getMaxInlineMediaBytes } from '../../core/inlineMediaLimit.js';
import { getMediaMemory } from '../../memory/media/media-memory-store.js';
import { computeAutoLinks } from '../../memory/media/media-links.js';
import { getMediaDerivedDir } from '../../memory/media/media-paths.js';
import { extractKeyframes } from './keyframe-extractor.js';
import {
  extractClip,
  extractAudioTrack,
  type ClipResult,
} from './ffmpeg-tools.js';
import { effortBudget } from './media-effort.js';
import { probeMedia, hashBuffer } from './probe.js';
import { buildMediaDelivery, buildMediaError } from './media-result.js';
import { MediaReadError } from './reader-registry.js';
import type { MediaEffort, Modality, MediaProbe } from './types.js';

/**
 * P4 · Explicit derivation with a first-class derived-artifact cache.
 *
 * `media_extract` produces a concrete artifact (keyframes / audio track / clip)
 * from a source file using ffmpeg locally — no model in the loop. Each artifact
 * is written to the content-addressed derived store, registered in media memory
 * as its own media object linked back to the source (`derivedFrom`), and
 * delivered to the model (inline when it fits) with a C10 note. Because the
 * store is content-addressed, re-deriving the same window is a cheap cache hit.
 *
 * `transcript` needs understanding (ASR), so it is not handled here — the tool
 * routes it to the delegated read path instead.
 */

export type DeriveMode = 'keyframes' | 'audio_track' | 'clip';

export interface DeriveInput {
  filePath: string;
  mode: DeriveMode;
  range?: [number, number];
  effort?: MediaEffort;
  config: Config;
  signal: AbortSignal;
}

interface DerivedArtifact {
  hash: string;
  storedPath: string;
  bytes: Buffer;
  mimeType: string;
  modality: Modality;
  label: string;
}

async function writeDerived(
  bytes: Buffer,
  ext: string,
): Promise<{ hash: string; storedPath: string }> {
  const hash = hashBuffer(bytes);
  const dir = getMediaDerivedDir();
  await fs.mkdir(dir, { recursive: true });
  const storedPath = path.join(dir, `${hash}.${ext}`);
  // Content-addressed: if it already exists, the bytes are identical — skip.
  try {
    await fs.access(storedPath);
  } catch {
    await fs.writeFile(storedPath, bytes);
  }
  return { hash, storedPath };
}

/** Register a derived artifact as its own media memory record, linked to source. */
async function rememberDerived(
  artifact: DerivedArtifact,
  source: MediaProbe,
  detail: string,
): Promise<void> {
  const memory = getMediaMemory();
  const links = computeAutoLinks(
    {
      hash: artifact.hash,
      path: artifact.storedPath,
      derivedFrom: source.hash,
    },
    await memory.list(),
  );
  await memory.put({
    hash: artifact.hash,
    modality: artifact.modality,
    path: artifact.storedPath,
    summary: `${artifact.label} (derived from ${path.basename(source.path)})`,
    body: detail,
    readerId: 'media-extract',
    links,
  });
}

function inlinePart(bytes: Buffer, mimeType: string, name: string): Part {
  return {
    inlineData: { data: bytes.toString('base64'), mimeType, displayName: name },
  };
}

/** Run a local ffmpeg derivation and return a self-describing (C10) ToolResult. */
export async function deriveMediaArtifact(
  input: DeriveInput,
): Promise<ToolResult> {
  let source: MediaProbe;
  try {
    source = await probeMedia(input.filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildMediaError({
      kind: message.includes('Unsupported media type')
        ? 'unsupported-format'
        : 'path-problem',
      message,
      remedy: 'Provide a readable image/audio/video file.',
    });
  }

  const budget = effortBudget(input.effort);
  const rangeNote = input.range
    ? ` t=${input.range[0]}s–${input.range[1]}s`
    : '';

  try {
    if (input.mode === 'keyframes') {
      if (source.modality !== 'video') {
        throw new MediaReadError(
          'unsupported-format',
          `keyframes extraction needs a video; ${input.filePath} is ${source.modality}.`,
          'Use mode "clip"/"audio_track", or provide a video.',
        );
      }
      const frames = await extractKeyframes(source, {
        ...(input.range ? { range: input.range } : {}),
        maxFrames: budget.maxFrames,
        longEdge: budget.frameLongEdge,
        signal: input.signal,
      });
      // Each keyframe is a first-class derived image with its own hash + record.
      const parts: Part[] = [];
      for (let i = 0; i < frames.parts.length; i++) {
        const p = frames.parts[i];
        const b64 = p.inlineData?.data;
        if (!b64) continue;
        const bytes = Buffer.from(b64, 'base64');
        const { hash, storedPath } = await writeDerived(bytes, 'jpg');
        await rememberDerived(
          {
            hash,
            storedPath,
            bytes,
            mimeType: 'image/jpeg',
            modality: 'image',
            label: `keyframe ${i + 1}${rangeNote}`,
          },
          source,
          `Keyframe ${i + 1} extracted from ${path.basename(source.path)}${rangeNote}.`,
        );
        parts.push(inlinePart(bytes, 'image/jpeg', `keyframe-${i + 1}.jpg`));
      }
      return buildMediaDelivery(parts, {
        path: source.path,
        hash: source.hash,
        modality: 'video',
        scope: `${parts.length} keyframes${rangeNote}`,
        precision: `LOSSY: still frames only, downscaled to ${frames.longEdge}px. Each frame saved as an independent media file (see media_grep).`,
        readMore:
          'Use media_watch with a range for motion+audio, or a narrower range for denser keyframes.',
      });
    }

    // audio_track / clip both yield a single media file.
    let result: ClipResult;
    let artifactModality: Modality;
    let label: string;
    if (input.mode === 'audio_track') {
      result = await extractAudioTrack(source, {
        ...(input.range ? { range: input.range } : {}),
        signal: input.signal,
      });
      artifactModality = 'audio';
      label = `audio track${rangeNote}`;
    } else {
      if (!input.range) {
        throw new MediaReadError(
          'no-capability',
          'clip mode requires a range [startSeconds, endSeconds].',
          'Pass a range, or use audio_track/keyframes for a whole-file derivation.',
        );
      }
      result = await extractClip(source, {
        range: input.range,
        maxLongEdge: budget.frameLongEdge * 2,
        signal: input.signal,
      });
      artifactModality = source.modality === 'video' ? 'video' : 'audio';
      label = `${source.modality} clip${rangeNote}`;
    }

    const { hash, storedPath } = await writeDerived(result.buffer, result.ext);
    await rememberDerived(
      {
        hash,
        storedPath,
        bytes: result.buffer,
        mimeType: result.mimeType,
        modality: artifactModality,
        label,
      },
      source,
      `${label} extracted from ${path.basename(source.path)}; saved to ${storedPath}.`,
    );

    const fitsInline = result.buffer.length <= getMaxInlineMediaBytes();
    const content: Part[] = fitsInline
      ? [inlinePart(result.buffer, result.mimeType, `${label}.${result.ext}`)]
      : [
          {
            text: `Derived ${label} saved to ${storedPath} (${(result.buffer.length / 1048576).toFixed(1)}MB — too large to inline). Read it with media_watch, or extract a narrower range.`,
          },
        ];
    return buildMediaDelivery(content, {
      path: source.path,
      hash: source.hash,
      modality: source.modality,
      scope: `${label}${fitsInline ? ' (inlined)' : ' (saved to disk)'}`,
      precision: `re-encoded to ${result.mimeType}; saved as an independent media file (hash ${hash.slice(0, 12)}).`,
      readMore: fitsInline
        ? 'Request a different range, or the whole file via media_watch.'
        : `The clip is on disk; media_watch ${storedPath} to view it.`,
    });
  } catch (err) {
    if (err instanceof MediaReadError) {
      return buildMediaError({
        kind: err.kind,
        message: err.message,
        remedy: err.remedy,
      });
    }
    return buildMediaError({
      kind: 'no-capability',
      message: `media_extract failed: ${err instanceof Error ? err.message : String(err)}`,
      remedy: 'Ensure ffmpeg is installed and on PATH.',
    });
  }
}
