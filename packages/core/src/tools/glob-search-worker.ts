/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parentPort, workerData } from 'node:worker_threads';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import {
  searchGlobDirectory,
  type GlobDirectorySearch,
  type GlobDirectoryReply,
} from './glob-search.js';

if (!parentPort) throw new Error('Glob search requires a worker thread.');
const options = workerData as GlobDirectorySearch;
const result = await searchGlobDirectory(
  options,
  new FileDiscoveryService(
    options.projectRoot,
    options.fileFilteringOptions.customIgnoreFiles,
  ),
  new AbortController().signal,
);
parentPort.postMessage({
  entries: result.entries.map((entry) => ({
    path: entry.fullpath(),
    mtimeMs: entry.mtimeMs,
  })),
  hitLimit: result.hitLimit,
} satisfies GlobDirectoryReply);
parentPort.close();
