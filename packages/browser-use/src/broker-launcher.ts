/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

const SPAWN_THROTTLE_MS = 1_000;

let lastSpawnAt = 0;

export async function ensureBrowserBroker(
  brokerPath: string,
  socketPath: string,
): Promise<void> {
  const now = Date.now();
  if (now - lastSpawnAt < SPAWN_THROTTLE_MS) return;
  lastSpawnAt = now;

  await access(brokerPath);
  const child = spawn(process.execPath, [brokerPath], {
    detached: true,
    stdio: 'ignore',
    env: brokerEnvironment(socketPath),
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

function brokerEnvironment(socketPath: string): NodeJS.ProcessEnv {
  return {
    QWEN_BROWSER_USE_SOCKET_PATH: socketPath,
    ...(process.platform === 'win32' && process.env['SystemRoot']
      ? { SystemRoot: process.env['SystemRoot'] }
      : {}),
  };
}
