/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';

export async function stopFixtureProcess(
  child,
  shutdown = () => child.kill('SIGKILL'),
  graceMs = 1000,
) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  try {
    try {
      shutdown();
    } catch {
      child.kill('SIGKILL');
    }
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
