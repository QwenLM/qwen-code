/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSpecificMimeType } from '../fileUtils.js';
import type { Modality, MediaProbe } from './types.js';

/**
 * P1 · Probe — deterministic identification of a media file (模型无感).
 *
 * Probe never involves the model: it establishes the facts every downstream
 * decision (capability gating, reader pick, transport, memory identity) depends
 * on. It is A-class and its output shape is stable across implementations.
 *
 * v1 keeps probe dependency-free: identity (content hash), modality, mime, and
 * byte size are always derivable cheaply. Duration / resolution / frame-rate are
 * left undefined here and filled in by a delegated probe backend only when a
 * decision proves it needs them (信念二: start simple, add on proof).
 */

/** Map a mime type to the modality the media layer reasons about, or undefined. */
export function modalityOf(mimeType: string): Modality | undefined {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return undefined;
}

/** Stream a file through sha256 without loading it fully into memory. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/**
 * Probe a media file. Throws if the path is missing/not a file, or the mime type
 * is not a media modality — callers translate that into a fail-closed media
 * error (path-problem / unsupported-format) via the C10 contract.
 */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  const mimeType = getSpecificMimeType(resolved) ?? 'application/octet-stream';
  const modality = modalityOf(mimeType);
  if (!modality) {
    throw new Error(
      `Unsupported media type "${mimeType}" for ${resolved}; probe handles image/audio/video only.`,
    );
  }
  const hash = await hashFile(resolved);
  return {
    path: resolved,
    hash,
    modality,
    mimeType,
    sizeBytes: stat.size,
  };
}
