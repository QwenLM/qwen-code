/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptEntry } from '../entry/transcript-entry.js';

/** Receives the exact entries covered by one successful physical write. */
export type TranscriptCommitObserver = (
  filePath: string,
  entries: readonly TranscriptEntry[],
) => void | Promise<void>;
