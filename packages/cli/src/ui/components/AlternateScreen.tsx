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
}

export const AlternateScreen: FC<AlternateScreenProps> = ({ children }) => {
  const writeRaw = useTerminalOutput();
  const { rows } = useTerminalSize();

  useEffect(() => {
    writeRaw(ENTER_ALT_SCREEN + CLEAR_SCREEN + HIDE_CURSOR);
    return () => {
      writeRaw(SHOW_CURSOR + EXIT_ALT_SCREEN);
    };
  }, [writeRaw]);

  return (
    <Box flexDirection="column" height={rows}>
      {children}
    </Box>
  );
};
