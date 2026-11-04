/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Ink parity suite runs two TUI sessions per scenario in the required
// no-AK lane. A green run cannot show whether a stall would be retried, so this
// pin keeps the integration root's `retry: 2` from tripling one.
const source = readFileSync(
  join(
    resolve(import.meta.dirname, '../..'),
    'integration-tests/interactive/ink-agent-loop-parity.test.ts',
  ),
  'utf8',
);

describe('Ink agent loop parity suite source pins', () => {
  it('runs each scenario once, without the root config retries', () => {
    // Both halves: the scenario table takes the options, and they keep
    // `retry: 0`. The ceiling is free to change.
    expect(source).toMatch(
      /it\.each\(scenarios\)\(\s*'\$name',\s*PARITY_CASE_OPTIONS,/,
    );
    expect(source).toMatch(/const PARITY_CASE_OPTIONS = \{[^}]*\bretry: 0\b/);
  });
});
