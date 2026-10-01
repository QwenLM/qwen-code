/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANAGED_EXTENSION_RECORD_BODIES } from './managed-extension-projection.js';
import { MANAGED_SESSION_ENABLED_DOMAINS } from './managed-session-records.js';

type Domain = 'mcp_configuration' | 'mcp_operation';
interface Fixture {
  id: string;
  domain: Domain;
  patch: Record<string, unknown>;
  valid: boolean;
  start: boolean;
}
const fixtures = JSON.parse(
  readFileSync(
    new URL('./contracts/managed-mcp-record-v1.fixtures.json', import.meta.url),
    'utf8',
  ),
) as {
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

describe('managed-mcp-record/1 shared contract', () => {
  it('enables both domains without projecting Session tasks', () => {
    for (const domain of ['mcp_configuration', 'mcp_operation'] as const) {
      expect(MANAGED_SESSION_ENABLED_DOMAINS).toContain(domain);
      expect(MANAGED_EXTENSION_RECORD_BODIES[domain]!.taskKind).toBeNull();
    }
  });

  it.each(fixtures.cases)('$id', (fixture) => {
    const body = MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!;
    const record = merge(fixtures.templates[fixture.domain], fixture.patch);
    if (fixture.valid) expect(() => body.parse(record)).not.toThrow();
    else expect(() => body.parse(record)).toThrow();
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
