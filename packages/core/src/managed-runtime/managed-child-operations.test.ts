/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isChildRunStart,
  isChildRunSuccessor,
  parseChildRun,
  type ChildAgentRun,
} from './managed-child-run-record.js';
import {
  isChildAcceptanceStart,
  isChildAcceptanceSuccessor,
  parseChildAcceptance,
} from './managed-child-acceptance-record.js';
import {
  MANAGED_CHILD_LIMITS,
  admitChildLaunch,
  childAcceptanceBody,
  childAcceptanceConsumedBody,
  childAttachBody,
  childCancelBody,
  childDeliveryBody,
  childDispatchBody,
  childFailBody,
  childLaunchBody,
  childSettleCompletedBody,
  childStopRequestedBody,
  decodeChildLaunchEnvelope,
  encodeChildLaunchEnvelope,
} from './managed-child-operations.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const DEFINITION = {
  definitionId: 'agent-main',
  definitionRevision: 3,
  definitionDigest: 'f'.repeat(64),
};

function ref(kind: string, id: string): ManagedSessionDurableRef {
  return Object.freeze({
    resourceId: id,
    kind,
    schemaVersion: 1,
    byteLength: 2,
    digest: 'c'.repeat(64),
  });
}

const INPUT = ref('managed-input', 'input-1');
const RESULT = ref('managed-child-result', 'result-1');
const RECEIPT = ref('managed-runtime-receipt', 'receipt-1');
const BINDING = { runtimeBindingId: 'binding-1', generation: '1' };

function launch(): ChildAgentRun {
  return childLaunchBody({
    childRunId: 'run-1',
    ownerScopeId: 'scope-main',
    rootSessionId: '550e8400-e29b-41d4-a716-446655440000',
    completion: 'sent',
    inputRef: INPUT,
    workingDirectory: '.',
    executionCallId: 'call-1',
    definition: DEFINITION,
  });
}

function chain(...steps: Array<(previous: ChildAgentRun) => ChildAgentRun>) {
  const bodies: ChildAgentRun[] = [launch()];
  for (const step of steps) bodies.push(step(bodies[bodies.length - 1]!));
  return bodies;
}

function expectValidChain(bodies: readonly ChildAgentRun[]) {
  expect(isChildRunStart(bodies[0])).toBe(true);
  for (const body of bodies) expect(parseChildRun(body)).toBeDefined();
  for (let index = 1; index < bodies.length; index++) {
    expect(
      isChildRunSuccessor(bodies[index - 1], bodies[index]),
      `revision ${index + 1} must follow`,
    ).toBe(true);
  }
}

describe('managed child operations (H4b)', () => {
  describe('launch envelope', () => {
    it('round-trips the bounded envelope', () => {
      const envelope = {
        description: 'audit the diff',
        prompt: 'review the change',
        definition: DEFINITION,
      };
      expect(
        decodeChildLaunchEnvelope(encodeChildLaunchEnvelope(envelope)),
      ).toEqual(envelope);
    });

    it('refuses an oversized description and envelope', () => {
      expect(() =>
        encodeChildLaunchEnvelope({
          description: 'd'.repeat(MANAGED_CHILD_LIMITS.maxDescriptionBytes + 1),
          prompt: 'p',
          definition: DEFINITION,
        }),
      ).toThrow('byte_limit');
      // The at-limit description encodes without a throw — a bound that
      // only rejects would leave the lawful window untested.
      expect(() =>
        encodeChildLaunchEnvelope({
          description: 'd'.repeat(MANAGED_CHILD_LIMITS.maxDescriptionBytes),
          prompt: 'p',
          definition: DEFINITION,
        }),
      ).not.toThrow();
      expect(() =>
        encodeChildLaunchEnvelope({
          description: 'd',
          prompt: 'p'.repeat(MANAGED_CHILD_LIMITS.maxEnvelopeBytes),
          definition: DEFINITION,
        }),
      ).toThrow('byte_limit');
    });

    it('refuses malformed envelope bytes', () => {
      for (const bytes of [
        Buffer.from('not json', 'utf8'),
        Buffer.from('[]', 'utf8'),
        Buffer.from('{"description":"d"}', 'utf8'),
        Buffer.from(
          JSON.stringify({
            description: 1,
            prompt: 'p',
            definition: DEFINITION,
          }),
          'utf8',
        ),
        Buffer.from(
          JSON.stringify({ description: 'd', prompt: 'p', definition: {} }),
          'utf8',
        ),
      ]) {
        expect(() => decodeChildLaunchEnvelope(bytes)).toThrow('Child launch');
      }
    });
  });

  describe('launch admission', () => {
    const base: Parameters<typeof admitChildLaunch>[0] = {
      closing: false,
      depth: 1,
      activeInScope: 0,
      envelopeBytes: 100,
      workspaceMode: 'shared',
      sameDefinition: true,
    };

    it('admits the default launch', () => {
      expect(admitChildLaunch(base)).toEqual({ admitted: true });
    });

    it('refuses each violation with its own reason', () => {
      const cases: Array<[Partial<typeof base>, string]> = [
        [{ closing: true }, 'closing'],
        [{ workspaceMode: 'snapshot' }, 'workspace_mode'],
        [{ workspaceMode: 'worktree' }, 'workspace_mode'],
        [{ sameDefinition: false }, 'definition_scope'],
        [{ depth: 2 }, 'depth_limit'],
        [
          { activeInScope: MANAGED_CHILD_LIMITS.maxActivePerScope },
          'count_limit',
        ],
        [
          { envelopeBytes: MANAGED_CHILD_LIMITS.maxEnvelopeBytes + 1 },
          'byte_limit',
        ],
      ];
      for (const [patch, reason] of cases) {
        expect(admitChildLaunch({ ...base, ...patch })).toEqual({
          admitted: false,
          reason,
        });
      }
    });
  });

  describe('run revision builders', () => {
    it('builds the full sent-arm pipeline as a valid chain', () => {
      const bodies = chain(
        (p) =>
          childDispatchBody(p, { dispatchId: 'dispatch-1', runtime: BINDING }),
        (p) => childAttachBody(p, { childSessionId: 'session-child' }),
        (p) =>
          childSettleCompletedBody(p, {
            resultRef: RESULT,
            terminalReceiptRef: RECEIPT,
          }),
        (p) => childDeliveryBody(p, 'accepted'),
        (p) => childDeliveryBody(p, 'consumed'),
      );
      expectValidChain(bodies);
      const settled = parseChildRun(bodies[3]!);
      if (settled.kind !== 'child_agent') throw new Error('kind');
      expect(settled.stopReason).toBe('completed');
      expect(settled.run.delivery).toEqual({
        target: 'session',
        state: 'accepting',
      });
    });

    it('builds the cancel cascade as a valid chain', () => {
      const bodies = chain(
        (p) =>
          childDispatchBody(p, { dispatchId: 'dispatch-1', runtime: BINDING }),
        (p) => childStopRequestedBody(p),
        (p) => childCancelBody(p, { started: false }),
      );
      expectValidChain(bodies);
      const cancelled = parseChildRun(bodies[3]!);
      if (cancelled.kind !== 'child_agent') throw new Error('kind');
      expect(cancelled.stopReason).toBe('stop_requested');
      expect(cancelled.run.execution).toBe('not_started_proven');
      expect(cancelled.run.delivery).toEqual({
        target: 'session',
        state: 'cancelled',
      });
    });

    it('builds a post-attach cancel and proven failures', () => {
      expectValidChain(
        chain(
          (p) =>
            childDispatchBody(p, {
              dispatchId: 'dispatch-1',
              runtime: BINDING,
            }),
          (p) => childAttachBody(p, { childSessionId: 'session-child' }),
          (p) => childStopRequestedBody(p),
          (p) => childCancelBody(p, { started: true }),
        ),
      );
      expectValidChain([
        launch(),
        childFailBody(launch(), {
          stopReason: 'creation_failed',
          reason: null,
          started: false,
        }),
      ]);
      expectValidChain([
        launch(),
        childFailBody(launch(), {
          stopReason: 'quota_exceeded',
          reason: 'count_limit',
          started: false,
        }),
      ]);
      expectValidChain(
        chain(
          (p) =>
            childDispatchBody(p, {
              dispatchId: 'dispatch-1',
              runtime: BINDING,
            }),
          (p) => childAttachBody(p, { childSessionId: 'session-child' }),
          (p) =>
            childFailBody(p, {
              stopReason: 'child_failed',
              reason: null,
              started: true,
            }),
        ),
      );
    });

    it('allows the pre-acceptance unknown delivery step', () => {
      const bodies = chain(
        (p) =>
          childDispatchBody(p, { dispatchId: 'dispatch-1', runtime: BINDING }),
        (p) => childAttachBody(p, { childSessionId: 'session-child' }),
        (p) =>
          childSettleCompletedBody(p, {
            resultRef: RESULT,
            terminalReceiptRef: RECEIPT,
          }),
        (p) => childDeliveryBody(p, 'unknown'),
      );
      expectValidChain(bodies);
    });
  });

  describe('acceptance builders', () => {
    it('builds the settled acceptance and its only successor', () => {
      const settled = chain(
        (p) =>
          childDispatchBody(p, { dispatchId: 'dispatch-1', runtime: BINDING }),
        (p) => childAttachBody(p, { childSessionId: 'session-child' }),
        (p) =>
          childSettleCompletedBody(p, {
            resultRef: RESULT,
            terminalReceiptRef: RECEIPT,
          }),
      );
      const child = settled[settled.length - 1]!;
      const accepted = childAcceptanceBody(child, {
        contentRef: RESULT,
        terminalReceiptRef: RECEIPT,
      });
      expect(parseChildAcceptance(accepted)).toBeDefined();
      expect(isChildAcceptanceStart(accepted)).toBe(true);
      expect(accepted.parentExecutionCallId).toBeNull();
      const consumed = childAcceptanceConsumedBody(accepted);
      expect(isChildAcceptanceSuccessor(accepted, consumed)).toBe(true);
      expect(parseChildAcceptance(consumed).run.delivery).toEqual({
        target: 'session',
        state: 'consumed',
      });
    });

    it('attaches the original call on a tool-completion acceptance', () => {
      const launched = childLaunchBody({
        childRunId: 'run-1',
        ownerScopeId: 'scope-main',
        rootSessionId: '550e8400-e29b-41d4-a716-446655440000',
        completion: 'tool',
        inputRef: INPUT,
        workingDirectory: '.',
        executionCallId: 'call-1',
        definition: DEFINITION,
      });
      const accepting = childAcceptanceBody(launched, {
        contentRef: RESULT,
        terminalReceiptRef: RECEIPT,
      });
      expect(accepting.parentExecutionCallId).toBe('call-1');
    });
  });
});
