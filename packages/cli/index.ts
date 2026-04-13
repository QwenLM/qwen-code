#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './src/gemini.js';
import { main } from './src/gemini.js';
import { FatalError } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from './src/utils/stdioHelpers.js';

// --- Global Entry Point ---

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

  // EAGAIN: transient non-blocking read error from PTY fd
  if (code === 'EAGAIN' || message.includes('EAGAIN')) {
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
    writeStderrLine(error.stack ?? error.message);
  } else {
    writeStderrLine(String(error));
  }
  process.exit(1);
});

main().catch((error) => {
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
});
