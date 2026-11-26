/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Image reading utilities with token-budget-aware compression.
 * Reads image files and applies progressive compression to fit within
 * a configurable token budget.
 *
 * Compression strategy:
 * 1. Standard resize via maybeResizeAndDownsampleImageBuffer
 * 2. If over token budget, compressImageBufferWithTokenLimit:
 *    a. Progressive resizing with format-specific optimizations
 *    b. PNG palette optimization (for PNGs)
 *    c. JPEG conversion with moderate compression
 *    d. Ultra-compressed JPEG fallback
 * 3. Last resort: 400x400 JPEG q20 thumbnail
 */

import fs from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repairBunNativesRuntime } from '../bootstrap/bunNativesBootstrap.js';
import { BRAND_CLI_NAME } from '../config/brand.js';
import { runLogger } from './runLogger.js';
import { pngStructureError } from './pngValidation.js';
import {
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  IMAGE_MIN_WIDTH,
  IMAGE_MIN_HEIGHT,
  IMAGE_TARGET_RAW_SIZE,
  MAX_READ_TOKENS,
} from './constants.js';
import {
  normalizeImageMediaType,
  type SupportedImageMediaType,
} from './supportedImageTypes.js';

/** Error thrown when image bytes cannot be decoded or normalized safely. */
export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageResizeError';
  }
}

/**
 * The platform-native Sharp backend is unavailable. Callers may try the
 * portable decoder or constrained raw-image fallback for this error; decode
 * and limit errors must still fail closed.
 */
export class ImageProcessorUnavailableError extends ImageResizeError {
  constructor(message: string) {
    super(message);
    this.name = 'ImageProcessorUnavailableError';
  }
}

export interface ImageDimensions {
  originalWidth?: number;
  originalHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
}

export interface ImageReadResult {
  base64: string;
  mediaType: string;
  originalSize: number;
  dimensions?: ImageDimensions;
  observation?: Record<string, number | undefined>;
}

const imageEncodingObservation = new AsyncLocalStorage<{ attempts: number; durationMs: number }>();

async function encodeObservedImage(image: SharpInstance): Promise<Buffer> {
  const observation = imageEncodingObservation.getStore();
  const start = performance.now();
  if (observation) observation.attempts++;
  try { return await image.toBuffer(); }
  finally { if (observation) observation.durationMs += performance.now() - start; }
}

function encodeObservedPhoton(encode: () => Buffer): Buffer {
  const observation = imageEncodingObservation.getStore();
  const start = performance.now();
  if (observation) observation.attempts++;
  try { return encode(); }
  finally { if (observation) observation.durationMs += performance.now() - start; }
}

export interface ImageBufferReadOptions {
  maxTokens?: number;
  originalMediaType?: string;
}

type ImageBufferMediaOptions = Omit<ImageBufferReadOptions, 'maxTokens'>;

interface MediaLimitedImageResult {
  resultBuffer: Buffer;
  mediaType: string;
  originalSize: number;
  dimensions?: ImageDimensions;
}

/** Minimal type definitions for the dynamically-imported sharp library. */
interface SharpInstance {
  metadata(): Promise<SharpMetadata>;
  raw(): SharpInstance;
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance;
  extend(options: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    extendWith?: 'background' | 'copy' | 'repeat' | 'mirror';
  }): SharpInstance;
  jpeg(options?: { quality?: number }): SharpInstance;
  png(options?: {
    compressionLevel?: number;
    palette?: boolean;
    colors?: number;
  }): SharpInstance;
  webp(options?: { quality?: number }): SharpInstance;
  toBuffer(): Promise<Buffer>;
}

interface SharpMetadata {
  width?: number;
  height?: number;
  format?: string;
}

type SharpFactory = (input: Buffer) => SharpInstance;

interface PhotonImage {
  get_width(): number;
  get_height(): number;
  get_bytes(): Uint8Array;
  get_bytes_jpeg(quality: number): Uint8Array;
  free(): void;
}

interface PhotonModule {
  PhotonImage: {
    new_from_byteslice(input: Uint8Array): PhotonImage;
  };
  SamplingFilter: {
    Lanczos3: number;
  };
  resize(
    image: PhotonImage,
    width: number,
    height: number,
    filter: number,
  ): PhotonImage;
}

class PhotonProcessorUnavailableError extends ImageResizeError {
  constructor(message: string) {
    super(message);
    this.name = 'PhotonProcessorUnavailableError';
  }
}

/**
 * Detect image format from buffer magic bytes.
 */
export function detectImageFormatFromBuffer(buffer: Buffer): string {
  return detectSupportedImageFormatFromBuffer(buffer) ?? 'image/png';
}

const BASE64_ALPHABET_PATTERN = /^[A-Za-z0-9+/_-]*={0,2}$/;
const BASE64_WHITESPACE_PATTERN = /[\t\n\f\r ]/g;

/**
 * Decode SDK/MCP image data after normalizing interoperable Base64 variants.
 *
 * MCP's Base64 schema accepts ASCII whitespace and omitted padding, while
 * Node's historical Buffer decoder also accepts the URL-safe alphabet. Keep
 * those inputs working, but reject every other coercion that Buffer.from()
 * would silently ignore and verify the decoded bytes round-trip exactly.
 */
export function decodeBase64ImageData(data: string): Buffer {
  const compact = data.replace(BASE64_WHITESPACE_PATTERN, '');
  if (!compact) {
    throw new ImageResizeError('Image data must not be empty');
  }
  if (!BASE64_ALPHABET_PATTERN.test(compact)) {
    throw new ImageResizeError(
      'Image data contains characters outside the base64 alphabet',
    );
  }

  const firstPadding = compact.indexOf('=');
  const unpadded =
    firstPadding === -1 ? compact : compact.slice(0, firstPadding);
  const suppliedPadding = compact.length - unpadded.length;
  const unpaddedRemainder = unpadded.length % 4;
  if (
    unpaddedRemainder === 1 ||
    (suppliedPadding > 0 &&
      (compact.length % 4 !== 0 ||
        unpaddedRemainder !== (suppliedPadding === 2 ? 2 : 3)))
  ) {
    throw new ImageResizeError('Image data contains invalid base64 padding');
  }

  const standardAlphabet = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const normalized =
    standardAlphabet + '='.repeat((4 - unpaddedRemainder) % 4);
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.toString('base64') !== normalized) {
    throw new ImageResizeError(
      'Image data contains non-canonical base64 padding bits',
    );
  }
  return buffer;
}

/** Strict magic-byte detection used by the raw passthrough safety gate. */
export function detectSupportedImageFormatFromBuffer(
  buffer: Buffer,
): SupportedImageMediaType | undefined {
  if (buffer.length < 4) return undefined;

  // PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer.length >= 8 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: 47 49 46 38
  if (
    buffer.length >= 6 &&
    (buffer.toString('ascii', 0, 6) === 'GIF87a' ||
      buffer.toString('ascii', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}

function probePngDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (
    buffer.length < 24 ||
    buffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return undefined;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return {
    originalWidth: width,
    originalHeight: height,
    displayWidth: width,
    displayHeight: height,
  };
}

function probeGifDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 10) return undefined;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (width === 0 || height === 0) return undefined;
  return {
    originalWidth: width,
    originalHeight: height,
    displayWidth: width,
    displayHeight: height,
  };
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function probeJpegDimensions(buffer: Buffer): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) return undefined;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) return undefined;

    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= buffer.length) return undefined;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      return undefined;
    }
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return undefined;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) return undefined;
      return {
        originalWidth: width,
        originalHeight: height,
        displayWidth: width,
        displayHeight: height,
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function probeWebpDimensions(buffer: Buffer): ImageDimensions | undefined {
  if (buffer.length < 30) return undefined;
  const chunk = buffer.toString('ascii', 12, 16);
  let width: number;
  let height: number;

  if (chunk === 'VP8X') {
    width = 1 + buffer.readUIntLE(24, 3);
    height = 1 + buffer.readUIntLE(27, 3);
  } else if (chunk === 'VP8L' && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    width = 1 + (bits & 0x3fff);
    height = 1 + ((bits >>> 14) & 0x3fff);
  } else if (
    chunk === 'VP8 ' &&
    buffer[23] === 0x9d &&
    buffer[24] === 0x01 &&
    buffer[25] === 0x2a
  ) {
    width = buffer.readUInt16LE(26) & 0x3fff;
    height = buffer.readUInt16LE(28) & 0x3fff;
  } else {
    return undefined;
  }

  if (width === 0 || height === 0) return undefined;
  return {
    originalWidth: width,
    originalHeight: height,
    displayWidth: width,
    displayHeight: height,
  };
}

function probeImageDimensions(
  buffer: Buffer,
  mediaType: SupportedImageMediaType,
): ImageDimensions | undefined {
  switch (mediaType) {
    case 'image/png':
      return probePngDimensions(buffer);
    case 'image/jpeg':
      return probeJpegDimensions(buffer);
    case 'image/gif':
      return probeGifDimensions(buffer);
    case 'image/webp':
      return probeWebpDimensions(buffer);
    default:
      return undefined;
  }
}

function hasCompletePngContainer(buffer: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const dataLength = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + dataLength;
    if (chunkEnd > buffer.length) return false;
    if (buffer.toString('ascii', offset + 4, offset + 8) === 'IEND') {
      return dataLength === 0 && chunkEnd === buffer.length;
    }
    offset = chunkEnd;
  }
  return false;
}

function hasBasicContainerTerminator(
  buffer: Buffer,
  mediaType: SupportedImageMediaType,
): boolean {
  switch (mediaType) {
    case 'image/png':
      return hasCompletePngContainer(buffer);
    case 'image/jpeg':
      return (
        buffer.length >= 2 &&
        buffer[buffer.length - 2] === 0xff &&
        buffer[buffer.length - 1] === 0xd9
      );
    case 'image/gif':
      return buffer.length >= 1 && buffer[buffer.length - 1] === 0x3b;
    case 'image/webp':
      return buffer.length >= 12 && buffer.readUInt32LE(4) + 8 === buffer.length;
    default:
      return false;
  }
}

function passthroughImageWhenProcessorUnavailable(
  imageBuffer: Buffer,
  originalSize: number,
  declaredFormat: string,
): ResizeResult {
  if (Math.max(originalSize, imageBuffer.length) > IMAGE_TARGET_RAW_SIZE) {
    throw new ImageResizeError(
      `Image processor is unavailable and the original image exceeds the ${IMAGE_TARGET_RAW_SIZE}-byte passthrough limit`,
    );
  }

  const detectedMediaType = detectSupportedImageFormatFromBuffer(imageBuffer);
  if (!detectedMediaType) {
    throw new ImageResizeError(
      'Image processor is unavailable and the original image format could not be verified',
    );
  }
  const declaredMediaType = normalizeImageMediaType(declaredFormat);
  if (declaredMediaType !== detectedMediaType) {
    throw new ImageResizeError(
      `Image processor is unavailable and the declared media type ${declaredMediaType} does not match ${detectedMediaType}`,
    );
  }
  if (!hasBasicContainerTerminator(imageBuffer, detectedMediaType)) {
    throw new ImageResizeError(
      'Image processor is unavailable and the original image container appears incomplete',
    );
  }

  const dimensions = probeImageDimensions(imageBuffer, detectedMediaType);
  if (
    !dimensions?.originalWidth ||
    !dimensions.originalHeight ||
    dimensions.originalWidth < IMAGE_MIN_WIDTH ||
    dimensions.originalHeight < IMAGE_MIN_HEIGHT ||
    dimensions.originalWidth > IMAGE_MAX_WIDTH ||
    dimensions.originalHeight > IMAGE_MAX_HEIGHT
  ) {
    throw new ImageResizeError(
      `Image processor is unavailable and the original image dimensions could not be verified within ${IMAGE_MIN_WIDTH}x${IMAGE_MIN_HEIGHT} to ${IMAGE_MAX_WIDTH}x${IMAGE_MAX_HEIGHT}`,
    );
  }

  runLogger.warn(
    'Image processor unavailable; forwarding verified original image without pixel decoding',
    {
      mediaType: detectedMediaType,
      size: imageBuffer.length,
      width: dimensions.originalWidth,
      height: dimensions.originalHeight,
    },
  );
  return {
    buffer: imageBuffer,
    mediaType: detectedMediaType.slice('image/'.length),
    dimensions,
  };
}

/**
 * Dynamically import sharp to avoid hard dependency at module load time.
 * Returns the callable sharp function.
 *
 * In Bun-compiled binaries sharp's native components live in a tmpdir tree
 * that OS temp cleaners may purge while the CLI is running. Importing sharp
 * with those files missing poisons the module cache: the first call throws
 * "Could not load the sharp module ..." and every later call fails with a
 * cryptic minified TypeError ("T is not a function") until the process
 * restarts. So before the first import we verify/repair the natives tree,
 * cache only a callable factory, and translate any residual failure into an
 * actionable error.
 */
let cachedSharpFactory: SharpFactory | null = null;

/**
 * Set once sharp has been probed and found unloadable (e.g. no native build
 * for this platform, as on HarmonyOS). Later calls then fail fast instead of
 * repeating the natives repair and two dlopen attempts.
 */
let sharpUnavailable = false;

const SHARP_UNAVAILABLE_HINT =
  'Image processing is unavailable because the sharp image library failed to load. ' +
  'Its native components may have been removed from the system temp directory. ' +
  `Restart ${BRAND_CLI_NAME} to restore image support.`;

async function importSharpFactory(): Promise<unknown> {
  const sharpModule = await import('sharp');
  return (
    (sharpModule as Record<string, unknown>)['default'] || sharpModule
  );
}

async function getSharp(): Promise<SharpFactory> {
  // Linux Electron 的系统 GLib 可能抢占 libvips 的符号，导致原生崩溃，
  // 无法通过 catch 恢复。加载前禁用 sharp，复用 Photon/WASM 和受限透传路径。
  if (process.platform === 'linux' && process.versions['electron']) {
    throw new ImageProcessorUnavailableError(
      'Native image processing is disabled on Linux Electron; using WebAssembly',
    );
  }
  if (cachedSharpFactory) return cachedSharpFactory;
  if (sharpUnavailable) {
    throw new ImageProcessorUnavailableError(SHARP_UNAVAILABLE_HINT);
  }

  // Re-extract the embedded natives tree if the temp cleaner removed it.
  // No-op outside Bun-compiled mode.
  try {
    repairBunNativesRuntime();
  } catch (e) {
    runLogger.warn('Natives runtime repair failed:', String(e));
  }

  let loadError: unknown;
  let factory: unknown;
  try {
    factory = await importSharpFactory();
  } catch (e) {
    loadError = e;
    // The natives tree was verified/repaired above; retry once in case the
    // failed attempt raced the repair or the runtime re-evaluates on
    // re-import. Keep the first error if the retry fails too.
    try {
      factory = await importSharpFactory();
    } catch {
      // ignore; loadError already holds the first (most informative) error
    }
  }

  if (typeof factory !== 'function') {
    const detail =
      loadError instanceof Error
        ? loadError.message
        : loadError !== undefined
          ? String(loadError)
          : 'sharp did not export a callable factory; ' +
            'the module cache may hold a previously failed load';
    runLogger.error('sharp is unavailable for image processing:', detail);
    sharpUnavailable = true;
    throw new ImageProcessorUnavailableError(
      `${SHARP_UNAVAILABLE_HINT} (${detail})`,
    );
  }

  cachedSharpFactory = factory as SharpFactory;
  return cachedSharpFactory;
}

const PHOTON_PACKAGE_NAME = '@silvia-odwyer/photon-node';
let cachedPhotonModule: PhotonModule | null = null;
let photonUnavailable = false;

function isPhotonModule(value: unknown): value is PhotonModule {
  if (!value || typeof value !== 'object') return false;
  const module = value as Partial<PhotonModule>;
  return (
    typeof module.PhotonImage?.new_from_byteslice === 'function' &&
    typeof module.resize === 'function' &&
    typeof module.SamplingFilter?.Lanczos3 === 'number'
  );
}

/**
 * Load Photon from a real filesystem path. Its CommonJS loader reads the
 * sibling photon_rs_bg.wasm file synchronously, so bundling the JS module into
 * Bun's virtual filesystem would bake in an unusable build-machine path.
 */
function getPhoton(): PhotonModule {
  if (cachedPhotonModule) return cachedPhotonModule;
  if (photonUnavailable) {
    throw new PhotonProcessorUnavailableError(
      'The portable WebAssembly image processor is unavailable',
    );
  }

  let runtimeDir: string | null = null;
  try {
    runtimeDir = repairBunNativesRuntime();
  } catch (error) {
    runLogger.warn(
      'Natives runtime repair before Photon load failed:',
      String(error),
    );
  }

  const request = runtimeDir
    ? join(
        runtimeDir,
        'node_modules',
        ...PHOTON_PACKAGE_NAME.split('/'),
        'photon_rs.js',
      )
    : PHOTON_PACKAGE_NAME;

  try {
    const loaded = createRequire(import.meta.url)(request) as unknown;
    const candidate =
      loaded && typeof loaded === 'object' && 'default' in loaded
        ? ((loaded as Record<string, unknown>)['default'] ?? loaded)
        : loaded;
    if (!isPhotonModule(candidate)) {
      throw new Error('module did not expose the expected image API');
    }
    cachedPhotonModule = candidate;
    runLogger.debug('Loaded portable WebAssembly image processor');
    return cachedPhotonModule;
  } catch (error) {
    photonUnavailable = true;
    const detail = error instanceof Error ? error.message : String(error);
    runLogger.error(
      'Portable WebAssembly image processor is unavailable:',
      detail,
    );
    throw new PhotonProcessorUnavailableError(
      `The portable WebAssembly image processor failed to load (${detail})`,
    );
  }
}

/**
 * Creates a text description of image metadata including dimensions and source path.
 * Used to provide coordinate mapping information when images are resized.
 * Returns null if no useful metadata is available.
 */
export function createImageMetadataText(
  dims: ImageDimensions,
  sourcePath?: string,
): string | null {
  const { originalWidth, originalHeight, displayWidth, displayHeight } = dims;

  // Skip if dimensions are not available or invalid
  // Note: checks for undefined/null and zero to prevent division by zero
  if (
    !originalWidth ||
    !originalHeight ||
    !displayWidth ||
    !displayHeight ||
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    // If we have a source path but no valid dimensions, still return source info
    if (sourcePath) {
      return `[Image source: ${sourcePath}]`;
    }
    return null;
  }

  // Check if image was resized
  const wasResized =
    originalWidth !== displayWidth || originalHeight !== displayHeight;

  // Only include metadata if there's useful info (resized or has source path)
  if (!wasResized && !sourcePath) {
    return null;
  }

  // Build metadata parts
  const parts: string[] = [];

  if (sourcePath) {
    parts.push(`source: ${sourcePath}`);
  }

  if (wasResized) {
    const scaleFactor = originalWidth / displayWidth;
    parts.push(
      `original ${originalWidth}x${originalHeight}, displayed at ${displayWidth}x${displayHeight}. Multiply coordinates by ${scaleFactor.toFixed(2)} to map to original image.`,
    );
  }

  return `[Image: ${parts.join(', ')}]`;
}

// ---------------------------------------------------------------------------
// maybeResizeAndDownsampleImageBuffer — standard resize path
// ---------------------------------------------------------------------------

export interface ResizeResult {
  buffer: Buffer;
  mediaType: string;
  dimensions?: ImageDimensions;
}

async function padImageToMinimumDimensions(
  sharp: SharpFactory,
  result: ResizeResult,
): Promise<ResizeResult> {
  const displayWidth = result.dimensions?.displayWidth;
  const displayHeight = result.dimensions?.displayHeight;
  if (
    displayWidth !== undefined &&
    displayHeight !== undefined &&
    displayWidth >= IMAGE_MIN_WIDTH &&
    displayHeight >= IMAGE_MIN_HEIGHT
  ) {
    return result;
  }

  const metadata = await sharp(result.buffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    throw new ImageResizeError(
      'Invalid or unsupported image data: missing output image dimensions',
    );
  }

  const horizontalPadding = Math.max(0, IMAGE_MIN_WIDTH - width);
  const verticalPadding = Math.max(0, IMAGE_MIN_HEIGHT - height);
  if (horizontalPadding === 0 && verticalPadding === 0) {
    return result;
  }

  const left = Math.floor(horizontalPadding / 2);
  const top = Math.floor(verticalPadding / 2);
  const paddedBuffer = await encodeObservedImage(sharp(result.buffer)
    .extend({
      left,
      right: horizontalPadding - left,
      top,
      bottom: verticalPadding - top,
      extendWith: 'copy',
    }));
  const paddedMetadata = await sharp(paddedBuffer).metadata();
  const paddedWidth = paddedMetadata.width;
  const paddedHeight = paddedMetadata.height;
  if (
    !paddedWidth ||
    !paddedHeight ||
    paddedWidth < IMAGE_MIN_WIDTH ||
    paddedHeight < IMAGE_MIN_HEIGHT
  ) {
    throw new ImageResizeError(
      `Image dimensions must be at least ${IMAGE_MIN_WIDTH}x${IMAGE_MIN_HEIGHT} pixels after preprocessing`,
    );
  }

  runLogger.debug(
    `Image padding: ${width}x${height} → ${paddedWidth}x${paddedHeight}`,
  );
  return {
    ...result,
    buffer: paddedBuffer,
    dimensions: {
      ...result.dimensions,
      originalWidth: result.dimensions?.originalWidth ?? width,
      originalHeight: result.dimensions?.originalHeight ?? height,
      displayWidth: paddedWidth,
      displayHeight: paddedHeight,
    },
  };
}

const PHOTON_MAX_INPUT_PIXELS = 100_000_000;

function photonBytesToBuffer(bytes: Uint8Array): Buffer {
  // Copy out of WebAssembly memory before PhotonImage.free() invalidates it.
  return Buffer.from(bytes);
}

function freePhotonImage(image: PhotonImage | null): void {
  if (!image) return;
  try {
    image.free();
  } catch {
    // Best-effort cleanup. Preserve the original processing error, if any.
  }
}

function decodePhotonImage(
  imageBuffer: Buffer,
): { photon: PhotonModule; image: PhotonImage } {
  const photon = getPhoton();
  try {
    return {
      photon,
      image: photon.PhotonImage.new_from_byteslice(imageBuffer),
    };
  } catch (error) {
    throw new ImageResizeError(
      `Invalid or unsupported image data: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function encodePhotonPng(image: PhotonImage): Buffer {
  return encodeObservedPhoton(() => photonBytesToBuffer(image.get_bytes()));
}

function encodePhotonJpeg(image: PhotonImage, quality: number): Buffer {
  return encodeObservedPhoton(() => photonBytesToBuffer(image.get_bytes_jpeg(quality)));
}

function resizePhotonImage(
  photon: PhotonModule,
  image: PhotonImage,
  width: number,
  height: number,
): PhotonImage {
  return photon.resize(
    image,
    Math.max(1, Math.round(width)),
    Math.max(1, Math.round(height)),
    photon.SamplingFilter.Lanczos3,
  );
}

function photonResizeResult(
  buffer: Buffer,
  mediaType: 'png' | 'jpeg',
  originalWidth: number,
  originalHeight: number,
  displayWidth: number,
  displayHeight: number,
): ResizeResult {
  return {
    buffer,
    mediaType,
    dimensions: {
      originalWidth,
      originalHeight,
      displayWidth,
      displayHeight,
    },
  };
}

/**
 * Portable pixel-decoding fallback used when native Sharp is unavailable. GIF
 * remains on the constrained raw path because Photon does not expose animated
 * output semantics compatible with the existing Sharp pipeline.
 */
async function maybeResizeAndDownsampleImageBufferWithPhoton(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
): Promise<ResizeResult> {
  const detectedMediaType = detectSupportedImageFormatFromBuffer(imageBuffer);
  if (detectedMediaType === 'image/gif') {
    throw new PhotonProcessorUnavailableError(
      'The portable image processor does not normalize animated GIF images',
    );
  }
  // Probe availability before validating the remaining input. If the module
  // itself cannot load, the caller must use the constrained raw-image gate,
  // which owns its own format/size/structure validation and error semantics.
  getPhoton();
  if (!detectedMediaType) {
    throw new ImageResizeError(
      'Invalid or unsupported image data: image format could not be verified',
    );
  }

  const declaredMediaType = normalizeImageMediaType(ext);
  if (declaredMediaType !== detectedMediaType) {
    throw new ImageResizeError(
      `Declared media type ${declaredMediaType} does not match ${detectedMediaType}`,
    );
  }

  const probed = probeImageDimensions(imageBuffer, detectedMediaType);
  const probedWidth = probed?.originalWidth;
  const probedHeight = probed?.originalHeight;
  if (!probedWidth || !probedHeight) {
    throw new ImageResizeError(
      'Invalid or unsupported image data: missing image dimensions',
    );
  }
  if (probedWidth * probedHeight > PHOTON_MAX_INPUT_PIXELS) {
    throw new ImageResizeError(
      `Image dimensions ${probedWidth}x${probedHeight} exceed the portable decoder safety limit`,
    );
  }

  let source: PhotonImage | null = null;
  try {
    const decoded = decodePhotonImage(imageBuffer);
    const photon = decoded.photon;
    source = decoded.image;
    const originalWidth = source.get_width();
    const originalHeight = source.get_height();
    if (
      originalWidth <= 0 ||
      originalHeight <= 0 ||
      originalWidth !== probedWidth ||
      originalHeight !== probedHeight
    ) {
      throw new ImageResizeError(
        'Invalid or unsupported image data: decoded dimensions do not match the image header',
      );
    }
    if (originalWidth < IMAGE_MIN_WIDTH || originalHeight < IMAGE_MIN_HEIGHT) {
      throw new ImageResizeError(
        `Image dimensions ${originalWidth}x${originalHeight} must be at least ${IMAGE_MIN_WIDTH}x${IMAGE_MIN_HEIGHT} pixels, but the portable image processor cannot add padding`,
      );
    }

    if (
      Math.max(originalSize, imageBuffer.length) <= maxBytes &&
      originalWidth <= IMAGE_MAX_WIDTH &&
      originalHeight <= IMAGE_MAX_HEIGHT
    ) {
      runLogger.debug(
        'Portable image processor fully decoded the original image; preserving its bytes',
      );
      return {
        buffer: imageBuffer,
        mediaType: detectedMediaType.slice('image/'.length),
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: originalWidth,
          displayHeight: originalHeight,
        },
      };
    }

    let width = originalWidth;
    let height = originalHeight;
    if (width > IMAGE_MAX_WIDTH) {
      height = Math.round((height * IMAGE_MAX_WIDTH) / width);
      width = IMAGE_MAX_WIDTH;
    }
    if (height > IMAGE_MAX_HEIGHT) {
      width = Math.round((width * IMAGE_MAX_HEIGHT) / height);
      height = IMAGE_MAX_HEIGHT;
    }
    if (width < IMAGE_MIN_WIDTH || height < IMAGE_MIN_HEIGHT) {
      throw new ImageResizeError(
        `Resized image dimensions ${width}x${height} must be at least ${IMAGE_MIN_WIDTH}x${IMAGE_MIN_HEIGHT} pixels, but the portable image processor cannot add padding`,
      );
    }

    const isPng = detectedMediaType === 'image/png';
    const encodeCandidates = (
      image: PhotonImage,
      displayWidth: number,
      displayHeight: number,
    ): ResizeResult | null => {
      if (isPng) {
        const png = encodePhotonPng(image);
        if (png.length <= maxBytes) {
          return photonResizeResult(
            png,
            'png',
            originalWidth,
            originalHeight,
            displayWidth,
            displayHeight,
          );
        }
      }
      for (const quality of [80, 60, 40, 20]) {
        const jpeg = encodePhotonJpeg(image, quality);
        if (jpeg.length <= maxBytes) {
          return photonResizeResult(
            jpeg,
            'jpeg',
            originalWidth,
            originalHeight,
            displayWidth,
            displayHeight,
          );
        }
      }
      return null;
    };

    if (width === originalWidth && height === originalHeight) {
      const compressed = encodeCandidates(source, width, height);
      if (compressed) return compressed;
    } else {
      runLogger.debug(
        `Portable image resize: ${originalWidth}x${originalHeight} → ${width}x${height}`,
      );
      const resized = resizePhotonImage(photon, source, width, height);
      try {
        const compressed = encodeCandidates(resized, width, height);
        if (compressed) return compressed;
      } finally {
        freePhotonImage(resized);
      }
    }

    const finalScale = Math.min(1, 1000 / width, 1000 / height);
    const finalWidth = Math.max(1, Math.round(width * finalScale));
    const finalHeight = Math.max(1, Math.round(height * finalScale));
    if (finalWidth < IMAGE_MIN_WIDTH || finalHeight < IMAGE_MIN_HEIGHT) {
      throw new ImageResizeError(
        `Compressed image dimensions ${finalWidth}x${finalHeight} must be at least ${IMAGE_MIN_WIDTH}x${IMAGE_MIN_HEIGHT} pixels, but the portable image processor cannot add padding`,
      );
    }
    const finalImage = resizePhotonImage(
      photon,
      source,
      finalWidth,
      finalHeight,
    );
    try {
      return photonResizeResult(
        encodePhotonJpeg(finalImage, 20),
        'jpeg',
        originalWidth,
        originalHeight,
        finalWidth,
        finalHeight,
      );
    } finally {
      freePhotonImage(finalImage);
    }
  } catch (error) {
    if (error instanceof ImageResizeError) {
      throw error;
    }
    throw new ImageResizeError(
      `Portable image processing failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    freePhotonImage(source);
  }
}

async function convertBmpToPngWithPhoton(imageBuffer: Buffer): Promise<Buffer> {
  let image: PhotonImage | null = null;
  try {
    const decoded = decodePhotonImage(imageBuffer);
    image = decoded.image;
    return encodePhotonPng(image);
  } finally {
    freePhotonImage(image);
  }
}

/**
 * Resizes image buffer to meet size and dimension constraints.
 * Multi-strategy approach:
 * 1. Check if original fits (size + dimensions)
 * 2. If oversized but within dimensions, try compression (PNG palette, JPEG quality ladder)
 * 3. Constrain dimensions, resize, then try compression if still too large
 * 4. Final fallback: smaller dimensions + aggressive JPEG
 */
export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
): Promise<ResizeResult> {
  if (imageBuffer.length === 0) {
    throw new ImageResizeError('Image file is empty (0 bytes)');
  }

  const detectedMediaType = detectSupportedImageFormatFromBuffer(imageBuffer);
  if (!detectedMediaType) {
    throw new ImageResizeError(
      'Invalid or unsupported image data: supported formats are PNG, JPEG, GIF, and WebP',
    );
  }

  const declaredMediaType = normalizeImageMediaType(ext);
  if (declaredMediaType !== detectedMediaType) {
    throw new ImageResizeError(
      `Invalid image data: declared media type ${declaredMediaType} does not match ${detectedMediaType}`,
    );
  }

  if (detectedMediaType === 'image/png') {
    const reason = pngStructureError(imageBuffer);
    if (reason) {
      throw new ImageResizeError(
        `Unable to read image: invalid PNG structure (${reason}). ` +
          'Use a valid image file before retrying.',
      );
    }
  }

  try {
    const sharp = await getSharp();
    const finalizeResult = (result: ResizeResult) =>
      padImageToMinimumDimensions(sharp, result);
    const image = sharp(imageBuffer);
    const metadata = await image.metadata();

    const mediaType = metadata.format ?? ext;
    // Normalize "jpg" to "jpeg" for media type compatibility
    const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType;

    // Images without dimensions cannot be decoded into pixels reliably.
    if (!metadata.width || !metadata.height) {
      throw new ImageResizeError(
        'Invalid or unsupported image data: missing image dimensions',
      );
    }

    // Store original dimensions - after the check above, TypeScript knows these are numbers
    const originalWidth = metadata.width;
    const originalHeight = metadata.height;

    // Calculate dimensions while maintaining aspect ratio
    let width = originalWidth;
    let height = originalHeight;

    // Check if the original file just works
    if (
      originalSize <= IMAGE_TARGET_RAW_SIZE &&
      width <= IMAGE_MAX_WIDTH &&
      height <= IMAGE_MAX_HEIGHT
    ) {
      // metadata() only parses container headers. A truncated JPEG can expose
      // dimensions while its scan data is not decodable. Force a full pixel
      // decode before preserving the original bytes.
      await sharp(imageBuffer).raw().toBuffer();
      return await finalizeResult({
        buffer: imageBuffer,
        mediaType: normalizedMediaType,
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: width,
          displayHeight: height,
        },
      });
    }

    const needsDimensionResize =
      width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT;
    const isPng = normalizedMediaType === 'png';

    // If dimensions are within limits but file is too large, try compression first
    // This preserves full resolution when possible
    if (!needsDimensionResize && originalSize > IMAGE_TARGET_RAW_SIZE) {
      // For PNGs, try PNG compression first to preserve transparency
      if (isPng) {
        const pngCompressed = await encodeObservedImage(sharp(imageBuffer)
          .png({ compressionLevel: 9, palette: true }));
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return await finalizeResult({
            buffer: pngCompressed,
            mediaType: 'png',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          });
        }
      }
      // Try JPEG compression (lossy but much smaller)
      for (const quality of [80, 60, 40, 20]) {
        const compressedBuffer = await encodeObservedImage(sharp(imageBuffer)
          .jpeg({ quality }));
        if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
          return await finalizeResult({
            buffer: compressedBuffer,
            mediaType: 'jpeg',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          });
        }
      }
      // Quality reduction alone wasn't enough, fall through to resize
    }

    // Constrain dimensions if needed
    if (width > IMAGE_MAX_WIDTH) {
      height = Math.round((height * IMAGE_MAX_WIDTH) / width);
      width = IMAGE_MAX_WIDTH;
    }
    if (height > IMAGE_MAX_HEIGHT) {
      width = Math.round((width * IMAGE_MAX_HEIGHT) / height);
      height = IMAGE_MAX_HEIGHT;
    }

    runLogger.debug(
      `Image resize: ${originalWidth}x${originalHeight} → ${width}x${height}`,
    );
    const resizedImageBuffer = await encodeObservedImage(sharp(imageBuffer)
      .resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true,
      }));

    // If still too large after resize, try compression
    if (resizedImageBuffer.length > IMAGE_TARGET_RAW_SIZE) {
      // For PNGs, try PNG compression first to preserve transparency
      if (isPng) {
        const pngCompressed = await encodeObservedImage(sharp(imageBuffer)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png({ compressionLevel: 9, palette: true }));
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return await finalizeResult({
            buffer: pngCompressed,
            mediaType: 'png',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          });
        }
      }

      // Try JPEG with progressively lower quality
      for (const quality of [80, 60, 40, 20]) {
        const compressedBuffer = await encodeObservedImage(sharp(imageBuffer)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality }));
        if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
          return await finalizeResult({
            buffer: compressedBuffer,
            mediaType: 'jpeg',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          });
        }
      }

      // If still too large, resize smaller and compress aggressively
      const smallerWidth = Math.min(width, 1000);
      const smallerHeight = Math.round(
        (height * smallerWidth) / Math.max(width, 1),
      );
      runLogger.debug(
        `Image still too large, compressing with JPEG at ${smallerWidth}x${smallerHeight}`,
      );
      const compressedBuffer = await encodeObservedImage(sharp(imageBuffer)
        .resize(smallerWidth, smallerHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 20 }));
      return await finalizeResult({
        buffer: compressedBuffer,
        mediaType: 'jpeg',
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: smallerWidth,
          displayHeight: smallerHeight,
        },
      });
    }

    return await finalizeResult({
      buffer: resizedImageBuffer,
      mediaType: normalizedMediaType,
      dimensions: {
        originalWidth,
        originalHeight,
        displayWidth: width,
        displayHeight: height,
      },
    });
  } catch (e) {
    if (e instanceof ImageProcessorUnavailableError) {
      try {
        return await maybeResizeAndDownsampleImageBufferWithPhoton(
          imageBuffer,
          originalSize,
          ext,
        );
      } catch (photonError) {
        if (photonError instanceof PhotonProcessorUnavailableError) {
          return passthroughImageWhenProcessorUnavailable(
            imageBuffer,
            originalSize,
            ext,
          );
        }
        if (photonError instanceof ImageResizeError) throw photonError;
        throw new ImageResizeError(
          `Portable image processing failed: ${photonError instanceof Error ? photonError.message : String(photonError)}`,
        );
      }
    }
    runLogger.error('Image resize failed:', String(e));
    if (e instanceof ImageResizeError) throw e;
    throw new ImageResizeError(
      `Invalid or unsupported image data: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// compressImageBuffer — token-budget compression pipeline
// ---------------------------------------------------------------------------

interface ImageCompressionContext {
  imageBuffer: Buffer;
  metadata: SharpMetadata;
  format: string;
  maxBytes: number;
  originalSize: number;
}

interface CompressedImageResult {
  base64: string;
  mediaType: string;
  originalSize: number;
}

function createCompressedImageResult(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
): CompressedImageResult {
  const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType;
  return {
    base64: buffer.toString('base64'),
    mediaType: `image/${normalizedMediaType}`,
    originalSize,
  };
}

function applyFormatOptimizations(
  image: SharpInstance,
  format: string,
): SharpInstance {
  switch (format) {
    case 'png':
      return image.png({ compressionLevel: 9, palette: true });
    case 'jpeg':
    case 'jpg':
      return image.jpeg({ quality: 80 });
    case 'webp':
      return image.webp({ quality: 80 });
    default:
      return image;
  }
}

/**
 * Try progressive resizing with format-specific optimizations.
 * Scaling factors: [1.0, 0.75, 0.5, 0.25]
 */
async function tryProgressiveResizing(
  context: ImageCompressionContext,
  sharp: SharpFactory,
): Promise<CompressedImageResult | null> {
  const scalingFactors = [1.0, 0.75, 0.5, 0.25];

  for (const scalingFactor of scalingFactors) {
    const newWidth = Math.round(
      (context.metadata.width || 2000) * scalingFactor,
    );
    const newHeight = Math.round(
      (context.metadata.height || 2000) * scalingFactor,
    );

    let resizedImage = sharp(context.imageBuffer).resize(newWidth, newHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    });

    // Apply format-specific optimizations
    resizedImage = applyFormatOptimizations(resizedImage, context.format);

    const resizedBuffer = await resizedImage.toBuffer();

    if (resizedBuffer.length <= context.maxBytes) {
      return createCompressedImageResult(
        resizedBuffer,
        context.format,
        context.originalSize,
      );
    }
  }

  return null;
}

/**
 * Try palette PNG compression at reduced dimensions.
 */
async function tryPalettePNG(
  context: ImageCompressionContext,
  sharp: SharpFactory,
): Promise<CompressedImageResult | null> {
  const palettePng = await sharp(context.imageBuffer)
    .resize(800, 800, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({
      compressionLevel: 9,
      palette: true,
      colors: 64,
    })
    .toBuffer();

  if (palettePng.length <= context.maxBytes) {
    return createCompressedImageResult(palettePng, 'png', context.originalSize);
  }

  return null;
}

/**
 * Try JPEG conversion with moderate compression.
 */
async function tryJPEGConversion(
  context: ImageCompressionContext,
  quality: number,
  sharp: SharpFactory,
): Promise<CompressedImageResult | null> {
  const jpegBuffer = await sharp(context.imageBuffer)
    .resize(600, 600, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer();

  if (jpegBuffer.length <= context.maxBytes) {
    return createCompressedImageResult(
      jpegBuffer,
      'jpeg',
      context.originalSize,
    );
  }

  return null;
}

/**
 * Ultra-compressed JPEG as last resort.
 */
async function createUltraCompressedJPEG(
  context: ImageCompressionContext,
  sharp: SharpFactory,
): Promise<CompressedImageResult> {
  const ultraCompressedBuffer = await sharp(context.imageBuffer)
    .resize(400, 400, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 20 })
    .toBuffer();

  return createCompressedImageResult(
    ultraCompressedBuffer,
    'jpeg',
    context.originalSize,
  );
}

/**
 * Compresses an image buffer to fit within a maximum byte size.
 *
 * Uses a multi-strategy fallback approach:
 * 1. Progressive resizing with format-specific optimizations (scale factors: 1.0, 0.75, 0.5, 0.25)
 * 2. For PNG: palette optimization with color reduction (64 colors)
 * 3. JPEG conversion with moderate compression (quality 50)
 * 4. Ultra-compressed JPEG fallback (400x400, quality 20)
 */
async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // Extract format from originalMediaType if provided (e.g., "image/png" -> "png")
  const fallbackFormat = originalMediaType?.split('/')[1] || 'jpeg';
  const normalizedFallback = fallbackFormat === 'jpg' ? 'jpeg' : fallbackFormat;

  try {
    const sharp = await getSharp();
    const metadata = await sharp(imageBuffer).metadata();
    const format = metadata.format || normalizedFallback;
    const originalSize = imageBuffer.length;

    const context: ImageCompressionContext = {
      imageBuffer,
      metadata,
      format,
      maxBytes,
      originalSize,
    };

    // If image is already within size limit, return as-is without processing
    if (originalSize <= maxBytes) {
      return createCompressedImageResult(imageBuffer, format, originalSize);
    }

    // Try progressive resizing with format preservation
    const resizedResult = await tryProgressiveResizing(context, sharp);
    if (resizedResult) {
      return resizedResult;
    }

    // For PNG, try palette optimization
    if (format === 'png') {
      const palettizedResult = await tryPalettePNG(context, sharp);
      if (palettizedResult) {
        return palettizedResult;
      }
    }

    // Try JPEG conversion with moderate compression
    const jpegResult = await tryJPEGConversion(context, 50, sharp);
    if (jpegResult) {
      return jpegResult;
    }

    // Last resort: ultra-compressed JPEG
    return await createUltraCompressedJPEG(context, sharp);
  } catch (e) {
    if (e instanceof ImageProcessorUnavailableError) {
      try {
        const portable =
          await maybeResizeAndDownsampleImageBufferWithPhoton(
            imageBuffer,
            imageBuffer.length,
            normalizedFallback,
            maxBytes,
          );
        return createCompressedImageResult(
          portable.buffer,
          portable.mediaType,
          imageBuffer.length,
        );
      } catch (photonError) {
        if (!(photonError instanceof PhotonProcessorUnavailableError)) {
          if (photonError instanceof ImageResizeError) throw photonError;
          throw new ImageResizeError(
            `Portable image compression failed: ${photonError instanceof Error ? photonError.message : String(photonError)}`,
          );
        }
      }
    } else {
      runLogger.error('Image compression failed:', String(e));
    }

    // If original image is within the requested limit, allow it through
    if (imageBuffer.length <= maxBytes) {
      const detected = detectImageFormatFromBuffer(imageBuffer);
      return {
        base64: imageBuffer.toString('base64'),
        mediaType: detected,
        originalSize: imageBuffer.length,
      };
    }

    // Image is too large and compression failed
    throw new ImageResizeError(
      `Unable to compress image (${imageBuffer.length} bytes) to fit within ${maxBytes} bytes. ` +
        `Please use a smaller image.`,
    );
  }
}

/**
 * Compresses an image buffer to fit within a token limit.
 * Converts tokens to bytes: maxBytes = (maxTokens / 0.125) * 0.75
 */
async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // Convert token limit to byte limit
  // base64 uses about 4/3 the original size, so we reverse this
  const maxBase64Chars = Math.floor(maxTokens / 0.125);
  const maxBytes = Math.floor(maxBase64Chars * 0.75);

  return compressImageBuffer(imageBuffer, maxBytes, originalMediaType);
}

async function readImageBuffer(
  filePath: string,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if (maxBytes === undefined) {
    return fs.promises.readFile(filePath, { signal });
  }

  const fd = await fs.promises.open(filePath, 'r');
  try {
    signal?.throwIfAborted();
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
    signal?.throwIfAborted();
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

/**
 * Reads an image file and only applies API/media-limit normalization.
 *
 * This path preserves vision detail whenever the image already fits API media
 * limits. It does not apply the Read text token budget.
 */
export async function readImageWithMediaLimits(
  filePath: string,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<ImageReadResult> {
  return processImageBufferWithMediaLimits(
    await readImageBuffer(filePath, maxBytes, signal),
  );
}

/**
 * Reads an image file and applies token-based compression if needed.
 * Use only for call sites that explicitly need an image to fit a text-like
 * output budget, such as remote tool-result bounding.
 */
export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number = MAX_READ_TOKENS,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<ImageReadResult> {
  return processImageBufferWithTokenBudget(
    await readImageBuffer(filePath, maxBytes, signal),
    {
      maxTokens,
    },
  );
}

/**
 * Applies image API/media-limit normalization to an already-loaded image buffer.
 * Does not apply a text token budget.
 */
export async function processImageBufferWithMediaLimits(
  imageBuffer: Buffer,
  options: ImageBufferMediaOptions = {},
): Promise<ImageReadResult> {
  const measurements = { attempts: 0, durationMs: 0 };
  const m = await imageEncodingObservation.run(measurements, () =>
    processImageBufferWithMediaLimitsInternal(imageBuffer, options));
  return {
    base64: m.resultBuffer.toString('base64'),
    mediaType: m.mediaType,
    originalSize: m.originalSize,
    dimensions: m.dimensions,
    observation: {
      original_bytes: m.originalSize,
      retained_bytes: m.resultBuffer.length,
      original_width: m.dimensions?.originalWidth,
      original_height: m.dimensions?.originalHeight,
      retained_width: m.dimensions?.displayWidth,
      retained_height: m.dimensions?.displayHeight,
      compression_attempts: measurements.attempts,
      compression_duration_ms: Math.round(measurements.durationMs),
    },
  };
}

async function processImageBufferWithMediaLimitsInternal(
  imageBuffer: Buffer,
  options: ImageBufferMediaOptions = {},
): Promise<MediaLimitedImageResult> {
  const originalSize = imageBuffer.length;
  if (originalSize === 0) {
    throw new ImageResizeError('Image data is empty');
  }

  // BMP is not supported by most LLM APIs — convert to PNG via Sharp.
  // This handles Windows/WSL2 scenarios where clipboard images may be BMP.
  let convertedBmp = false;
  if (
    imageBuffer.length >= 2 &&
    imageBuffer[0] === 0x42 &&
    imageBuffer[1] === 0x4d
  ) {
    try {
      const sharp = await getSharp();
      imageBuffer = await encodeObservedImage(sharp(imageBuffer).png());
      convertedBmp = true;
      runLogger.debug('Converted BMP image to PNG');
    } catch (e) {
      if (e instanceof ImageProcessorUnavailableError) {
        try {
          imageBuffer = await convertBmpToPngWithPhoton(imageBuffer);
          convertedBmp = true;
          runLogger.debug(
            'Converted BMP image to PNG with the portable image processor',
          );
        } catch (photonError) {
          if (!(photonError instanceof PhotonProcessorUnavailableError)) {
            throw photonError;
          }
          runLogger.warn(
            'BMP to PNG conversion is unavailable',
            String(photonError),
          );
        }
      } else {
        runLogger.warn(
          'BMP to PNG conversion failed, using original',
          String(e),
        );
      }
    }
  }

  const detectedMediaType =
    (convertedBmp ? 'image/png' : options.originalMediaType) ||
    detectImageFormatFromBuffer(imageBuffer);
  const detectedFormat = detectedMediaType.split('/')[1] || 'png';

  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    originalSize,
    detectedFormat,
  );
  const resultBuffer = resized.buffer;
  const resultMediaType = resized.mediaType;
  const dimensions = resized.dimensions;

  // Ensure mediaType has the 'image/' prefix
  const fullMediaType = resultMediaType.startsWith('image/')
    ? resultMediaType
    : `image/${resultMediaType}`;

  return {
    resultBuffer,
    mediaType: fullMediaType,
    originalSize,
    dimensions,
  };
}

/**
 * Applies image API/media-limit normalization first, then applies aggressive
 * token-budget compression only if the caller explicitly requested that budget.
 */
export async function processImageBufferWithTokenBudget(
  imageBuffer: Buffer,
  options: ImageBufferReadOptions = {},
): Promise<ImageReadResult> {
  const maxTokens = options.maxTokens ?? MAX_READ_TOKENS;
  const m = await processImageBufferWithMediaLimitsInternal(
    imageBuffer,
    options,
  );
  // Estimate tokens from buffer length without base64 encoding:
  // base64 expands by 4/3, then ~0.125 tokens per char ≈ bufferLength / 6.
  const estimatedTokens = Math.ceil(m.resultBuffer.length / 6);

  if (estimatedTokens <= maxTokens) {
    return {
      base64: m.resultBuffer.toString('base64'),
      mediaType: m.mediaType,
      originalSize: m.originalSize,
      dimensions: m.dimensions,
    };
  }

  try {
    const compressed = await compressImageBufferWithTokenLimit(
      m.resultBuffer,
      maxTokens,
      m.mediaType,
    );
    return {
      base64: compressed.base64,
      mediaType: compressed.mediaType,
      originalSize: m.originalSize,
    };
  } catch (e) {
    if (e instanceof ImageResizeError) throw e;
    runLogger.error('Token-limited compression failed:', String(e));
    try {
      const sharp = await getSharp();
      const fallbackBuffer = await sharp(m.resultBuffer)
        .resize(400, 400, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 20 })
        .toBuffer();

      return {
        base64: fallbackBuffer.toString('base64'),
        mediaType: 'image/jpeg',
        originalSize: m.originalSize,
      };
    } catch (fallbackError) {
      runLogger.error('Fallback compression failed', String(fallbackError));
    }
  }

  return {
    base64: m.resultBuffer.toString('base64'),
    mediaType: m.mediaType,
    originalSize: m.originalSize,
    dimensions: m.dimensions,
  };
}
