/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';

// The `qwen serve` spawn/teardown contract shared by cli/_daemon-harness.ts
// and helpers/hosted-harness-process.ts. It imports only Node built-ins, so
// the Hosted helper does not pick up the SDK or core through it.

/** The line `qwen serve` prints once its loopback listener is bound. */
export const LISTENING_LINE_RE =
  /^(?<line>.*listening on http:\/\/127\.0\.0\.1:(?<port>\d+).*)$/m;

const DAEMON_STOP_GRACE_MS = 5_000;

/**
 * Sends SIGTERM, then SIGKILL once the grace period passes, and resolves when
 * the child has exited. Returns at once for a child that has already exited
 * or never spawned.
 */
export async function stopDaemon(child: ChildProcess): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), DAEMON_STOP_GRACE_MS);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
