/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const BINARY_APPLICATION_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/octet-stream',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/wasm',
  'application/java-archive',
]);

/**
 * True when a content type carries bytes that cannot be meaningfully decoded
 * as UTF-8 text. Unknown application/* types default to TEXT: structured
 * text formats (yaml, ndjson, toml, sql, ...) are routinely served under
 * application/, and mislabeled binaries are still caught by magic-byte
 * sniffing downstream.
 */
export function isBinaryContentType(contentType: string): boolean {
  if (!contentType) return false;
  const mt = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (mt.startsWith('text/')) return false;
  if (mt.endsWith('+json') || mt.endsWith('+xml')) return false;
  if (
    mt.startsWith('image/') ||
    mt.startsWith('audio/') ||
    mt.startsWith('video/') ||
    mt.startsWith('font/')
  ) {
    return true;
  }
  if (BINARY_APPLICATION_TYPES.has(mt)) return true;
  if (mt.startsWith('application/vnd.openxmlformats')) return true;
  if (mt.startsWith('application/vnd.oasis.opendocument')) return true;
  return false;
}

const MIME_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'pdf'],
  ['application/zip', 'zip'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pptx',
  ],
  ['application/msword', 'doc'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.ms-powerpoint', 'ppt'],
  ['application/gzip', 'gz'],
  ['application/x-gzip', 'gz'],
  ['application/x-tar', 'tar'],
  ['application/x-7z-compressed', '7z'],
  ['application/x-rar-compressed', 'rar'],
  ['application/vnd.rar', 'rar'],
  ['application/wasm', 'wasm'],
  ['application/java-archive', 'jar'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
]);

export function extensionForMimeType(mimeType: string | undefined): string {
  if (!mimeType) return 'bin';
  const mt = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return MIME_EXTENSIONS.get(mt) ?? 'bin';
}

// The recognizable-extension whitelist is the mime table's value set plus
// aliases/fallbacks — derived so a new mime entry is automatically honored
// in Content-Disposition/URL-extension sniffing.
const KNOWN_EXTENSIONS = new Set([...MIME_EXTENSIONS.values(), 'jpeg', 'bin']);

export interface SniffedFileKind {
  /** Effective file extension (no dot). */
  extension: string;
  /** Effective mime type for display; falls back to the served Content-Type. */
  mimeType: string;
  /** True when magic bytes identified an unambiguous binary format. */
  magicMatched: boolean;
  /**
   * How the extension was determined: 'magic' bytes, a recognized 'name'
   * (Content-Disposition or URL filename), the Content-Type 'mime' map, or
   * the 'fallback' default. Callers deciding binary-vs-text on a headerless
   * response need this — a *recognized* .bin filename is binary, while the
   * fallback 'bin' just means "unknown".
   */
  extensionSource: 'magic' | 'name' | 'mime' | 'fallback';
}

function extensionFromFilename(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const ext = name.split('.').pop()?.trim().toLowerCase();
  return ext && ext !== name && KNOWN_EXTENSIONS.has(ext) ? ext : undefined;
}

function filenameFromContentDisposition(
  contentDisposition: string,
): string | undefined {
  // filename*=UTF-8'lang'name.pdf (the language tag is usually empty, but
  // RFC 5987 allows one) takes precedence over filename="name.pdf"
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(contentDisposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
  return plain?.[1]?.trim();
}

/**
 * Determine the real file kind of fetched bytes. Servers frequently deliver
 * PDFs and Office files as application/octet-stream, so Content-Type alone
 * would persist them as .bin and strand every downstream consumer. Priority:
 * magic bytes → Content-Disposition filename → URL path extension →
 * Content-Type → bin.
 */
export function sniffFileKind(
  bytes: Buffer,
  contentType: string,
  contentDisposition: string,
  url: string,
): SniffedFileKind {
  const dispositionExt = extensionFromFilename(
    filenameFromContentDisposition(contentDisposition),
  );
  let urlExt: string | undefined;
  try {
    urlExt = extensionFromFilename(new URL(url).pathname.split('/').pop());
  } catch {
    urlExt = undefined;
  }

  // Magic bytes: unambiguous formats first.
  if (
    bytes.length >= 5 &&
    bytes.subarray(0, 5).toString('latin1') === '%PDF-'
  ) {
    return {
      extension: 'pdf',
      mimeType: 'application/pdf',
      magicMatched: true,
      extensionSource: 'magic',
    };
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    // ZIP container — OpenXML office files and JARs are zips; refine via
    // the filename or the declared Content-Type (a proper xlsx mime with a
    // generic download URL must not degrade to .zip).
    const zipHint =
      dispositionExt ?? urlExt ?? extensionForMimeType(contentType);
    const refined =
      zipHint && ['docx', 'xlsx', 'pptx', 'jar'].includes(zipHint)
        ? zipHint
        : 'zip';
    return {
      extension: refined,
      mimeType: contentType || 'application/zip',
      magicMatched: true,
      extensionSource: 'magic',
    };
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return {
      extension: 'gz',
      mimeType: 'application/gzip',
      magicMatched: true,
      extensionSource: 'magic',
    };
  }
  // RAR4 is Rar!\x1A\x07\x00, RAR5 is Rar!\x1A\x07\x01\x00 — the shared
  // 6-byte prefix covers both.
  if (
    bytes.length >= 7 &&
    bytes.subarray(0, 4).toString('latin1') === 'Rar!' &&
    bytes[4] === 0x1a &&
    bytes[5] === 0x07
  ) {
    return {
      extension: 'rar',
      mimeType: 'application/vnd.rar',
      magicMatched: true,
      extensionSource: 'magic',
    };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.subarray(1, 4).toString('latin1') === 'PNG'
  ) {
    return {
      extension: 'png',
      mimeType: 'image/png',
      magicMatched: true,
      extensionSource: 'magic',
    };
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return {
      extension: 'jpg',
      mimeType: 'image/jpeg',
      magicMatched: true,
      extensionSource: 'magic',
    };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') {
    return {
      extension: 'gif',
      mimeType: 'image/gif',
      magicMatched: true,
      extensionSource: 'magic',
    };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return {
      extension: 'webp',
      mimeType: 'image/webp',
      magicMatched: true,
      extensionSource: 'magic',
    };
  }

  const nameExt = dispositionExt ?? urlExt;
  if (nameExt) {
    return {
      extension: nameExt,
      mimeType: contentType,
      magicMatched: false,
      extensionSource: 'name',
    };
  }
  const mimeExt = extensionForMimeType(contentType);
  return {
    extension: mimeExt,
    mimeType: contentType,
    magicMatched: false,
    extensionSource: mimeExt !== 'bin' ? 'mime' : 'fallback',
  };
}

/**
 * Cheap "is this actually text?" heuristic for mislabeled bodies: NUL bytes
 * (present in virtually every real binary format, and in UTF-16) or invalid
 * UTF-8 in the leading window mean binary. A small replacement-char
 * allowance covers a multi-byte sequence cut at the window edge.
 */
export function looksLikeText(bytes: Buffer): boolean {
  const window = bytes.subarray(0, 8192);
  if (window.includes(0)) return false;
  const decoded = new TextDecoder('utf-8').decode(window);
  let bad = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] === '�' && ++bad > 2) return false;
  }
  return true;
}

export type PersistBinaryResult =
  | { filepath: string; size: number; ext: string }
  | { error: string };

/**
 * Write raw fetched bytes to `dir` with the given extension so the file can
 * be consumed by native tools afterwards (read_file for PDFs/images, shell
 * tools for archives). Callers derive `ext` via sniffFileKind.
 */
export async function persistBinaryContent(
  bytes: Buffer,
  ext: string,
  dir: string,
  persistId: string,
): Promise<PersistBinaryResult> {
  const filepath = path.join(dir, `${persistId}.${ext}`);
  try {
    // Owner-only: fetched content can be sensitive (private/localhost URLs),
    // matching the 0600/0700 convention used for other persisted state.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(filepath, bytes, { mode: 0o600 });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  return { filepath, size: bytes.length, ext };
}

export function formatByteSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024;
  if (kb < 1) return `${sizeInBytes} bytes`;
  const fmt = (n: number) => n.toFixed(1).replace(/\.0$/, '');
  if (kb < 1024) return `${fmt(kb)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${fmt(mb)}MB`;
  return `${fmt(mb / 1024)}GB`;
}
