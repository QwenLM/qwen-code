/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { probeMediaMetadata, type MediaProbeResult } from './ffmpeg.js';

/** Media modality handled by the omni pipeline. */
export type OmniModality = 'image' | 'audio' | 'video';

/** Result of content recognition for a local media file. */
export interface RecognizedMedia {
  /** Modality derived from the sniffed container type. */
  modality: OmniModality;
  /** Hex-encoded SHA-256 of the full file content. */
  sha256: string;
  /** Authoritative MIME type detected from content (sniff), not extension. */
  detectedMimeType: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** ffprobe/header metadata (fields populated per modality). */
  metadata: MediaProbeResult;
}

/** @deprecated S1 name — video-only alias kept for existing imports. */
export type RecognizedVideo = RecognizedMedia;

interface SniffedType {
  mimeType: string;
  modality: OmniModality;
  extension: string;
}

function bmffBrandType(brand: string): SniffedType {
  if (brand.startsWith('qt')) {
    return {
      mimeType: 'video/quicktime',
      modality: 'video',
      extension: '.mov',
    };
  }
  // M4A/M4B audio brands inside ISO BMFF.
  if (brand.startsWith('M4A') || brand.startsWith('M4B')) {
    return { mimeType: 'audio/mp4', modality: 'audio', extension: '.m4a' };
  }
  return { mimeType: 'video/mp4', modality: 'video', extension: '.mp4' };
}

/**
 * Content-sniffed media type detection (magic bytes). Returns null when the
 * header does not match a supported container. Covers:
 * video — MP4/MOV (ISO BMFF), WebM/Matroska (EBML), AVI (RIFF);
 * image — JPEG, PNG, WebP (RIFF), GIF;
 * audio — MP3 (ID3 or frame sync), WAV (RIFF), FLAC, OGG, M4A (BMFF brand).
 */
export function sniffMediaType(header: Buffer): SniffedType | null {
  if (header.length >= 12) {
    if (header.subarray(4, 8).toString('latin1') === 'ftyp') {
      return bmffBrandType(header.subarray(8, 12).toString('latin1'));
    }
    const riff = header.subarray(0, 4).toString('latin1') === 'RIFF';
    if (riff) {
      const kind = header.subarray(8, 12).toString('latin1');
      if (kind === 'AVI ') {
        return {
          mimeType: 'video/x-msvideo',
          modality: 'video',
          extension: '.avi',
        };
      }
      if (kind === 'WAVE') {
        return { mimeType: 'audio/wav', modality: 'audio', extension: '.wav' };
      }
      if (kind === 'WEBP') {
        return {
          mimeType: 'image/webp',
          modality: 'image',
          extension: '.webp',
        };
      }
      return null;
    }
  }
  if (header.length >= 8) {
    // PNG
    if (header.readUInt32BE(0) === 0x89504e47) {
      return { mimeType: 'image/png', modality: 'image', extension: '.png' };
    }
  }
  if (header.length >= 4) {
    // EBML (WebM/Matroska)
    if (header.readUInt32BE(0) === 0x1a45dfa3) {
      return { mimeType: 'video/webm', modality: 'video', extension: '.webm' };
    }
    // FLAC
    if (header.subarray(0, 4).toString('latin1') === 'fLaC') {
      return { mimeType: 'audio/flac', modality: 'audio', extension: '.flac' };
    }
    // OGG
    if (header.subarray(0, 4).toString('latin1') === 'OggS') {
      return { mimeType: 'audio/ogg', modality: 'audio', extension: '.ogg' };
    }
    // GIF87a / GIF89a
    if (header.subarray(0, 3).toString('latin1') === 'GIF') {
      return { mimeType: 'image/gif', modality: 'image', extension: '.gif' };
    }
  }
  if (header.length >= 3) {
    // JPEG
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
      return { mimeType: 'image/jpeg', modality: 'image', extension: '.jpg' };
    }
    // MP3: ID3 tag or bare MPEG frame sync (0xFFEx/0xFFFx).
    if (header.subarray(0, 3).toString('latin1') === 'ID3') {
      return { mimeType: 'audio/mpeg', modality: 'audio', extension: '.mp3' };
    }
    if (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0) {
      return { mimeType: 'audio/mpeg', modality: 'audio', extension: '.mp3' };
    }
  }
  return null;
}

/** S1-compat: video-only sniff. */
export function sniffVideoMimeType(header: Buffer): string | null {
  const sniffed = sniffMediaType(header);
  return sniffed?.modality === 'video' ? sniffed.mimeType : null;
}

/** Map a detected MIME type to the canonical object-store extension. */
export function extensionForMime(mimeType: string): string {
  const sniffTable: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-msvideo': '.avi',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/mp4': '.m4a',
  };
  return sniffTable[mimeType] ?? '.bin';
}

/** @deprecated S1 name kept for existing imports. */
export const extensionForVideoMime = extensionForMime;

/** Stream a file through SHA-256 without loading it into memory. */
export async function hashFileSha256(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath, signal ? { signal } : {}), hash);
  return hash.digest('hex');
}

/** Number of header bytes read for content sniffing. */
const SNIFF_BYTES = 4096;

/**
 * Recognize a local media file: content sniff (magic bytes), streaming
 * SHA-256, and ffprobe metadata. Throws when the content does not sniff as
 * a supported media container or when probing fails — the omni pipeline
 * fails closed on unrecognizable input. Error messages carry the file's
 * basename only (they can reach model-visible content).
 *
 * When `expectedModality` is given, a successful sniff of a DIFFERENT
 * modality is rejected (e.g. an .mp3 that is actually an mp4 container).
 */
export async function recognizeMediaFile(
  filePath: string,
  options?: { expectedModality?: OmniModality; signal?: AbortSignal },
): Promise<RecognizedMedia> {
  const { expectedModality, signal } = options ?? {};
  const handle = await fs.open(filePath, 'r');
  let header: Buffer;
  let sizeBytes: number;
  try {
    const stat = await handle.stat();
    sizeBytes = stat.size;
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    await handle.read(buf, 0, buf.length, 0);
    header = buf;
  } finally {
    await handle.close();
  }

  const sniffed = sniffMediaType(header);
  if (!sniffed) {
    throw new Error(
      `File content does not match a supported media container: ${path.basename(filePath)}`,
    );
  }
  if (expectedModality && sniffed.modality !== expectedModality) {
    throw new Error(
      `File content sniffs as ${sniffed.modality} (${sniffed.mimeType}) but was referenced as ${expectedModality}: ${path.basename(filePath)}`,
    );
  }

  const [sha256, metadata] = await Promise.all([
    hashFileSha256(filePath, signal),
    probeMediaMetadata(filePath, sniffed.modality, signal),
  ]);

  return {
    modality: sniffed.modality,
    sha256,
    detectedMimeType: sniffed.mimeType,
    sizeBytes,
    metadata,
  };
}

/** @deprecated S1 wrapper: video-only recognition. */
export async function recognizeVideoFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<RecognizedMedia> {
  return recognizeMediaFile(filePath, { expectedModality: 'video', signal });
}
