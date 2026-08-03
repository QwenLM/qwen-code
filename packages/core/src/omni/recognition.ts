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
import { probeVideoMetadata, type VideoProbeResult } from './ffmpeg.js';

/** Result of minimal S1 recognition for a local video file. */
export interface RecognizedVideo {
  /** Hex-encoded SHA-256 of the full file content. */
  sha256: string;
  /** Authoritative MIME type detected from content (sniff), not extension. */
  detectedMimeType: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Basic ffprobe metadata. */
  metadata: VideoProbeResult;
}

/**
 * Content-sniffed video container detection (magic bytes). Returns the
 * detected MIME type, or null when the header does not look like a video
 * container we recognize. Covers the common containers for S1: MP4/MOV
 * (ISO BMFF "ftyp"), WebM/Matroska (EBML), and AVI (RIFF).
 */
export function sniffVideoMimeType(header: Buffer): string | null {
  if (header.length >= 12) {
    // ISO BMFF: bytes 4..8 are "ftyp"; the major brand distinguishes
    // QuickTime ("qt  ") from the MP4 family.
    if (header.subarray(4, 8).toString('latin1') === 'ftyp') {
      const brand = header.subarray(8, 12).toString('latin1');
      return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
    }
  }
  if (header.length >= 4) {
    // EBML magic for WebM/Matroska. Distinguishing the two requires parsing
    // the DocType element; default to video/webm which DashScope accepts
    // for both in practice, and matroska readers tolerate.
    if (header.readUInt32BE(0) === 0x1a45dfa3) {
      return 'video/webm';
    }
  }
  if (header.length >= 12) {
    // RIFF....AVI LIST
    if (
      header.subarray(0, 4).toString('latin1') === 'RIFF' &&
      header.subarray(8, 12).toString('latin1') === 'AVI '
    ) {
      return 'video/x-msvideo';
    }
  }
  return null;
}

/** Map a detected video MIME type to the canonical file extension used for
 * content-addressed object names. Covers exactly the MIME types
 * `sniffVideoMimeType` can emit. */
export function extensionForVideoMime(mimeType: string): string {
  switch (mimeType) {
    case 'video/mp4':
      return '.mp4';
    case 'video/quicktime':
      return '.mov';
    case 'video/webm':
      return '.webm';
    case 'video/x-msvideo':
      return '.avi';
    default:
      return '.bin';
  }
}

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
 * Minimal S1 recognition for a local video file: content sniff (magic
 * bytes), streaming SHA-256, and ffprobe metadata. Throws when the file
 * does not sniff as a video container or when ffprobe fails — the omni
 * pipeline fails closed on unrecognizable input. Error messages carry the
 * file's basename only (they can reach model-visible content).
 */
export async function recognizeVideoFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<RecognizedVideo> {
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

  const detectedMimeType = sniffVideoMimeType(header);
  if (!detectedMimeType) {
    throw new Error(
      `File content does not match a supported video container (mp4/mov/webm/mkv/avi): ${path.basename(filePath)}`,
    );
  }

  const [sha256, metadata] = await Promise.all([
    hashFileSha256(filePath, signal),
    probeVideoMetadata(filePath, signal),
  ]);

  return { sha256, detectedMimeType, sizeBytes, metadata };
}
