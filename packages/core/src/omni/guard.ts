/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import {
  estimateRawResourceTokens,
  type OmniTokenEstimate,
} from './estimation.js';
import type { RecognizedMedia } from './recognition.js';

/** Default per-file upload ceiling: 1 GiB (DashScope instant-upload cap). */
export const DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;

/** Thrown when a transport guard rejects an input. Fail closed: callers
 * surface the message; there is no silent degradation. Messages must stay
 * free of absolute paths (they can reach model-visible content). */
export class OmniTransportGuardError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OmniTransportGuardError';
  }
}

/** Resolve the effective byte ceiling (undefined/<=0 config → default). */
export function effectiveMaxUploadFileBytes(config: Config): number {
  const configured = config.getOmniMaxUploadFileBytes?.();
  return configured !== undefined && configured > 0
    ? configured
    : DEFAULT_OMNI_MAX_UPLOAD_FILE_BYTES;
}

/**
 * Byte-dimension guard. Runs on a cheap stat BEFORE any hashing/probing.
 */
export function assertWithinByteLimit(
  config: Config,
  sizeBytes: number,
  displayName: string,
): void {
  const maxBytes = effectiveMaxUploadFileBytes(config);
  if (sizeBytes > maxBytes) {
    throw new OmniTransportGuardError(
      `${displayName} exceeds the omni upload limit: ${sizeBytes} bytes > ` +
        `${maxBytes} bytes (omni.processing.transportGuard.maxUploadFileBytes). ` +
        `Reduce the file size before retrying.`,
    );
  }
}

/**
 * Duration-dimension guard. Runs alongside the token check (both need
 * probe metadata) and BEFORE store/upload.
 *
 * Byte and token limits alone cannot express the provider's duration cap,
 * and that gap is not theoretical: a 98-minute film downscaled to 474 MB
 * clears a 1 GB byte limit, gets uploaded, and is then rejected by the API
 * for being too long. The guard reported success, the creator got an
 * opaque 400, and a full transcode was paid for nothing. Duration is a
 * transport limit like any other, so it belongs here — where exceeding it
 * turns into an honest omission that names duration as the reason.
 *
 * Threshold semantics mirror the token guard
 * (`omni.processing.transportGuard.maxDurationSeconds`): unset / 0 /
 * negative disables it; a missing duration never rejects (metadata is
 * never guessed).
 */
export function assertWithinDurationLimit(
  config: Config,
  media: RecognizedMedia,
  displayName: string,
): void {
  const maxSeconds = config.getOmniMaxDurationSeconds?.();
  if (maxSeconds === undefined || maxSeconds <= 0) return;
  const durationMs = media.metadata.durationMs;
  if (durationMs === undefined || !Number.isFinite(durationMs)) return;
  const seconds = durationMs / 1000;
  if (seconds > maxSeconds) {
    throw new OmniTransportGuardError(
      `${displayName} exceeds the omni duration limit: ` +
        `${Math.round(seconds)}s > ${maxSeconds}s ` +
        `(omni.processing.transportGuard.maxDurationSeconds). ` +
        `Clip a shorter span — downscaling cannot bring a long file ` +
        `within a duration limit.`,
    );
  }
}

/**
 * Token-dimension guard. Runs AFTER recognition (needs probe metadata) and
 * BEFORE store/upload, so an oversized input costs one probe — not a copy
 * and a multi-minute upload.
 *
 * Threshold semantics (`omni.processing.transportGuard.maxEstimatedTokens`):
 * - unset / 0 / negative → guard disabled (the estimation formula is still
 *   pending confirmation with the model provider; estimates are attached
 *   for observability but must not reject until a threshold is set);
 * - positive → hard fail-closed limit against the versioned estimator.
 *
 * An `unavailable` estimate never rejects — per design, missing metadata
 * must not be guessed, and the transport guard only acts on real numbers.
 */
export function assertWithinTokenLimit(
  config: Config,
  media: RecognizedMedia,
  displayName: string,
): OmniTokenEstimate {
  const estimate = estimateRawResourceTokens(media);
  const maxTokens = config.getOmniMaxEstimatedTokens?.();
  if (maxTokens === undefined || maxTokens <= 0) return estimate;
  if (estimate.status !== 'ok') return estimate;
  if (estimate.estimatedTokenCount > maxTokens) {
    throw new OmniTransportGuardError(
      `${displayName} exceeds the omni estimated-token limit: ` +
        `~${estimate.estimatedTokenCount} tokens (${estimate.method}) > ` +
        `${maxTokens} (omni.processing.transportGuard.maxEstimatedTokens). ` +
        `Reduce duration/resolution or raise the limit.`,
    );
  }
  return estimate;
}
