/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FC, ReactNode } from 'react';
import { useEffect } from 'react';
import { Box } from 'ink';
import { useTerminalOutput } from '../contexts/TerminalOutputContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

interface AlternateScreenProps {
  children: ReactNode;
  /** Skip escape writes when the root Ink renderer already owns the alt screen (VP mode). */
  disabled?: boolean;
}

export const AlternateScreen: FC<AlternateScreenProps> = ({
  children,
  disabled,
}) => {
  const writeRaw = useTerminalOutput();
  const { rows } = useTerminalSize();

  useEffect(() => {
    // Skip when the root Ink renderer already owns the alt screen (VP mode),
    // or when stdout is not a TTY (piped/redirected/CI): writing alt-screen
    // escapes to a non-terminal would just emit garbage bytes. Mirrors the
    // repo convention of guarding terminal-control writes on `isTTY`
    // (see startInteractiveUI.tsx / notificationService.ts). On non-TTY the
    // transcript degrades to in-buffer rendering (no full-screen takeover).
    if (disabled || !process.stdout.isTTY) return;
    // Guard the raw writes: stdout can throw synchronously (EPIPE when the
    // terminal closes mid-render, EAGAIN under backpressure). An uncaught throw
    // from this effect / its cleanup would crash the app or leave the terminal
    // in a corrupt state; swallow it — a failed escape write is best-effort.
    const safeWrite = (data: string) => {
      try {
        writeRaw(data);
      } catch {
        // best-effort terminal control; ignore transient I/O errors
      }
    };
    safeWrite(ENTER_ALT_SCREEN + CLEAR_SCREEN + HIDE_CURSOR);
    const onExit = () => safeWrite(SHOW_CURSOR + EXIT_ALT_SCREEN);
    process.on('exit', onExit);
    return () => {
      process.removeListener('exit', onExit);
      safeWrite(SHOW_CURSOR + EXIT_ALT_SCREEN);
    };
  }, [writeRaw, disabled]);

  return (
    <Box flexDirection="column" height={rows}>
      {children}
    </Box>
  );
};
