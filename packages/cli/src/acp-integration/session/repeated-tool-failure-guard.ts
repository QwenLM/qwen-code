/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolErrorType,
  type ToolExecutionStatus,
} from '@qwen-code/qwen-code-core';

export const REPEATED_TOOL_FAILURE_THRESHOLD = 8;
export const REPEATED_TOOL_FAILURE_BATCH_THRESHOLD = 2;

export const REPEATED_TOOL_FAILURE_REMINDER =
  'System: the same tool execution has failed repeatedly for the same classified reason. Do not repeat the same approach. Inspect the returned result, change the approach or required preconditions, or explain the blocker.';

export const REPEATED_TOOL_FAILURE_STOP_MESSAGE =
  'Automatic continuation stopped because the same tool execution failure continued after a corrective reminder. New user input is required to continue.';

export type RepeatedToolFailureGuardMode =
  | 'off'
  | 'shadow'
  | 'warn'
  | 'enforce';

export type RepeatedToolFailureTerminalStatus =
  | 'success'
  | 'error'
  | 'cancelled';

export type RepeatedToolFailureObservation = {
  callId: string;
  policyToolName?: string;
  toolType?: 'native' | 'mcp';
  terminalStatus: RepeatedToolFailureTerminalStatus;
  executionStatus?: ToolExecutionStatus | 'unknown';
  executionErrorType?: ToolErrorType;
  providerDuplicate?: boolean;
};

export type RepeatedToolFailureBatch = {
  complete: boolean;
  observations: readonly RepeatedToolFailureObservation[];
};

type FailureKey = {
  policyToolName: string;
  executionErrorType: ToolErrorType;
};

export type RepeatedToolFailureGuardPhase =
  | 'idle'
  | 'tracking'
  | 'warned'
  | 'latched';

export type RepeatedToolFailureGuardState = {
  phase: RepeatedToolFailureGuardPhase;
  key?: FailureKey;
  failureCount: number;
  batchCount: number;
  candidateOrdinal: number;
  nextCandidateOrdinal: number;
  enforcementDisabled: boolean;
};

export type RepeatedToolFailureResetReason =
  | 'success'
  | 'cancelled'
  | 'not_started'
  | 'post_execution_failure'
  | 'unknown'
  | 'mixed'
  | 'incomplete'
  | 'external_input'
  | 'queued_prompt'
  | 'unreliable_input'
  | 'contract_violation';

const INELIGIBLE_RESET_REASON_PRECEDENCE = [
  'contract_violation',
  'cancelled',
  'unknown',
  'not_started',
  'post_execution_failure',
] as const satisfies readonly RepeatedToolFailureResetReason[];

export type RepeatedToolFailureGuardDecision =
  | { kind: 'none'; state: RepeatedToolFailureGuardState }
  | {
      kind: 'reset';
      state: RepeatedToolFailureGuardState;
      reason: RepeatedToolFailureResetReason;
    }
  | {
      kind: 'tracked';
      state: RepeatedToolFailureGuardState;
    }
  | {
      kind: 'would_warn' | 'warn' | 'would_stop' | 'stop';
      state: RepeatedToolFailureGuardState;
    };

export type RepeatedToolFailureGuardInput = {
  mode: RepeatedToolFailureGuardMode;
  batch: RepeatedToolFailureBatch;
  hasExternalInput: boolean;
  hasQueuedPrompt: boolean;
  inputReliable: boolean;
};

export function createRepeatedToolFailureGuardState(): RepeatedToolFailureGuardState {
  return {
    phase: 'idle',
    failureCount: 0,
    batchCount: 0,
    candidateOrdinal: 0,
    nextCandidateOrdinal: 1,
    enforcementDisabled: false,
  };
}

export function parseRepeatedToolFailureGuardMode(
  value: string | undefined,
): RepeatedToolFailureGuardMode | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'off':
    case 'shadow':
    case 'warn':
    case 'enforce':
      return normalized;
    default:
      return undefined;
  }
}

function resetState(
  state: RepeatedToolFailureGuardState,
  enforcementDisabled = state.enforcementDisabled,
): RepeatedToolFailureGuardState {
  return {
    phase: 'idle',
    failureCount: 0,
    batchCount: 0,
    candidateOrdinal: 0,
    nextCandidateOrdinal: state.nextCandidateOrdinal,
    enforcementDisabled,
  };
}

function reset(
  state: RepeatedToolFailureGuardState,
  reason: RepeatedToolFailureResetReason,
  enforcementDisabled = state.enforcementDisabled,
): RepeatedToolFailureGuardDecision {
  const nextState = resetState(state, enforcementDisabled);
  if (
    state.phase === 'idle' &&
    state.enforcementDisabled === enforcementDisabled
  ) {
    return { kind: 'none', state: nextState };
  }
  return { kind: 'reset', state: nextState, reason };
}

function keysEqual(left: FailureKey | undefined, right: FailureKey): boolean {
  return (
    left?.policyToolName === right.policyToolName &&
    left.executionErrorType === right.executionErrorType
  );
}

function effectiveMode(
  mode: RepeatedToolFailureGuardMode,
  enforcementDisabled: boolean,
): RepeatedToolFailureGuardMode {
  return mode === 'enforce' && enforcementDisabled ? 'warn' : mode;
}

export function reduceRepeatedToolFailureGuard(
  state: RepeatedToolFailureGuardState,
  input: RepeatedToolFailureGuardInput,
): RepeatedToolFailureGuardDecision {
  if (input.mode === 'off' || state.phase === 'latched') {
    return { kind: 'none', state };
  }
  if (!input.inputReliable) {
    return reset(state, 'unreliable_input', true);
  }
  if (input.hasExternalInput) {
    return reset(state, 'external_input');
  }
  if (input.hasQueuedPrompt) {
    return reset(state, 'queued_prompt');
  }
  if (!input.batch.complete) {
    return reset(state, 'incomplete');
  }

  const observations = input.batch.observations.filter(
    (observation) => !observation.providerDuplicate,
  );
  if (observations.length === 0) {
    return { kind: 'none', state };
  }

  const eligible: FailureKey[] = [];
  const successfulPolicyToolNames = new Set<string>();
  const resetReasons = new Set<RepeatedToolFailureResetReason>();
  let enforcementDisabled = state.enforcementDisabled;
  for (const observation of observations) {
    const { terminalStatus, executionStatus } = observation;
    if (terminalStatus === 'cancelled') {
      resetReasons.add('cancelled');
      continue;
    }
    if (executionStatus === undefined || executionStatus === 'unknown') {
      resetReasons.add('unknown');
      enforcementDisabled = true;
      continue;
    }
    if (terminalStatus === 'success') {
      if (executionStatus === 'error' || executionStatus === 'cancelled') {
        resetReasons.add('contract_violation');
        enforcementDisabled = true;
      } else if (
        executionStatus === 'success' ||
        executionStatus === 'not_started'
      ) {
        if (observation.policyToolName) {
          successfulPolicyToolNames.add(observation.policyToolName);
        } else {
          resetReasons.add('unknown');
          enforcementDisabled = true;
        }
      } else {
        resetReasons.add('unknown');
        enforcementDisabled = true;
      }
      continue;
    }
    if (executionStatus === 'cancelled') {
      resetReasons.add('cancelled');
      continue;
    }
    if (executionStatus === 'not_started') {
      resetReasons.add('not_started');
      continue;
    }
    if (executionStatus === 'success') {
      resetReasons.add('post_execution_failure');
      continue;
    }
    if (executionStatus !== 'error') {
      resetReasons.add('unknown');
      enforcementDisabled = true;
      continue;
    }
    if (
      !observation.policyToolName ||
      observation.executionErrorType === undefined ||
      observation.executionErrorType === ToolErrorType.UNKNOWN
    ) {
      resetReasons.add('unknown');
      enforcementDisabled = true;
      continue;
    }
    eligible.push({
      policyToolName: observation.policyToolName,
      executionErrorType: observation.executionErrorType,
    });
  }

  const resetReason = INELIGIBLE_RESET_REASON_PRECEDENCE.find((reason) =>
    resetReasons.has(reason),
  );
  if (resetReason !== undefined) {
    return reset(state, resetReason, enforcementDisabled);
  }

  const matchingFailures = eligible.filter(
    (failure) => !successfulPolicyToolNames.has(failure.policyToolName),
  );
  const key = matchingFailures[0];
  if (!key) {
    if (state.key && successfulPolicyToolNames.has(state.key.policyToolName)) {
      return reset(state, 'success');
    }
    if (successfulPolicyToolNames.size > 0) {
      return { kind: 'none', state };
    }
    return reset(state, 'unknown', true);
  }
  if (matchingFailures.some((entry) => !keysEqual(entry, key))) {
    return reset(state, 'mixed');
  }

  if (!keysEqual(state.key, key)) {
    const nextState: RepeatedToolFailureGuardState = {
      phase: 'tracking',
      key,
      failureCount: matchingFailures.length,
      batchCount: 1,
      candidateOrdinal: state.nextCandidateOrdinal,
      nextCandidateOrdinal: state.nextCandidateOrdinal + 1,
      enforcementDisabled: state.enforcementDisabled,
    };
    return { kind: 'tracked', state: nextState };
  }

  const failureCount = state.failureCount + matchingFailures.length;
  const batchCount = state.batchCount + 1;
  if (state.phase === 'warned') {
    const nextState: RepeatedToolFailureGuardState = {
      ...state,
      phase: 'latched',
      failureCount,
      batchCount,
    };
    return {
      kind:
        effectiveMode(input.mode, state.enforcementDisabled) === 'enforce'
          ? 'stop'
          : 'would_stop',
      state: nextState,
    };
  }

  const nextState: RepeatedToolFailureGuardState = {
    ...state,
    failureCount,
    batchCount,
  };
  if (
    failureCount < REPEATED_TOOL_FAILURE_THRESHOLD ||
    batchCount < REPEATED_TOOL_FAILURE_BATCH_THRESHOLD
  ) {
    return { kind: 'tracked', state: nextState };
  }

  nextState.phase = 'warned';
  return {
    kind:
      effectiveMode(input.mode, state.enforcementDisabled) === 'shadow'
        ? 'would_warn'
        : 'warn',
    state: nextState,
  };
}
