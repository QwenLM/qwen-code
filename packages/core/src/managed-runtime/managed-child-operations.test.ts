/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ManagedSessionRecordError } from './managed-session-records.js';
import {
  isChildRunStart,
  isChildRunSuccessor,
  parseChildRun,
  type ChildAgentRun,
  type ChildSessionRun,
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
  childContinuationBody,
  childDeliveryBody,
  childDispatchBody,
  childFailBody,
  childLaunchBody,
  childSettleCompletedBody,
  childStopRequestedBody,
  decodeChildLaunchEnvelope,
  decodeWorkflowLaunchEnvelope,
  encodeChildLaunchEnvelope,
  encodeWorkflowLaunchEnvelope,
  workflowLaunchBody,
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

function chain(
  ...steps: Array<(previous: ChildSessionRun) => ChildSessionRun>
) {
  const bodies: ChildSessionRun[] = [launch()];
  for (const step of steps) bodies.push(step(bodies[bodies.length - 1]!));
  return bodies;
}

function expectValidChain(bodies: readonly ChildSessionRun[]) {
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
      launchedInScope: 0,
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
          { launchedInScope: MANAGED_CHILD_LIMITS.maxLaunchesPerScope },
          'budget_exhausted',
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

    it('spends the launch budget on every launch, ended ones included', () => {
      expect(
        admitChildLaunch({
          ...base,
          launchedInScope: MANAGED_CHILD_LIMITS.maxLaunchesPerScope - 1,
        }),
      ).toEqual({ admitted: true });
      // A spent budget never recovers, so it wins over the concurrency
      // cap, which a later launch may find cleared.
      expect(
        admitChildLaunch({
          ...base,
          activeInScope: MANAGED_CHILD_LIMITS.maxActivePerScope,
          launchedInScope: MANAGED_CHILD_LIMITS.maxLaunchesPerScope,
        }),
      ).toEqual({ admitted: false, reason: 'budget_exhausted' });
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

    it('names the minted Session on never-started settlements', () => {
      const failed = childFailBody(launch(), {
        stopReason: 'creation_failed',
        reason: null,
        started: false,
        childSessionId: 'session-child',
      });
      expect(failed.childSessionId).toBe('session-child');
      expectValidChain([launch(), failed]);
      // A replay restating the same Session is the same revision, a
      // different one conflicts instead of renaming it.
      const restated = childFailBody(failed, {
        stopReason: 'creation_failed',
        reason: null,
        started: false,
        childSessionId: 'session-child',
      });
      expect(restated).toEqual(failed);
      expect(() =>
        childFailBody(failed, {
          stopReason: 'creation_failed',
          reason: null,
          started: false,
          childSessionId: 'session-other',
        }),
      ).toThrow(ManagedSessionRecordError);
      const cancelled = childCancelBody(launch(), {
        started: false,
        childSessionId: 'session-child',
      });
      expect(cancelled.childSessionId).toBe('session-child');
      expect(cancelled.stopReason).toBe('stop_requested');
      expectValidChain([launch(), cancelled]);
      expect(() =>
        childCancelBody(cancelled, {
          started: false,
          childSessionId: 'session-other',
        }),
      ).toThrow(ManagedSessionRecordError);
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

  describe('continueChildRun (H4d)', () => {
    it('opens a new run that keeps the predecessor identities', () => {
      const completed = chain(
        (previous) =>
          childDispatchBody(previous, {
            dispatchId: 'dispatch-1',
            runtime: BINDING,
          }),
        (previous) =>
          childAttachBody(previous, { childSessionId: 'session-child' }),
        (previous) =>
          childSettleCompletedBody(previous, {
            resultRef: RESULT,
            terminalReceiptRef: RECEIPT,
          }),
      ).at(-1)!;
      const next = ref('managed-input', 'input-2');
      const continuation = childContinuationBody(completed, {
        childRunId: 'run-2',
        completion: 'tool',
        inputRef: next,
        executionCallId: 'call-2',
      });
      expect(isChildRunStart(continuation)).toBe(true);
      expect(continuation).toEqual({
        ...launch(),
        childRunId: 'run-2',
        completion: 'tool',
        inputRef: next,
        predecessorChildRunId: 'run-1',
        run: { ...launch().run, executionCallId: 'call-2' },
      });
      expect(Object.isFrozen(continuation)).toBe(true);
      // The kind, depth and isolation follow the predecessor, never the
      // launch defaults.
      const nested = childContinuationBody(
        {
          ...completed,
          kind: 'workflow',
          depth: 2,
          workspaceMode: 'snapshot',
        },
        {
          childRunId: 'run-2',
          completion: 'sent',
          inputRef: next,
          executionCallId: 'call-2',
        },
      );
      expect(nested).toMatchObject({
        kind: 'workflow',
        depth: 2,
        workspaceMode: 'snapshot',
      });
    });
  });
});

describe('managed workflow child operations (#13803)', () => {
  const WORKFLOW_DEFINITION = {
    definitionId: 'workflow/audit',
    definitionRevision: 1,
    definitionDigest: 'a'.repeat(64),
  };
  const SCRIPT = 'return args.x + 1;';

  function workflowLaunch(): ChildSessionRun {
    return workflowLaunchBody({
      childRunId: 'run-1',
      ownerScopeId: 'scope-main',
      rootSessionId: '550e8400-e29b-41d4-a716-446655440000',
      completion: 'sent',
      inputRef: INPUT,
      workingDirectory: '.',
      executionCallId: 'call-1',
      definition: WORKFLOW_DEFINITION,
    });
  }

  function workflowChain(
    ...steps: Array<(previous: ChildSessionRun) => ChildSessionRun>
  ) {
    const bodies: ChildSessionRun[] = [workflowLaunch()];
    for (const step of steps) bodies.push(step(bodies[bodies.length - 1]!));
    return bodies;
  }

  describe('workflow launch envelope', () => {
    it('round-trips definition, script and args, with args null when absent', () => {
      const envelope = {
        definition: WORKFLOW_DEFINITION,
        script: SCRIPT,
        args: { x: 1 },
      };
      expect(
        decodeWorkflowLaunchEnvelope(encodeWorkflowLaunchEnvelope(envelope)),
      ).toEqual(envelope);
      expect(
        decodeWorkflowLaunchEnvelope(
          encodeWorkflowLaunchEnvelope({
            definition: WORKFLOW_DEFINITION,
            script: SCRIPT,
            args: undefined,
          }),
        ),
      ).toEqual({ ...envelope, args: null });
    });

    it('refuses an oversized envelope and non-serializable args', () => {
      expect(() =>
        encodeWorkflowLaunchEnvelope({
          definition: WORKFLOW_DEFINITION,
          script: 's'.repeat(MANAGED_CHILD_LIMITS.maxEnvelopeBytes),
          args: null,
        }),
      ).toThrow('byte_limit');
      expect(() =>
        encodeWorkflowLaunchEnvelope({
          definition: WORKFLOW_DEFINITION,
          script: SCRIPT,
          args: null,
        }),
      ).not.toThrow();
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      expect(() =>
        encodeWorkflowLaunchEnvelope({
          definition: WORKFLOW_DEFINITION,
          script: SCRIPT,
          args: cyclic,
        }),
      ).toThrow(ManagedSessionRecordError);
    });

    it('refuses malformed envelope bytes', () => {
      for (const [bytes, message] of [
        [Buffer.from('not json', 'utf8'), 'must be JSON'],
        [Buffer.from('[]', 'utf8'), 'must be a JSON object'],
        [Buffer.from('{"script":"s"}', 'utf8'), 'must have exactly'],
        [
          Buffer.from(
            JSON.stringify({ definition: WORKFLOW_DEFINITION, script: SCRIPT }),
            'utf8',
          ),
          'must have exactly',
        ],
        [
          Buffer.from(
            JSON.stringify({
              definition: {},
              script: SCRIPT,
              args: null,
            }),
            'utf8',
          ),
          'must have exactly the keys',
        ],
        [
          Buffer.from(
            JSON.stringify({
              definition: { ...WORKFLOW_DEFINITION, extra: true },
              script: SCRIPT,
              args: null,
            }),
            'utf8',
          ),
          'must have exactly the keys',
        ],
        [
          Buffer.from(
            JSON.stringify({
              definition: {
                ...WORKFLOW_DEFINITION,
                definitionDigest: 'F'.repeat(64),
              },
              script: SCRIPT,
              args: null,
            }),
            'utf8',
          ),
          'digest',
        ],
        [
          Buffer.from(
            JSON.stringify({
              definition: {
                ...WORKFLOW_DEFINITION,
                definitionRevision: 0,
              },
              script: SCRIPT,
              args: null,
            }),
            'utf8',
          ),
          'integer from 1 or more',
        ],
        [
          Buffer.from(
            JSON.stringify({
              definition: WORKFLOW_DEFINITION,
              script: '',
              args: null,
            }),
            'utf8',
          ),
          'must be non-empty text',
        ],
      ] as const) {
        expect(() => decodeWorkflowLaunchEnvelope(bytes)).toThrow(message);
      }
    });
  });

  describe('workflow run revision builders', () => {
    it('opens with the pin from revision 1, as the contract requires', () => {
      const launch = workflowLaunch();
      expect(launch.kind).toBe('workflow');
      expect(isChildRunStart(launch)).toBe(true);
      expect(launch.run.definition).toEqual(WORKFLOW_DEFINITION);
      expect(launch.depth).toBe(1);
      expect(launch.workspaceMode).toBe('shared');
      // H4c's parse rule: a first revision without the pin is refused.
      expect(() =>
        parseChildRun({
          ...launch,
          run: { ...launch.run, definition: null },
        }),
      ).toThrow('Workflow run must pin its workflow definition from launch.');
    });

    it('replays the full sent-arm pipeline over a workflow chain', () => {
      const bodies = workflowChain(
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
      if (settled.kind !== 'workflow') throw new Error('kind');
      expect(settled.stopReason).toBe('completed');
      expect(settled.run.delivery).toEqual({
        target: 'session',
        state: 'accepting',
      });
      const acceptance = childAcceptanceBody(bodies[3]!, {
        contentRef: RESULT,
        terminalReceiptRef: RECEIPT,
      });
      expect(isChildAcceptanceStart(acceptance)).toBe(true);
      expect(
        isChildAcceptanceSuccessor(
          acceptance,
          childAcceptanceConsumedBody(acceptance),
        ),
      ).toBe(true);
    });

    it('replays the cancel cascade and proven failures over a workflow chain', () => {
      expectValidChain(
        workflowChain(
          (p) =>
            childDispatchBody(p, {
              dispatchId: 'dispatch-1',
              runtime: BINDING,
            }),
          (p) => childStopRequestedBody(p),
          (p) => childCancelBody(p, { started: false }),
        ),
      );
      expectValidChain(
        workflowChain(
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
      const cancelled = parseChildRun(
        workflowChain(
          (p) => childStopRequestedBody(p),
          (p) => childCancelBody(p, { started: false }),
        ).at(-1)!,
      );
      if (cancelled.kind !== 'workflow') throw new Error('kind');
      expect(cancelled.stopReason).toBe('stop_requested');
      expect(cancelled.run.delivery).toEqual({
        target: 'session',
        state: 'cancelled',
      });
    });
  });
});
