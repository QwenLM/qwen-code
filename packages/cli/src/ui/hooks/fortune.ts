/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { parse } from 'shell-quote';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import stripAnsi from 'strip-ansi';

const execFileAsync = promisify(execFile);
const debugLogger = createDebugLogger('fortune');

/**
 * Get a random fortune quote by calling the fortune command.
 */
export async function getFortuneQuote(command: string): Promise<string | null> {
  try {
    // Detect environment variables in command
    if (/\$[a-zA-Z_][a-zA-Z0-9_]*|\$\{[^}]+\}/.test(command)) {
      debugLogger.warn(
        'Environment variables ($VAR, ${VAR}) are not supported in fortuneCommand; ignoring command: %s',
        command,
      );
      return null;
    }

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
      } else {
        debugLogger.warn(
          'Shell operators (|, >, <, etc.) are not supported in fortuneCommand; ignoring command: %s',
          command,
        );
        return null;
      }
    }

    if (!executable) {
      return null;
    }

    const { stdout } = await execFileAsync(executable, args, {
      timeout: 2000,
      maxBuffer: 1024,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    });
    const quote = stripAnsi(stdout).trim().replace(/\s+/g, ' ');
    return quote || null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLogger.error('Command failed:', msg);
    return null;
  }
}
