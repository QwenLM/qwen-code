/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsEnvironmentUrls } from './types.js';

export async function prepareWindowsEnvironment(
  signal: AbortSignal,
  urls?: WindowsEnvironmentUrls,
): Promise<() => Promise<void>> {
  signal.throwIfAborted();
  if (process.platform !== 'win32') return async () => {};
  const { scheduleBackgroundPreparation } = await import(
    './backgroundPreparation.js'
  );
  signal.throwIfAborted();
  return scheduleBackgroundPreparation(urls, signal);
}
