/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

export interface TranscriptFileSystem {
  mkdir(
    directoryPath: string,
    options: { recursive: true; mode: number },
  ): Promise<unknown>;
  open(filePath: string, flags: string, mode?: number): Promise<FileHandle>;
  appendFile(
    filePath: string,
    data: Uint8Array,
    options: { mode: number },
  ): Promise<void>;
  rm(filePath: string, options: { force: boolean }): Promise<void>;
}

export const nodeTranscriptFileSystem: TranscriptFileSystem = {
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
  appendFile: (filePath, data, options) =>
    fs.appendFile(filePath, data, options),
  rm: (filePath, options) => fs.rm(filePath, options),
};
