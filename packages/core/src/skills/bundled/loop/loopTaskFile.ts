/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const LOOP_TASK_FILE_MAX_BYTES = 25_000;

export type LoopTaskFileResult =
  | {
      status: 'found';
      path: string;
      content: string;
      truncated: boolean;
      warning?: string;
    }
  | {
      status: 'missing';
      checkedPaths: string[];
    };

export interface ReadLoopTaskFileOptions {
  projectRoot: string;
  homeDir: string;
}

/** Reads `.qwen/loop.md`, project before home, capped at 25 KB. Missing files are skipped, not thrown. */
export async function readLoopTaskFile({
  projectRoot,
  homeDir,
}: ReadLoopTaskFileOptions): Promise<LoopTaskFileResult> {
  const checkedPaths = [
    path.join(projectRoot, '.qwen', 'loop.md'),
    path.join(homeDir, '.qwen', 'loop.md'),
  ];

  for (const filePath of checkedPaths) {
    try {
      const buffer = await fs.readFile(filePath);
      const truncated = buffer.byteLength > LOOP_TASK_FILE_MAX_BYTES;
      let contentBuffer = buffer;
      if (truncated) {
        // Back off to a UTF-8 boundary so a cut mid-character can't decode to
        // U+FFFD and push byteLength past the cap.
        let end = LOOP_TASK_FILE_MAX_BYTES;
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
          end--;
        }
        contentBuffer = buffer.subarray(0, end);
      }

      return {
        status: 'found',
        path: filePath,
        content: contentBuffer.toString('utf8'),
        truncated,
        ...(truncated
          ? {
              warning: `loop.md exceeded ${LOOP_TASK_FILE_MAX_BYTES} bytes and was truncated.`,
            }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return {
    status: 'missing',
    checkedPaths,
  };
}
