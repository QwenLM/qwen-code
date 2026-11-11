/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompressionStatus,
  formatApiErrorDisplayMessage,
  QODER_PROVIDER_ID,
} from '@qwen-code/core';

export interface CompressionFailureDisplayInfo {
  failureReason?: string;
  providerStatus?: number;
  providerSource?: string;
  displayErrorCode?: string | number;
  errorFallbackMessage?: string;
}

export const COMPACT_NOOP_TEXT =
  'Nothing to compress yet. /compact needs at least one model response in the current conversation.';

export function getCompactErrorText(
  compressionStatus: number,
  failure: CompressionFailureDisplayInfo = {},
): string {
  if (compressionStatus === CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST) {
    // The SDK result and -p text share this legacy projection.
    return formatCompressionFailureText(
      failure,
      getFailureReasonText(failure.failureReason),
    );
  }
  return `Compaction returned no result (status=${compressionStatus}).`;
}

function getFailureReasonText(failureReason: string | undefined): string {
  switch (failureReason) {
    case 'quota_exhausted':
      return 'Compression failed because your credits or usage quota are exhausted. Run /usage to check your account usage.';
    case 'model_queued':
      return 'Compression failed because the model is queued or temporarily unavailable. Please try again later.';
    case 'auth_error':
      return 'Compression failed because authentication failed. Please sign in again.';
    case 'rate_limited':
      return 'Compression failed because the model request was rate limited. Please try again later.';
    default:
      return 'Compression failed because the model request failed. Please try again.';
  }
}

export function getCompressionModelRequestFailureText(
  failure: CompressionFailureDisplayInfo,
): string {
  if (failure.providerSource !== QODER_PROVIDER_ID) {
    switch (failure.failureReason) {
      case 'auth_error':
        return failure.providerStatus === 403
          ? 'Compression failed because the model service denied access. Please check your provider permissions.'
          : 'Compression failed because authentication failed. Please check your provider credentials.';
      case 'quota_exhausted':
        return 'Compression failed because the model service quota was exhausted. Please check your provider usage and limits.';
      default:
        return getFailureReasonText(failure.failureReason);
    }
  }
  return formatCompressionFailureText(
    failure,
    getFailureReasonText(failure.failureReason),
  );
}

function formatCompressionFailureText(
  failure: CompressionFailureDisplayInfo,
  fallbackText: string,
): string {
  if (failure.displayErrorCode !== undefined) {
    return formatApiErrorDisplayMessage(
      failure.displayErrorCode,
      failure.errorFallbackMessage || fallbackText,
    );
  }

  return fallbackText;
}
