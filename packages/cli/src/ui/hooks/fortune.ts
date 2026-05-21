/**
 * @license
 * Copyright 2025
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Get a random fortune quote by calling the fortune command.
 * Exported for testing purposes.
 */
export async function getFortuneQuote(command: string): Promise<string | null> {
  try {
    const parts = command.split(/\s+/);
    const [executable, ...args] = parts;
    const { stdout } = await execFileAsync(executable, args, {
      timeout: 5000,
      maxBuffer: 1024,
    });
    const quote = stdout.trim().replace(/\s+/g, ' ');
    return quote || null;
  } catch {
    return null;
  }
}
