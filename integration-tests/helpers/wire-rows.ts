/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface WireRow {
  kind?: string;
  requestId?: number;
  at?: number;
  method?: string;
  url?: string;
  operation?: string;
  status?: number;
  requestSnippet?: string;
  responseSnippet?: string;
  replied?: string;
}

// The blocked-wedge driver appends each row with one appendFile of
// JSON.stringify(row) + '\n', and polls the same file from the same process,
// so a read can land mid-append. Parse only complete rows: an unterminated
// tail is the row still being written, and the next poll reads it whole. A
// complete-but-malformed row still reaches JSON.parse and throws.
export function parseWireRows(text: string): WireRow[] {
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WireRow);
}
