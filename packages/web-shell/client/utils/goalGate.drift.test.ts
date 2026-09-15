/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  goalCheckpointHealthVisible,
  type GoalCheckpointHealthRecord,
} from './goalGate';

// The Web Shell bundles for the browser and does not depend on
// `@qwen-code/qwen-code-core`, so the checkpoint-health rule is copied into
// `goalGate.ts` rather than imported. A comment asking the next person to keep
// the copies in sync is not a mechanism: read core's function body from source
// and run both over every combination of the fields the rule reads, so a
// branch added to either copy without the other fails here.
const protocolSource = readFileSync(
  fileURLToPath(
    new URL('../../../core/src/goals/goal-protocol.ts', import.meta.url),
  ),
  'utf8',
);

function coreCheckpointHealthVisible(): (
  goal: GoalCheckpointHealthRecord,
) => boolean {
  const match = protocolSource.match(
    /export function goalCheckpointHealthVisible\(goal: \{[^}]*\}\): boolean \{\n([\s\S]*?)\n\}\n/,
  );
  if (!match) {
    throw new Error(
      'could not locate `goalCheckpointHealthVisible` in core goal-protocol.ts',
    );
  }
  // The body reads only `goal` and plain JavaScript, so it runs as written.
  return new Function('goal', match[1]) as (
    goal: GoalCheckpointHealthRecord,
  ) => boolean;
}

const STATUSES = [
  undefined,
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'complete',
];
const STALLS = [undefined, 0, 1, 3];
const FAILURES = [undefined, '', ' ', '\r', 'Error: provider failed'];
const LIMIT_KINDS = [undefined, 'evidence_catalog', 'checkpoint_request'];

describe('goalCheckpointHealthVisible drift vs core', () => {
  it('sanity-checks that core function body was parsed', () => {
    const core = coreCheckpointHealthVisible();
    expect(core({ status: 'complete', checkpointStalls: 3 })).toBe(false);
    expect(core({ status: 'paused', checkpointStalls: 1 })).toBe(true);
  });

  it('agrees with core on every combination of the fields it reads', () => {
    const core = coreCheckpointHealthVisible();
    const disagreements: string[] = [];
    for (const status of STATUSES) {
      for (const checkpointStalls of STALLS) {
        for (const lastCheckpointFailure of FAILURES) {
          for (const limitKind of LIMIT_KINDS) {
            const goal = {
              status,
              checkpointStalls,
              lastCheckpointFailure,
              limitKind,
            };
            if (core(goal) !== goalCheckpointHealthVisible(goal)) {
              disagreements.push(JSON.stringify(goal));
            }
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
