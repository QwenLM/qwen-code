/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';

export async function stopFixtureProcess(
  child,
  shutdown = () => child.kill('SIGKILL'),
) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, 'exit');
  shutdown();
  await exited;
}
