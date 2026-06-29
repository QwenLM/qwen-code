/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Text, useIsScreenReaderEnabled } from 'ink';
import Spinner from 'ink-spinner';
import type { SpinnerName } from 'cli-spinners';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import {
  SCREEN_READER_LOADING,
  SCREEN_READER_RESPONDING,
} from '../textConstants.js';
import { theme } from '../semantic-colors.js';

const TMUX_SPINNER_INTERVAL_MS = 750;
const TMUX_SPINNER_FRAMES = ['.  ', '.. ', '...'];

interface GeminiRespondingSpinnerProps {
  /**
   * Optional string to display when not in Responding state.
   * If not provided and not Responding, renders null.
   */
  nonRespondingDisplay?: string;
  spinnerType?: SpinnerName;
}

export const GeminiRespondingSpinner: React.FC<
  GeminiRespondingSpinnerProps
> = ({ nonRespondingDisplay, spinnerType = 'dots' }) => {
  const streamingState = useStreamingContext();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  if (streamingState === StreamingState.Responding) {
    return (
      <GeminiSpinner
        spinnerType={spinnerType}
        altText={SCREEN_READER_RESPONDING}
      />
    );
  } else if (nonRespondingDisplay) {
    return isScreenReaderEnabled ? (
      <Text>{SCREEN_READER_LOADING}</Text>
    ) : (
      <Text color={theme.text.primary}>{nonRespondingDisplay}</Text>
    );
  }
  return null;
};

interface GeminiSpinnerProps {
  spinnerType?: SpinnerName;
  altText?: string;
}

export const GeminiSpinner: React.FC<GeminiSpinnerProps> = ({
  spinnerType = 'dots',
  altText,
}) => {
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const isTmux = Boolean(process.env['TMUX']);
  const [tmuxFrameIndex, setTmuxFrameIndex] = useState(0);

  useEffect(() => {
    if (isScreenReaderEnabled || !isTmux) {
      return;
    }

    const interval = setInterval(() => {
      setTmuxFrameIndex((index) => (index + 1) % TMUX_SPINNER_FRAMES.length);
    }, TMUX_SPINNER_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isScreenReaderEnabled, isTmux]);

  if (isScreenReaderEnabled) {
    return <Text>{altText}</Text>;
  }

  if (isTmux) {
    // Note: must NOT wrap in <Box> here — GeminiSpinner is rendered inside a
    // <Text> in Footer.tsx (`<Text>...<GeminiSpinner /> {msg}</Text>`), and
    // Ink forbids <Box> nested inside <Text>. The 3-char fixed-width frames
    // already give us stable layout without an explicit width container.
    return (
      <Text color={theme.text.primary}>
        {TMUX_SPINNER_FRAMES[tmuxFrameIndex]}
      </Text>
    );
  }

  return (
    <Text color={theme.text.primary}>
      <Spinner type={spinnerType} />
    </Text>
  );
};
