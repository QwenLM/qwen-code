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
import { probeMedia } from './probe.js';
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

  let probe: MediaProbe;
  try {
    probe = await probeMedia(filePath);
  } catch (err) {
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

  return buildMediaDelivery(result.content, {
    path: probe.path,
    hash: probe.hash,
    modality: probe.modality,
    scope: result.scope,
    precision: result.precision,
    cost: result.cost,
    readMore: result.readMore,
    ...(priorNote ? { notes: priorNote } : {}),
  });
}
