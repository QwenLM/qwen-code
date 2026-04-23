/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useCallback } from 'react';
import { useStdout } from 'ink';
import { StreamingState } from '../types.js';
import {
  OSC,
  BEL,
  wrapForMultiplexer,
  detectTerminal,
} from '../../utils/osc.js';

/**
 * OSC 9;4 progress sequences for terminal tab/title bar progress.
 * Supported terminals: iTerm2 3.6.6+, Ghostty 1.2.0+, ConEmu,
 * Windows Terminal 1.6+.
 * @see https://iterm2.com/documentation-escape-codes.html
 * @see https://learn.microsoft.com/en-us/windows/terminal/tutorials/progress-bar-sequences
 */
const PROGRESS_CLEAR = wrapForMultiplexer(`${OSC}9;4;0;${BEL}`);
const PROGRESS_INDETERMINATE = wrapForMultiplexer(`${OSC}9;4;3;;${BEL}`);

function isProgressBarSupported(): boolean {
  // Don't emit escape sequences when stdout is not a TTY (CI, piped output,
  // redirected to log files, etc.)
  if (!process.stdout?.isTTY) return false;
  const term = detectTerminal();
  if (term === 'iTerm.app') return true;
  if (term === 'ghostty') return true;
  if (process.env['ConEmuPID']) return true;
  if (process.env['WT_SESSION']) return true;
  return false;
}

/**
 * Emits OSC 9;4 terminal progress bar sequences based on streaming state.
 * Shows an indeterminate progress spinner in the terminal tab when tools
 * are executing, and clears it when idle.
 */
export function useTerminalProgress(
  streamingState: StreamingState,
  hasToolExecuting: boolean,
): void {
  const { stdout } = useStdout();

  const writeProgress = useCallback(
    (seq: string) => {
      stdout?.write(seq);
    },
    [stdout],
  );

  useEffect(() => {
    if (!isProgressBarSupported()) return;

    if (streamingState === StreamingState.Responding && hasToolExecuting) {
      writeProgress(PROGRESS_INDETERMINATE);
    } else if (streamingState === StreamingState.Idle) {
      writeProgress(PROGRESS_CLEAR);
    }

    return () => {
      writeProgress(PROGRESS_CLEAR);
    };
  }, [streamingState, hasToolExecuting, writeProgress]);

  // Clear the progress bar on process exit so the terminal tab does not
  // stay stuck showing progress after qwen terminates. We deliberately
  // hook only 'exit' (not SIGINT/SIGTERM) to avoid swallowing those
  // signals — other parts of the CLI already own the signal-to-shutdown
  // path and will ultimately call process.exit(), at which point 'exit'
  // fires and this cleanup runs.
  useEffect(() => {
    if (!isProgressBarSupported()) return;
    const clearOnExit = () => {
      stdout?.write(PROGRESS_CLEAR);
    };
    process.on('exit', clearOnExit);
    return () => {
      process.removeListener('exit', clearOnExit);
    };
  }, [stdout]);
}
