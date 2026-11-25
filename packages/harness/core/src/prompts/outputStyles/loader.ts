/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Compatibility adapters; file discovery and parsing live in the resource package. */
import {
  loadOutputStylesFromDir as loadDirectory,
  loadOutputStylesFromPath as loadPath,
} from '@qwen-code/resource';
import { runLogger } from '../../utils/runLogger.js';
import type { OutputStyleConfig, OutputStyleSource } from './types.js';

const onError = (error: { filePath: string; message: string }): void => {
  runLogger.debug(`[output-styles] ${error.filePath}: ${error.message}`);
};

export function loadOutputStylesFromDir(
  dir: string,
  source: OutputStyleSource,
  pluginName?: string,
  options?: { recursive?: boolean },
): Promise<OutputStyleConfig[]> {
  return loadDirectory(dir, source, pluginName, { ...options, onError });
}

export function loadOutputStylesFromPath(
  entryPath: string,
  source: OutputStyleSource,
  pluginName?: string,
): Promise<OutputStyleConfig[]> {
  return loadPath(entryPath, source, pluginName, { onError });
}
