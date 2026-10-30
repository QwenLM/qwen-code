/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANAGED_EXTENSION_RECORD_BODIES } from './managed-extension-projection.js';
import {
  MANAGED_TEAM_LEADER,
  MANAGED_TEAM_LIMITS,
} from './managed-team-record.js';
import {
  MANAGED_SESSION_ENABLED_DOMAINS,
  assertManagedSessionDomainEnabled,
} from './managed-session-records.js';

type TeamDomain = 'team_state' | 'team_task' | 'team_message' | 'team_plan';

interface Fixture {
  id: string;
  domain: TeamDomain;
  template: string;
  patch: Record<string, unknown>;
  valid: boolean;
  start: boolean;
  /** The clause substring both validators must report on an invalid case. */
  error?: string;
}
const fixtures = JSON.parse(
  readFileSync(
    new URL(
      './contracts/managed-team-record-v1.fixtures.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  contract: string;
  domains: Record<TeamDomain, { taskKind: null }>;
  leader: string;
  limits: Record<string, number>;
  keys: Record<TeamDomain, readonly string[]>;
  fixedKeys: Record<TeamDomain, readonly string[]>;
  templates: Record<string, Record<string, unknown>>;
  cases: Fixture[];
  successors: Array<
    Omit<Fixture, 'patch' | 'start'> & {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  >;
};

const RECORD_ID: Record<TeamDomain, string> = {
  team_state: 'teamId',
  team_task: 'taskId',
  team_message: 'messageId',
  team_plan: 'requestId',
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

function frozenDeep(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(frozenDeep);
}

describe('managed-team-record/1 shared contract', () => {
  it('projects no task, and enables only the lead-side domains', () => {
    expect(fixtures.contract).toBe('managed-team-record/1');
    expect(fixtures.leader).toBe(MANAGED_TEAM_LEADER);
    expect(fixtures.limits).toEqual({ ...MANAGED_TEAM_LIMITS });
    for (const domain of Object.keys(fixtures.domains) as TeamDomain[]) {
      const body = MANAGED_EXTENSION_RECORD_BODIES[domain]!;
      for (const template of Object.keys(fixtures.templates).filter((name) =>
        name.startsWith(domain),
      )) {
        expect(
          body.taskKindOf(body.parse(fixtures.templates[template]).record),
        ).toBeNull();
      }
      // H4e-b1 enabled the roster and the board after its physical pass;
      // the mailbox and plans wait on H4e-b2 and H4e-b3.
      if (domain === 'team_state' || domain === 'team_task') {
        expect(MANAGED_SESSION_ENABLED_DOMAINS).toContain(domain);
        expect(() => assertManagedSessionDomainEnabled(domain)).not.toThrow();
      } else {
        expect(MANAGED_SESSION_ENABLED_DOMAINS).not.toContain(domain);
        expect(() => assertManagedSessionDomainEnabled(domain)).toThrow(
          `domain ${domain} is registered but not enabled for submission.`,
        );
      }
    }
  });

  it('pins the closed keys and the fixed keys', () => {
    expect(fixtures.keys).toEqual({
      team_state: [
        'leadSessionId',
        'lifecycle',
        'members',
        'membershipRevision',
        'name',
        'run',
        'teamId',
      ],
      team_task: [
        'activeForm',
        'blockedBy',
        'descriptionRef',
        'metadataRef',
        'number',
        'owner',
        'run',
        'status',
        'subject',
        'taskId',
        'teamId',
      ],
      team_message: [
        'contentDigest',
        'contentRef',
        'from',
        'inputId',
        'kind',
        'messageId',
        'run',
        'targetSessionId',
        'teamId',
        'to',
      ],
      team_plan: [
        'decision',
        'feedbackRef',
        'member',
        'planRef',
        'planRevision',
        'requestId',
        'run',
        'teamId',
      ],
    });
    expect(fixtures.fixedKeys).toEqual({
      team_state: ['leadSessionId', 'name', 'teamId'],
      team_task: ['number', 'taskId', 'teamId'],
      team_message: [
        'contentDigest',
        'contentRef',
        'from',
        'kind',
        'messageId',
        'teamId',
        'to',
      ],
      team_plan: ['member', 'planRef', 'planRevision', 'requestId', 'teamId'],
    });
    for (const [name, template] of Object.entries(fixtures.templates)) {
      const domain = (Object.keys(fixtures.keys) as TeamDomain[]).find((each) =>
        name.startsWith(each),
      )!;
      expect(Object.keys(template).sort()).toEqual([...fixtures.keys[domain]]);
    }
  });

  it.each(fixtures.cases)('$id', (fixture) => {
    const body = MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!;
    const record = merge(templateOf(fixture), fixture.patch);
    if (fixture.valid) {
      const parsed = body.parse(record);
      expect(parsed.record).toEqual(record);
      expect(parsed.recordId).toBe(record[RECORD_ID[fixture.domain]]);
      expect(frozenDeep(parsed.record)).toBe(true);
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
