/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptEntry } from '../entry/transcript-entry.js';

export interface AppendChannelLease {
  readonly filePath: string;
  append(entries: readonly TranscriptEntry[]): Promise<void>;
  barrier(): Promise<void>;
  flush(): Promise<void>;
  readTail(maxBytes?: number): Promise<Buffer>;
  readAll(): Promise<Buffer>;
  release(): Promise<void>;
}
