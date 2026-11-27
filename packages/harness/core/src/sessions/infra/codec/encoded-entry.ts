/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptEntry } from '../entry/transcript-entry.js';

export interface EncodedTranscriptEntry {
  readonly entry: TranscriptEntry;
  readonly bytes: Buffer;
}
