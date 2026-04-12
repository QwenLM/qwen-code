/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useCallback } from 'react';
import { useStdout } from 'ink';
import { StreamingState } from '../types.js';

/**
 * OSC 9;4 progress sequences for terminal tab/title bar progress.
 * Supported terminals: iTerm2 3.6.6+, Ghostty 1.2.0+, ConEmu.
 * @see https://iterm2.com/documentation-escape-codes.html
 */
const OSC = '\x1b]';
const BEL = '\x07';

/**
 * Wrap an OSC sequence for tmux/screen passthrough.
 * tmux requires DCS escape: \ePtmux;\e<seq>\e\\
 * screen requires DCS escape: \eP<seq>\e\\
 */
function wrapForMultiplexer(seq: string): string {
  if (process.env['TMUX']) {
    return `\x1bPtmux;\x1b${seq}\x1b\\`;
  }
  if (process.env['STY']) {
    return `\x1bP${seq}\x1b\\`;
  }
  return seq;
}

const PROGRESS_CLEAR = wrapForMultiplexer(`${OSC}9;4;0;${BEL}`);
const PROGRESS_INDETERMINATE = wrapForMultiplexer(`${OSC}9;4;3;;${BEL}`);

function isProgressBarSupported(): boolean {
  // Don't emit escape sequences when stdout is not a TTY (CI, piped output,
  // redirected to log files, etc.)
  if (!process.stdout?.isTTY) return false;
  const term = process.env['TERM_PROGRAM'];
  if (term === 'iTerm.app') return true;
  if (term === 'ghostty') return true;
  if (process.env['ConEmuPID']) return true;
  // Windows Terminal interprets OSC 9;4 as notifications, not progress
  if (process.env['WT_SESSION']) return false;
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
      // Only clear if we actually wrote sequences (i.e., terminal supports it)
      if (isProgressBarSupported()) {
        writeProgress(PROGRESS_CLEAR);
      }
    };
  }, [streamingState, hasToolExecuting, writeProgress]);
}
