/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANAGED_EXTENSION_RECORD_BODIES } from './managed-extension-projection.js';
import { parseChildAcceptance } from './managed-child-acceptance-record.js';
import { MANAGED_SESSION_ENABLED_DOMAINS } from './managed-session-records.js';

interface Fixture {
  id: string;
  domain: 'child_acceptance';
  patch: Record<string, unknown>;
  valid: boolean;
  start: boolean;
  /** The clause substring both validators must report on an invalid case. */
  error?: string;
}
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-child-acceptance-record-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  contract: string;
  keys: readonly string[];
  fixedKeys: readonly string[];
  templates: Record<string, Record<string, unknown>>;
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

describe('managed-child-acceptance-record/1 shared contract', () => {
  it('projects no task and stays disabled for submission', () => {
    const body = MANAGED_EXTENSION_RECORD_BODIES.child_acceptance!;
    expect(
      body.taskKindOf(
        parseChildAcceptance(fixtures.templates['child_acceptance']),
      ),
    ).toBeNull();
    expect(MANAGED_SESSION_ENABLED_DOMAINS).not.toContain('child_acceptance');
    expect(fixtures.contract).toBe('managed-child-acceptance-record/1');
  });

  it('pins the closed keys and the fixed keys', () => {
    expect([...fixtures.keys].sort()).toEqual(
      [
        'childRunId',
        'contentDigest',
        'contentRef',
        'parentExecutionCallId',
        'parentScopeId',
        'resultVersion',
        'run',
        'terminalReceiptRef',
      ].sort(),
    );
    expect([...fixtures.fixedKeys].sort()).toEqual(
      [
        'childRunId',
        'contentDigest',
        'contentRef',
        'parentExecutionCallId',
        'parentScopeId',
        'resultVersion',
        'terminalReceiptRef',
      ].sort(),
    );
  });

  it.each(fixtures.cases)('$id', (fixture) => {
    const body = MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!;
    const template = fixtures.templates[fixture.domain];
    if (template === undefined) {
      throw new Error(`fixture ${fixture.id} names an unknown template`);
    }
    const record = merge(template, fixture.patch);
    if (fixture.valid) {
      const parsed = body.parse(record);
      expect(parsed.record).toEqual(record);
      expect(parsed.recordId).toBe(
        (record as { childRunId: string }).childRunId,
      );
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
      expect(() => body.parse(record)).toThrow(fixture.error as string);
    }
    expect(body.isStart(record)).toBe(fixture.start);
  });

  it.each(fixtures.successors)('$id', (fixture) => {
    const template = fixtures.templates[fixture.domain];
    if (template === undefined) {
      throw new Error(`fixture ${fixture.id} names an unknown template`);
    }
    expect(
      MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!.isSuccessor(
        merge(template, fixture.before),
        merge(template, fixture.after),
      ),
    ).toBe(fixture.valid);
  });
});
