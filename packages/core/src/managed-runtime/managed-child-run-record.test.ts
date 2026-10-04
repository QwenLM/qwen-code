/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_EXTENSION_RECORD_BODIES,
  MANAGED_TASK_KINDS,
} from './managed-extension-projection.js';
import { CHILD_RUN_STOP_REASONS } from './managed-child-run-record.js';
import { MANAGED_SESSION_ENABLED_DOMAINS } from './managed-session-records.js';

type Domain = 'child_run';
interface Fixture {
  id: string;
  domain: Domain;
  patch: Record<string, unknown>;
  valid: boolean;
  start: boolean;
  /** The clause substring both validators must report on an invalid case. */
  error?: string;
}
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-child-run-record-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  keys: readonly string[];
  fixedKeys: readonly string[];
  stopReasons: Record<string, readonly string[]>;
  templates: Record<Domain, Record<string, unknown>>;
  cases: Fixture[];
  successors: Array<
    Omit<Fixture, 'patch' | 'start'> & {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  >;
};

function merge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const value = structuredClone(base ?? {});
  for (const [key, replacement] of Object.entries(patch)) {
    value[key] =
      replacement !== null &&
      typeof replacement === 'object' &&
      !Array.isArray(replacement)
        ? merge(
            value[key] as Record<string, unknown>,
            replacement as Record<string, unknown>,
          )
        : replacement;
  }
  return value;
}

describe('managed-child-run-record/1 shared contract', () => {
  it('projects a background_shell task and stays disabled for submission', () => {
    // The body lands before its producer: enabling the domain is the H3
    // enablement slice's own explicit step.
    expect(MANAGED_EXTENSION_RECORD_BODIES.child_run!.taskKind).toBe(
      'background_shell',
    );
    expect(MANAGED_TASK_KINDS).toContain('background_shell');
    expect(MANAGED_SESSION_ENABLED_DOMAINS).not.toContain('child_run');
  });

  it('pins the closed keys and the closed stop-reason vocabulary', () => {
    expect([...fixtures.keys].sort()).toEqual(
      [
        'commandRef',
        'exitCode',
        'exitSignal',
        'kind',
        'outputRef',
        'ownerScopeId',
        'run',
        'shellId',
        'startReceiptRef',
        'stopReason',
        'stopRequested',
      ].sort(),
    );
    expect([...fixtures.fixedKeys].sort()).toEqual(
      ['commandRef', 'kind', 'ownerScopeId', 'shellId'].sort(),
    );
    expect(fixtures.stopReasons).toEqual({
      settled: [...CHILD_RUN_STOP_REASONS.settled],
      failed: [...CHILD_RUN_STOP_REASONS.failed],
      cancelled: [...CHILD_RUN_STOP_REASONS.cancelled],
    });
  });

  it.each(fixtures.cases)('$id', (fixture) => {
    const body = MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!;
    const record = merge(fixtures.templates[fixture.domain], fixture.patch);
    if (fixture.valid) {
      const parsed = body.parse(record);
      // The committed body round-trips the input and is deeply frozen.
      expect(parsed.record).toEqual(record);
      expect(Object.isFrozen(parsed.record)).toBe(true);
      for (const value of Object.values(
        parsed.record as Record<string, unknown>,
      )) {
        if (
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value)
        ) {
          expect(Object.isFrozen(value)).toBe(true);
        }
      }
    } else {
      // Every invalid case names the clause that must refuse it, so a
      // masked guard can never slip a fixture green.
      expect(() => body.parse(record)).toThrow(fixture.error as string);
    }
    expect(body.isStart(record)).toBe(fixture.start);
  });

  it.each(fixtures.successors)('$id', (fixture) => {
    const template = fixtures.templates[fixture.domain];
    expect(
      MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!.isSuccessor(
        merge(template, fixture.before),
        merge(template, fixture.after),
      ),
    ).toBe(fixture.valid);
  });
});
