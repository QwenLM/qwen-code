/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeStderrLine } from './stdioHelpers.js';

// Keep this leaf independent of the entry lifecycle so llm.tsx can share the
// handler without pulling bootstrap dependencies into its module graph.

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

  // The direction of the failed I/O does not change the class of the race:
  // `write EIO` is the same pty teardown as `read EIO`, only observed from the
  // other side. It is what Ink's throttled log write raises once the terminal
  // is closed or detached, and node delivers it asynchronously out of the
  // stream write callback, so it lands here as an uncaughtException (#11783).
  if (
    (code === 'EIO' && message.includes('read')) ||
    message.includes('read EIO') ||
    (code === 'EIO' && message.includes('write')) ||
    message.includes('write EIO')
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
 * `setupUncaughtExceptionHandler` in llm.tsx removes this handler and
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
