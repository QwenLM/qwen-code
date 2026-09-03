/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompressionStatus,
  isCompressionFailureStatus,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export const formatCompressionTokenCount = (
  count: number,
  isEstimated?: boolean,
) => (isEstimated ? `~${count}` : String(count));

export interface CompressionStatusTextOptions {
  isPending?: boolean;
  originalTokenCount?: number | null;
  newTokenCount?: number | null;
  compressionStatus?: CompressionStatus | null;
  originalTokenCountIsEstimated?: boolean;
  newTokenCountIsEstimated?: boolean;
}

export function getCompressionStatusText({
  isPending,
  originalTokenCount,
  newTokenCount,
  compressionStatus,
  originalTokenCountIsEstimated,
  newTokenCountIsEstimated,
}: CompressionStatusTextOptions) {
  if (isPending) {
    return t('Compressing chat history');
  }

  const originalTokens = originalTokenCount ?? 0;
  const newTokens = newTokenCount ?? 0;

  switch (compressionStatus) {
    case CompressionStatus.COMPRESSED:
      return t(
        'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.',
        {
          originalTokens: formatCompressionTokenCount(
            originalTokens,
            originalTokenCountIsEstimated,
          ),
          newTokens: formatCompressionTokenCount(
            newTokens,
            newTokenCountIsEstimated,
          ),
        },
      );
    case CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT:
      // For smaller histories (< 50k tokens), compression overhead likely exceeds benefits.
      if (originalTokens < 50000) {
        return t('Compression was not beneficial for this history size.');
      }
      return t(
        'Chat history compression did not reduce size. This may indicate issues with the compression prompt.',
      );
    case CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR:
      return t(
        'Could not compress chat history due to a token counting error.',
      );
    case CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY:
      return t(
        'Could not compress chat history because the compression summary was empty.',
      );
    case CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED:
      return t(
        'Could not compress chat history because the compression summary was truncated.',
      );
    case CompressionStatus.COMPRESSION_FAILED_API_ERROR:
      return t('Could not compress chat history due to an API error.');
    case CompressionStatus.NOOP:
      return 'Nothing to compress.';
    default:
      return '';
  }
}

export function getCompressionFailureStatusText(
  options: CompressionStatusTextOptions,
) {
  if (!isCompressionFailureStatus(options.compressionStatus)) {
    return t('Failed to compress chat history.');
  }

  return (
    getCompressionStatusText({
      ...options,
      isPending: false,
    }) || t('Failed to compress chat history.')
  );
}
