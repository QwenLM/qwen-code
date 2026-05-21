/**
 * @license
 * Copyright 2025
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get a random fortune quote by calling the fortune command.
 * Exported for testing purposes.
 */
export async function getFortuneQuote(command: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(command);
    const quote = stdout.trim().replace(/\s+/g, ' ');
    return quote || null;
  } catch {
    return null;
  }
}
