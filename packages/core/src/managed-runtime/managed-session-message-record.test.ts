/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANAGED_EXTENSION_RECORD_BODIES } from './managed-extension-projection.js';
import { parseSessionMessage } from './managed-session-message-record.js';
import {
  MANAGED_SESSION_ENABLED_DOMAINS,
  assertManagedSessionDomainEnabled,
} from './managed-session-records.js';

interface Fixture {
  id: string;
  domain: 'session_message';
  template: 'outbound' | 'inbound';
  patch: Record<string, unknown>;
  valid: boolean;
  start: boolean;
  /** The clause substring both validators must report on an invalid case. */
  error?: string;
}
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-session-message-record-v1.fixtures.json',
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

/** Resolves a fixture's template, or fails loudly: a silent miss degenerates. */
function templateOf(fixture: { id: string; template: string }) {
  const template = fixtures.templates[fixture.template];
  if (template === undefined) {
    throw new Error(`fixture ${fixture.id} names an unknown template`);
  }
  return template;
}

describe('managed-session-message-record/1 shared contract', () => {
  it('projects no task and stays disabled for submission', () => {
    const body = MANAGED_EXTENSION_RECORD_BODIES.session_message!;
    for (const template of ['outbound', 'inbound']) {
      expect(
        body.taskKindOf(parseSessionMessage(fixtures.templates[template])),
      ).toBeNull();
    }
    expect(MANAGED_SESSION_ENABLED_DOMAINS).not.toContain('session_message');
    expect(() => assertManagedSessionDomainEnabled('session_message')).toThrow(
      'domain session_message is registered but not enabled for submission.',
    );
    expect(fixtures.contract).toBe('managed-session-message-record/1');
  });

  it('pins the closed keys and the fixed keys', () => {
    expect([...fixtures.keys].sort()).toEqual(
      [
        'childRunId',
        'contentDigest',
        'contentRef',
        'direction',
        'inputId',
        'messageId',
        'route',
        'run',
        'senderSessionId',
        'targetSessionId',
      ].sort(),
    );
    expect([...fixtures.fixedKeys].sort()).toEqual(
      [
        'childRunId',
        'contentDigest',
        'contentRef',
        'direction',
        'messageId',
        'route',
        'senderSessionId',
      ].sort(),
    );
    for (const template of Object.values(fixtures.templates)) {
      expect(Object.keys(template).sort()).toEqual([...fixtures.keys].sort());
    }
  });

  it.each(fixtures.cases)('$id', (fixture) => {
    const body = MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!;
    const record = merge(templateOf(fixture), fixture.patch);
    if (fixture.valid) {
      const parsed = body.parse(record);
      expect(parsed.record).toEqual(record);
      expect(parsed.recordId).toBe((record as { messageId: string }).messageId);
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
    const template = templateOf(fixture);
    expect(
      MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!.isSuccessor(
        merge(template, fixture.before),
        merge(template, fixture.after),
      ),
    ).toBe(fixture.valid);
  });
});
