/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

/**
 * Enables and disables bracketed paste mode in the terminal.
 *
 * This hook ensures that bracketed paste mode is enabled when the component
 * mounts and disabled when it unmounts.
 */
export const useBracketedPaste = () => {
  useEffect(() => {
    process.stdout.write(ENABLE_BRACKETED_PASTE);

    return () => {
      process.stdout.write(DISABLE_BRACKETED_PASTE);
    };
  }, []);
};
