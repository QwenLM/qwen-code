/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  discardResponseBody,
  isAddressPrivate,
  isPrivateIpAsync,
  isRedirectStatus,
  readLimitedResponseBody,
  unmanagedRequest,
} from './fetch.js';
import { isSubpath } from './paths.js';

export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;

const MAX_REDIRECTS = 5;
const MAX_FILENAME_STEM_LENGTH = 80;
/** Upper bound for one download request, applied afresh to every redirect hop. */
const DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS = 600_000;
/**
 * Cheap pre-filter so a hostile payload is rejected before any O(n) scan.
 * Base64 inflates by 4/3; the slack covers padding, a data-URL header, and
 * embedded whitespace. The exact decoded size is checked separately.
 */
const MAX_ENCODED_IMAGE_CHARS =
  Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 1024;
const OVERSIZED_IMAGE_MESSAGE = `Generated image too large: exceeded ${MAX_GENERATED_IMAGE_BYTES} bytes`;

type GeneratedImageExtension = 'png' | 'jpg' | 'webp' | 'gif' | 'avif';

/** Leading byte signatures, compared as latin1 so every byte maps 1:1. */
const IMAGE_SIGNATURES: ReadonlyArray<{
  extension: GeneratedImageExtension;
  parts: ReadonlyArray<readonly [offset: number, magic: string]>;
}> = [
  { extension: 'png', parts: [[0, '\x89PNG\r\n\x1a\n']] },
  { extension: 'jpg', parts: [[0, '\xff\xd8\xff']] },
  {
    extension: 'webp',
    parts: [
      [0, 'RIFF'],
      [8, 'WEBP'],
    ],
  },
  { extension: 'gif', parts: [[0, 'GIF87a']] },
  { extension: 'gif', parts: [[0, 'GIF89a']] },
  {
    extension: 'avif',
    parts: [
      [4, 'ftyp'],
      [8, 'avif'],
    ],
  },
  {
    extension: 'avif',
    parts: [
      [4, 'ftyp'],
      [8, 'avis'],
    ],
  },
];

export interface GeneratedImageFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Resolves a provider-supplied image reference — an inline `data:` URL or a
 * remote http(s) URL — into validated image bytes. Single entry point so both
 * the first-party and custom-provider paths agree on how a reference is recognized.
 */
export async function loadGeneratedImage(
  reference: string,
  options?: GeneratedImageFetchOptions,
): Promise<Buffer> {
  return reference.startsWith('data:')
    ? decodeGeneratedImageBase64(reference)
    : downloadGeneratedImage(reference, options);
}

/**
 * Downloads an image while enforcing public-network, redirect, size, and
 * content boundaries. Redirects are followed manually so every destination is
 * checked before a request is sent.
 */
export async function downloadGeneratedImage(
  url: string,
  options?: GeneratedImageFetchOptions,
): Promise<Buffer> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_IMAGE_DOWNLOAD_TIMEOUT_MS;
  // Redirect chains commonly stay on one host; resolve each host at most once.
  const hostIsPrivate = new Map<string, boolean>();
  let currentUrl = parseGeneratedImageUrl(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicImageUrl(currentUrl, hostIsPrivate);
    const response = await unmanagedRequest(
      currentUrl,
      { signal: options?.signal, redirect: 'manual' },
      { timeoutMs },
    );

    if (!isRedirectStatus(response.status)) {
      if (!response.ok) {
        await discardResponseBody(response);
        throw new Error(
          `Failed to download generated image: HTTP ${response.status}`,
        );
      }
      assertImageContentType(response.headers.get('content-type'));
      const bytes = await readLimitedResponseBody(
        response,
        MAX_GENERATED_IMAGE_BYTES,
        { subject: 'Generated image', logTag: 'ImageGen' },
      );
      validateGeneratedImage(bytes);
      return bytes;
    }

    const location = response.headers.get('location');
    await discardResponseBody(response);
    if (!location) {
      throw new Error('Generated image redirect is missing a location');
    }
    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new Error('Generated image URL is invalid');
    }
    assertGeneratedImageUrlShape(next);
    currentUrl = next;
  }
  throw new Error(`Generated image exceeded ${MAX_REDIRECTS} redirects`);
}

/** Decodes and validates an image returned as base64 or a data URL. */
export function decodeGeneratedImageBase64(value: string): Buffer {
  if (value.length > MAX_ENCODED_IMAGE_CHARS) {
    throw new Error(OVERSIZED_IMAGE_MESSAGE);
  }

  // Anchored and non-capturing past the header, so the payload is never copied.
  const header = /^data:([^;,]+);base64,/i.exec(value);
  if (value.startsWith('data:') && !header) {
    throw new Error('Invalid generated image data URL');
  }
  let encoded = value;
  if (header) {
    assertImageContentType(header[1]);
    encoded = value.slice(header[0].length);
  }

  // Node silently drops invalid base64 characters, which would truncate an
  // otherwise well-formed image, so reject malformed input outright. Provider
  // payloads are whitespace-free in practice, so the strip is only paid for
  // when the charset test actually fails — one O(n) scan on the common path.
  if (!isCanonicalBase64(encoded)) {
    encoded = encoded.replace(/\s+/g, '');
    if (!isCanonicalBase64(encoded)) {
      throw new Error('Invalid generated image base64 data');
    }
  }
  if (decodedBase64ByteLength(encoded) > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(OVERSIZED_IMAGE_MESSAGE);
  }

  const bytes = Buffer.from(encoded, 'base64');
  validateGeneratedImage(bytes);
  return bytes;
}

/**
 * Writes a validated image below one output directory with a sanitized,
 * collision-resistant filename.
 */
export async function saveGeneratedImage(
  workingDir: string,
  outputDirName: string,
  requestedName: string,
  imageBytes: Uint8Array,
): Promise<string> {
  const extension = validateGeneratedImage(imageBytes);
  const workingDirPath = resolve(workingDir);
  const imageDirPath = resolve(workingDirPath, outputDirName);
  assertContainedPath(workingDirPath, imageDirPath);
  await mkdir(imageDirPath, { recursive: true });

  // Re-check once the directory exists: either path may resolve through a
  // symlink that lands outside the working directory.
  const [realWorkingDir, realImageDir] = await Promise.all([
    realpath(workingDirPath),
    realpath(imageDirPath),
  ]);
  assertContainedPath(realWorkingDir, realImageDir);

  const safeName = sanitizeImageName(requestedName);
  const filename = `${safeName}_${Date.now()}_${randomUUID().slice(0, 8)}.${extension}`;
  const filePath = resolve(imageDirPath, filename);
  assertContainedPath(imageDirPath, filePath);

  await writeFile(filePath, imageBytes, { flag: 'wx' });
  return filePath;
}

/** Rejects empty, oversized, and unrecognized images; returns the extension. */
function validateGeneratedImage(bytes: Uint8Array): GeneratedImageExtension {
  if (bytes.length === 0) {
    throw new Error('Generated image is empty');
  }
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(OVERSIZED_IMAGE_MESSAGE);
  }
  const signature = IMAGE_SIGNATURES.find(({ parts }) =>
    parts.every(
      ([offset, magic]) => latin1(bytes, offset, magic.length) === magic,
    ),
  );
  if (!signature) {
    throw new Error('Generated image has an unsupported or invalid format');
  }
  return signature.extension;
}

function isCanonicalBase64(value: string): boolean {
  return value.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/**
 * Decoded size of canonical base64, computed from the string length instead of
 * scanning the payload — a megabyte-scale image would otherwise pay one full
 * pass here and a second one in the Buffer.from that follows.
 */
function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function sanitizeImageName(value: string): string {
  const sanitized = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_FILENAME_STEM_LENGTH);
  return sanitized || 'image';
}

function assertContainedPath(parent: string, candidate: string): void {
  if (candidate === parent || !isSubpath(parent, candidate)) {
    throw new Error('Generated image path escaped the output directory');
  }
}

function parseGeneratedImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Generated image URL is invalid');
  }
  assertGeneratedImageUrlShape(url);
  return url;
}

function assertGeneratedImageUrlShape(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Generated image URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Generated image URL must not contain credentials');
  }
}

async function assertPublicImageUrl(
  url: URL,
  hostIsPrivate: Map<string, boolean>,
): Promise<void> {
  let isPrivate = hostIsPrivate.get(url.hostname);
  if (isPrivate === undefined) {
    // The sync check is load-bearing: isPrivateIpAsync deliberately treats
    // loopback hosts as public, so literal private addresses are caught here.
    isPrivate =
      isAddressPrivate(url.hostname) || (await isPrivateIpAsync(url.href));
    hostIsPrivate.set(url.hostname, isPrivate);
  }
  if (isPrivate) {
    throw new Error('Generated image URL resolves to a private network');
  }
}

function assertImageContentType(contentType: string | null): void {
  if (!contentType) return;
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  if (
    mediaType.startsWith('image/') ||
    mediaType === 'application/octet-stream' ||
    mediaType === 'binary/octet-stream'
  ) {
    return;
  }
  throw new Error(`Generated image has invalid content type: ${mediaType}`);
}

/** Reads `length` bytes as latin1 without copying; '' when out of range. */
function latin1(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.byteLength) return '';
  return Buffer.from(bytes.buffer, bytes.byteOffset + offset, length).toString(
    'latin1',
  );
}
