#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { startCapturingEarlyInput } from './src/utils/earlyInput.js';

// --- Global Entry Point ---
//
// Start capturing interactive input before loading the heavy CLI module graph.
// This covers the real startup window where users can type before `gemini.tsx`
// has finished evaluating and before `main()` starts.
startCapturingEarlyInput();

// Suppress known race conditions in @lydell/node-pty.
//
// PTY errors that are expected due to timing races between process exit
// and I/O operations. These should not crash the app.
//
// References:
// - https://github.com/microsoft/node-pty/issues/178 (EIO on macOS/Linux)
// - https://github.com/microsoft/node-pty/issues/827 (resize on Windows)
const getErrnoCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const isExpectedPtyRaceError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  const code = getErrnoCode(error);

  // EIO: PTY read race on macOS/Linux - code + PTY context required
  // https://github.com/microsoft/node-pty/issues/178
  if (
    (code === 'EIO' && message.includes('read')) ||
    message.includes('read EIO')
  ) {
    return true;
  }

  // PTY-specific resize/exit race errors - require PTY context in message
  if (
    message.includes('ioctl(2) failed, EBADF') ||
    message.includes('Cannot resize a pty that has already exited')
  ) {
    return true;
  }

  return false;
};

process.on('uncaughtException', (error) => {
  if (isExpectedPtyRaceError(error)) {
    return;
  }

  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});

const run = async () => {
  const { main } = await import('./src/gemini.js');

  try {
    await main();
  } catch (error) {
    const { FatalError } = await import('@qwen-code/qwen-code-core');

    if (error instanceof FatalError) {
      let errorMessage = error.message;
      if (!process.env['NO_COLOR']) {
        errorMessage = `\x1b[31m${errorMessage}\x1b[0m`;
      }
      console.error(errorMessage);
      process.exit(error.exitCode);
    }

    console.error('An unexpected critical error occurred:');
    if (error instanceof Error) {
      console.error(error.stack);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  }
};

void run();
