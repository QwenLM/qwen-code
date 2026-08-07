/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { DashScopeOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/dashscope.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isAbortError } from '../utils/errors.js';
import { isFfmpegAvailable, isFfprobeAvailable } from './ffmpeg.js';
import {
  estimateRawResourceTokens,
  type OmniTokenEstimate,
} from './estimation.js';
import {
  assertWithinByteLimit,
  assertWithinTokenLimit,
  effectiveMaxUploadFileBytes,
  OmniTransportGuardError,
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
import { formatDisclosureText, formatOmissionText } from './disclosure.js';
import {
  runFixedPolicies,
  type PolicyDeliveryResource,
} from './policy/orchestrator.js';
import type { OmniProcessingConfigView } from './policy/types.js';

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
export {
  OMNI_DISCLOSURE_TEXT_PREFIX,
  OMNI_OMISSION_TEXT_PREFIX,
  formatDisclosureText,
  formatOmissionText,
  isDisclosureText,
} from './disclosure.js';
export {
  runFixedPolicies,
  OmniPolicyExecutionError,
  type PolicyDeliveryResource,
  type PolicyRunRecord,
} from './policy/orchestrator.js';
export type {
  FixedPolicyOrigin,
  NormalizedFixedPolicy,
  NormalizedOmniProcessingConfig,
} from './policy/types.js';

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
  /** Whether the content was already known to the system — object-store
   * dedup on the miss path, always true on an upload-cache hit. */
  deduped: boolean;
  /** True when the oss URL came from the persistent upload cache (no
   * network transfer happened for this delivery). */
  uploadCacheHit: boolean;
  /** Disclosure text that must accompany the media Part (present iff the
   * delivered content is a lossy policy derivative). */
  disclosure?: string;
  /** True when a fixed policy replaced the source with a lossy
   * derivative. */
  degraded?: boolean;
  /** Present when the transport guard could not bring the resource within
   * limits even after the transport-guard policies ran: the media was NOT
   * uploaded (`fileUri` is empty) and callers must materialize an
   * explicit-omission text Part in its place (policy design §10.2). */
  omission?: { reason: string };
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

/** Non-throwing transport-limit check: runs both guard dimensions and
 * reports the first violation as a message instead of an exception, so
 * the Stage B guard loop can react (run guard policies / omit) while
 * configs without a processing config keep the fail-closed throw. */
function evaluateTransportLimits(
  config: Config,
  recognized: RecognizedMedia,
  displayName: string,
): { estimate: OmniTokenEstimate; violation?: string } {
  try {
    assertWithinByteLimit(config, recognized.sizeBytes, displayName);
    return {
      estimate: assertWithinTokenLimit(config, recognized, displayName),
    };
  } catch (err) {
    if (err instanceof OmniTransportGuardError) {
      return {
        estimate: estimateRawResourceTokens(recognized),
        violation: err.message,
      };
    }
    throw err;
  }
}

/**
 * Omni pipeline: recognize → fixed policies (degradation) → transport
 * guard → hash → promote into the content-addressed store → upload via the
 * DashScope temporary channel → return the oss:// URL plus the token
 * estimate.
 *
 * The default pipeline never SILENTLY alters content: any degradation is
 * performed by configured fixed policies through real media-policy tools,
 * and every lossy derivative carries a mandatory disclosure (decision D8)
 * that reaches the model next to the media Part. The transport guard runs
 * AFTER the policies (decision D1) so it judges what is actually delivered
 * — an oversized original that a policy shrank must pass, and a policy
 * failure leaves the guard as the backstop. Successful uploads are
 * remembered in the persistent upload cache
 * (`.qwen/omni/upload-cache.json`, keyed by sha256 + model + endpoint
 * scope) for the oss URL validity window, so a re-read of unchanged
 * content skips both the store copy and the network transfer. Throws
 * OmniDeliveryError / OmniTransportGuardError on failure; user aborts
 * propagate untouched.
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
    /** Provenance for fixed-policy origin matching. Defaults to 'user';
     * the tool-result funnel passes 'tool'. */
    origin?: 'user' | 'tool';
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

  // Existence pre-check with a clean caller-facing error (recognition
  // failures on a missing file read worse). The byte guard is NOT applied
  // here anymore — it judges the post-policy delivery set below.
  await fs.stat(filePath).catch((err) => {
    throw new OmniDeliveryError(
      `Cannot stat media file ${displayName}: ${sanitizeErrorMessage(err, [filePath])}`,
      { cause: err },
    );
  });

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

  const store = new OmniObjectStore(config.storage.getQwenDir());
  const cgc = config.getContentGeneratorConfig();
  // Scope the cache to the endpoint credential: an oss:// URL minted for one
  // (origin, apiKey) pair must never be served for another — switching
  // accounts or endpoints yields URLs the new credential may not own. The
  // fingerprint keeps raw key material out of the cache file.
  const cacheScope = createHash('sha256')
    .update(`${cgc.baseUrl ?? ''}|${cgc.apiKey ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  const configuredTtl = config.getOmniUploadUrlTtlHours?.();
  const uploadCache = new OmniUploadCache(
    store.getOmniRootDir(),
    configuredTtl === undefined
      ? DEFAULT_UPLOAD_CACHE_TTL_HOURS
      : configuredTtl,
    cacheScope,
  );
  // Lazy one-time hygiene scan (expired .part files, promotion orphans,
  // quarantine retention/size sweeps, sampled object verification). MUST
  // run before the orchestrator: the scan deletes staging/ wholesale,
  // which would race live invocations.
  await runStartupRecoveryOnce(store, uploadCache, {
    quarantineRetentionDays: config.getOmniQuarantineRetentionDays?.(),
    quarantineMaxBytes: config.getOmniQuarantineMaxBytes?.(),
  });

  // Fixed-policy preprocessing (decision D5: this single site covers
  // @-commands, tool results, the URL funnel and ACP). Structural view —
  // a config without the accessor (stub configs, embedders skipping
  // initialize) or with no policies changes nothing.
  const processingConfig = (
    config as OmniProcessingConfigView
  ).getOmniProcessingConfig?.();
  let final: PolicyDeliveryResource = { filePath, recognized };
  const policies = processingConfig?.fixedPolicies ?? [];
  if (policies.length > 0) {
    let deliveries: PolicyDeliveryResource[];
    try {
      ({ deliveries } = await runFixedPolicies(
        config,
        {
          filePath,
          recognized,
          displayName,
          origin: options?.origin ?? 'user',
        },
        { store, policies, signal, limits: processingConfig?.limits },
      ));
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OmniDeliveryError(
        `Fixed-policy processing failed for ${displayName}: ` +
          `${sanitizeErrorMessage(err, [filePath, store.getOmniRootDir()])}`,
        { cause: err },
      );
    }
    // The S4 delivery contract is one Part per source: every degradation
    // tool is 1:1 with `source: omit`, so a differently-shaped set means
    // a configuration this stage does not support yet.
    if (deliveries.length !== 1) {
      throw new OmniDeliveryError(
        `Fixed policies produced ${deliveries.length} deliverables for ${displayName}; exactly one is supported.`,
      );
    }
    final = deliveries[0];
  }

  // Transport guard on the FINAL delivery set (decision D1): the bytes
  // and token estimate judged are the ones actually delivered. Stage B:
  // a violation first runs the transport-guard policies (matched by
  // modality only — no `when`, coverage of all three modalities is
  // enforced at config normalization) for up to
  // `limits.maxTransportPasses` passes; a still-over-limit resource is
  // explicitly OMITTED (policy design §10.2) rather than delivered
  // oversized. Without a normalized processing config (stub configs,
  // embedders skipping initialize) the guard keeps its fail-closed throw.
  let guard = evaluateTransportLimits(config, final.recognized, displayName);
  if (guard.violation && processingConfig) {
    const guardPolicies = processingConfig.transportGuardPolicies.filter((p) =>
      p.mediaTypes.includes(final.recognized.modality),
    );
    const maxPasses = processingConfig.limits.maxTransportPasses;
    for (
      let pass = 0;
      guard.violation && guardPolicies.length > 0 && pass < maxPasses;
      pass++
    ) {
      let deliveries: PolicyDeliveryResource[];
      try {
        ({ deliveries } = await runFixedPolicies(
          config,
          {
            filePath: final.filePath,
            recognized: final.recognized,
            displayName,
            origin: options?.origin ?? 'user',
          },
          {
            store,
            policies: guardPolicies,
            signal,
            limits: processingConfig.limits,
          },
        ));
      } catch (err) {
        if (signal?.aborted) throw err;
        // Guard-policy failure with no compliant alternative: fail closed
        // — a guard configuration error must never degrade into sending
        // over-limit media (policy design §10.2).
        throw new OmniDeliveryError(
          `Transport-guard processing failed for ${displayName}: ` +
            `${sanitizeErrorMessage(err, [final.filePath, store.getOmniRootDir()])}`,
          { cause: err },
        );
      }
      if (deliveries.length !== 1) {
        throw new OmniDeliveryError(
          `Transport-guard policies produced ${deliveries.length} deliverables for ${displayName}; exactly one is supported.`,
        );
      }
      if (deliveries[0].filePath === final.filePath) {
        // No progress (every guard policy was a no_op for this input) —
        // further passes would repeat the same work.
        break;
      }
      final = deliveries[0];
      guard = evaluateTransportLimits(config, final.recognized, displayName);
    }
  }
  if (guard.violation) {
    if (!processingConfig) {
      throw new OmniTransportGuardError(guard.violation);
    }
    debugLogger.debug(
      `omni ${final.recognized.modality} explicitly omitted (transport guard): ${guard.violation}`,
    );
    return {
      fileUri: '',
      mimeType: final.recognized.detectedMimeType,
      sha256: final.sha256 ?? '',
      recognized: final.recognized,
      tokenEstimate: guard.estimate,
      deduped: false,
      uploadCacheHit: false,
      disclosure: final.disclosure,
      degraded: final.degraded,
      omission: { reason: guard.violation },
    };
  }
  const tokenEstimate = guard.estimate;

  // Content hash: identity of the stored object. Derivatives arrive with
  // their hash from promotion; sources are hashed here, after all guards.
  let sha256: string;
  try {
    sha256 = final.sha256 ?? (await hashFileSha256(final.filePath, signal));
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OmniDeliveryError(
      `Failed to hash media file ${displayName}: ${sanitizeErrorMessage(err, [final.filePath])}`,
      { cause: err },
    );
  }

  // Cache lookup BEFORE store promotion: a hit means the server already
  // holds these bytes for this model+endpoint, so neither the local copy
  // nor the upload is needed (zoom_image reads the original path, not the
  // store). Checking after putFile would pay a full-file copy per hit.
  const model = config.getModel();
  const cachedUrl = await uploadCache.get(sha256, model);
  if (cachedUrl) {
    debugLogger.debug(
      `omni upload cache hit: sha256=${sha256.slice(0, 12)}… model=${model}`,
    );
    return {
      fileUri: cachedUrl,
      mimeType: final.recognized.detectedMimeType,
      sha256,
      recognized: final.recognized,
      tokenEstimate,
      // No new copy was made: the content is already known to the system
      // (a prior delivery both stored and uploaded it).
      deduped: true,
      uploadCacheHit: true,
      disclosure: final.disclosure,
      degraded: final.degraded,
    };
  }

  const extension = extensionForMime(final.recognized.detectedMimeType);
  let objectPath: string;
  let deduped: boolean;
  try {
    const put = await store.putFile(final.filePath, sha256, extension, signal);
    objectPath = put.objectPath;
    deduped = put.deduped;
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OmniDeliveryError(
      `Failed to store media in the omni object store: ` +
        `${sanitizeErrorMessage(err, [final.filePath, store.getOmniRootDir()])}`,
      { cause: err },
    );
  }

  const uploader = new DashScopeUploader({
    apiKey: cgc.apiKey ?? '',
    baseUrl: cgc.baseUrl,
  });
  let fileUri: string;
  try {
    fileUri = await uploader.uploadFile({
      filePath: objectPath,
      model,
      mimeType: final.recognized.detectedMimeType,
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
    `omni ${final.recognized.modality} delivered: sha256=${sha256.slice(0, 12)}… ` +
      `size=${final.recognized.sizeBytes} est=${tokenEstimate.estimatedTokenCount}(${tokenEstimate.status}) ` +
      `deduped=${deduped} degraded=${final.degraded === true} uri=${fileUri}`,
  );
  await uploadCache.put(sha256, model, fileUri);
  return {
    fileUri,
    mimeType: final.recognized.detectedMimeType,
    sha256,
    recognized: final.recognized,
    tokenEstimate,
    deduped,
    uploadCacheHit: false,
    disclosure: final.disclosure,
    degraded: final.degraded,
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
    if (delivery.omission) {
      // Explicit omission (policy design §10.2): the media is withheld and
      // the omission notice text stands in its place. Not an error — the
      // read succeeded; the transport guard's verdict is the content.
      return {
        llmContent: formatOmissionText(displayName, delivery.omission.reason),
        returnDisplay: `Media omitted by the omni transport guard: ${relativePathForDisplay}`,
        tokenEstimate: delivery.tokenEstimate,
      };
    }
    const fileDataPart = {
      fileData: {
        fileUri: delivery.fileUri,
        mimeType: delivery.mimeType,
        displayName,
      },
    };
    const parts: Array<{ text: string } | typeof fileDataPart> = [];
    const { width, height } = delivery.recognized.metadata;
    if (
      delivery.recognized.modality === 'image' &&
      width !== undefined &&
      height !== undefined
    ) {
      parts.push({
        text:
          `Image ${displayName}: full resolution ${width}x${height} px. ` +
          `Use zoom_image for a closer look at details.`,
      });
    }
    // Disclosure IMMEDIATELY before its media part (decision D8): provider
    // converters that relocate media move the adjacent pair together.
    if (delivery.disclosure) {
      parts.push({
        text: formatDisclosureText(displayName, delivery.disclosure),
      });
    }
    parts.push(fileDataPart);
    const llmContent = parts.length === 1 ? fileDataPart : parts;
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
 * `omni.ingestion.localization.url.maxFileBytes` is explicitly configured
 * higher. */
export function effectiveMaxDownloadFileBytes(config: Config): number {
  const uploadCap = effectiveMaxUploadFileBytes(config);
  const configured = config.getOmniUrlDownloadMaxFileBytes?.();
  if (configured !== undefined && configured > 0) {
    return Math.min(configured, uploadCap);
  }
  return uploadCap;
}
