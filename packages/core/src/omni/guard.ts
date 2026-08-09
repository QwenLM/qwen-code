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
