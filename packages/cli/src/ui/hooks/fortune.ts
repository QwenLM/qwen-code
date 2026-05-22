/**
 * @license
 * Copyright 2025
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { parse } from 'shell-quote';

const execFileAsync = promisify(execFile);

/**
 * Default fortune command: runs fortune with short (-s) output limited to 45 chars.
 * Shared constant to avoid duplication across schema and hook.
 */
export const DEFAULT_FORTUNE_COMMAND = '/usr/games/fortune -s -n 45';

/**
 * Get a random fortune quote by calling the fortune command.
 * Exported for testing purposes.
 */
export async function getFortuneQuote(command: string): Promise<string | null> {
  try {
    const parsed = parse(command);
    const args: string[] = [];
    let executable: string | null = null;

    for (const part of parsed) {
      if (typeof part === 'string') {
        if (executable === null) {
          executable = part;
        } else {
          args.push(part);
        }
      }
    }

    if (!executable) {
      return null;
    }

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
