#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { initStartupProfiler } from './src/utils/startupProfiler.js';
import { isServeFastPathArgv } from './src/serve/fast-path-argv.js';

// Must run before any other imports to capture the earliest possible T0.
initStartupProfiler();

import { initCpuProfiler } from './src/utils/cpuProfiler.js';
// Initialize early to register SIGUSR1 handler and start recording when
// QWEN_CODE_CPU_PROFILE=1, capturing as much of the startup as possible.
initCpuProfiler();

// --- Global Entry Point ---

function writeStderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

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
  if (
    (code === 'EAGAIN' && message.includes('read')) ||
    message.includes('read EAGAIN')
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

async function runCliEntry(): Promise<void> {
  if (isServeFastPathArgv(process.argv.slice(2))) {
    const { tryRunServeFastPath } = await import('./src/serve/fast-path.js');
    if (await tryRunServeFastPath()) return;
  }

  const { main } = await import('./src/gemini.js');
  await main();
}

async function handleCriticalError(error: unknown): Promise<void> {
  const [{ FatalError }, { AlreadyReportedError }] = await Promise.all([
    import('@qwen-code/qwen-code-core'),
    import('./src/utils/errors.js'),
  ]);

  if (error instanceof FatalError) {
    let errorMessage = error.message;
    if (!process.env['NO_COLOR']) {
      errorMessage = `\x1b[31m${errorMessage}\x1b[0m`;
    }
    console.error(errorMessage);
    process.exit(error.exitCode);
  }
  // AlreadyReportedError means an upstream layer (e.g. the non-interactive
  // stream-error handler) has already written the user-facing message to
  // stderr and just wants to surface a non-zero exit code. Don't print
  // "An unexpected critical error occurred:" with a stack trace — that
  // framing is for genuinely unexpected, programmer-level bugs, and a
  // routine 4xx from an upstream API does not qualify.
  if (error instanceof AlreadyReportedError) {
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

runCliEntry().catch((error: unknown) => {
  void handleCriticalError(error).catch((handlerError: unknown) => {
    console.error('An unexpected critical error occurred:');
    console.error('Original error:');
    if (error instanceof Error) {
      console.error(error.stack);
    } else {
      console.error(String(error));
    }
    console.error('Error handler failed:');
    if (handlerError instanceof Error) {
      console.error(handlerError.stack);
    } else {
      console.error(String(handlerError));
    }
    process.exit(1);
  });
});
