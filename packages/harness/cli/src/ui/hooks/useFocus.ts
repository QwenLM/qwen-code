/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useStdin, useStdout } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import { useKeypressContext } from '../contexts/KeypressContext.js';

// ANSI escape codes to enable/disable terminal focus reporting
export const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
export const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';

// ANSI escape codes for focus events
export const FOCUS_IN = '\x1b[I';
export const FOCUS_OUT = '\x1b[O';

export const useFocus = (): {
  isFocused: boolean;
  hasReceivedFocusEvent: boolean;
} => {
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const [isFocused, setIsFocused] = useState(true);
  const [hasReceivedFocusEvent, setHasReceivedFocusEvent] = useState(false);

  useEffect(() => {
    const handleData = (data: Buffer) => {
      const sequence = data.toString();
      const lastFocusIn = sequence.lastIndexOf(FOCUS_IN);
      const lastFocusOut = sequence.lastIndexOf(FOCUS_OUT);

      if (lastFocusIn > lastFocusOut) {
        setHasReceivedFocusEvent(true);
        setIsFocused(true);
      } else if (lastFocusOut > lastFocusIn) {
        setHasReceivedFocusEvent(true);
        setIsFocused(false);
      }
    };

    // Enable focus reporting
    stdout?.write(ENABLE_FOCUS_REPORTING);
    stdin?.on('data', handleData);

    return () => {
      // Disable focus reporting on cleanup
      stdout?.write(DISABLE_FOCUS_REPORTING);
      stdin?.removeListener('data', handleData);
    };
  }, [stdin, stdout]);

  const { registerOnAnyKeypress, unregisterOnAnyKeypress } =
    useKeypressContext();

  const handleAnyKeypress = useCallback(() => {
    if (!isFocused) {
      // If the user has typed a key, they cannot possibly be focused out.
      // This is a workaround for some tmux use cases. It is still useful to
      // listen for the true FOCUS_IN event as that will update the focus
      // state earlier than waiting for a keypress.
      setIsFocused(true);
    }
  }, [isFocused]);

  useEffect(() => {
    registerOnAnyKeypress(handleAnyKeypress);
    return () => {
      unregisterOnAnyKeypress(handleAnyKeypress);
    };
  }, [handleAnyKeypress, registerOnAnyKeypress, unregisterOnAnyKeypress]);

  return {
    isFocused,
    hasReceivedFocusEvent,
  };
};
