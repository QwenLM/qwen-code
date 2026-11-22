/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const root = resolve(import.meta.dirname, '../..');

// The TUI parity suite runs two TUI sessions per scenario in the required
// no-AK lane. A green run cannot show whether a stall would be retried, so this
// pin keeps the integration root's `retry: 2` from tripling one.
const source = readFileSync(
  join(root, 'integration-tests/interactive/tui-agent-loop-parity.test.ts'),
  'utf8',
);

describe('TUI agent loop parity suite source pins', () => {
  it('runs each scenario once, without the root config retries', () => {
    // Both halves: the scenario table takes the options, and they keep
    // `retry: 0`. The ceiling is pinned against the gate step below.
    expect(source).toMatch(
      /it\.each\(scenarios\)\(\s*'\$name',\s*PARITY_CASE_OPTIONS,/,
    );
    expect(source).toMatch(/const PARITY_CASE_OPTIONS = \{[^}]*\bretry: 0\b/);
  });

  it('keeps the case ceiling within the gate step that runs the suite', () => {
    const gate = getWorkflowStep(
      getWorkflowJob(
        readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
        'integration_no_ak',
      ),
      'Run required no-AK integration gate',
    );
    const stepMs = Number(/timeout-minutes: (\d+)/.exec(gate)?.[1]) * 60_000;
    const ceilingMs = Number(
      /const PARITY_CASE_OPTIONS = \{[^}]*\btimeout: ([\d_]+)/
        .exec(source)?.[1]
        ?.replaceAll('_', ''),
    );
    // The step runs the whole no-AK list sharded two ways, and shard 1 also
    // typechecks, so a stalled case must leave its shard at least half.
    expect(ceilingMs).toBeLessThanOrEqual(stepMs / 2);
  });
});
