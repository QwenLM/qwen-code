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
import { ToolErrorType } from '../tools/tool-error.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isAbortError } from '../utils/errors.js';
import { isFfmpegAvailable, isFfprobeAvailable } from './ffmpeg.js';
import type { OmniTokenEstimate } from './estimation.js';
import {
  assertWithinByteLimit,
  assertWithinTokenLimit,
  effectiveMaxUploadFileBytes,
} from './guard.js';
import {
  extensionForMime,
  hashFileSha256,
  recognizeMediaFile,
  type OmniModality,
  type RecognizedMedia,
} from './recognition.js';
import { OmniObjectStore } from './storage.js';
import { DashScopeUploader } from './upload.js';
import {
  OmniUploadCache,
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
} from './upload-cache.js';
import { runStartupRecoveryOnce } from './recovery.js';

export {
  assertOmniRuntimeDependencies,
  isFfmpegAvailable,
  isFfprobeAvailable,
  resetFfmpegCachesForTests,
} from './ffmpeg.js';
export { OmniObjectStore } from './storage.js';
export { DashScopeUploader, OSS_URL_PREFIX } from './upload.js';
export {
  recognizeMediaFile,
  sniffMediaType,
  sniffFileModality,
  sniffVideoMimeType,
  hashFileSha256,
  type OmniModality,
  type RecognizedMedia,
} from './recognition.js';
export {
  estimateRawResourceTokens,
  type OmniTokenEstimate,
} from './estimation.js';
export {
  OmniTransportGuardError,
  DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES,
} from './guard.js';
export {
  downloadMediaUrl,
  parseHttpUrlRef,
  OmniDownloadError,
  type DownloadedMedia,
} from './download.js';
// Circular-safe (both modules only bind functions): lets the ./omni
// subpath entry serve the tool-result funnel without the big barrel.
export { processToolResultOmniMedia } from './tool-result-media.js';
export {
  OmniUploadCache,
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
} from './upload-cache.js';
export {
  runStartupRecoveryOnce,
  resetRecoveryLatchForTests,
} from './recovery.js';
export { resetCredentialCacheForTests } from './upload.js';

const debugLogger = createDebugLogger('omni');

/**
 * Scrub absolute path segments out of an error message, keeping the
 * basename — fs errors embed full paths (`ENOENT: … stat '/Users/x/…'`)
 * and several wraps below flow into model-visible llmContent, which must
 * never carry real paths.
 *
 * `knownPaths` are replaced EXACTLY (split/join) before the pattern pass:
 * a regex can never enumerate every path shape (CJK segments, `~`-prefixed
 * or special-character basenames, Windows drives), but the pipeline always
 * knows which file it was working on, and exact replacement of that path is
 * immune to all of them. The pattern pass then catches other embedded paths
 * (e.g. the object-store destination) with separator-based — not
 * ASCII-word-based — segment classes, so non-ASCII segments still match.
 */
// Exported for direct unit testing of the path shapes (visible only via the
// module namespace; not re-exported from any barrel).
export function sanitizeErrorMessage(
  err: unknown,
  knownPaths: string[] = [],
): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const known of knownPaths) {
    if (known) msg = msg.split(known).join(path.basename(known));
  }
  return (
    msg
      // POSIX: two or more segments then a basename → keep the basename.
      .replace(/(?:\/[^/\s'"]+)+\/([^/\s'"]+)/g, '$1')
      // Windows: optional drive letter, backslash segments.
      .replace(/(?:[A-Za-z]:)?(?:\\[^\\\s'"]+)+\\([^\\\s'"]+)/g, '$1')
  );
}

/**
 * Placeholder the model-config resolver assigns under Qwen OAuth; the real
 * token is swapped in per-request by QwenContentGenerator and never lands
 * in the ContentGeneratorConfig, so it cannot authenticate the uploads
 * endpoint. See modelConfigResolver.ts.
 */
const QWEN_OAUTH_PLACEHOLDER_API_KEY = 'QWEN_OAUTH_DYNAMIC_TOKEN';

/** Result of the omni media delivery pipeline. */
export interface OmniMediaDelivery {
  /** `oss://…` URL to place in fileData.fileUri. */
  fileUri: string;
  /** Authoritative (sniffed) MIME type for the Part. */
  mimeType: string;
  /** Content hash — identity of the stored object. */
  sha256: string;
  /** Recognition output, for logs/display. */
  recognized: RecognizedMedia;
  /** Raw-resource token estimate (attached even when the guard is off). */
  tokenEstimate: OmniTokenEstimate;
  /** Whether the object store already held this content. */
  deduped: boolean;
  /** True when the oss URL came from the persistent upload cache (no
   * network transfer happened for this delivery). */
  uploadCacheHit: boolean;
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
 * Gate for the omni delivery path. All conditions must hold:
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
 * Modality support is checked by the caller (fileUtils) alongside the
 * existing modality gate.
 */
export function isOmniDeliveryActive(config: Config): boolean {
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
      'omni delivery inactive: no static API key usable for the uploads endpoint (Qwen OAuth is not supported)',
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
 * Omni pipeline: recognize → transport guard → hash → promote into the
 * content-addressed store → upload via the DashScope temporary channel →
 * return the oss:// URL plus the token estimate.
 *
 * All modalities are uploaded AS-IS — no resizing, no transcoding.
 * Degradation is the job of S4 policies (which must disclose); the default
 * path never silently alters content. No caching yet (S3 adds the
 * (sha256, model) upload cache). Throws OmniDeliveryError /
 * OmniTransportGuardError on failure; user aborts propagate untouched.
 */
export async function processMediaForOmniDelivery(
  filePath: string,
  config: Config,
  options?: {
    expectedModality?: OmniModality;
    signal?: AbortSignal;
    /**
     * Name used for the file in guard/error messages. Defaults to the
     * file's basename — callers whose input is not a user-visible path
     * (the URL funnel stages downloads under opaque temp names) pass the
     * user-recognizable name instead.
     */
    displayName?: string;
  },
): Promise<OmniMediaDelivery> {
  const { expectedModality, signal } = options ?? {};
  const displayName = options?.displayName ?? path.basename(filePath);

  // Defense in depth: startup validation already asserted this, but the
  // pipeline can also be reached in embedders that skip Config.initialize.
  const [ffmpeg, ffprobe] = await Promise.all([
    isFfmpegAvailable(),
    isFfprobeAvailable(),
  ]);
  if (!ffmpeg || !ffprobe) {
    throw new OmniDeliveryError(
      'ffmpeg/ffprobe not available; omni media delivery requires both on PATH.',
    );
  }

  // Byte guard from a cheap stat BEFORE hashing/probing — a 60GB capture
  // must not stream through SHA-256 only to be rejected.
  const stat = await fs.stat(filePath).catch((err) => {
    throw new OmniDeliveryError(
      `Cannot stat media file ${displayName}: ${sanitizeErrorMessage(err, [filePath])}`,
      { cause: err },
    );
  });
  assertWithinByteLimit(config, stat.size, displayName);

  let recognized: RecognizedMedia;
  try {
    recognized = await recognizeMediaFile(filePath, {
      expectedModality,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OmniDeliveryError(
      `Media recognition failed for ${displayName}: ${sanitizeErrorMessage(err, [filePath])}`,
      { cause: err },
    );
  }

  // Token guard AFTER probe (needs metadata), BEFORE hash/copy/upload — a
  // token-oversized input must not pay a full-file SHA-256 to be rejected.
  const tokenEstimate = assertWithinTokenLimit(config, recognized, displayName);

  // Content hash: identity of the stored object. Computed only once all
  // guards have passed, immediately before promotion into the store.
  let sha256: string;
  try {
    sha256 = await hashFileSha256(filePath, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OmniDeliveryError(
      `Failed to hash media file ${displayName}: ${sanitizeErrorMessage(err, [filePath])}`,
      { cause: err },
    );
  }

  const store = new OmniObjectStore(config.storage.getQwenDir());
  const configuredTtl = config.getOmniUploadCacheTtlHours?.();
  const uploadCache = new OmniUploadCache(
    store.getOmniRootDir(),
    configuredTtl === undefined
      ? DEFAULT_UPLOAD_CACHE_TTL_HOURS
      : configuredTtl,
  );
  // Lazy one-time hygiene scan (expired .part files, promotion orphans,
  // sampled object verification). Never throws.
  await runStartupRecoveryOnce(store, uploadCache);
  const extension = extensionForMime(recognized.detectedMimeType);
  let objectPath: string;
  let deduped: boolean;
  try {
    const put = await store.putFile(filePath, sha256, extension, signal);
    objectPath = put.objectPath;
    deduped = put.deduped;
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OmniDeliveryError(
      `Failed to store media in the omni object store: ` +
        `${sanitizeErrorMessage(err, [filePath, store.getOmniRootDir()])}`,
      { cause: err },
    );
  }

  const model = config.getModel();
  const cachedUrl = await uploadCache.get(sha256, model);
  if (cachedUrl) {
    debugLogger.debug(
      `omni upload cache hit: sha256=${sha256.slice(0, 12)}… model=${model}`,
    );
    return {
      fileUri: cachedUrl,
      mimeType: recognized.detectedMimeType,
      sha256,
      recognized,
      tokenEstimate,
      deduped,
      uploadCacheHit: true,
    };
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
      model,
      mimeType: recognized.detectedMimeType,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    // Upload errors can embed the object-store path (spawn/fs failures) —
    // sanitize with the concrete path AND the store root, since a path with
    // a space in a segment defeats the pattern pass (segment classes break
    // at whitespace) and only exact replacement is immune.
    throw new OmniDeliveryError(
      sanitizeErrorMessage(err, [objectPath, store.getOmniRootDir()]),
      { cause: err },
    );
  }

  debugLogger.debug(
    `omni ${recognized.modality} delivered: sha256=${sha256.slice(0, 12)}… ` +
      `size=${recognized.sizeBytes} est=${tokenEstimate.estimatedTokenCount}(${tokenEstimate.status}) ` +
      `deduped=${deduped} uri=${fileUri}`,
  );
  await uploadCache.put(sha256, model, fileUri);
  return {
    fileUri,
    mimeType: recognized.detectedMimeType,
    sha256,
    recognized,
    tokenEstimate,
    deduped,
    uploadCacheHit: false,
  };
}

/** Read-result shape consumed by fileUtils.processSingleFileContent for
 * media Parts (structurally mirrors ProcessedFileReadResult's media case
 * without importing fileUtils, which would create a cycle). */
export interface OmniMediaReadResult {
  llmContent:
    | string
    | Array<
        | { text: string }
        | {
            fileData: {
              fileUri: string;
              mimeType: string;
              displayName: string;
            };
          }
      >
    | { fileData: { fileUri: string; mimeType: string; displayName: string } };
  returnDisplay: string;
  error?: string;
  errorType?: ToolErrorType;
  tokenEstimate?: OmniTokenEstimate;
}

/**
 * fileUtils-facing wrapper: run the delivery pipeline and shape the
 * outcome as a file-read result. Fails closed on delivery errors (no
 * inline fallback); rethrows user aborts so the caller's abort handling
 * applies. For images, a text part with dimensions and a zoom hint is
 * emitted alongside the fileData part (zoom_image reads the original from
 * disk and stays functional under upload delivery).
 */
export async function readMediaViaOmniDelivery(params: {
  filePath: string;
  config: Config;
  displayName: string;
  relativePathForDisplay: string;
  expectedModality: OmniModality;
  signal?: AbortSignal;
}): Promise<OmniMediaReadResult> {
  const {
    filePath,
    config,
    displayName,
    relativePathForDisplay,
    expectedModality,
    signal,
  } = params;
  try {
    const delivery = await processMediaForOmniDelivery(filePath, config, {
      expectedModality,
      signal,
    });
    const fileDataPart = {
      fileData: {
        fileUri: delivery.fileUri,
        mimeType: delivery.mimeType,
        displayName,
      },
    };
    const { width, height } = delivery.recognized.metadata;
    const llmContent =
      delivery.recognized.modality === 'image' &&
      width !== undefined &&
      height !== undefined
        ? [
            {
              text:
                `Image ${displayName}: full resolution ${width}x${height} px. ` +
                `Use zoom_image for a closer look at details.`,
            },
            fileDataPart,
          ]
        : fileDataPart;
    return {
      llmContent,
      returnDisplay: `Read ${delivery.recognized.modality} file (omni upload): ${relativePathForDisplay}`,
      tokenEstimate: delivery.tokenEstimate,
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw err;
    // Fail closed: no silent fallback to inline base64 — a fallback would
    // resurrect the 10MB cap surprise and mislead the user into thinking
    // the model saw the original media.
    //
    // Both llmContent AND error are model-visible: on READ_CONTENT_FAILURE
    // the scheduler puts `error` (not the sanitized llmContent) into the
    // functionResponse, so an unsanitized message here would leak the
    // absolute path on every failed read_file. Sanitize once, use twice,
    // and name the file by displayName rather than its real path.
    const message = sanitizeErrorMessage(err, [filePath]);
    return {
      llmContent: `[Omni media delivery failed for ${displayName}: ${message}]`,
      returnDisplay: `Failed to deliver media via omni upload: ${relativePathForDisplay}`,
      error: `Omni media delivery failed: ${displayName}: ${message}`,
      errorType: ToolErrorType.READ_CONTENT_FAILURE,
    };
  }
}

/** Effective download byte ceiling — never above the upload channel cap
 * (downloading more than can be delivered is pointless), including when
 * `omni.download.maxFileBytes` is explicitly configured higher. */
export function effectiveMaxDownloadFileBytes(config: Config): number {
  const uploadCap = effectiveMaxUploadFileBytes(config);
  const configured = config.getOmniDownloadMaxFileBytes?.();
  if (configured !== undefined && configured > 0) {
    return Math.min(configured, uploadCap);
  }
  return uploadCap;
}
