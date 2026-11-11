/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptCommitObserver } from './commit-observer.js';
import type { TranscriptFileSystem } from './append-channel-file-system.js';
import type { TranscriptPathFileSystem } from '../path/transcript-path-file-system.js';

export interface WriterCoordinatorOptions {
  flushIntervalMs?: number;
  maxBatchBytes?: number;
  fileSystem?: TranscriptFileSystem & TranscriptPathFileSystem;
  commitObserver?: TranscriptCommitObserver;
}
