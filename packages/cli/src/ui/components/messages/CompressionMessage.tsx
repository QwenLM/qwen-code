/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import type { CompressionProps } from '../../types.js';
import { CliSpinner } from '../CliSpinner.js';
import { theme } from '../../semantic-colors.js';
import { SCREEN_READER_MODEL_PREFIX } from '../../textConstants.js';
import { CompressionStatus } from '@qwen-code/core';
import { PrefixedMessage } from './PrefixedMessage.js';
import { INDENT } from '../../constants/messageLayout.js';
import { getCompressionModelRequestFailureText } from '../../../utils/compressionFailureText.js';

export interface CompressionDisplayProps {
  compression: CompressionProps;
}

/*
 * Compression messages appear when the /compress command is run, and show a loading spinner
 * while compression is in progress, followed by a completion or error message.
 */
export function CompressionMessage({
  compression,
}: CompressionDisplayProps): React.JSX.Element {
  const { isPending, originalTokenCount, newTokenCount, compressionStatus } =
    compression;

  const originalTokens = originalTokenCount ?? 0;
  const newTokens = newTokenCount ?? 0;

  // Compression success: compressionStatus === COMPRESSED, OR, for the
  // auto-compact path, compressionStatus is null (the boundary item is added
  // by applyPostCompact's onCompactionPersisted callback after the JSONL
  // write succeeds, and carries only token counts).
  const isSuccessfulFinish =
    !isPending &&
    (compressionStatus === CompressionStatus.COMPRESSED ||
      (compressionStatus === null && originalTokens > 0 && newTokens > 0));

  const getCompressionText = () => {
    if (isPending) {
      return 'Compressing chat history';
    }

    if (isSuccessfulFinish) {
      return `Conversation compacted`;
    }

    switch (compressionStatus) {
      case CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT:
        // For smaller histories (< 50k tokens), compression overhead likely exceeds benefits
        if (originalTokens < 50000) {
          return 'Compression was not beneficial for this history size.';
        }
        // For larger histories where compression should work but didn't,
        // this suggests an issue with the compression process itself
        return 'Chat history compression did not reduce size. This may indicate issues with the compression prompt.';
      case CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR:
        return 'Could not compress chat history due to a token counting error.';
      case CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST:
        return getCompressionModelRequestFailureText(compression);
      case CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY:
        return 'Chat history compression failed: the model returned an empty summary.';
      case CompressionStatus.NOOP:
        return 'Nothing to compress.';
      default:
        return '';
    }
  };

  const text = getCompressionText();

  const prefixNode = isPending ? (
    <CliSpinner type="dots" />
  ) : (
    <Text color={isSuccessfulFinish ? theme.ui.comment : theme.text.accent}>
      ✻
    </Text>
  );

  return (
    <PrefixedMessage
      prefix={prefixNode}
      prefixWidth={INDENT.PREFIX_WIDTH_STANDARD}
    >
      <Text
        color={
          isPending
            ? theme.text.accent
            : isSuccessfulFinish
              ? theme.ui.comment
              : theme.status.warning
        }
        aria-label={SCREEN_READER_MODEL_PREFIX}
      >
        {text}
      </Text>
    </PrefixedMessage>
  );
}
