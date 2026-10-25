/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';

export const PROVIDER_MEDIA_MYSQL_PREFIX =
  'qwen-e2e-home-provider-media-mysql-';
export const PROVIDER_MEDIA_HARNESS_PREFIX =
  'qwen-e2e-home-provider-media-harness-';
export const PROVIDER_MEDIA_FIXTURES_PREFIX =
  'qwen-e2e-home-provider-media-fixtures-';
export const PROVIDER_MEDIA_PROBE_PREFIX =
  'qwen-e2e-home-provider-media-probe-';

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
