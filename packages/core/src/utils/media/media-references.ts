/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Part } from '@google/genai';
import type { Config } from '../../config/config.js';
import { getMediaMemory } from '../../memory/media/media-memory-store.js';
import { readMedia } from './media-orchestrator.js';
import { resolveMediaConfig } from './media-config.js';
import { modalityOf } from './probe.js';
import { getSpecificMimeType } from '../fileUtils.js';
import type { Modality } from './types.js';

/**
 * P5 · skill/memory media integration (pull-style, additive).
 *
 * Skills and memory are text pipelines; a media file they reference used to be
 * invisible to the layer. This resolves such references through the unified read
 * interface so they become first-class:
 *  - `summary-first` (default): surface each referenced file + any prior
 *    cross-session understanding (media memory), and tell the model how to pull
 *    the bytes (image_view/media_watch). Cheap, no large byte injection.
 *  - `bytes-first`: inline the media now via the read trunk (probe → reader).
 *  - `path-only`: just list the paths.
 *
 * References are matched conservatively and confined to `baseDir` (the skill's
 * own directory) so skill text cannot pull arbitrary absolute paths.
 */

const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.flac',
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.m4v',
]);

const REFERENCE_PATTERN =
  /(?:\.\/|\.\.\/)?[\w./-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|mp3|wav|m4a|aac|ogg|flac|mp4|mov|mkv|webm|avi|m4v)/gi;

export interface MediaReference {
  absPath: string;
  relPath: string;
  modality: Modality;
}

/**
 * Find media references in `text`, resolved against `baseDir` and confined to
 * it. Returns existing files only. Deterministic, no model involved.
 */
export async function findMediaReferences(
  text: string,
  baseDir: string,
): Promise<MediaReference[]> {
  const root = path.resolve(baseDir);
  const seen = new Set<string>();
  const refs: MediaReference[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const raw = match[0];
    const ext = path.extname(raw).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(ext)) continue;
    const absPath = path.resolve(root, raw);
    // Confine to the skill directory subtree.
    const rel = path.relative(root, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const modality = modalityOf(getSpecificMimeType(absPath) ?? '');
    if (!modality) continue;
    refs.push({ absPath, relPath: rel, modality });
  }
  return refs;
}

/**
 * Build additive parts for media referenced in skill/memory text, per the
 * configured injection mode. Returns [] when nothing is referenced.
 */
export async function buildReferencedMediaParts(
  text: string,
  baseDir: string,
  config: Config,
  signal: AbortSignal,
): Promise<Part[]> {
  const refs = await findMediaReferences(text, baseDir);
  if (refs.length === 0) return [];

  const mode = resolveMediaConfig(config).injection.mode;

  if (mode === 'bytes-first') {
    const parts: Part[] = [];
    for (const ref of refs) {
      try {
        const result = await readMedia({
          filePath: ref.absPath,
          params: {},
          config,
          signal,
        });
        const content = result.llmContent;
        if (Array.isArray(content)) {
          for (const p of content) {
            parts.push(typeof p === 'string' ? { text: p } : p);
          }
        } else if (typeof content === 'string') {
          parts.push({ text: content });
        } else if (content) {
          parts.push(content);
        }
      } catch {
        parts.push({
          text: `[Referenced media ${ref.relPath} could not be loaded; use media_watch/image_view to read it.]`,
        });
      }
    }
    return parts;
  }

  // summary-first (default) / path-only: list references + any prior memory.
  const memory = getMediaMemory();
  const lines: string[] = [
    '<referenced_media note="Files referenced above. Pull full detail with image_view (images) or media_watch (audio/video).">',
  ];
  for (const ref of refs) {
    if (mode === 'path-only') {
      lines.push(`- ${ref.relPath} (${ref.modality}) — ${ref.absPath}`);
      continue;
    }
    const prior = await memory.getByPath(ref.absPath).catch(() => undefined);
    const priorNote = prior
      ? `prior understanding: ${prior.summary}`
      : 'no prior understanding yet';
    lines.push(
      `- ${ref.relPath} (${ref.modality}) — ${priorNote}. Read: ${
        ref.modality === 'image' ? 'image_view' : 'media_watch'
      } ${ref.absPath}`,
    );
  }
  lines.push('</referenced_media>');
  return [{ text: lines.join('\n') }];
}
