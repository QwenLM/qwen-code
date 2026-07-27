/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Part } from '@google/genai';
import {
  determineUploader,
  UploadNotConfiguredError,
} from '../../../core/media/uploader.js';
import { decideTransport } from '../../../core/media/transport-decider.js';
import {
  estimateModalityTokens,
  getMediaProfile,
} from '../../../core/media/provider-media-profiles.js';
import { getMaxInlineMediaBytes } from '../../../core/inlineMediaLimit.js';
import { extractKeyframes } from '../keyframe-extractor.js';
import { effortBudget } from '../media-effort.js';
import {
  transformImage,
  extractClip,
  extractAudioTrack,
  type ImageTransformParams,
} from '../ffmpeg-tools.js';
import type {
  MediaReadContext,
  MediaReader,
  MediaReadParams,
  MediaReadResult,
} from '../reader-registry.js';
import { MediaReadError } from '../reader-registry.js';
import type { CostEstimate, MediaProbe, Modality } from '../types.js';

/**
 * P1 · Native passthrough reader (the one built-in reader).
 *
 * When the primary model can natively ingest the modality, this reader puts the
 * bytes into the model's view via the existing tool-result media path. It now
 * honors the refinement knobs (region/scale for images, range/fps for a/v) by
 * transforming the source with ffmpeg before delivery, and applies the provider
 * image downscale cap — every reduction is declared in the C10 precision note
 * (零静默降质). Transport and profile choices live in `core/media`.
 */

const MODALITY_TO_INPUT_KEY: Record<Modality, 'image' | 'audio' | 'video'> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
};

function costFor(
  probe: MediaProbe,
  config: MediaReadContext['config'],
): CostEstimate {
  const profile = getMediaProfile(config);
  const units = probe.durationSec ?? 1;
  const tokens = estimateModalityTokens(profile, probe.modality, units);
  return { tokens, note: `≈${tokens} tokens (native ${probe.modality})` };
}

function inlinePart(buffer: Buffer, mimeType: string, name: string): Part {
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType,
      displayName: name,
    },
  };
}

function fits(buffer: Buffer): boolean {
  return buffer.length <= getMaxInlineMediaBytes();
}

/**
 * Whether an audio mime type is directly ingestible on the inline audio channel
 * without transcoding. Providers' inline audio (OpenAI/DashScope `input_audio`)
 * accept only wav/mp3; everything else must be transcoded to mp3.
 */
function isInlineReadyAudio(mimeType: string): boolean {
  const m = mimeType.toLowerCase();
  return m.includes('wav') || m.includes('mp3') || m.includes('mpeg');
}

class NativeInlineReader implements MediaReader {
  readonly id = 'native-inline';
  readonly kind = 'native' as const;
  readonly modalities: Modality[] = ['image', 'audio', 'video'];

  isAvailable(probe: MediaProbe, ctx: MediaReadContext): boolean {
    const modalities = ctx.config.getEffectiveInputModalities();
    // Video is serviceable whenever the model can ingest video natively OR at
    // least images: an image-capable model sees a video via keyframes (原生代看,
    // the trunk owns this downgrade — strategies must not reinvent it).
    if (probe.modality === 'video') {
      return modalities.video === true || modalities.image === true;
    }
    return modalities[MODALITY_TO_INPUT_KEY[probe.modality]] === true;
  }

  estimateCost(probe: MediaProbe): CostEstimate {
    const units = probe.durationSec ?? 1;
    return {
      tokens: Math.ceil(units),
      note: `≈${Math.ceil(units)} unit(s) (native ${probe.modality})`,
    };
  }

  async read(
    probe: MediaProbe,
    params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<MediaReadResult> {
    if (probe.modality === 'image') {
      return this.readImage(probe, params, ctx);
    }
    return this.readAudioVideo(probe, params, ctx);
  }

  /**
   * Image path: apply crop (region) / downscale (scale) / provider long-edge cap
   * (effort-scaled), then inline as JPEG. When nothing needed reduction and the
   * original fits, the original bytes are delivered at full fidelity.
   */
  private async readImage(
    probe: MediaProbe,
    params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<MediaReadResult> {
    const profile = getMediaProfile(ctx.config);
    const budget = effortBudget(params.effort);
    const cap = Math.round(
      profile.imageMaxLongEdge * budget.imageLongEdgeScale,
    );
    const longEdge = Math.max(probe.width ?? 0, probe.height ?? 0);
    const originalBytes = await fs.readFile(probe.path);

    const needsCap = longEdge > 0 && longEdge > cap;
    const needsTransform =
      !!params.region || params.scale !== undefined || needsCap;

    if (!needsTransform && fits(originalBytes)) {
      return {
        content: inlinePart(
          originalBytes,
          probe.mimeType,
          path.basename(probe.path),
        ),
        scope: `full image (native inline)${longEdge ? `, ${probe.width}×${probe.height}` : ''}`,
        precision: 'original fidelity',
        cost: costFor(probe, ctx.config),
        readMore:
          'Full image delivered at original fidelity — nothing was omitted. To zoom, call image_view with a region.',
      };
    }

    const tParams: ImageTransformParams = { signal: ctx.signal };
    if (params.region) tParams.region = params.region;
    if (params.scale !== undefined) tParams.scale = params.scale;
    if (params.scale === undefined && (needsCap || !fits(originalBytes))) {
      tParams.maxLongEdge = cap;
    }
    const t = await transformImage(probe, tParams);
    if (!fits(t.buffer)) {
      // Still too big even after capping — cap harder to fit the inline limit.
      const smaller = await transformImage(probe, {
        ...tParams,
        maxLongEdge: Math.min(cap, 768),
        signal: ctx.signal,
      });
      if (fits(smaller.buffer)) {
        return this.imageResult(smaller, probe, ctx, true);
      }
      throw new MediaReadError(
        'over-budget',
        `${probe.path} is too large to inline even after downscaling.`,
        'Request a specific region of the image, or configure an upload backend.',
      );
    }
    return this.imageResult(t, probe, ctx, needsCap);
  }

  private imageResult(
    t: Awaited<ReturnType<typeof transformImage>>,
    probe: MediaProbe,
    ctx: MediaReadContext,
    fromCap: boolean,
  ): MediaReadResult {
    const dims = t.width && t.height ? ` (${t.width}×${t.height})` : '';
    return {
      content: inlinePart(
        t.buffer,
        t.mimeType,
        `${path.basename(probe.path)} · view`,
      ),
      scope: `image view${dims}`,
      precision: t.changed
        ? `LOSSY: ${t.appliedNote}${fromCap ? ' to fit the provider image budget' : ''} — the original is ${probe.width ?? '?'}×${probe.height ?? '?'}`
        : 'original fidelity (re-encoded to JPEG)',
      cost: costFor(probe, ctx.config),
      readMore:
        'Call image_view again with a smaller region (and/or higher effort) to inspect an area at more detail.',
    };
  }

  /**
   * Audio/video path: honor a time `range` by cutting a clip (video keeps
   * audio; falls back to keyframes when the clip is still too big), and an fps
   * request by sampling frames. Otherwise deliver the whole file (inline →
   * upload → keyframe fallback for video).
   */
  private async readAudioVideo(
    probe: MediaProbe,
    params: MediaReadParams,
    ctx: MediaReadContext,
  ): Promise<MediaReadResult> {
    const budget = effortBudget(params.effort);
    const cost = costFor(probe, ctx.config);

    // Capability downgrade owned by the trunk: a model that cannot ingest video
    // natively but can see images gets the video as keyframes (原生代看). This is
    // why S2/dispatch does not need its own keyframe path — it reads segments
    // through this reader and gets native clips or keyframes per capability.
    if (
      probe.modality === 'video' &&
      ctx.config.getEffectiveInputModalities().video !== true
    ) {
      return this.keyframeResult(probe, params.range, budget, ctx, params.fps);
    }

    // Explicit time window → cut a clip.
    if (params.range) {
      const [s, e] = params.range;
      try {
        const clip = await extractClip(probe, {
          range: params.range,
          maxLongEdge: budget.frameLongEdge * 2,
          signal: ctx.signal,
        });
        if (fits(clip.buffer)) {
          return {
            content: inlinePart(
              clip.buffer,
              clip.mimeType,
              `${path.basename(probe.path)} · ${s}s-${e}s`,
            ),
            scope: `${probe.modality} clip t=${s}s–${e}s (native inline)`,
            precision: `clipped to [${s}s, ${e}s] and re-encoded${probe.modality === 'video' ? `, downscaled to ≤${budget.frameLongEdge * 2}px` : ''}`,
            cost,
            readMore:
              'Request a different or narrower range, or omit range to read the whole file.',
          };
        }
        // Clip too big to inline: keyframes for the range (video only).
        if (probe.modality === 'video') {
          return this.keyframeResult(probe, params.range, budget, ctx);
        }
        throw new MediaReadError(
          'over-budget',
          `The audio clip t=${s}s–${e}s is still too large to inline.`,
          'Request a narrower range, or configure an upload backend.',
        );
      } catch (err) {
        if (err instanceof MediaReadError) throw err;
        throw new MediaReadError(
          'no-capability',
          `Failed to clip ${probe.path}: ${err instanceof Error ? err.message : String(err)}`,
          'Ensure ffmpeg is installed and on PATH, or read the whole file (omit range).',
        );
      }
    }

    // fps request on a video (no range) → sample frames across the whole video.
    if (params.fps !== undefined && probe.modality === 'video') {
      return this.keyframeResult(probe, undefined, budget, ctx, params.fps);
    }

    // Whole file: inline when it fits.
    const transport = decideTransport(probe, ctx.config);
    if (transport.mode === 'inline') {
      // Audio must be inlined in a broadly-ingestible container. Providers'
      // inline-audio channel only accepts wav/mp3 (OpenAI/DashScope input_audio),
      // so transcode other codecs (m4a/aac/ogg/flac/opus/…) to mp3 — otherwise
      // the request converter silently drops the audio (零静默降质).
      if (probe.modality === 'audio' && !isInlineReadyAudio(probe.mimeType)) {
        try {
          const mp3 = await extractAudioTrack(probe, { signal: ctx.signal });
          if (fits(mp3.buffer)) {
            return {
              content: inlinePart(
                mp3.buffer,
                mp3.mimeType,
                `${path.basename(probe.path)}.mp3`,
              ),
              scope: 'full audio (native inline, transcoded to mp3)',
              precision: `re-encoded from ${probe.mimeType} to audio/mpeg so the provider can ingest it (container change; audio content preserved)`,
              cost,
              readMore:
                'Full track delivered; re-encoded to mp3 for provider compatibility.',
            };
          }
          // Transcoded track still too big to inline → oversized handling below.
        } catch {
          // ffmpeg unavailable/failed: fall through to inlining the original,
          // which some providers (e.g. Gemini) can still ingest.
        }
      }
      const bytes = await fs.readFile(probe.path);
      return {
        content: inlinePart(bytes, probe.mimeType, path.basename(probe.path)),
        scope: `full ${probe.modality} (native inline)`,
        precision: 'original fidelity',
        cost,
        readMore:
          'Full file delivered natively at original fidelity — nothing was omitted.',
      };
    }

    // Too large: upload only when the provider can actually consume THIS
    // modality by reference. Uploading audio for a provider whose request path
    // only takes image/video URLs would strand the bytes behind a URL that gets
    // dropped downstream — so gate on the per-modality capability, not just
    // supportsFileUri, and otherwise fall back / fail closed with a remedy.
    const profile = getMediaProfile(ctx.config);
    if (profile.fileUriModalities.includes(probe.modality)) {
      const uploader = determineUploader(ctx.config);
      try {
        const uploaded = await uploader.upload(probe);
        return {
          content: {
            fileData: {
              fileUri: uploaded.fileUri,
              mimeType: uploaded.mimeType,
            },
          },
          scope: `full ${probe.modality} (native, uploaded)`,
          precision: 'original fidelity',
          cost,
          readMore: 'Delivered by reference to the uploaded file.',
        };
      } catch (err) {
        if (!(err instanceof UploadNotConfiguredError)) throw err;
        return this.oversizedFallback(probe, params, budget, ctx, err.remedy);
      }
    }
    return this.oversizedFallback(
      probe,
      params,
      budget,
      ctx,
      probe.modality === 'audio'
        ? 'This provider cannot ingest audio by URL. Read a specific time range with media_watch(range=…) so a clip fits inline, or media_extract(mode="transcript") for the whole track.'
        : 'Configure a media upload backend, or request a specific time range so a clip fits inline.',
    );
  }

  private async keyframeResult(
    probe: MediaProbe,
    range: [number, number] | undefined,
    budget: ReturnType<typeof effortBudget>,
    ctx: MediaReadContext,
    fps?: number,
  ): Promise<MediaReadResult> {
    const frames = await extractKeyframes(probe, {
      ...(range ? { range } : {}),
      maxFrames: budget.maxFrames,
      longEdge: budget.frameLongEdge,
      ...(fps !== undefined ? { fps } : {}),
      signal: ctx.signal,
    });
    const rangeNote = range ? ` from t=${range[0]}s–${range[1]}s` : '';
    const everyNote = frames.intervalSec
      ? ` (~1 frame every ${frames.intervalSec.toFixed(1)}s)`
      : '';
    return {
      content: frames.parts,
      scope: `${frames.frameCount} downsampled keyframes${rangeNote}${everyNote}`,
      precision: `LOSSY: keyframes only (no audio, no motion), downscaled to ${frames.longEdge}px`,
      cost: {
        tokens: frames.frameCount * getMediaProfile(ctx.config).tokensPerImage,
        note: `${frames.frameCount} frames`,
      },
      readMore:
        'Request a narrower time range for denser sampling, raise effort for more frames, or configure an upload backend for full fidelity.',
    };
  }

  /**
   * No upload channel, file too large to inline. For video we can still show the
   * content via downsampled keyframes; anything else fails closed with a remedy.
   */
  private async oversizedFallback(
    probe: MediaProbe,
    params: MediaReadParams,
    budget: ReturnType<typeof effortBudget>,
    ctx: MediaReadContext,
    remedy: string,
  ): Promise<MediaReadResult> {
    if (probe.modality !== 'video') {
      throw new MediaReadError(
        'over-budget',
        `${probe.path} (${probe.sizeBytes}B) is too large to inline and cannot be delivered by reference.`,
        remedy,
      );
    }
    try {
      return await this.keyframeResult(
        probe,
        params.range,
        budget,
        ctx,
        params.fps,
      );
    } catch (kfErr) {
      throw new MediaReadError(
        'over-budget',
        `${probe.path} is too large to inline and the keyframe fallback failed: ${kfErr instanceof Error ? kfErr.message : String(kfErr)}`,
        remedy,
      );
    }
  }
}

export function createNativeInlineReader(): MediaReader {
  return new NativeInlineReader();
}
