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
  projectManagedTask,
} from './managed-extension-projection.js';
import {
  SCHEDULE_CATCH_UP_POLICIES,
  SCHEDULE_OVERLAP_POLICIES,
  SCHEDULE_SESSION_MODES,
  type AutomationRun,
} from './managed-automation-record.js';
import {
  assertManagedSessionDomainEnabled,
  MANAGED_SESSION_ENABLED_DOMAINS,
  ManagedSessionRecordError,
} from './managed-session-records.js';

type Domain = 'schedule' | 'automation_run';
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
      './contracts/managed-automation-record-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  contract: string;
  domains: Record<Domain, { taskKind: string | null }>;
  validatedTimezones: readonly string[];
  overlapPolicies: readonly string[];
  catchUpPolicies: readonly string[];
  sessionModes: readonly string[];
  keys: Record<Domain, readonly string[]>;
  fixedKeys: Record<Domain, readonly string[]>;
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

describe('managed-automation-record/1 shared contract', () => {
  it('projects neither definition and every run, staying disabled', () => {
    // The Schedule definition is no task; every run projects
    // automation_run. Enabling either domain is the H6 producer slice's
    // own explicit step.
    const scheduleBody = MANAGED_EXTENSION_RECORD_BODIES.schedule!;
    expect(
      scheduleBody.taskKindOf(
        scheduleBody.parse(fixtures.templates.schedule).record,
      ),
    ).toBe(fixtures.domains.schedule.taskKind);
    const parsed = MANAGED_EXTENSION_RECORD_BODIES.automation_run!.parse(
      fixtures.templates.automation_run,
    );
    expect(
      MANAGED_EXTENSION_RECORD_BODIES.automation_run!.taskKindOf(parsed.record),
    ).toBe(fixtures.domains.automation_run.taskKind);
    expect(MANAGED_TASK_KINDS).toContain('automation_run');
    expect(parsed.recordId).toBe('run-1');
    // The run block holds no definition pin of its own, so an
    // automation_run task row always reads definitionRevision: null; the
    // authoritative revision lives on the record itself.
    expect(
      projectManagedTask(null, parsed.run, 1_000).definitionRevision,
    ).toBeNull();
    expect((parsed.record as AutomationRun).definitionRevision).toBe(3);
    for (const domain of ['schedule', 'automation_run'] as const) {
      expect(MANAGED_SESSION_ENABLED_DOMAINS).not.toContain(domain);
      expect(() => assertManagedSessionDomainEnabled(domain)).toThrow(
        ManagedSessionRecordError,
      );
    }
  });

  it('pins the closed keys, fixed keys and policy vocabularies', () => {
    expect([...fixtures.keys.schedule].sort()).toEqual(
      [
        'catchUp',
        'catchUpLimit',
        'cron',
        'definitionDigest',
        'definitionRevision',
        'enabled',
        'goal',
        'kind',
        'overlap',
        'ownerScopeId',
        'promptRef',
        'run',
        'scheduleId',
        'sessionMode',
        'targetSessionId',
        'timezone',
      ].sort(),
    );
    expect([...fixtures.keys.automation_run].sort()).toEqual(
      [
        'automationRunId',
        'definitionRevision',
        'kind',
        'occurrenceKey',
        'run',
        'scheduleId',
        'sessionMode',
        'targetSessionId',
      ].sort(),
    );
    expect([...fixtures.fixedKeys.schedule].sort()).toEqual(
      ['kind', 'ownerScopeId', 'scheduleId'].sort(),
    );
    expect([...fixtures.fixedKeys.automation_run].sort()).toEqual(
      [
        'automationRunId',
        'definitionRevision',
        'kind',
        'occurrenceKey',
        'scheduleId',
        'sessionMode',
        'targetSessionId',
      ].sort(),
    );
    expect(fixtures.overlapPolicies).toEqual([...SCHEDULE_OVERLAP_POLICIES]);
    expect(fixtures.catchUpPolicies).toEqual([...SCHEDULE_CATCH_UP_POLICIES]);
    expect(fixtures.sessionModes).toEqual([...SCHEDULE_SESSION_MODES]);
  });

  it('anchors every fixture timezone in the host tz database', () => {
    const zones = Intl.supportedValuesOf('timeZone');
    for (const zone of fixtures.validatedTimezones) {
      expect(zones).toContain(zone);
    }
  });

  it.each(fixtures.cases)('$id', (fixture) => {
    const body = MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!;
    const record = merge(fixtures.templates[fixture.domain], fixture.patch);
    if (fixture.valid) {
      const parsed = body.parse(record);
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
