/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { DashScopeOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/dashscope.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isFfmpegAvailable, isFfprobeAvailable } from './ffmpeg.js';
import {
  extensionForVideoMime,
  recognizeVideoFile,
  type RecognizedVideo,
} from './recognition.js';
import { OmniObjectStore } from './storage.js';
import { DashScopeUploader } from './upload.js';

export {
  assertOmniRuntimeDependencies,
  isFfmpegAvailable,
  isFfprobeAvailable,
  resetFfmpegCachesForTests,
} from './ffmpeg.js';
export { OmniObjectStore } from './storage.js';
export { DashScopeUploader, OSS_URL_PREFIX } from './upload.js';
export {
  recognizeVideoFile,
  sniffVideoMimeType,
  hashFileSha256,
} from './recognition.js';

const debugLogger = createDebugLogger('omni');

/** Default per-file upload ceiling: 1 GiB (DashScope instant-upload cap). */
export const DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;

/** Result of the S1 video delivery pipeline. */
export interface OmniVideoDelivery {
  /** `oss://…` URL to place in fileData.fileUri. */
  fileUri: string;
  /** Authoritative (sniffed) MIME type for the Part. */
  mimeType: string;
  /** Content hash — identity of the stored object. */
  sha256: string;
  /** Recognition output, for logs/display. */
  recognized: RecognizedVideo;
  /** Whether the object store already held this content. */
  deduped: boolean;
}

/** Thrown for omni pipeline failures. The pipeline fails closed: callers
 * surface the message instead of silently falling back to inline base64. */
export class OmniDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OmniDeliveryError';
  }
}

/**
 * Gate for the S1 video delivery path. All three conditions must hold:
 * omni enabled, provider is DashScope-compatible, and an API key exists
 * for the uploads endpoint. Video modality is checked by the caller
 * (fileUtils) alongside the existing modality gate.
 */
export function isOmniVideoDeliveryActive(config: Config): boolean {
  // Optional calls so stub Configs in tests (and embedders constructing
  // partial configs) don't need the omni accessors to process files.
  if (!config.isOmniEnabled?.()) return false;
  const cgc = config.getContentGeneratorConfig?.();
  if (!cgc) return false;
  if (!cgc.apiKey) {
    debugLogger.debug(
      'omni enabled but no API key available for the uploads endpoint; falling back to inline delivery',
    );
    return false;
  }
  return DashScopeOpenAICompatibleProvider.isDashScopeProvider(cgc);
}

/**
 * S1 pipeline: recognize → promote into the content-addressed store →
 * upload via the DashScope temporary channel → return the oss:// URL.
 *
 * No caching in S1: every invocation re-uploads (S3 adds the
 * (sha256, model) upload cache). Throws OmniDeliveryError on any failure.
 */
export async function processVideoForOmniDelivery(
  filePath: string,
  config: Config,
  signal?: AbortSignal,
): Promise<OmniVideoDelivery> {
  // Defense in depth: startup validation already asserted this, but the
  // pipeline can also be reached in embedders that skip Config.initialize.
  const [ffmpeg, ffprobe] = await Promise.all([
    isFfmpegAvailable(),
    isFfprobeAvailable(),
  ]);
  if (!ffmpeg || !ffprobe) {
    throw new OmniDeliveryError(
      'ffmpeg/ffprobe not available; omni video delivery requires both on PATH.',
    );
  }

  let recognized: RecognizedVideo;
  try {
    recognized = await recognizeVideoFile(filePath);
  } catch (err) {
    throw new OmniDeliveryError(
      `Video recognition failed for ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  const maxBytes =
    config.getOmniUploadMaxFileBytes() ?? DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES;
  if (recognized.sizeBytes > maxBytes) {
    throw new OmniDeliveryError(
      `Video exceeds the omni upload limit: ${recognized.sizeBytes} bytes > ` +
        `${maxBytes} bytes (omni.upload.maxFileBytes). ` +
        `Reduce the file size before retrying.`,
    );
  }

  const store = new OmniObjectStore(config.storage.getQwenDir());
  const extension = extensionForVideoMime(recognized.detectedMimeType);
  let objectPath: string;
  let deduped: boolean;
  try {
    const put = await store.putFile(filePath, recognized.sha256, extension);
    objectPath = put.objectPath;
    deduped = put.deduped;
  } catch (err) {
    throw new OmniDeliveryError(
      `Failed to store video in the omni object store: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  const cgc = config.getContentGeneratorConfig();
  const uploader = new DashScopeUploader({
    apiKey: cgc.apiKey ?? '',
    baseUrl: cgc.baseUrl,
  });
  let fileUri: string;
  try {
    fileUri = await uploader.uploadFile({
      filePath: objectPath,
      model: config.getModel(),
      mimeType: recognized.detectedMimeType,
      signal,
    });
  } catch (err) {
    throw new OmniDeliveryError(
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }

  debugLogger.debug(
    `omni video delivered: sha256=${recognized.sha256.slice(0, 12)}… ` +
      `size=${recognized.sizeBytes} deduped=${deduped} uri=${fileUri}`,
  );
  return {
    fileUri,
    mimeType: recognized.detectedMimeType,
    sha256: recognized.sha256,
    recognized,
    deduped,
  };
}
