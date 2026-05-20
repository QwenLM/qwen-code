/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Get a random fortune quote by calling the fortune command.
 * Uses -s flag to get only short (single-line) fortunes.
 */
export async function getFortuneQuote(command: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(command);
    // Replace newlines with spaces and trim to ensure single-line output
    const quote = stdout.trim().replace(/\s+/g, ' ');
    return quote || null;
  } catch {
    // Return null to signal fallback to preselected phrases
    return null;
  }
}
