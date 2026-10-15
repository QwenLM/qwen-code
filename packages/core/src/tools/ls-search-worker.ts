/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { FileFilteringOptions } from '../utils/file-filtering-options.js';
import { resolveContainedSearchPath } from './bounded-search.js';

export interface LSDirectorySearch {
  containmentRoot: string;
  path?: string;
  fileFilteringOptions: FileFilteringOptions;
}

export interface LSDirectoryReply {
  entries: Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  }>;
  hitLimit: boolean;
}

if (!parentPort) throw new Error('Directory search requires a worker thread.');
const options = workerData as LSDirectorySearch;
const { root, searchPath } = resolveContainedSearchPath(
  options.containmentRoot,
  options.path,
);
const discovery = new FileDiscoveryService(
  root,
  options.fileFilteringOptions.customIgnoreFiles,
);
const directory = await fs.opendir(searchPath);
const entries: LSDirectoryReply['entries'] = [];
let hitLimit = false;
let visited = 0;
for await (const entry of directory) {
  if (visited++ === 1000) {
    hitLimit = true;
    break;
  }
  const fullPath = path.join(searchPath, entry.name);
  const stats = await fs.lstat(fullPath);
  const relative = path.relative(root, fullPath);
  if (
    discovery.shouldIgnoreFile(
      relative + (stats.isDirectory() ? '/' : ''),
      options.fileFilteringOptions,
    )
  )
    continue;
  const resultPath = path.resolve(options.containmentRoot, relative);
  entries.push({
    name: entry.name,
    path: resultPath,
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
  });
}
entries.sort(
  (a, b) =>
    Number(b.isDirectory) - Number(a.isDirectory) ||
    a.name.localeCompare(b.name),
);
parentPort.postMessage({ entries, hitLimit } satisfies LSDirectoryReply);
parentPort.close();
