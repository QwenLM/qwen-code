/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MANAGED_EXTENSION_RECORD_BODIES } from './managed-extension-projection.js';
import { parseSessionCommand } from './managed-session-command-record.js';
import {
  inboundCommandBody,
  outboundCommandBody,
  sessionCommandId,
} from './managed-session-command-operations.js';
import {
  MANAGED_SESSION_ENABLED_DOMAINS,
  assertManagedSessionDomainEnabled,
} from './managed-session-records.js';
import { sessionMessageId } from './managed-session-message-operations.js';

interface Fixture {
  id: string;
  domain: 'session_command';
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
      './contracts/managed-session-command-record-v1.fixtures.json',
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

describe('managed-session-command-record/1 shared contract', () => {
  it('projects no task and is enabled for submission (H4e-b3)', () => {
    const body = MANAGED_EXTENSION_RECORD_BODIES.session_command!;
    for (const template of ['outbound', 'inbound']) {
      expect(
        body.taskKindOf(parseSessionCommand(fixtures.templates[template])),
      ).toBeNull();
    }
    expect(MANAGED_SESSION_ENABLED_DOMAINS).toContain('session_command');
    expect(() =>
      assertManagedSessionDomainEnabled('session_command'),
    ).not.toThrow();
    expect(fixtures.contract).toBe('managed-session-command-record/1');
  });

  it('pins the closed keys and the fixed keys', () => {
    expect([...fixtures.keys].sort()).toEqual(
      [
        'argsDigest',
        'argsRef',
        'childRunId',
        'commandId',
        'direction',
        'kind',
        'replyDigest',
        'replyRef',
        'route',
        'run',
        'senderSessionId',
        'targetSessionId',
      ].sort(),
    );
    expect([...fixtures.fixedKeys].sort()).toEqual(
      [
        'argsDigest',
        'argsRef',
        'childRunId',
        'commandId',
        'direction',
        'kind',
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
      expect(parsed.recordId).toBe((record as { commandId: string }).commandId);
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

  it('commands never meet the message or task id namespaces', () => {
    const commandId = sessionCommandId({
      senderSessionId: 'session-member',
      promptKey: 'prompt-1',
      callId: 'call-1',
    });
    expect(commandId).toMatch(/^cmd_[0-9a-f]{32}$/);
    const messageId = sessionMessageId({
      senderSessionId: 'session-member',
      turnId: 'prompt-1',
      callId: 'call-1',
    });
    expect(messageId).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(commandId).not.toBe(messageId);
  });

  it('derives replay-stable ids and reports unfinished outbox entries', () => {
    const one = sessionCommandId({
      senderSessionId: 'session-member',
      promptKey: 'prompt-1',
      callId: 'call-1',
    });
    const two = sessionCommandId({
      senderSessionId: 'session-member',
      promptKey: 'prompt-1',
      callId: 'call-1',
    });
    expect(one).toBe(two);
    const outbound = parseSessionCommand(
      outboundCommandBody({
        commandId: one,
        kind: 'board_write',
        childRunId: 'run-1',
        senderSessionId: 'session-member',
        argsRef: {
          resourceId: 'args-1',
          kind: 'managed-command-args',
          schemaVersion: 1,
          byteLength: 2,
          digest:
            'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
        executionCallId: 'call-1',
      }),
    );
    expect(outbound.run.delivery?.state).toBe('planned');
    const inbound = parseSessionCommand(
      inboundCommandBody({
        commandId: one,
        kind: 'board_write',
        childRunId: 'run-1',
        senderSessionId: 'session-member',
        targetSessionId: 'session-lead',
        argsRef: {
          resourceId: 'args-copy-1',
          kind: 'managed-command-args',
          schemaVersion: 1,
          byteLength: 2,
          digest:
            'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
        replyRef: {
          resourceId: 'reply-1',
          kind: 'managed-command-reply',
          schemaVersion: 1,
          byteLength: 10,
          digest:
            'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        },
      }),
    );
    expect(inbound.run.delivery?.state).toBe('consumed');
  });
});
