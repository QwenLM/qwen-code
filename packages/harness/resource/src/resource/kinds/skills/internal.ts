/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dir } from 'node:fs';
import { BRAND_FIXED_ENV_PREFIX } from '../../../brand.js';

export interface Logger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

// Hosts own the terminal: a console.warn during early startup lands as raw red
// text before the TUI mounts, so both levels stay opt-in.
export const logger: Logger = {
  debug(...args: unknown[]): void {
    if (process.env[`${BRAND_FIXED_ENV_PREFIX}RESOURCES_DEBUG`]) {
      // oxlint-disable-next-line no-console
      console.debug(...args);
    }
  },
  warn(...args: unknown[]): void {
    if (process.env[`${BRAND_FIXED_ENV_PREFIX}RESOURCES_DEBUG`]) {
      // oxlint-disable-next-line no-console
      console.warn(...args);
    }
  },
};

export async function closeDirHandleQuietly(handle: Dir): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_DIR_CLOSED') {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`Failed to close directory handle for ${handle.path}: ${message}`);
  }
}
