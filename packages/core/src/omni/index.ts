/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Config } from '../config/config.js';
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
  assertWithinDurationLimit,
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
import { createOmniUploader } from './oss-upload.js';
import { requireEffectiveOmniUploadConfig } from './upload-config.js';
import {
  OmniUploadCache,
  DEFAULT_UPLOAD_CACHE_TTL_HOURS,
} from './upload-cache.js';
import { runStartupRecoveryOnce } from './recovery.js';
import { effectiveOmniStorageMaxTotalBytes, runOmniGcOnce } from './gc.js';
import { OmniDegradationCache } from './policy/degradation-cache.js';
import {
  formatDisclosureText,
  formatOmissionText,
  formatResourceHandleText,
  formatResourcePathText,
  formatTranscriptText,
} from './disclosure.js';
import {
  runFixedPolicies,
  type PolicyDeliveryResource,
  type PolicyFileDelivery,
} from './policy/orchestrator.js';
import { buildSessionConditionNamespace } from './policy/session-context.js';
import type { OmniProcessingConfigView } from './policy/types.js';
import {
  MediaMemoryService,
  MEDIA_DETECTOR_VERSION,
  type MediaMemoryBinding,
  type MediaResourceRegistry,
  type OmniMediaRegistryView,
  type OmniMemoryConfigView,
} from '../services/media-memory/index.js';

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
  assertWithinDurationLimit,
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
  OMNI_TRANSCRIPT_TEXT_PREFIX,
  formatDisclosureText,
  formatOmissionText,
  formatResourceHandleText,
  formatTranscriptText,
  isDisclosureText,
} from './disclosure.js';
export {
  runFixedPolicies,
  OmniPolicyExecutionError,
  type PolicyDeliveryResource,
  type PolicyFileDelivery,
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
  /** Transcript-protocol text deliverables (upstream P §6.2): file
   * artifacts (`kind:'file'`, `metadata.omniRole:'transcript'`) produced
   * by fixed policies and selected for delivery. They travel as text Parts
   * after the media Part — or stand alone when the policies omitted the
   * media entirely (`fileUri` is empty and `omission` is absent). */
  transcripts?: Array<{ text: string; disclosure?: string }>;
  /** Media deliverables beyond the primary one — present when a
   * multi-output fixed policy (e.g. `omni_extract_keyframes`) produced
   * more than one media derivative for this source (#8187 多产物投递).
   * Each entry was uploaded through the same store/upload pipeline as
   * the primary; an entry that violated the transport limits carries
   * `omission` instead of a usable `fileUri` (policy design §10.2 —
   * additional derivatives are already policy products, so a violating
   * one is withheld rather than re-derived). Callers materialize each
   * entry as [disclosure?, fileData] (or the omission notice) after the
   * primary media Part and before any transcripts. */
  additionalMedia?: OmniAdditionalMediaDelivery[];
  /** Opaque session handle for the SOURCE media (M §5.2), present iff
   * media memory recorded it. Consumers disclose it next to the delivered
   * content so the model can reference the resource in recall requests —
   * the handle stands in for the path the model must never see. */
  resourceId?: string;
}

/** One extra media deliverable of a multi-output fixed policy. */
export interface OmniAdditionalMediaDelivery {
  /** `oss://…` URL; empty iff `omission` is present. */
  fileUri: string;
  mimeType: string;
  sha256: string;
  /** Disclosure text that must immediately precede this media Part. */
  disclosure?: string;
  /** Present when the transport limits rejected this deliverable: it was
   * NOT uploaded and an explicit-omission text Part stands in its place. */
  omission?: { reason: string };
}

/** A Part materialized from an additional media deliverable. */
export type OmniAdditionalMediaPart =
  | { text: string }
  | { fileData: { fileUri: string; mimeType: string; displayName: string } };

/**
 * Materialize `additionalMedia` as Parts — shared by every delivery
 * consumer (fileUtils read results, tool-result funnels, the @url funnel)
 * so the multi-output contract has a single shape: per extra
 * [disclosure?, fileData] (or [disclosure?, omission text]), placed after
 * the primary media Part (or its omission/transcript stand-in) and before
 * any transcript Parts. D8 adjacency applies to each pair independently.
 */
export function buildAdditionalMediaParts(
  displayName: string,
  additionalMedia: OmniAdditionalMediaDelivery[] | undefined,
): OmniAdditionalMediaPart[] {
  const parts: OmniAdditionalMediaPart[] = [];
  for (const extra of additionalMedia ?? []) {
    if (extra.disclosure) {
      parts.push({ text: formatDisclosureText(displayName, extra.disclosure) });
    }
    if (extra.omission) {
      parts.push({
        text: formatOmissionText(displayName, extra.omission.reason),
      });
    } else {
      parts.push({
        fileData: {
          fileUri: extra.fileUri,
          mimeType: extra.mimeType,
          displayName,
        },
      });
    }
  }
  return parts;
}

/**
 * Materialize transcript deliverables (§6.2) as text Parts — shared by
 * every delivery consumer: each transcript follows its media Part (or the
 * omission notice), preceded by its own disclosure (same D8 adjacency
 * contract as media disclosures).
 */
export function buildTranscriptParts(
  displayName: string,
  transcripts: Array<{ text: string; disclosure?: string }> | undefined,
): Array<{ text: string }> {
  const parts: Array<{ text: string }> = [];
  for (const t of transcripts ?? []) {
    if (t.disclosure) {
      parts.push({ text: formatDisclosureText(displayName, t.disclosure) });
    }
    parts.push({ text: formatTranscriptText(displayName, t.text) });
  }
  return parts;
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

export { isOmniDeliveryActive } from './delivery-gate.js';

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
    // Duration is a transport limit too: downscaling can bring a long
    // file under the byte ceiling but never under a duration cap, so the
    // guard must reject it here instead of letting the provider do it.
    assertWithinDurationLimit(config, recognized, displayName);
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
    /**
     * The URL this media was downloaded from. Set by the URL funnel, whose
     * `filePath` is a staging download it deletes in its `finally` THIS
     * turn — so, exactly like tool-result media, its memory identity must
     * anchor to the content-addressed object store, never to the staging
     * path. The URL itself is recorded as the version's source locator.
     */
    sourceUrl?: string;
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
  const uploadConfig = requireEffectiveOmniUploadConfig(config);
  // Scope the cache to the endpoint credential: an oss:// URL minted for one
  // (origin, apiKey) pair must never be served for another — switching
  // accounts or endpoints yields URLs the new credential may not own. The
  // fingerprint keeps raw key material out of the cache file.
  const cacheScope = createHash('sha256')
    .update(`${uploadConfig.baseUrl}|${uploadConfig.apiKey}`)
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
  // run before the orchestrator: the scan deletes stale staging entries,
  // which would race this process's own live invocations. (Other
  // processes' live entries are protected by the staging grace window.)
  await runStartupRecoveryOnce(store, uploadCache, {
    quarantineRetentionDays: config.getOmniQuarantineRetentionDays?.(),
    quarantineMaxBytes: config.getOmniQuarantineMaxBytes?.(),
    // Corrupt-object deletion must also invalidate degradation-cache
    // entries (as source or derivative) — otherwise policy-cache.json
    // accumulates orphans that can never be served again.
    degradationCache: new OmniDegradationCache(store.getOmniRootDir()),
  });

  // Fixed-policy preprocessing (decision D5: this single site covers
  // @-commands, tool results, the URL funnel and ACP). Structural view —
  // a config without the accessor (stub configs, embedders skipping
  // initialize) or with no policies changes nothing.
  const processingConfig = (
    config as OmniProcessingConfigView
  ).getOmniProcessingConfig?.();
  // Session-namespace snapshot for `when` conditions (policy design §8.3):
  // taken ONCE before any policy executes and reused across the
  // preprocessing run and every transport-guard pass of this delivery.
  // The request namespace is computed inside the orchestrator from the
  // pending delivery set.
  const conditionContext = processingConfig
    ? {
        session: buildSessionConditionNamespace(
          config,
          processingConfig.limits.reservedOutputTokens,
        ),
      }
    : undefined;
  // Media-memory collection (S5, design M §6). Same structural-view
  // pattern as the processing config; absent accessor or config = off.
  // Recording FileRecognized needs the source's content hash NOW, so the
  // hash is paid upfront and seeded through the pipeline (source →
  // WorkItem → final) — uploadResource's lazy hash never re-pays it. A
  // memory failure (hash or store) never blocks delivery: collection is
  // skipped and the pipeline continues exactly as without memory.
  const memoryConfig = (config as OmniMemoryConfigView).getOmniMemoryConfig?.();
  const memoryService = memoryConfig
    ? new MediaMemoryService(store.getOmniRootDir(), {
        maxInlineTextBytes: memoryConfig.collection.maxInlineTextBytes,
      })
    : undefined;
  // GC (storage design §6.2), asynchronously after recovery so the first
  // delivery is never blocked on a sweep. Memory IS the root set, so the
  // GC only exists where memory does — without it every object would read
  // as unreferenced and the sweep would empty the store on age alone.
  if (memoryService) {
    void runOmniGcOnce({
      store,
      memoryService,
      registry: (
        config as OmniMediaRegistryView
      ).getOmniMediaResourceRegistry?.(),
      uploadCache,
      degradationCache: new OmniDegradationCache(store.getOmniRootDir()),
      retentionDays: config.getOmniStorageRetentionDays?.() ?? 14,
      // Floor-clamped: a budget below 10× the single-media limit cannot
      // hold normal artifacts and would read as permanent suspension.
      maxTotalBytes:
        typeof config.getOmniStorageMaxTotalBytes === 'function'
          ? effectiveOmniStorageMaxTotalBytes(config)
          : 20 * 1024 * 1024 * 1024,
    });
  }
  // Session resource registry (M §5.2): every memory-known resource this
  // delivery puts in front of the model gets an opaque session handle,
  // making it addressable by recall without ever exposing a path.
  const registry = memoryService
    ? (config as OmniMediaRegistryView).getOmniMediaResourceRegistry?.()
    : undefined;
  const bindSessionResource = (
    item: PolicyDeliveryResource,
    /** Overrides the locator the handle resolves to — used for the source
     * of tool-result media, whose `filePath` is an ephemeral staging file
     * while its persistent bytes live in the object store. */
    fileRefOverride?: string,
  ): ReturnType<MediaResourceRegistry['bind']> | undefined =>
    registry && item.memoryBinding
      ? registry.bind({
          ...item.memoryBinding,
          fileRef: fileRefOverride ?? item.filePath,
          mediaType: item.recognized.modality,
        })
      : undefined;
  let sourceSha256: string | undefined;
  let sourceBinding: MediaMemoryBinding | undefined;
  let sourceFileRef = filePath;
  if (memoryService) {
    try {
      sourceSha256 = await hashFileSha256(filePath, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      debugLogger.debug(
        `omni memory: hashing ${displayName} failed, skipping collection: ` +
          `${sanitizeErrorMessage(err, [filePath])}`,
      );
    }
    if (sourceSha256) {
      // Persistent identity of the SOURCE. A user file's bytes stay in
      // place, so its own path is the identity (S §4). A tool-result
      // file's path is a staging `.part` the funnel deletes in its
      // `finally` THIS turn — recording it would hand out a handle that
      // resolves to a deleted path (ENOENT for any policy tool the model
      // points at it) and make recall report `artifact_unavailable` for
      // an artifact that actually persists. Its bytes are promoted into
      // the content-addressed object store by this same delivery, and
      // that location is derivable from the hash — so name it directly.
      // If promotion never happens (the transport guard omitted the
      // media), the ref dangles and recall says `artifact_unavailable`:
      // honest, because the bytes were genuinely not retained.
      const origin = options?.origin ?? 'user';
      // URL media shares the tool-result lifetime: its local file is a
      // staging download deleted this turn, so it anchors the same way.
      const ephemeralSource =
        origin === 'tool' || options?.sourceUrl !== undefined;
      sourceFileRef = ephemeralSource
        ? store.objectPathFor(
            sourceSha256,
            extensionForMime(recognized.detectedMimeType),
          )
        : filePath;
      sourceBinding = await memoryService.recordFileRecognized({
        fileRef: sourceFileRef,
        sha256: sourceSha256,
        mediaType: recognized.modality,
        metadata: recognized.metadata,
        sizeBytes: recognized.sizeBytes,
        mimeType: recognized.detectedMimeType,
        origin,
        source:
          options?.sourceUrl !== undefined
            ? { protocol: 'url', locator: options.sourceUrl }
            : origin === 'tool'
              ? { protocol: 'managed', locator: `sha256/${sourceSha256}` }
              : { protocol: 'local', locator: displayName },
        recognition: {
          ingestionConfigHash: '',
          detectorVersion: MEDIA_DETECTOR_VERSION,
          probeStatus: 'complete',
        },
      });
    }
  }
  let final: PolicyDeliveryResource = {
    filePath,
    recognized,
    sha256: sourceSha256,
    memoryBinding: sourceBinding,
  };
  // The source is always addressable by recall, even when preprocessing
  // later replaces the delivered bytes with a derivative. Its handle is
  // the one disclosed to the model (M §5.2): recall requests and future
  // evidence-gathering tool calls reference the SOURCE, never a path.
  const sessionResourceId = bindSessionResource(
    final,
    sourceFileRef,
  )?.resourceId;
  /** A guard verdict that carries the source handle with it, so a caller
   * withholding the bytes can still tell the model what to recall. */
  const guardRejection = (
    message: string,
    options?: { cause?: unknown },
  ): OmniTransportGuardError => {
    const err = new OmniTransportGuardError(message, options);
    if (sessionResourceId !== undefined) {
      err.sessionResourceId = sessionResourceId;
    }
    return err;
  };
  /** Media deliverables beyond the primary (multi-output fixed policies). */
  let extraDeliveries: PolicyDeliveryResource[] = [];
  // Transcript-protocol text deliverables (upstream P §6.2) accumulated
  // across preprocessing and guard passes; threaded into every return.
  const transcripts: Array<{ text: string; disclosure?: string }> = [];
  const collectTranscripts = (files: PolicyFileDelivery[]) => {
    for (const file of files) {
      transcripts.push({ text: file.text, disclosure: file.disclosure });
    }
  };
  // Pure-transcript delivery result (§6.2): the policies replaced the
  // media with text-only deliverables — no media Part is emitted
  // (`fileUri: ''`), nothing to guard or upload for the primary, and the
  // collected transcripts ride along. Shared by the preprocessing and
  // transport-guard resolutions of this shape.
  const textOnlyDelivery = (
    recognizedFinal: RecognizedMedia,
    tokenEstimate: OmniTokenEstimate,
    extras?: {
      disclosure?: string;
      additionalMedia?: OmniAdditionalMediaDelivery[];
    },
  ): OmniMediaDelivery => ({
    fileUri: '',
    mimeType: recognizedFinal.detectedMimeType,
    sha256: '',
    recognized: recognizedFinal,
    tokenEstimate,
    deduped: false,
    uploadCacheHit: false,
    degraded: true,
    transcripts,
    resourceId: sessionResourceId,
    ...extras,
  });
  const policies = processingConfig?.fixedPolicies ?? [];
  if (policies.length > 0) {
    let deliveries: PolicyDeliveryResource[];
    let fileDeliveries: PolicyFileDelivery[];
    try {
      ({ deliveries, fileDeliveries } = await runFixedPolicies(
        config,
        {
          filePath,
          recognized,
          displayName,
          origin: options?.origin ?? 'user',
          sha256: sourceSha256,
        },
        {
          store,
          policies,
          signal,
          limits: processingConfig?.limits,
          conditionContext,
          memory: memoryService
            ? { service: memoryService, sourceBinding }
            : undefined,
        },
      ));
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OmniDeliveryError(
        `Fixed-policy processing failed for ${displayName}: ` +
          `${sanitizeErrorMessage(err, [filePath, store.getOmniRootDir()])}`,
        { cause: err },
      );
    }
    collectTranscripts(fileDeliveries);
    // Pure-transcript delivery (§6.2): the token estimate reports the RAW
    // resource for logs/telemetry; no media Part is emitted, so the guard
    // verdict is irrelevant.
    if (deliveries.length === 0 && transcripts.length > 0) {
      return textOnlyDelivery(
        recognized,
        evaluateTransportLimits(config, recognized, displayName).estimate,
      );
    }
    // The S4 delivery contract keeps ONE primary media Part per source
    // (plus any transcript text Parts); a multi-output fixed policy
    // (e.g. omni_extract_keyframes) additionally yields extra media
    // deliverables, carried in `additionalMedia` and materialized by the
    // callers as [disclosure?, fileData] pairs after the primary Part
    // (#8187 多产物投递). Zero media deliverables without transcripts
    // remains a configuration error.
    if (deliveries.length === 0) {
      throw new OmniDeliveryError(
        `Fixed policies produced 0 media deliverables for ${displayName}; exactly one is supported.`,
      );
    }
    final = deliveries[0];
    extraDeliveries = deliveries.slice(1);
    // Every delivered derivative becomes session-addressable (bind is
    // idempotent — the source keeps its already-issued handle if a no_op
    // policy passed it through unchanged).
    for (const delivery of deliveries) bindSessionResource(delivery);
  }

  // Hash → upload-cache lookup → store promotion → upload. Shared by the
  // primary deliverable and every additional media deliverable of a
  // multi-output policy. Derivatives arrive with their promotion hash;
  // sources are hashed at call time, after all guards.
  const uploadModel = uploadConfig.model;
  const uploadResource = async (
    item: PolicyDeliveryResource,
    estimate: OmniTokenEstimate,
  ): Promise<{
    fileUri: string;
    sha256: string;
    deduped: boolean;
    uploadCacheHit: boolean;
  }> => {
    let sha256: string;
    try {
      sha256 = item.sha256 ?? (await hashFileSha256(item.filePath, signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OmniDeliveryError(
        `Failed to hash media file ${displayName}: ${sanitizeErrorMessage(err, [item.filePath])}`,
        { cause: err },
      );
    }

    // Cache lookup BEFORE store promotion: a hit means the server already
    // holds these bytes for this model+endpoint, so neither the local copy
    // nor the upload is needed (zoom_image reads the original path, not the
    // store). Checking after putFile would pay a full-file copy per hit.
    const cachedUrl = await uploadCache.get(sha256, uploadModel);
    if (cachedUrl) {
      debugLogger.debug(
        `omni upload cache hit: sha256=${sha256.slice(0, 12)}… model=${uploadModel}`,
      );
      // No new copy was made: the content is already known to the system
      // (a prior delivery both stored and uploaded it).
      return {
        fileUri: cachedUrl,
        sha256,
        deduped: true,
        uploadCacheHit: true,
      };
    }

    const extension = extensionForMime(item.recognized.detectedMimeType);
    let objectPath: string;
    let deduped: boolean;
    try {
      const put = await store.putFile(item.filePath, sha256, extension, signal);
      objectPath = put.objectPath;
      deduped = put.deduped;
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new OmniDeliveryError(
        `Failed to store media in the omni object store: ` +
          `${sanitizeErrorMessage(err, [item.filePath, store.getOmniRootDir()])}`,
        { cause: err },
      );
    }

    const uploader = createOmniUploader(uploadConfig);
    let fileUri: string;
    try {
      fileUri = await uploader.uploadFile({
        filePath: objectPath,
        model: uploadModel,
        mimeType: item.recognized.detectedMimeType,
        sha256,
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
      `omni ${item.recognized.modality} delivered: sha256=${sha256.slice(0, 12)}… ` +
        `size=${item.recognized.sizeBytes} est=${estimate.estimatedTokenCount}(${estimate.status}) ` +
        `deduped=${deduped} degraded=${item.degraded === true} uri=${fileUri}`,
    );
    await uploadCache.put(sha256, uploadModel, fileUri);
    return { fileUri, sha256, deduped, uploadCacheHit: false };
  };

  // Additional media deliverables (multi-output fixed policies, #8187
  // 多产物投递): each is judged against the transport limits and uploaded
  // through the same pipeline as the primary. A violating extra is
  // explicitly omitted (policy design §10.2) rather than re-derived — it
  // is already a policy product, and a second derivation pass over
  // derivatives is out of scope for this stage. Deferred until the
  // primary's own fate is decided (each return site below calls this
  // exactly once): the primary uploads first, and a fail-closed throw on
  // the primary never wastes extra uploads.
  const processAdditionalMedia = async (): Promise<
    OmniAdditionalMediaDelivery[] | undefined
  > => {
    if (extraDeliveries.length === 0) return undefined;
    // Extras are independent (content-addressed store + per-file serialized
    // upload cache), so they upload concurrently; map keeps output order
    // aligned with the policy's deliverable order.
    return Promise.all(
      extraDeliveries.map(
        async (extra): Promise<OmniAdditionalMediaDelivery> => {
          const extraGuard = evaluateTransportLimits(
            config,
            extra.recognized,
            displayName,
          );
          if (extraGuard.violation) {
            debugLogger.debug(
              `omni additional ${extra.recognized.modality} explicitly omitted (transport guard): ${extraGuard.violation}`,
            );
            return {
              fileUri: '',
              mimeType: extra.recognized.detectedMimeType,
              sha256: extra.sha256 ?? '',
              disclosure: extra.disclosure,
              omission: { reason: extraGuard.violation },
            };
          }
          const uploaded = await uploadResource(extra, extraGuard.estimate);
          return {
            fileUri: uploaded.fileUri,
            mimeType: extra.recognized.detectedMimeType,
            sha256: uploaded.sha256,
            disclosure: extra.disclosure,
          };
        },
      ),
    );
  };

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
    const maxPasses = processingConfig.limits.maxTransportPasses;
    for (let pass = 0; guard.violation && pass < maxPasses; pass++) {
      // Re-filter per pass: a guard policy may transform the resource into
      // another modality (e.g. video → extracted audio), and the NEXT pass
      // must run that modality's guard policies — the pre-loop set would
      // silently no-op and omit a resource the right policy could still
      // bring under the limit. Coverage of all three modalities is
      // enforced at config normalization, so the filter never strands a
      // modality without a policy.
      const guardPolicies = processingConfig.transportGuardPolicies.filter(
        (p) => p.mediaTypes.includes(final.recognized.modality),
      );
      if (guardPolicies.length === 0) break;
      let deliveries: PolicyDeliveryResource[];
      let fileDeliveries: PolicyFileDelivery[];
      try {
        ({ deliveries, fileDeliveries } = await runFixedPolicies(
          config,
          {
            filePath: final.filePath,
            recognized: final.recognized,
            displayName,
            origin: options?.origin ?? 'user',
            sha256: final.sha256,
          },
          {
            store,
            policies: guardPolicies,
            signal,
            limits: processingConfig.limits,
            conditionContext,
            // The guard pass derives FROM the current final resource, so
            // its memory lineage hangs off that resource's own binding
            // (a derivative's version when preprocessing degraded it).
            memory: memoryService
              ? { service: memoryService, sourceBinding: final.memoryBinding }
              : undefined,
          },
        ));
      } catch (err) {
        if (signal?.aborted) throw err;
        // Guard-policy failure with no compliant alternative: fail closed
        // — a guard configuration error must never degrade into sending
        // over-limit media (policy design §10.2). Thrown as a GUARD error
        // (not a generic delivery error): the verdict "this resource is
        // over the limit" already stands, so consumers with an inline
        // fallback (the tool-result funnel) must withhold the bytes, not
        // fall back to delivering exactly what the guard rejected.
        throw guardRejection(
          `Transport-guard processing failed for ${displayName}: ` +
            `${sanitizeErrorMessage(err, [final.filePath, store.getOmniRootDir()])}`,
          { cause: err },
        );
      }
      collectTranscripts(fileDeliveries);
      // Pure-transcript guard resolution (§6.2): the guard policy
      // replaced the over-limit media with text-only deliverables — the
      // violation is resolved by not sending media at all. Keyed on THIS
      // pass's fileDeliveries, not the cumulative transcripts: a guard
      // pass that omitted the source without producing any deliverable
      // must fall through to the zero-deliverable throw below, even when
      // an earlier pass already collected a transcript.
      if (deliveries.length === 0 && fileDeliveries.length > 0) {
        return textOnlyDelivery(final.recognized, guard.estimate, {
          disclosure: final.disclosure,
          additionalMedia: await processAdditionalMedia(),
        });
      }
      if (deliveries.length !== 1) {
        // Same guard-error class as the pass failure above: the violation
        // verdict stands, so inline fallbacks must withhold.
        throw guardRejection(
          `Transport-guard policies produced ${deliveries.length} media deliverables for ${displayName}; exactly one is supported.`,
        );
      }
      if (deliveries[0].filePath === final.filePath) {
        // No progress (every guard policy was a no_op for this input) —
        // further passes would repeat the same work.
        break;
      }
      // Chain the disclosures instead of replacing: when preprocessing
      // already degraded the resource and the guard degrades it AGAIN,
      // the model must be told about both steps (decision D8 — every
      // lossy step is disclosed, not just the last one).
      const priorDisclosure = final.disclosure;
      final = deliveries[0];
      if (priorDisclosure && final.disclosure) {
        final = {
          ...final,
          disclosure: `${priorDisclosure}；${final.disclosure}`,
        };
      } else if (priorDisclosure) {
        final = { ...final, disclosure: priorDisclosure };
      }
      bindSessionResource(final);
      guard = evaluateTransportLimits(config, final.recognized, displayName);
    }
  }
  if (guard.violation) {
    if (!processingConfig) {
      throw guardRejection(guard.violation);
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
      transcripts: transcripts.length > 0 ? transcripts : undefined,
      additionalMedia: await processAdditionalMedia(),
      resourceId: sessionResourceId,
    };
  }
  const tokenEstimate = guard.estimate;
  const uploaded = await uploadResource(final, tokenEstimate);
  return {
    fileUri: uploaded.fileUri,
    mimeType: final.recognized.detectedMimeType,
    sha256: uploaded.sha256,
    recognized: final.recognized,
    tokenEstimate,
    deduped: uploaded.deduped,
    uploadCacheHit: uploaded.uploadCacheHit,
    disclosure: final.disclosure,
    degraded: final.degraded,
    transcripts: transcripts.length > 0 ? transcripts : undefined,
    additionalMedia: await processAdditionalMedia(),
    resourceId: sessionResourceId,
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
    // §6.2/D8 ordering contract documented on buildTranscriptParts.
    const transcriptParts = buildTranscriptParts(
      displayName,
      delivery.transcripts,
    );
    // Additional media Parts (multi-output fixed policies): materialized
    // right after the primary media slot in every branch below.
    const additionalParts = buildAdditionalMediaParts(
      displayName,
      delivery.additionalMedia,
    );
    // Session resource handle (M §5.2): leads the part group in every
    // branch — even an omitted/transcript-only delivery leaves the model
    // a handle to recall or reprocess the source. Placed FIRST so the
    // disclosure keeps its D8 adjacency to the media part.
    // A model-visible local source — its registry binding's fileRef is the
    // very path the model read (non-ephemeral user input) — is referenced by
    // that ABSOLUTE PATH rather than an opaque handle: the model already
    // holds the path and can re-read it or point tools at it, so the handle
    // is redundant noise. Passive recall still recovers the handle from the
    // path (resolveByFileRef). Path-less sources (tool/URL media, whose
    // fileRef is an internal object-store locator) keep the handle form —
    // no usable path exists to show.
    const handleParts: Array<{ text: string }> = (() => {
      if (!delivery.resourceId) return [];
      const binding = config
        .getOmniMediaResourceRegistry?.()
        ?.resolve(delivery.resourceId);
      if (binding && binding.fileRef === filePath) {
        return [{ text: formatResourcePathText(filePath) }];
      }
      return [
        { text: formatResourceHandleText(displayName, delivery.resourceId) },
      ];
    })();
    if (delivery.omission) {
      // Explicit omission (policy design §10.2): the media is withheld and
      // the omission notice text stands in its place. Not an error — the
      // read succeeded; the transport guard's verdict is the content.
      const omissionPart = {
        text: formatOmissionText(displayName, delivery.omission.reason),
      };
      return {
        llmContent:
          transcriptParts.length > 0 ||
          additionalParts.length > 0 ||
          handleParts.length > 0
            ? [
                ...handleParts,
                omissionPart,
                ...additionalParts,
                ...transcriptParts,
              ]
            : omissionPart.text,
        returnDisplay: `Media omitted by the omni transport guard: ${relativePathForDisplay}`,
        tokenEstimate: delivery.tokenEstimate,
      };
    }
    if (!delivery.fileUri && transcriptParts.length > 0) {
      // Pure-transcript delivery (§6.2): the policies replaced the media
      // with text-only deliverables — no media Part is emitted for the
      // primary (additional media deliverables, if any, still are). The
      // primary disclosure (chained prior lossy steps, decision D8) still
      // renders: the transcript was derived through those steps.
      const disclosureParts = delivery.disclosure
        ? [{ text: formatDisclosureText(displayName, delivery.disclosure) }]
        : [];
      return {
        llmContent: [
          ...handleParts,
          ...disclosureParts,
          ...additionalParts,
          ...transcriptParts,
        ],
        returnDisplay: `Read ${delivery.recognized.modality} as transcript (omni policy): ${relativePathForDisplay}`,
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
    const parts: Array<{ text: string } | typeof fileDataPart> = [
      ...handleParts,
    ];
    const { width, height } = delivery.recognized.metadata;
    if (
      delivery.recognized.modality === 'image' &&
      width !== undefined &&
      height !== undefined
    ) {
      // On the degradation path `delivery.recognized` re-recognizes the
      // DERIVATIVE, so width/height are the downsampled dimensions —
      // calling them "full resolution" would contradict the disclosure
      // pushed right below and steer the model away from zoom_image, the
      // exact remedy for degradation-stripped detail (it reads the
      // original from disk).
      parts.push({
        text: delivery.disclosure
          ? `Image ${displayName}: delivered at ${width}x${height} px ` +
            `after degradation. Use zoom_image to inspect details — it ` +
            `reads the original file.`
          : `Image ${displayName}: full resolution ${width}x${height} px. ` +
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
    parts.push(...additionalParts);
    parts.push(...transcriptParts);
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

// Re-anchoring is reached from the CLI's `@`-reference funnel, which already
// loads this module dynamically for every other omni call it makes. Kept off
// the ROOT barrel deliberately: that barrel is statically imported across the
// CLI, and every module added to its graph regroups esbuild's chunks — which
// is how the ACP agent's static closure acquired iconv-lite's 550 KB of
// encoding tables (scripts/check-serve-fast-path-bundle.js caught it).
export { reanchorRememberedMedia } from './memory-recall.js';

// Trajectory export (S6): a pure reader over transcript + memory.json,
// exposed through the omni door for the wrapper script and E2E tests.
export {
  exportOmniTrajectory,
  serializeOmniTrajectory,
  writeOmniTrajectoryJsonl,
  type OmniTrajectoryRecord,
  type OmniTrajectoryTurnRecord,
  type OmniTrajectoryExecutionRecord,
  type OmniTrajectoryFileRecord,
} from './export.js';
