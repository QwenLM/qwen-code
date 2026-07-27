/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { Config } from '../../config/config.js';
import type { ToolResult } from '../../tools/tools.js';
import { getMediaMemory } from '../../memory/media/media-memory-store.js';
import { computeAutoLinks } from '../../memory/media/media-links.js';
import {
  createReaderRegistry,
  MediaReadError,
  type MediaReadContext,
  type MediaReadParams,
  type ReaderRegistry,
} from './reader-registry.js';
import { createNativeInlineReader } from './readers/native-inline.js';
import { createDelegatedReader } from './readers/delegated-reader.js';
import { resolveMediaConfig } from './media-config.js';
import { buildMediaDelivery, buildMediaError } from './media-result.js';
import {
  resolveAndProbe,
  isRemoteMediaUrl,
  describeRemoteUrl,
  hashRemoteUrl,
} from './media-source.js';
import { getMediaProfile } from '../../core/media/provider-media-profiles.js';
import type { MediaProbe } from './types.js';

/**
 * Seam A read trunk. Every media read — whatever the entry tool — flows through
 * here: probe → registry.pick → reader.read → write memory → C10 result. Tools
 * are just different entry points; strategies (S1–S6) and parallelism are
 * orchestration *above* this trunk, not new trunks (方案 §4.6).
 */

/** Build the reader registry from config: native built-in + declared delegated. */
export function buildReaderRegistry(config: Config): ReaderRegistry {
  const registry = createReaderRegistry();
  registry.register(createNativeInlineReader());
  const media = resolveMediaConfig(config);
  for (const decl of media.readers) {
    if (decl.kind === 'delegated') {
      registry.register(createDelegatedReader(decl));
    }
  }
  return registry;
}

/**
 * Read the raw media parts for a (probe, params) window through the trunk's
 * reader selection — probe→registry.pick→reader.read — WITHOUT the memory/C10
 * wrapping. This is the seam strategies (e.g. S2 media_dispatch) build on: they
 * orchestrate above the trunk (slice, fan out, reduce) but every byte they show
 * a model still comes from here, so native-vs-keyframe-vs-delegated and provider
 * capability are decided in one place, never reinvented.
 */
export async function readMediaParts(
  probe: MediaProbe,
  params: MediaReadParams,
  config: Config,
  signal: AbortSignal,
): Promise<Part[]> {
  const ctx: MediaReadContext = { config, signal };
  const registry = buildReaderRegistry(config);
  const reader = registry.pick(probe.modality, probe, ctx);
  if (!reader) {
    throw new MediaReadError(
      'no-capability',
      `No reader available for ${probe.modality}.`,
      `Use a model that supports ${probe.modality}, or configure a delegated reader.`,
    );
  }
  const result = await reader.read(probe, params, ctx);
  return Array.isArray(result.content)
    ? (result.content as Part[])
    : [result.content as Part];
}

function extractText(content: Part | Part[]): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function remember(
  probe: MediaProbe,
  readerId: string,
  readerKind: string,
  scope: string,
  precision: string,
  costNote: string | undefined,
  bodyText: string,
): Promise<void> {
  const memory = getMediaMemory();
  const links = computeAutoLinks(
    { hash: probe.hash, path: probe.path },
    await memory.list(),
  );
  await memory.put({
    hash: probe.hash,
    modality: probe.modality,
    path: probe.path,
    summary: scope,
    body:
      readerKind === 'delegated' && bodyText
        ? bodyText
        : `Delivered natively: ${scope}; ${precision}.`,
    readerId,
    cost: costNote,
    links,
  });
}

export interface ReadMediaInput {
  filePath: string;
  params: MediaReadParams;
  config: Config;
  signal: AbortSignal;
  /**
   * Force a delegated reader (explicit extraction: transcript/keyframes/…).
   * When set and no delegated reader is available, fail closed with a remedy.
   */
  requireDelegated?: boolean;
}

/** Run the full read trunk and return a self-describing (C10) ToolResult. */
export async function readMedia(input: ReadMediaInput): Promise<ToolResult> {
  const { filePath, params, config, signal } = input;

  // Fast path — deliver a remote URL BY REFERENCE, with no download, when:
  //  · it is an http(s) URL whose modality is clear from the extension,
  //  · the read is whole-file (no region/range/fps/scale that needs local ffmpeg),
  //  · the provider can fetch that modality by URL (fileUriModalities), and
  //  · the main model ingests that modality natively.
  // This is the S1 native path for remote media: the model fetches the URL
  // itself (e.g. qwen-omni video_url), so we never move the bytes through here.
  if (isRemoteMediaUrl(filePath) && !input.requireDelegated) {
    const { modality, mimeType } = describeRemoteUrl(filePath);
    const needsLocal =
      !!params.region ||
      !!params.range ||
      params.fps !== undefined ||
      params.scale !== undefined;
    if (modality && !needsLocal) {
      const profile = getMediaProfile(config);
      const inputModalities = config.getEffectiveInputModalities?.() ?? {};
      if (
        profile.fileUriModalities.includes(modality) &&
        (inputModalities as Record<string, boolean>)[modality] === true
      ) {
        return buildMediaDelivery(
          { fileData: { fileUri: filePath, mimeType } },
          {
            path: filePath,
            hash: hashRemoteUrl(filePath),
            modality,
            scope: `full ${modality} (native, delivered by URL reference)`,
            precision:
              'original fidelity — the model fetches the URL directly; no download or re-encoding',
            readMore:
              'For a specific time range or image region, call again with range/region (that path downloads and processes locally).',
          },
        );
      }
    }
  }

  // Resolve (URL/file:// → local) and probe via the shared entry, then run the
  // local pipeline. Local paths pass through unchanged.
  let probe: MediaProbe;
  let sourceUrl: string | undefined;
  try {
    const resolved = await resolveAndProbe(filePath, signal);
    probe = resolved.probe;
    sourceUrl = resolved.sourceUrl;
  } catch (err) {
    if (err instanceof MediaReadError) {
      return buildMediaError({
        kind: err.kind,
        message: err.message,
        remedy: err.remedy,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    const isUnsupported = message.includes('Unsupported media type');
    return buildMediaError({
      kind: isUnsupported ? 'unsupported-format' : 'path-problem',
      message,
      remedy: isUnsupported
        ? 'Provide an image/audio/video file, or convert it to a supported format first.'
        : 'Check the path exists and points to a readable file.',
    });
  }

  const ctx: MediaReadContext = { config, signal };
  const registry = buildReaderRegistry(config);
  const reader = input.requireDelegated
    ? registry
        .available(probe.modality, probe, ctx)
        .find((r) => r.kind === 'delegated')
    : registry.pick(probe.modality, probe, ctx);
  if (!reader) {
    return buildMediaError({
      kind: 'no-capability',
      message: input.requireDelegated
        ? `No delegated reader is configured for ${probe.modality}.`
        : `No reader is available for ${probe.modality} (the model cannot ingest it natively and no delegated reader is configured).`,
      remedy: `Configure a delegated reader for ${probe.modality} in the media settings (e.g. via:"command" running a local CLI)${input.requireDelegated ? '.' : ', or switch to a model that supports ' + probe.modality + ' input.'}`,
    });
  }

  // Auto-load: surface any prior cross-session understanding of THIS file
  // (same content hash) before the read, so re-encountering a file brings back
  // accumulated understanding cheaply (检索是快路径). The read still runs — the
  // original bytes remain the source of truth.
  const prior = await getMediaMemory()
    .get(probe.hash)
    .catch(() => undefined);

  let result;
  try {
    result = await reader.read(probe, params, ctx);
  } catch (err) {
    if (err instanceof MediaReadError) {
      return buildMediaError({
        kind: err.kind,
        message: err.message,
        remedy: err.remedy,
      });
    }
    throw err;
  }

  const bodyText = extractText(result.content as Part | Part[]);
  try {
    await remember(
      probe,
      reader.id,
      reader.kind,
      result.scope,
      result.precision,
      result.cost?.note,
      bodyText,
    );
  } catch {
    // Memory is a cache/asset, not on the critical path — never fail the read
    // because persistence hiccuped.
  }

  const priorNote = prior
    ? `recalled prior understanding of this file from media memory — "${prior.summary}" (call media_grep for the full accumulated notes)`
    : undefined;
  const remoteNote = sourceUrl
    ? `fetched from remote URL ${sourceUrl} (cached locally at ${probe.path})`
    : undefined;
  const notes = [remoteNote, priorNote].filter(Boolean).join('; ') || undefined;

  return buildMediaDelivery(result.content, {
    path: probe.path,
    hash: probe.hash,
    modality: probe.modality,
    scope: result.scope,
    precision: result.precision,
    cost: result.cost,
    readMore: result.readMore,
    ...(notes ? { notes } : {}),
  });
}
