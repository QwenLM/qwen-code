/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
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

/**
 * Placeholder the model-config resolver assigns under Qwen OAuth; the real
 * token is swapped in per-request by QwenContentGenerator and never lands
 * in the ContentGeneratorConfig, so it cannot authenticate the uploads
 * endpoint. See modelConfigResolver.ts.
 */
const QWEN_OAUTH_PLACEHOLDER_API_KEY = 'QWEN_OAUTH_DYNAMIC_TOKEN';

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
 * surface the message instead of silently falling back to inline base64.
 * Messages must not contain absolute paths or raw upstream response
 * bodies — they can reach model-visible content. */
export class OmniDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OmniDeliveryError';
  }
}

/**
 * Gate for the S1 video delivery path. All conditions must hold:
 *
 * 1. omni enabled (settings or QWEN_CODE_ENABLE_OMNI=1);
 * 2. trusted workspace (the pipeline writes .qwen/omni/ and uploads
 *    workspace bytes off-machine);
 * 3. a usable API key for the uploads endpoint — Qwen OAuth is excluded:
 *    its ContentGeneratorConfig carries a placeholder, and the OAuth token
 *    is not accepted by the uploads channel;
 * 4. an explicit baseUrl (the uploads origin is derived from it — never
 *    send the configured credential to an origin the user didn't set);
 * 5. a DashScope-compatible provider.
 *
 * Any failed condition falls back to the pre-omni inline behavior.
 * Video modality is checked by the caller (fileUtils) alongside the
 * existing modality gate.
 */
export function isOmniVideoDeliveryActive(config: Config): boolean {
  // Optional calls so stub Configs in tests (and embedders constructing
  // partial configs) don't need the omni accessors to process files.
  if (!config.isOmniEnabled?.()) return false;
  if (config.isTrustedFolder?.() === false) {
    debugLogger.debug('omni delivery inactive: untrusted workspace');
    return false;
  }
  const cgc = config.getContentGeneratorConfig?.();
  if (!cgc) return false;
  if (
    cgc.authType === AuthType.QWEN_OAUTH ||
    !cgc.apiKey ||
    cgc.apiKey === QWEN_OAUTH_PLACEHOLDER_API_KEY
  ) {
    debugLogger.debug(
      'omni delivery inactive: no static API key usable for the uploads endpoint (Qwen OAuth is not supported in S1)',
    );
    return false;
  }
  if (!cgc.baseUrl) {
    debugLogger.debug(
      'omni delivery inactive: no explicit baseUrl to derive the uploads origin from',
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
 * (sha256, model) upload cache). Throws OmniDeliveryError on any failure;
 * user aborts propagate as the original abort error.
 */
export async function processVideoForOmniDelivery(
  filePath: string,
  config: Config,
  signal?: AbortSignal,
): Promise<OmniVideoDelivery> {
  const displayName = path.basename(filePath);

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

  // Enforce the byte ceiling from a cheap stat BEFORE hashing/probing —
  // a 60GB capture must not stream through SHA-256 only to be rejected.
  const configuredMax = config.getOmniUploadMaxFileBytes?.();
  const maxBytes =
    configuredMax !== undefined && configuredMax > 0
      ? configuredMax
      : DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES;
  const stat = await fs.stat(filePath).catch((err) => {
    throw new OmniDeliveryError(
      `Cannot stat video file ${displayName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  });
  if (stat.size > maxBytes) {
    throw new OmniDeliveryError(
      `Video exceeds the omni upload limit: ${stat.size} bytes > ` +
        `${maxBytes} bytes (omni.upload.maxFileBytes). ` +
        `Reduce the file size before retrying.`,
    );
  }

  let recognized: RecognizedVideo;
  try {
    recognized = await recognizeVideoFile(filePath, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OmniDeliveryError(
      `Video recognition failed for ${displayName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  const store = new OmniObjectStore(config.storage.getQwenDir());
  const extension = extensionForVideoMime(recognized.detectedMimeType);
  let objectPath: string;
  let deduped: boolean;
  try {
    const put = await store.putFile(
      filePath,
      recognized.sha256,
      extension,
      signal,
    );
    objectPath = put.objectPath;
    deduped = put.deduped;
  } catch (err) {
    if (signal?.aborted) throw err;
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
    if (signal?.aborted) throw err;
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
