/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the ink compaction notice
 * (ui/components/messages/CompressionMessage.tsx): the /compress and
 * auto-compact history row — pending spinner text, final token counts, and
 * the failure-mode messages, with the diamond marker replacing the spinner
 * once the run settles.
 */

import { useEffect, useState } from 'react';
import { CompressionStatus } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { ICON } from '../constants.js';
import { C } from './theme.js';

export interface CompactionViewProps {
  isPending: boolean;
  originalTokenCount: number | null;
  newTokenCount: number | null;
  compressionStatus: CompressionStatus | null;
}

const COMPRESSION_NOT_BENEFICIAL_TOKEN_LIMIT = 50000;

/** Parity of CompressionMessage.getCompressionText. */
export function compactionText(props: CompactionViewProps): string {
  const { isPending, originalTokenCount, newTokenCount, compressionStatus } =
    props;
  const originalTokens = originalTokenCount ?? 0;
  const newTokens = newTokenCount ?? 0;

  if (isPending) {
    return t('Compressing chat history');
  }

  switch (compressionStatus) {
    case CompressionStatus.COMPRESSED:
      return t(
        'Chat history compressed from {{originalTokens}} to {{newTokens}} tokens.',
        {
          originalTokens: String(originalTokens),
          newTokens: String(newTokens),
        },
      );
    case CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT:
      if (originalTokens < COMPRESSION_NOT_BENEFICIAL_TOKEN_LIMIT) {
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

export interface CompactionView {
  text: string;
  pending: boolean;
  /** Parity colors: accent while pending, success once settled. */
  color: string;
  markerColor: string;
  marker: 'diamond';
  iconGlyph: string;
}

export function compactionView(props: CompactionViewProps): CompactionView {
  return {
    text: compactionText(props),
    pending: props.isPending,
    color: props.isPending ? C.accent : C.green,
    markerColor: C.accent,
    marker: 'diamond',
    iconGlyph: ICON.DIAMOND,
  };
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

/** The compaction history row: spinner (pending) or diamond, then the text. */
export function CompressionNotice(props: { view: CompactionView }) {
  const { view } = props;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!view.pending) return;
    const handle = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => clearInterval(handle);
  }, [view.pending]);

  return (
    <box flexDirection="row">
      <box width={2} flexShrink={0}>
        {view.pending ? (
          <text fg={view.color}>{SPINNER_FRAMES[frame]}</text>
        ) : (
          <text fg={view.markerColor}>{view.iconGlyph}</text>
        )}
      </box>
      <text fg={view.color}>{view.text}</text>
    </box>
  );
}
