/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import {
  ToolErrorType,
  type ToolExecutionStatus,
} from '@qwen-code/qwen-code-core';
import { describe, expect, it } from 'vitest';
import {
  createRepeatedToolFailureGuardState,
  reduceRepeatedToolFailureGuard,
  REPEATED_TOOL_FAILURE_REMINDER,
  REPEATED_TOOL_FAILURE_STOP_MESSAGE,
  parseRepeatedToolFailureGuardMode,
  type RepeatedToolFailureGuardMode,
  type RepeatedToolFailureObservation,
  type RepeatedToolFailureTerminalStatus,
} from './repeated-tool-failure-guard.js';

function observation(
  overrides: Partial<RepeatedToolFailureObservation> = {},
): RepeatedToolFailureObservation {
  return {
    callId: 'call-1',
    policyToolName: 'read_file',
    toolType: 'native',
    terminalStatus: 'error',
    executionStatus: 'error',
    executionErrorType: ToolErrorType.FILE_NOT_FOUND,
    ...overrides,
  };
}

function reduce(
  state: ReturnType<typeof createRepeatedToolFailureGuardState>,
  observations: RepeatedToolFailureObservation[],
  options: {
    mode?: RepeatedToolFailureGuardMode;
    complete?: boolean;
    hasExternalInput?: boolean;
    hasQueuedPrompt?: boolean;
    inputReliable?: boolean;
  } = {},
) {
  return reduceRepeatedToolFailureGuard(state, {
    mode: options.mode ?? 'enforce',
    batch: {
      complete: options.complete ?? true,
      observations,
    },
    hasExternalInput: options.hasExternalInput ?? false,
    hasQueuedPrompt: options.hasQueuedPrompt ?? false,
    inputReliable: options.inputReliable ?? true,
  });
}

describe('repeated tool failure guard', () => {
  it('parses valid deployment modes and rejects missing or invalid values', () => {
    expect(parseRepeatedToolFailureGuardMode(undefined)).toBeUndefined();
    expect(parseRepeatedToolFailureGuardMode('invalid')).toBeUndefined();
    expect(parseRepeatedToolFailureGuardMode(' WARN ')).toBe('warn');
  });

  it('does no work when the deployment mode is off', () => {
    const state = createRepeatedToolFailureGuardState();
    expect(reduce(state, [observation()], { mode: 'off' })).toEqual({
      kind: 'none',
      state,
    });
  });

  it('requires eight failures across at least two batches before warning', () => {
    const first = reduce(
      createRepeatedToolFailureGuardState(),
      Array.from({ length: 8 }, (_, index) =>
        observation({ callId: `call-${index}` }),
      ),
    );
    expect(first.kind).toBe('tracked');
    expect(first.state).toMatchObject({
      phase: 'tracking',
      failureCount: 8,
      batchCount: 1,
    });

    const second = reduce(first.state, [observation({ callId: 'call-9' })]);
    expect(second.kind).toBe('warn');
    expect(second.state).toMatchObject({
      phase: 'warned',
      failureCount: 9,
      batchCount: 2,
    });
  });

  it('stops only after the next complete matching batch', () => {
    const first = reduce(
      createRepeatedToolFailureGuardState(),
      Array.from({ length: 4 }, (_, index) =>
        observation({ callId: `first-${index}` }),
      ),
    );
    const warned = reduce(
      first.state,
      Array.from({ length: 4 }, (_, index) =>
        observation({ callId: `second-${index}` }),
      ),
    );
    const stopped = reduce(warned.state, [
      observation({ callId: 'post-warning' }),
    ]);

    expect(warned.kind).toBe('warn');
    expect(stopped.kind).toBe('stop');
    expect(stopped.state.phase).toBe('latched');
    expect(
      reduce(stopped.state, [observation({ callId: 'ignored' })]).kind,
    ).toBe('none');
  });

  it.each([
    ['shadow', 'would_warn', 'would_stop'],
    ['warn', 'warn', 'would_stop'],
    ['enforce', 'warn', 'stop'],
  ] as const)(
    'applies %s mode without changing detection semantics',
    (mode, warningKind, stopKind) => {
      const first = reduce(
        createRepeatedToolFailureGuardState(),
        Array.from({ length: 4 }, (_, index) =>
          observation({ callId: `first-${index}` }),
        ),
        { mode },
      );
      const warning = reduce(
        first.state,
        Array.from({ length: 4 }, (_, index) =>
          observation({ callId: `second-${index}` }),
        ),
        { mode },
      );
      const stop = reduce(
        warning.state,
        [observation({ callId: 'post-warning' })],
        { mode },
      );

      expect(warning.kind).toBe(warningKind);
      expect(stop.kind).toBe(stopKind);
    },
  );

  it.each([
    ['success', 'success', 'success'],
    ['synthetic success', 'success', 'not_started'],
    ['cancelled', 'cancelled', 'cancelled'],
    ['execution cancelled', 'error', 'cancelled'],
    ['not started', 'error', 'not_started'],
    ['post execution', 'error', 'success'],
  ] as const)(
    'resets a streak for a %s outcome',
    (
      _label,
      terminalStatus: RepeatedToolFailureTerminalStatus,
      executionStatus: ToolExecutionStatus,
    ) => {
      const tracked = reduce(createRepeatedToolFailureGuardState(), [
        observation(),
      ]);
      const result = reduce(tracked.state, [
        observation({ terminalStatus, executionStatus }),
      ]);

      expect(result).toMatchObject({
        kind: 'reset',
        state: { phase: 'idle', failureCount: 0, batchCount: 0 },
      });
    },
  );

  it('keeps counting a failure key when other tools succeed in the same batch', () => {
    const failingShell = (callId: string) =>
      observation({
        callId,
        policyToolName: 'run_shell_command',
        executionErrorType: ToolErrorType.EXECUTION_FAILED,
      });
    const first = reduce(
      createRepeatedToolFailureGuardState(),
      Array.from({ length: 4 }, (_, index) => failingShell(`first-${index}`)),
    );
    const second = reduce(first.state, [
      ...Array.from({ length: 4 }, (_, index) =>
        failingShell(`second-${index}`),
      ),
      observation({
        callId: 'read-success',
        policyToolName: 'read_file',
        terminalStatus: 'success',
        executionStatus: 'success',
        executionErrorType: undefined,
      }),
    ]);

    expect(second).toMatchObject({
      kind: 'warn',
      state: { failureCount: 8, batchCount: 2 },
    });
  });

  it('preserves a failure streak across successful batches from other tools', () => {
    const failingShell = (callId: string) =>
      observation({
        callId,
        policyToolName: 'run_shell_command',
        executionErrorType: ToolErrorType.EXECUTION_FAILED,
      });
    const first = reduce(
      createRepeatedToolFailureGuardState(),
      Array.from({ length: 4 }, (_, index) => failingShell(`first-${index}`)),
    );
    const unrelatedSuccess = reduce(first.state, [
      observation({
        callId: 'edit-success',
        policyToolName: 'replace',
        terminalStatus: 'success',
        executionStatus: 'success',
        executionErrorType: undefined,
      }),
    ]);
    const second = reduce(
      unrelatedSuccess.state,
      Array.from({ length: 4 }, (_, index) => failingShell(`second-${index}`)),
    );

    expect(unrelatedSuccess).toEqual({ kind: 'none', state: first.state });
    expect(second).toMatchObject({
      kind: 'warn',
      state: { failureCount: 8, batchCount: 2 },
    });
  });

  it('resets when the failing tool also succeeds in the same batch', () => {
    const tracked = reduce(createRepeatedToolFailureGuardState(), [
      observation(),
    ]);
    const result = reduce(tracked.state, [
      observation({ callId: 'failure' }),
      observation({
        callId: 'success',
        terminalStatus: 'success',
        executionStatus: 'success',
        executionErrorType: undefined,
      }),
    ]);

    expect(result).toMatchObject({ kind: 'reset', reason: 'success' });
  });

  it('does not let another tool self-recovery reset the tracked candidate', () => {
    const tracked = reduce(createRepeatedToolFailureGuardState(), [
      observation(),
    ]);
    const result = reduce(tracked.state, [
      observation({
        callId: 'other-failure',
        policyToolName: 'run_shell_command',
        executionErrorType: ToolErrorType.EXECUTION_FAILED,
      }),
      observation({
        callId: 'other-success',
        policyToolName: 'run_shell_command',
        terminalStatus: 'success',
        executionStatus: 'success',
        executionErrorType: undefined,
      }),
    ]);

    expect(result).toEqual({ kind: 'none', state: tracked.state });
  });

  it('counts one failure key when another failing tool succeeds in the batch', () => {
    const result = reduce(createRepeatedToolFailureGuardState(), [
      observation({ callId: 'tracked-failure' }),
      observation({
        callId: 'other-failure',
        policyToolName: 'run_shell_command',
        executionErrorType: ToolErrorType.EXECUTION_FAILED,
      }),
      observation({
        callId: 'other-success',
        policyToolName: 'run_shell_command',
        terminalStatus: 'success',
        executionStatus: 'success',
        executionErrorType: undefined,
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'tracked',
      state: {
        key: {
          policyToolName: 'read_file',
          executionErrorType: ToolErrorType.FILE_NOT_FOUND,
        },
        failureCount: 1,
        batchCount: 1,
      },
    });
  });

  it('downgrades enforcement for a successful observation without tool identity', () => {
    const result = reduce(createRepeatedToolFailureGuardState(), [
      observation({
        policyToolName: undefined,
        terminalStatus: 'success',
        executionStatus: 'success',
        executionErrorType: undefined,
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'reset',
      reason: 'unknown',
      state: { enforcementDisabled: true },
    });
  });

  it('ignores provider duplicates without advancing or resetting', () => {
    const tracked = reduce(createRepeatedToolFailureGuardState(), [
      observation(),
    ]);
    const duplicate = reduce(tracked.state, [
      observation({ providerDuplicate: true }),
    ]);

    expect(duplicate).toEqual({ kind: 'none', state: tracked.state });
  });

  it('resets mixed failure keys and assigns a new candidate to a new key', () => {
    const tracked = reduce(createRepeatedToolFailureGuardState(), [
      observation(),
    ]);
    const mixed = reduce(tracked.state, [
      observation(),
      observation({
        callId: 'call-2',
        executionErrorType: ToolErrorType.PERMISSION_DENIED,
      }),
    ]);
    const next = reduce(mixed.state, [
      observation({
        executionErrorType: ToolErrorType.PERMISSION_DENIED,
      }),
    ]);

    expect(mixed).toMatchObject({ kind: 'reset', reason: 'mixed' });
    expect(next).toMatchObject({
      kind: 'tracked',
      state: { candidateOrdinal: 2 },
    });
  });

  it.each([
    [{ complete: false }, 'incomplete'],
    [{ hasExternalInput: true }, 'external_input'],
    [{ hasQueuedPrompt: true }, 'queued_prompt'],
    [{ inputReliable: false }, 'unreliable_input'],
  ] as const)('resets for boundary condition %s', (options, reason) => {
    const tracked = reduce(createRepeatedToolFailureGuardState(), [
      observation(),
    ]);
    const result = reduce(tracked.state, [observation()], options);

    expect(result).toMatchObject({ kind: 'reset', reason });
  });

  it('downgrades enforcement after an unknown execution contract', () => {
    const invalid = reduce(createRepeatedToolFailureGuardState(), [
      observation({ executionStatus: undefined }),
    ]);
    expect(invalid).toMatchObject({
      reason: 'unknown',
      state: { enforcementDisabled: true },
    });

    const first = reduce(
      invalid.state,
      Array.from({ length: 4 }, (_, index) =>
        observation({ callId: `first-${index}` }),
      ),
    );
    const warning = reduce(
      first.state,
      Array.from({ length: 4 }, (_, index) =>
        observation({ callId: `second-${index}` }),
      ),
    );
    const stop = reduce(warning.state, [observation()]);

    expect(warning.kind).toBe('warn');
    expect(stop.kind).toBe('would_stop');
  });

  it.each([
    [
      'success/error',
      { terminalStatus: 'success' as const, executionStatus: 'error' as const },
      'contract_violation',
    ],
    [
      'success/cancelled',
      {
        terminalStatus: 'success' as const,
        executionStatus: 'cancelled' as const,
      },
      'contract_violation',
    ],
    [
      'unknown execution error type',
      { executionErrorType: ToolErrorType.UNKNOWN },
      'unknown',
    ],
    ['unknown execution status', { executionStatus: 'unknown' }, 'unknown'],
    ['missing policy tool identity', { policyToolName: undefined }, 'unknown'],
  ] as const)('downgrades enforcement for %s', (_label, overrides, reason) => {
    const result = reduce(createRepeatedToolFailureGuardState(), [
      observation(overrides),
    ]);

    expect(result).toMatchObject({
      reason,
      state: {
        phase: 'idle',
        enforcementDisabled: true,
      },
    });
  });

  it('does not count the terminal error type after successful execution', () => {
    const tracked = reduce(createRepeatedToolFailureGuardState(), [
      observation(),
    ]);
    const result = reduce(tracked.state, [
      observation({
        executionStatus: 'success',
        executionErrorType: ToolErrorType.UNHANDLED_EXCEPTION,
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'reset',
      reason: 'post_execution_failure',
    });
  });

  it('lets terminal cancellation win when execution status is missing', () => {
    const tracked = reduce(createRepeatedToolFailureGuardState(), [
      observation(),
    ]);
    const result = reduce(tracked.state, [
      observation({
        terminalStatus: 'cancelled',
        executionStatus: undefined,
        executionErrorType: undefined,
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'reset',
      reason: 'cancelled',
      state: { enforcementDisabled: false },
    });
  });

  it.each([
    ['cancelled first', ['cancelled', 'unknown']],
    ['unknown first', ['unknown', 'cancelled']],
  ] as const)(
    'classifies mixed ineligible batches deterministically when %s',
    (_label, order) => {
      const tracked = reduce(createRepeatedToolFailureGuardState(), [
        observation(),
      ]);
      const byOutcome = {
        cancelled: observation({
          callId: 'cancelled',
          terminalStatus: 'cancelled',
          executionStatus: 'cancelled',
          executionErrorType: undefined,
        }),
        unknown: observation({
          callId: 'unknown',
          policyToolName: undefined,
        }),
      };
      const result = reduce(
        tracked.state,
        order.map((outcome) => byOutcome[outcome]),
      );

      expect(result).toMatchObject({
        kind: 'reset',
        reason: 'cancelled',
        state: { enforcementDisabled: true },
      });
    },
  );

  it.each(['error', 'success'] as const)(
    'fails open when a future execution status reaches a terminal %s observation',
    (terminalStatus) => {
      const result = reduce(createRepeatedToolFailureGuardState(), [
        observation({
          terminalStatus,
          executionStatus: 'timeout' as ToolExecutionStatus,
        }),
      ]);

      expect(result).toMatchObject({
        reason: 'unknown',
        state: { enforcementDisabled: true },
      });
    },
  );

  it('uses fixed privacy-safe reminder and stop text', () => {
    expect(REPEATED_TOOL_FAILURE_REMINDER).toBe(
      'System: the same tool execution has failed repeatedly for the same classified reason. Do not repeat the same approach. Inspect the returned result, change the approach or required preconditions, or explain the blocker.',
    );
    expect(REPEATED_TOOL_FAILURE_STOP_MESSAGE).toBe(
      'Automatic continuation stopped because the same tool execution failure continued after a corrective reminder. New user input is required to continue.',
    );
  });
});
