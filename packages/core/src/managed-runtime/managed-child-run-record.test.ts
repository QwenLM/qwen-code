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
import {
  CHILD_AGENT_STOP_REASONS,
  CHILD_RUN_STOP_REASONS,
  parseChildRun,
  parseChildShellRun,
} from './managed-child-run-record.js';
import { MANAGED_SESSION_ENABLED_DOMAINS } from './managed-session-records.js';

interface Fixture {
  id: string;
  domain: 'child_run';
  /** The fixture template the case merges onto; the domain's own by default. */
  template?: string;
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
  childAgentKeys: readonly string[];
  childAgentFixedKeys: readonly string[];
  childAgentStopReasons: Record<string, readonly string[]>;
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
function templateOf(fixture: {
  id: string;
  domain: string;
  template?: string;
}) {
  const name = fixture.template ?? fixture.domain;
  const template = fixtures.templates[name];
  if (template === undefined) {
    throw new Error(`fixture ${fixture.id} names an unknown template`);
  }
  return template;
}

describe('managed-child-run-record/1 shared contract', () => {
  it('projects per-kind tasks and stays disabled for submission', () => {
    // The body lands before its producers: enabling the domain is the
    // enablement slice's own explicit step.
    const body = MANAGED_EXTENSION_RECORD_BODIES.child_run!;
    expect(
      body.taskKindOf(parseChildRun(fixtures.templates['child_run'])),
    ).toBe('background_shell');
    expect(
      body.taskKindOf(parseChildRun(fixtures.templates['child_agent'])),
    ).toBe('child_agent');
    expect(MANAGED_TASK_KINDS).toContain('background_shell');
    expect(MANAGED_TASK_KINDS).toContain('child_agent');
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
    expect(fixtures.childAgentKeys).toEqual(
      [
        'childRunId',
        'childSessionId',
        'completion',
        'depth',
        'inputRef',
        'kind',
        'ownerScopeId',
        'predecessorChildRunId',
        'resultRef',
        'resultVersion',
        'rootSessionId',
        'run',
        'stopReason',
        'stopRequested',
        'terminalReceiptRef',
        'workspaceMode',
        'workingDirectory',
      ].sort(),
    );
    expect(fixtures.childAgentFixedKeys).toEqual(
      [
        'childRunId',
        'completion',
        'depth',
        'inputRef',
        'kind',
        'ownerScopeId',
        'predecessorChildRunId',
        'rootSessionId',
        'workspaceMode',
        'workingDirectory',
      ].sort(),
    );
    expect(fixtures.childAgentStopReasons).toEqual({
      settled: [...CHILD_AGENT_STOP_REASONS.settled],
      failed: [...CHILD_AGENT_STOP_REASONS.failed],
      cancelled: [...CHILD_AGENT_STOP_REASONS.cancelled],
    });
  });

  it.each(fixtures.cases)('$id', (fixture) => {
    const body = MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!;
    const record = merge(templateOf(fixture), fixture.patch);
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
    const template = templateOf(fixture);
    expect(
      MANAGED_EXTENSION_RECORD_BODIES[fixture.domain]!.isSuccessor(
        merge(template, fixture.before),
        merge(template, fixture.after),
      ),
    ).toBe(fixture.valid);
  });

  it('refuses a child_agent body at the shell-only entry point', () => {
    expect(() => parseChildShellRun(fixtures.templates['child_agent'])).toThrow(
      "Child run kind must be 'shell' for this consumer, got child_agent.",
    );
    expect(parseChildShellRun(fixtures.templates['child_run']).kind).toBe(
      'shell',
    );
  });
});
