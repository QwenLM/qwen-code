/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import './hosted-harness-session.test-helper.js';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedSessionEvent } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { ManagedSessionRecordError } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import {
  attributeShellReceipts,
  settleCancelledHookTurn,
  wakeDispatchOwnsInput,
} from './hosted-harness-session.js';
import type { PendingSessionInput } from './hosted-wake-intake.js';
import { hostedHookOccurrenceId } from './hosted-hook-session.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import { AUTOMATION_INPUT_SOURCE } from '@qwen-code/qwen-code-core/managed-runtime/managed-automation-operations.js';
import { SESSION_MESSAGE_INPUT_SOURCE } from './hosted-session-message-session.js';

describe('attributeShellReceipts', () => {
  const input = (turnId: string, source = 'hosted-harness') =>
    ({
      kind: 'input.accepted',
      payload: { turnId, source },
    }) as unknown as ManagedSessionEvent;
  const receipt = () =>
    ({
      kind: 'tool.receipt',
      payload: { executionCallId: 'call' },
    }) as unknown as ManagedSessionEvent;

  it('attributes a receipt behind a queued monitor notification to the foreground prompt', () => {
    const { promptId, receipts } = attributeShellReceipts([
      input('prompt'),
      input('monitor:1:notify:1', 'monitor'),
      receipt(),
    ]);
    expect(promptId).toBe('prompt');
    expect(receipts.map((item) => item.promptId)).toEqual(['prompt']);
  });

  it('attributes a receipt behind a queued automation input to the foreground prompt', () => {
    // H6: an automation input is never a parked Turn either, so a receipt
    // behind its queued input still belongs to the occupied prompt.
    const { promptId, receipts } = attributeShellReceipts([
      input('prompt'),
      input('arun_1:input', AUTOMATION_INPUT_SOURCE),
      receipt(),
    ]);
    expect(promptId).toBe('prompt');
    expect(receipts.map((item) => item.promptId)).toEqual(['prompt']);
  });

  it('attributes a receipt behind a settled turn to no prompt at all', () => {
    const { promptId, receipts } = attributeShellReceipts([
      input('prompt'),
      receipt(),
      {
        kind: 'turn.settled',
        payload: { turnId: 'prompt' },
      } as unknown as ManagedSessionEvent,
      receipt(),
    ]);
    expect(promptId).toBeNull();
    expect(receipts.map((item) => item.promptId)).toEqual(['prompt']);
  });
});

describe('wakeDispatchOwnsInput', () => {
  const NOW = 1_000_000;
  const input = (
    overrides: Partial<PendingSessionInput> = {},
  ): PendingSessionInput => ({
    inputId: 'loop:wakeup',
    turnId: 'loop:wakeup',
    source: 'loop',
    sequence: 1,
    contentRef: undefined,
    notBefore: NOW + 1,
    ...overrides,
  });

  it('owns a deferred, unattempted wake input', () => {
    expect(
      wakeDispatchOwnsInput(
        {},
        input(),
        [{ daemonPromptId: 'another-turn' }],
        NOW,
      ),
    ).toBe(true);
  });

  it.each<
    [
      string,
      { messagesStopped?: boolean },
      PendingSessionInput,
      Array<{ daemonPromptId?: string }>,
    ]
  >([
    ['a non-wake input', {}, input({ source: 'hosted-harness' }), []],
    [
      "a stopped run's message",
      { messagesStopped: true },
      input({ source: SESSION_MESSAGE_INPUT_SOURCE }),
      [],
    ],
    ['an immediate input', {}, input({ notBefore: null }), []],
    ['an input due now', {}, input({ notBefore: NOW }), []],
    ['an attempted input', {}, input(), [{ daemonPromptId: 'loop:wakeup' }]],
  ])('leaves %s to the resident Session', (_, session, pending, projected) => {
    expect(wakeDispatchOwnsInput(session, pending, projected, NOW)).toBe(false);
  });
});

describe('settleCancelledHookTurn', () => {
  // A parked pre-tool turn: the prompt's assistant message committed its
  // tool call, then a PreToolUse evaluation fence parked the turn.
  const preToolParkedSession = (
    records: unknown[],
    read: (ref: unknown) => Promise<Buffer>,
  ) => {
    const events = [
      {
        kind: 'input.accepted',
        sequence: 5,
        payload: { turnId: 'prompt', source: 'hosted-harness' },
      } as unknown as ManagedSessionEvent,
      {
        kind: 'model.attempt',
        sequence: 6,
        payload: { attemptId: 'attempt-1', state: 'output_committed' },
      } as unknown as ManagedSessionEvent,
    ];
    return {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 6,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain: () => records,
          domainRecord: () => undefined,
          harnessRunAuthorization: async () => ({
            status: 'runnable',
            checkpoint: { continuation: { phase: 'model_output_committed' } },
          }),
        },
        resources: { read },
        sink: {
          project: async () => [
            {
              daemonPromptId: 'prompt',
              type: 'assistant',
              uuid: 'u-assistant',
              model: 'test-model',
              message: {
                parts: [
                  {
                    functionCall: {
                      id: 'call-0',
                      name: 'write_file',
                      args: {},
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
  };

  const settledPreToolRecord = (occurrenceId: string, resourceId: string) => {
    const resultRef = {
      resourceId,
      kind: 'managed-hook-result',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'b'.repeat(64),
    };
    const record = {
      hookExecutionId: occurrenceId,
      occurrenceId,
      runtimeSessionId: 'runtime-1',
      registrationId: 'registration-1',
      eventName: HookEventName.PreToolUse,
      ordinal: 1,
      hookId: 'hook-1',
      planRef: {
        ...resultRef,
        resourceId: `${resourceId}-plan`,
        kind: 'managed-hook-plan',
      },
      inputRef: {
        ...resultRef,
        resourceId: `${resourceId}-input`,
        kind: 'managed-hook-input',
      },
      resultRef,
      onceKey: null,
      cancelRequested: false,
      run: {
        state: 'settled',
        reason: null,
        definition: {
          definitionId: 'catalog',
          definitionRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
        executionCallId: null,
        effectId: occurrenceId,
        dispatchId: null,
        deliveryId: null,
        execution: 'settled',
        runtime: null,
        delivery: null,
      },
    };
    return { record, resultRef };
  };

  it('does not read a settled PreToolUse result from an unrelated earlier occurrence', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'earlier-prompt:call-9'),
      'r-unrelated',
    );
    const read = vi.fn(async () => Buffer.from('{}'));
    const session = preToolParkedSession([{ record }], read);
    await settleCancelledHookTurn(session);
    // The in-memory occurrence filter runs ahead of any durable read, so a
    // record that cannot match this turn never pays a resources.read —
    // pre-filter this read fired once per historical record per pass.
    expect(read).not.toHaveBeenCalledWith(resultRef);
    expect(read).not.toHaveBeenCalled();
    // The unrelated record is no fence: the parked turn stays parked.
    expect(session.blocked).toBe(true);
  });

  it('treats an unreadable settled PreToolUse result as no fence', async () => {
    const { record } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-gone',
    );
    const read = vi.fn(async () => {
      throw new ManagedSessionRecordError('resource gone');
    });
    const session = preToolParkedSession([{ record }], read);
    // One missing result resource on any historical record must not reject
    // the pass — the open route has no arm for that throw.
    await expect(settleCancelledHookTurn(session)).resolves.toBeUndefined();
    expect(session.blocked).toBe(true);
  });

  it('treats an unreadable settled PreToolUse input as no fence', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-input',
    );
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === resultRef.resourceId)
        return Buffer.from(
          '{"outcome":"timeout","duration":0,"notStarted":true}',
        );
      throw new ManagedSessionRecordError('resource gone');
    });
    const session = preToolParkedSession([{ record }], read);
    // The result read proves the fence, then the input read that would
    // attribute it to the parked turn fails: the record must be skipped,
    // never rejecting the pass and never counting as a match.
    await expect(settleCancelledHookTurn(session)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'r-input-input' }),
    );
    expect(session.blocked).toBe(true);
  });

  it('does not settle a turn on a genuine callback-phase timeout receipt', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-real',
    );
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === resultRef.resourceId)
        // A callback that ran and timed out at its own deadline carries no
        // notStarted marker; only the Runtime's proven non-execution
        // receipts carry it.
        return Buffer.from(
          '{"outcome":"timeout","duration":5000,"error":"Managed hook execution failed."}',
        );
      return Buffer.from(
        '{"prompt_id":"prompt","tool_use_id":"call-0","tool_name":"write_file"}',
      );
    });
    const session = preToolParkedSession([{ record }], read);
    const write = vi.fn();
    (session.managed.sink as unknown as { write: typeof write }).write = write;
    await settleCancelledHookTurn(session);
    // The receipt proves the callback ran: nothing is certified cancelled,
    // so no turn_result is written and the recovery barrier stays latched.
    expect(write).not.toHaveBeenCalled();
    expect(session.blocked).toBe(true);
  });

  it('does not settle a turn on a genuine callback-phase cancelled receipt', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-ran',
    );
    const cancelledRecord = {
      ...record,
      run: { ...record.run, state: 'cancelled' },
    };
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === resultRef.resourceId)
        // A callback cancelled after it ran carries no notStarted marker;
        // only the Runtime's proven non-execution receipts carry it.
        return Buffer.from(
          '{"outcome":"cancelled","duration":3000,"error":"Hook execution cancelled."}',
        );
      return Buffer.from(
        '{"prompt_id":"prompt","tool_use_id":"call-0","tool_name":"write_file"}',
      );
    });
    const session = preToolParkedSession([{ record: cancelledRecord }], read);
    const write = vi.fn();
    (session.managed.sink as unknown as { write: typeof write }).write = write;
    await settleCancelledHookTurn(session);
    // The receipt proves the callback ran: nothing is certified cancelled,
    // so no turn_result is written and the recovery barrier stays latched.
    expect(write).not.toHaveBeenCalled();
    expect(session.blocked).toBe(true);
  });

  it('does not settle a turn on a cancelled receipt whose callback ran inside its own millisecond', async () => {
    const { record, resultRef } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'prompt:call-0'),
      'r-fast',
    );
    const cancelledRecord = {
      ...record,
      run: { ...record.run, state: 'cancelled' },
    };
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === resultRef.resourceId)
        // A callback dispatched and cancelled inside its own starting
        // millisecond publishes the republish's exact shape minus the
        // marker: millisecond wall clock cannot tell the two apart, so the
        // missing marker is the only thing keeping this certified as real
        // work.
        return Buffer.from(
          '{"outcome":"cancelled","duration":0,"error":"Managed hook execution failed."}',
        );
      return Buffer.from(
        '{"prompt_id":"prompt","tool_use_id":"call-0","tool_name":"write_file"}',
      );
    });
    const session = preToolParkedSession([{ record: cancelledRecord }], read);
    const write = vi.fn();
    (session.managed.sink as unknown as { write: typeof write }).write = write;
    await settleCancelledHookTurn(session);
    // No marker, no fence: nothing is certified cancelled, so no
    // turn_result is written and the recovery barrier stays latched.
    expect(write).not.toHaveBeenCalled();
    expect(session.blocked).toBe(true);
  });

  it('treats an unreadable InstructionsLoaded input of the parked turn as no fence', async () => {
    const hookExecutionId = 'hook-instructions';
    const resultRef = {
      resourceId: 'r-result',
      kind: 'managed-hook-result',
      schemaVersion: 1,
      byteLength: 2,
      digest: 'b'.repeat(64),
    };
    const record = {
      hookExecutionId,
      occurrenceId: hostedHookOccurrenceId(
        HookEventName.InstructionsLoaded,
        `prompt:native:${'c'.repeat(64)}:0`,
      ),
      runtimeSessionId: 'runtime-1',
      registrationId: 'registration-1',
      eventName: HookEventName.InstructionsLoaded,
      ordinal: 1,
      hookId: 'hook-1',
      planRef: {
        ...resultRef,
        resourceId: 'r-plan',
        kind: 'managed-hook-plan',
      },
      inputRef: {
        ...resultRef,
        resourceId: 'r-input',
        kind: 'managed-hook-input',
      },
      resultRef,
      onceKey: null,
      cancelRequested: false,
      run: {
        state: 'settled',
        reason: null,
        definition: {
          definitionId: 'catalog',
          definitionRevision: 1,
          definitionDigest: 'a'.repeat(64),
        },
        executionCallId: null,
        effectId: hookExecutionId,
        dispatchId: null,
        deliveryId: null,
        execution: 'settled',
        runtime: null,
        delivery: null,
      },
    };
    const events = [
      {
        kind: 'input.accepted',
        sequence: 5,
        payload: { turnId: 'prompt', source: 'hosted-harness' },
      } as unknown as ManagedSessionEvent,
      // The record's creation commit inside the parked turn: what admits a
      // republished InstructionsLoaded fence, which can never carry
      // cancelRequested, ahead of any durable read.
      {
        kind: 'domain.committed',
        sequence: 6,
        payload: { domain: 'hook_execution', operationId: hookExecutionId },
      } as unknown as ManagedSessionEvent,
    ];
    const read = vi.fn(async (ref: unknown) => {
      if ((ref as { resourceId?: string }).resourceId === 'r-result')
        return Buffer.from(
          '{"outcome":"timeout","duration":0,"notStarted":true}',
        );
      throw new ManagedSessionRecordError('resource gone');
    });
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 6,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain: () => [{ record }],
        },
        resources: { read },
        sink: { project: async () => [] },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await expect(settleCancelledHookTurn(session)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'r-input' }),
    );
    expect(session.blocked).toBe(true);
  });

  it('aborts the pre-model scan when the reconcile signal fires', async () => {
    const reason = new Error('The Hook reconciliation deadline expired.');
    const aborted = new AbortController();
    aborted.abort(reason);
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 5,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => [
            {
              kind: 'input.accepted',
              sequence: 5,
              payload: { turnId: 'prompt', source: 'hosted-harness' },
            } as unknown as ManagedSessionEvent,
          ],
          // The record body is never parsed: the abort lands first.
          extensionRecordsInDomain: () => [{ record: {} }],
        },
        resources: { read: async () => Buffer.from('{}') },
        sink: { project: async () => [] },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await expect(settleCancelledHookTurn(session, aborted.signal)).rejects.toBe(
      reason,
    );
    expect(session.hooksBusy).toBe(false);
  });

  it('aborts the pre-tool scan when the reconcile signal fires', async () => {
    const reason = new Error('The prompting client disconnected.');
    const aborted = new AbortController();
    aborted.abort(reason);
    const { record } = settledPreToolRecord(
      hostedHookOccurrenceId(HookEventName.PreToolUse, 'earlier-prompt:call-9'),
      'r-unrelated',
    );
    const read = vi.fn(async () => Buffer.from('{}'));
    const session = preToolParkedSession([{ record }], read);
    await expect(settleCancelledHookTurn(session, aborted.signal)).rejects.toBe(
      reason,
    );
    expect(session.hooksBusy).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not count a queued monitor notification toward the parked turn', async () => {
    const events = [
      {
        kind: 'input.accepted',
        sequence: 5,
        payload: { turnId: 'prompt', source: 'hosted-harness' },
      } as unknown as ManagedSessionEvent,
      {
        kind: 'input.accepted',
        sequence: 7,
        payload: { turnId: 'monitor:1:notify:1', source: 'monitor' },
      } as unknown as ManagedSessionEvent,
    ];
    const extensionRecordsInDomain = vi.fn(() => []);
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 7,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain,
        },
        resources: { read: async () => Buffer.from('{}') },
        sink: { project: async () => [] },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await settleCancelledHookTurn(session);
    // The monitor input is never its own parked Turn, so the sole pending
    // turn is the prompt itself and the Hook execution scan actually ran
    // — with the notification counted, the early none-of-one exit would
    // leave this hook turn wedged forever.
    expect(extensionRecordsInDomain).toHaveBeenCalledWith('hook_execution');
  });

  it('does not count a queued automation input toward the parked turn', async () => {
    const events = [
      {
        kind: 'input.accepted',
        sequence: 5,
        payload: { turnId: 'prompt', source: 'hosted-harness' },
      } as unknown as ManagedSessionEvent,
      {
        kind: 'input.accepted',
        sequence: 7,
        payload: { turnId: 'arun_1:input', source: AUTOMATION_INPUT_SOURCE },
      } as unknown as ManagedSessionEvent,
    ];
    const extensionRecordsInDomain = vi.fn(() => []);
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 7,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain,
        },
        resources: { read: async () => Buffer.from('{}') },
        sink: { project: async () => [] },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await settleCancelledHookTurn(session);
    // Same arithmetic as the monitor notification: the queued automation
    // input is nobody's parked turn, so the prompt is the sole pending one.
    expect(extensionRecordsInDomain).toHaveBeenCalledWith('hook_execution');
  });

  it('settles a monitor wake that already started and parks', async () => {
    // A wake that started — the projection holds its records — and then
    // parked are its own settled owner: the cancelled settle must act.
    const events = [
      {
        kind: 'input.accepted',
        sequence: 7,
        payload: { turnId: 'monitor:1:notify:1', source: 'monitor' },
      } as unknown as ManagedSessionEvent,
    ];
    const extensionRecordsInDomain = vi.fn(() => []);
    const session = {
      blocked: true,
      hooks: { hasPendingOperations: false },
      managed: {
        authority: {
          committedSequence: 8,
          sessionHeader: { sessionKey: { sessionId: 's' } },
          eventsInSequenceRange: () => events,
          extensionRecordsInDomain,
        },
        resources: { read: async () => Buffer.from('{}') },
        sink: {
          project: async () => [{ daemonPromptId: 'monitor:1:notify:1' }],
        },
      },
    } as unknown as Parameters<typeof settleCancelledHookTurn>[0];
    await settleCancelledHookTurn(session);
    // Once the wake ran, its turn parks exactly like a prompt's: the
    // cancelled settle must own it, or the Session stays blocked and every
    // later prompt answers hosted_turn_recovery_required.
    expect(extensionRecordsInDomain).toHaveBeenCalledWith('hook_execution');
  });
});
