/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_RUN_INSTRUCTION,
  MANAGED_AUTOMATION_LIMITS,
  assertAutomationDefinition,
  automationDefinitionDigest,
  automationInputBudgetBytes,
  automationInputId,
  automationRunClaimBody,
  automationRunDispatchBody,
  automationRunId,
  automationRunIdOfInput,
  automationRunSettleBody,
  automationTurnText,
  decodeAutomationInputEnvelope,
  encodeAutomationInputEnvelope,
  manualOccurrenceKey,
  scheduleOpenBody,
  scheduleRetireBody,
  scheduleRevisionBody,
  type AutomationDefinition,
} from './managed-automation-operations.js';
import {
  isAutomationRunStart,
  isAutomationRunSuccessor,
  isScheduleStart,
  isScheduleSuccessor,
  parseAutomationRunRecord,
  parseScheduleRecord,
} from './managed-automation-record.js';
import { ManagedSessionRecordError } from './managed-session-records.js';

const promptRef = Object.freeze({
  resourceId: 'prompt-1',
  kind: 'managed-automation-prompt',
  schemaVersion: 1,
  byteLength: 13,
  digest: 'a'.repeat(64),
});

const definition: AutomationDefinition = Object.freeze({
  goal: 'Nightly build',
  cron: '0 2 * * *',
  timezone: 'Asia/Shanghai',
  prompt: 'Run the build.',
  sessionMode: 'persistent',
  overlap: 'skip',
  catchUp: 'none',
  catchUpLimit: null,
  enabled: true,
});

const sessionId = '550e8400-e29b-41d4-a716-446655440000';

function open() {
  return scheduleOpenBody({
    scheduleId: 'asch_1',
    ownerScopeId: sessionId,
    targetSessionId: sessionId,
    definition,
    promptRef,
    definitionDigest: automationDefinitionDigest(definition),
  });
}

describe('automation identities', () => {
  it('derives one run id per definition and occurrence in both languages', () => {
    const expected = `arun_${createHash('sha256')
      .update('asch_1\u0000schedule:2026-03-08T07:00:00Z', 'utf8')
      .digest('hex')}`;
    expect(automationRunId('asch_1', 'schedule:2026-03-08T07:00:00Z')).toBe(
      expected,
    );
    expect(automationRunId('asch_1', 'manual:key-1')).not.toBe(expected);
    expect(() => automationRunId('asch_1', '')).toThrow(/non-empty/);
    expect(() => automationRunId('a\u0000b', 'manual:key-1')).toThrow(/no NUL/);
  });

  it('names the input of a run and reads it back', () => {
    const runId = automationRunId('asch_1', 'manual:key-1');
    expect(automationInputId(runId)).toBe(`${runId}:input`);
    expect(automationRunIdOfInput(`${runId}:input`)).toBe(runId);
    expect(automationRunIdOfInput('mon-1:notify:3')).toBeUndefined();
    expect(automationRunIdOfInput(runId)).toBeUndefined();
  });

  it('keys a manual run by its command', () => {
    expect(manualOccurrenceKey('key-1')).toBe('manual:key-1');
    expect(() => manualOccurrenceKey('')).toThrow(/non-empty/);
  });
});

describe('automation definitions', () => {
  it('admits a request with the contract defaults', () => {
    const parsed = assertAutomationDefinition({
      goal: 'Nightly build',
      cron: '0 2 * * *',
      timezone: 'Asia/Shanghai',
      prompt: 'Run the build.',
    });
    expect(parsed).toEqual(definition);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('refuses what the H6a contract refuses, and its own prompt bound', () => {
    const base = {
      goal: 'g',
      cron: '0 2 * * *',
      timezone: 'UTC',
      prompt: 'p',
    };
    for (const [patch, message] of [
      [{ cron: '0 24 * * *' }, /cron hour field values/],
      [{ timezone: 'Mars/Olympus Mons' }, /timezone/],
      [{ goal: '' }, /goal/],
      [{ goal: 'x'.repeat(4097) }, /goal exceeds 4096 UTF-8 bytes/],
      [{ catchUp: 'bounded' }, /catchUpLimit/],
      [{ catchUp: 'none', catchUpLimit: 2 }, /catchUpLimit/],
      [{ overlap: 'always' }, /overlap/],
      [{ sessionMode: 'fresh' }, /sessionMode/],
      [{ enabled: 'yes' }, /enabled/],
      [{ prompt: '' }, /prompt/],
      [{ prompt: 'x'.repeat(64 * 1024 + 1) }, /prompt exceeds/],
      [{ extra: 1 }, /unknown field/],
    ] as const) {
      expect(() => assertAutomationDefinition({ ...base, ...patch })).toThrow(
        message,
      );
    }
    expect(() => assertAutomationDefinition(null)).toThrow(
      ManagedSessionRecordError,
    );
  });

  it('fills a revision from the previous definition', () => {
    const revised = assertAutomationDefinition(
      { cron: '30 2 * * *' },
      definition,
    );
    expect(revised).toEqual({ ...definition, cron: '30 2 * * *' });
  });

  it('digests the content in a fixed order, prompt by bytes', () => {
    const digest = automationDefinitionDigest(definition);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(automationDefinitionDigest({ ...definition })).toBe(digest);
    expect(
      automationDefinitionDigest({ ...definition, prompt: 'Run the build!' }),
    ).not.toBe(digest);
    expect(
      automationDefinitionDigest({ ...definition, enabled: false }),
    ).not.toBe(digest);
  });

  it('applies the final-input budget, not just the raw prompt bound', () => {
    const base = { goal: 'g', cron: '0 2 * * *', timezone: 'UTC' };
    // A 64 KiB raw prompt passes the byte bound, but once wrapped with
    // the run framing and JSON-escaped it cannot be published: admission
    // refuses it instead of committing a definition whose fire strands.
    expect(() =>
      assertAutomationDefinition({ ...base, prompt: 'x'.repeat(64 * 1024) }),
    ).toThrow(/final execution input would exceed/);
    expect(() =>
      assertAutomationDefinition({ ...base, prompt: '\n'.repeat(33_792) }),
    ).toThrow(/final execution input would exceed/);
    expect(
      assertAutomationDefinition({ ...base, prompt: 'x'.repeat(48 * 1024) })
        .prompt,
    ).toHaveLength(48 * 1024);
  });

  it('sizes the budget no smaller than any envelope a fire can build', () => {
    const scheduleId = 'asch_0123456789abcdef0123456789abcdef';
    const occurrenceKey = 'schedule:2026-03-08T07:00:00Z';
    const firedAt = Date.parse('2026-03-08T07:00:05Z');
    const actual = encodeAutomationInputEnvelope({
      automationRunId: automationRunId(scheduleId, occurrenceKey),
      scheduleId,
      definitionRevision: 1,
      occurrenceKey,
      trigger: 'scheduled',
      firedAt,
      text: automationTurnText({
        schedule: {
          scheduleId,
          goal: definition.goal,
          cron: definition.cron,
          timezone: definition.timezone,
        },
        occurrenceKey,
        trigger: 'scheduled',
        firedAt,
        prompt: definition.prompt,
      }),
    }).byteLength;
    const budget = automationInputBudgetBytes(definition);
    expect(actual).toBeLessThanOrEqual(budget);
    expect(budget).toBeLessThan(MANAGED_AUTOMATION_LIMITS.maxInputBytes);
    expect(
      automationInputBudgetBytes({
        ...definition,
        prompt: `${definition.prompt}x`,
      }),
    ).toBeGreaterThan(budget);
  });
});

describe('schedule bodies', () => {
  it('opens a definition the contract accepts and the start rule admits', () => {
    const body = open();
    expect(parseScheduleRecord(body)).toEqual(body);
    expect(isScheduleStart(body)).toBe(true);
    expect(body.definitionRevision).toBe(1);
    expect(body.targetSessionId).toBe(sessionId);
    expect(body.run.state).toBe('admitted');
  });

  it('revises append-only and keeps the run where it is', () => {
    const first = open();
    const second = scheduleRevisionBody(first, {
      definition: { ...definition, enabled: false },
      promptRef,
      definitionDigest: automationDefinitionDigest({
        ...definition,
        enabled: false,
      }),
    });
    expect(second.definitionRevision).toBe(2);
    expect(second.enabled).toBe(false);
    expect(isScheduleSuccessor(first, second)).toBe(true);
    expect(isScheduleSuccessor(second, first)).toBe(false);
    expect(() =>
      scheduleRevisionBody(first, {
        definition: { ...definition, sessionMode: 'per_run' },
        promptRef,
        definitionDigest: 'b'.repeat(64),
      }),
    ).toThrow(/cannot change its target mode/);
  });

  it('retires into a frozen terminal revision', () => {
    const first = open();
    const retired = scheduleRetireBody(first);
    expect(retired.run.state).toBe('cancelled');
    expect(retired.enabled).toBe(false);
    expect(retired.definitionRevision).toBe(2);
    expect(isScheduleSuccessor(first, retired)).toBe(true);
    expect(
      isScheduleSuccessor(
        retired,
        scheduleRevisionBody(retired, {
          definition,
          promptRef,
          definitionDigest: 'c'.repeat(64),
        }),
      ),
    ).toBe(false);
  });
});

describe('automation run bodies', () => {
  const schedule = open();
  const occurrenceKey = 'schedule:2026-03-08T07:00:00Z';

  it('claims with the derived id, a named dispatch and nothing dispatched', () => {
    const claim = automationRunClaimBody({ schedule, occurrenceKey });
    expect(claim.automationRunId).toBe(
      automationRunId('asch_1', occurrenceKey),
    );
    expect(claim.definitionRevision).toBe(schedule.definitionRevision);
    expect(claim.targetSessionId).toBe(sessionId);
    expect(claim.run.dispatchId).toBe(claim.automationRunId);
    expect(claim.run.effectId).toBe(automationInputId(claim.automationRunId));
    expect(claim.run.execution).toBe('intent');
    expect(isAutomationRunStart(claim)).toBe(true);
    expect(parseAutomationRunRecord(claim)).toEqual(claim);
    expect(() =>
      automationRunClaimBody({ schedule, occurrenceKey: 'webhook:e-1' }),
    ).toThrow(/reserved/);
  });

  it('dispatches and settles one allowed step at a time', () => {
    const claim = automationRunClaimBody({ schedule, occurrenceKey });
    const dispatched = automationRunDispatchBody(claim);
    expect(dispatched.run.state).toBe('running');
    expect(dispatched.run.execution).toBe('dispatch_started');
    expect(isAutomationRunSuccessor(claim, dispatched)).toBe(true);
    for (const outcome of ['settled', 'failed', 'cancelled'] as const) {
      const ended = automationRunSettleBody(dispatched, outcome, true);
      expect(ended.run.state).toBe(outcome);
      expect(ended.run.execution).toBe('settled');
      expect(isAutomationRunSuccessor(dispatched, ended)).toBe(true);
      expect(isAutomationRunSuccessor(ended, dispatched)).toBe(false);
    }
    const neverRan = automationRunSettleBody(dispatched, 'cancelled', false);
    expect(neverRan.run.execution).toBe('not_started_proven');
    expect(isAutomationRunSuccessor(dispatched, neverRan)).toBe(true);
    expect(() => automationRunSettleBody(dispatched, 'settled', false)).toThrow(
      /never started/,
    );
    // Settling straight from the claim skips the dispatch step.
    expect(
      isAutomationRunSuccessor(
        claim,
        automationRunSettleBody(claim, 'settled', true),
      ),
    ).toBe(false);
  });
});

describe('automation input envelope and turn text', () => {
  it('round-trips the envelope and refuses a broken one', () => {
    const envelope = {
      automationRunId: automationRunId('asch_1', 'manual:key-1'),
      scheduleId: 'asch_1',
      definitionRevision: 1,
      occurrenceKey: 'manual:key-1',
      trigger: 'manual' as const,
      firedAt: 1_700_000_000_000,
      text: 'Run it.',
    };
    expect(
      decodeAutomationInputEnvelope(encodeAutomationInputEnvelope(envelope)),
    ).toEqual(envelope);
    expect(() =>
      decodeAutomationInputEnvelope(Buffer.from('{"text":""}')),
    ).toThrow(/automationRunId/);
    expect(() =>
      decodeAutomationInputEnvelope(
        Buffer.from(JSON.stringify({ ...envelope, trigger: 'webhook' })),
      ),
    ).toThrow(/trigger/);
    expect(() => decodeAutomationInputEnvelope(Buffer.from('nope'))).toThrow(
      /JSON/,
    );
  });

  it('frames the prompt like a Legacy scheduled run', () => {
    const text = automationTurnText({
      schedule: {
        scheduleId: 'asch_1',
        goal: 'Nightly\u001b[31m build ‎',
        cron: '0 2 * * *',
        timezone: 'Asia/Shanghai',
      },
      occurrenceKey: 'schedule:2026-03-08T07:00:00Z',
      trigger: 'catch_up',
      firedAt: Date.parse('2026-03-08T07:00:05Z'),
      prompt: 'Run the build.\nThen report.',
    });
    expect(text.split('\n')).toEqual([
      'Scheduled automation: Nightly build',
      'Automation ID: asch_1',
      'Schedule: 0 2 * * * (Asia/Shanghai)',
      'Occurrence: schedule:2026-03-08T07:00:00Z',
      'Triggered at: 2026-03-08T07:00:05.000Z',
      'Trigger: catch_up',
      '',
      AUTOMATION_RUN_INSTRUCTION,
      '',
      'Run the build.',
      'Then report.',
    ]);
  });
});
