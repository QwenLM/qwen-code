/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI port of ink's `QueuedMessageDisplay`: the prompts the user submitted
 * while a turn was in flight, shown between the waiting row and the composer
 * until the following turn consumes them.
 */

import { useRef } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import { t } from '../../i18n/index.js';
import { sanitizeTerminalText, truncateToWidth } from '../utils/textUtils.js';
import { C } from './theme.js';

const MAX_DISPLAYED_QUEUED_MESSAGES = 3;
const NUM_TIMES_QUEUE_HINT_SHOWN = 3;
/** ink's `wrap="truncate"` on a box that pads two columns and spans the rest. */
const QUEUE_ROW_INDENT = 2;

export interface OpenTuiQueuedMessageDisplayProps {
  messageQueue: readonly string[];
}

export const OpenTuiQueuedMessageDisplay = ({
  messageQueue,
}: OpenTuiQueuedMessageDisplayProps) => {
  const { width } = useTerminalDimensions();
  // Counts how many times the edit hint has been shown, so it stops after a
  // few. ink keys this on the empty → non-empty transition, and its counter
  // resets whenever the composer unmounts — which happens for a dialog here
  // too, since the composer branch is swapped out the same way.
  const hintSeenCountRef = useRef(0);
  const wasEmptyRef = useRef(true);

  if (messageQueue.length === 0) {
    wasEmptyRef.current = true;
    return null;
  }

  if (wasEmptyRef.current) {
    hintSeenCountRef.current++;
    wasEmptyRef.current = false;
  }

  const shouldShowHint = hintSeenCountRef.current <= NUM_TIMES_QUEUE_HINT_SHOWN;
  const rowBudget = Math.max(0, width - QUEUE_ROW_INDENT);

  return (
    <box flexDirection="column" marginTop={1}>
      {messageQueue
        .slice(0, MAX_DISPLAYED_QUEUED_MESSAGES)
        .map((message, index) => (
          <box key={index} paddingLeft={QUEUE_ROW_INDENT}>
            <text fg={C.dim}>
              {truncateToWidth(
                sanitizeTerminalText(message.replace(/\s+/g, ' ')),
                rowBudget,
              )}
            </text>
          </box>
        ))}
      {messageQueue.length > MAX_DISPLAYED_QUEUED_MESSAGES && (
        <box paddingLeft={QUEUE_ROW_INDENT}>
          <text fg={C.dim}>
            {`... (+${
              messageQueue.length - MAX_DISPLAYED_QUEUED_MESSAGES
            } more)`}
          </text>
        </box>
      )}
      {shouldShowHint && (
        <box paddingLeft={QUEUE_ROW_INDENT}>
          <text fg={C.dim} attributes={4}>
            {t('Ctrl+Q to queue · ↑ to edit queued messages')}
          </text>
        </box>
      )}
    </box>
  );
};
