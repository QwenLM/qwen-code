/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptCommitObserver } from './commit-observer.js';
import type { TranscriptFileSystem } from './append-channel-file-system.js';

export interface AppendChannelOptions {
  filePath: string;
  flushIntervalMs?: number;
  maxBatchBytes?: number;
  fileSystem?: TranscriptFileSystem;
  commitObserver?: TranscriptCommitObserver;
}
