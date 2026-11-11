/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, useIsScreenReaderEnabled } from 'ink';
import type { SpinnerName } from 'cli-spinners';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import {
  SCREEN_READER_LOADING,
  SCREEN_READER_RESPONDING,
} from '../textConstants.js';
import { theme } from '../semantic-colors.js';
import { ModelSpinner } from './ModelSpinner.js';

interface ModelRespondingSpinnerProps {
  /**
   * Optional string to display when not in Responding state.
   * If not provided and not Responding, renders null.
   */
  nonRespondingDisplay?: string;
  spinnerType?: SpinnerName;
  /**
   * If true, we prioritize showing the nonRespondingDisplay (hook icon)
   * even if the state is Responding.
   */
  isHookActive?: boolean;
  forceSpinner?: boolean;
  color?: string;
}

export const ModelRespondingSpinner: React.FC<ModelRespondingSpinnerProps> = ({
  nonRespondingDisplay,
  spinnerType = 'dots',
  isHookActive = false,
  forceSpinner = false,
  color,
}) => {
  const streamingState = useStreamingContext();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();

  // If a hook is active, we want to show the hook icon (nonRespondingDisplay)
  // to be consistent, instead of the rainbow spinner which means "the model is talking".
  if (
    (streamingState === StreamingState.Responding || forceSpinner) &&
    !isHookActive
  ) {
    return (
      <ModelSpinner
        spinnerType={spinnerType}
        altText={
          streamingState === StreamingState.Responding
            ? SCREEN_READER_RESPONDING
            : SCREEN_READER_LOADING
        }
      />
    );
  }

  if (nonRespondingDisplay) {
    return isScreenReaderEnabled ? (
      <Text>{SCREEN_READER_LOADING}</Text>
    ) : (
      <Text color={color ?? theme.text.primary}>{nonRespondingDisplay}</Text>
    );
  }

  return null;
};
