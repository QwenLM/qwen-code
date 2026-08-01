/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeStderrLine } from './stdioHelpers.js';

// These helpers live in a leaf module (no import of cli.ts or gemini.tsx) so
// both the entry point and the lazily-loaded gemini.tsx can share them. A
// static import of cli.ts from gemini.tsx makes esbuild hoist the entry into a
// shared chunk under `splitting: true`, which silently disables the bootstrap
// guard at the bottom of cli.ts and leaves the bundled CLI dead.

function getErrnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isExpectedPtyRaceError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  const code = getErrnoCode(error);

  if (
    (code === 'EIO' && message.includes('read')) ||
    message.includes('read EIO')
  ) {
    return true;
  }

  if (
    (code === 'EAGAIN' && message.includes('read')) ||
    message.includes('read EAGAIN')
  ) {
    return true;
  }

  return (
    message.includes('ioctl(2) failed, EBADF') ||
    message.includes('Cannot resize a pty that has already exited')
  );
}

/**
 * The process-level `uncaughtException` handler registered at the entry point,
 * before the session ID (and thus the debug-log path) is known. Benign PTY
 * teardown races are suppressed; anything else is reported to stderr and fatal.
 *
 * `setupUncaughtExceptionHandler` in gemini.tsx removes this handler and
 * installs a session-aware replacement once interactive startup is far enough
 * along to leave the alternate screen and write the debug file. Exactly one
 * listener must be active: two would conflict (the first calls `process.exit`
 * before the second runs) and this basic one lacks the visibility behavior.
 */
export function handleUncaughtException(error: unknown): void {
  if (isExpectedPtyRaceError(error)) {
    return;
  }

  if (error instanceof Error) {
    writeStderrLine(error.stack ?? error.message);
  } else {
    writeStderrLine(String(error));
  }
  process.exit(1);
}
