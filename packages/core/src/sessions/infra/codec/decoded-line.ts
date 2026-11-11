/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TranscriptEntry } from '../entry/transcript-entry.js';

export type DecodedTranscriptLine =
  | { readonly kind: 'entry'; readonly entry: TranscriptEntry }
  | { readonly kind: 'unknown'; readonly value: unknown; readonly type?: string }
  | {
      readonly kind: 'invalid-shape';
      readonly value: unknown;
      readonly type: string;
    }
  | { readonly kind: 'malformed'; readonly error: SyntaxError };
