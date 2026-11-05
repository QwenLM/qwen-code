/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AgentResultDisplay } from '@qwen-code/qwen-code-core/tools/tools.js';
import {
  MessageType,
  StreamingState,
  type HistoryItem,
  type HistoryItemWithoutId,
} from '../types.js';
import type { TrackedToolCall } from './useReactToolScheduler.js';
import type { ProgramStatus } from '../../utils/osc.js';
import {
  finalizeProgramStatus,
  reportProgramStatus,
  resendProgramStatus,
} from '../../utils/program-status.js';

export interface ProgramStatusInputs {
  streamingState: StreamingState;
  pendingToolCalls?: readonly TrackedToolCall[];
  /** How the last turn ended, or `idle` when no turn has ended yet. */
  turnOutcome: 'idle' | 'done' | 'error';
  /** Auth dialog open or an auth flow in progress. */
  authPending: boolean;
  /** A slash command's shell confirmation is on screen. */
  shellConfirmationPending: boolean;
  loopDetectionPending: boolean;
  /** Folder trust, MCP server or project hook approval at startup. */
  startupApprovalPending: boolean;
}

/**
 * Map UI state onto the single root OSC 7501 record.
 *
 * Only waits the agent started count as `blocked`; dialogs the user opened
 * (theme, settings, ...) do not, since the user is already at the keyboard.
 * `msg` names the tool at most — never its arguments or model text.
 */
export function deriveProgramStatus(input: ProgramStatusInputs): ProgramStatus {
  if (input.authPending) {
    return { state: 'blocked', kind: 'auth', msg: 'Authentication required' };
  }
  const awaiting = findAwaitingConfirmation(input.pendingToolCalls ?? []);
  if (awaiting) return awaiting;
  if (input.shellConfirmationPending) {
    return {
      state: 'blocked',
      kind: 'permission',
      msg: 'Permission needed: Shell',
    };
  }
  if (input.loopDetectionPending) {
    return {
      state: 'blocked',
      kind: 'question',
      msg: 'Loop detected: continue?',
    };
  }
  if (input.startupApprovalPending) {
    return { state: 'blocked', kind: 'permission', msg: 'Approval needed' };
  }
  if (input.streamingState === StreamingState.WaitingForConfirmation) {
    return { state: 'blocked', kind: 'permission', msg: 'Permission needed' };
  }
  if (input.streamingState === StreamingState.Responding) {
    return { state: 'working' };
  }
  if (input.turnOutcome === 'error') {
    return { state: 'error', msg: 'Request failed' };
  }
  return { state: input.turnOutcome };
}

function findAwaitingConfirmation(
  toolCalls: readonly TrackedToolCall[],
): ProgramStatus | undefined {
  for (const tc of toolCalls) {
    if (tc.status === 'awaiting_approval') {
      if (tc.confirmationDetails.type === 'ask_user_question') {
        return {
          state: 'blocked',
          kind: 'question',
          msg: 'Waiting for your answer',
        };
      }
      const name = tc.tool?.displayName ?? tc.request.name;
      return {
        state: 'blocked',
        kind: 'permission',
        msg: `Permission needed: ${name}`,
      };
    }
  }
  for (const tc of toolCalls) {
    if (tc.status !== 'executing') continue;
    const liveOutput = tc.liveOutput as AgentResultDisplay | undefined;
    if (
      typeof liveOutput !== 'object' ||
      liveOutput === null ||
      liveOutput.type !== 'task_execution' ||
      !liveOutput.pendingConfirmation
    ) {
      continue;
    }
    if (liveOutput.pendingConfirmation.type === 'ask_user_question') {
      return {
        state: 'blocked',
        kind: 'question',
        msg: 'Waiting for your answer',
      };
    }
    const name =
      liveOutput.toolCalls?.find((call) => call.status === 'awaiting_approval')
        ?.name ?? liveOutput.subagentName;
    return {
      state: 'blocked',
      kind: 'permission',
      msg: name ? `Permission needed: ${name}` : 'Permission needed',
    };
  }
  return undefined;
}

/**
 * Work out how the last turn ended. A turn is a stretch where streaming
 * state is not idle; it ended in `error` if it added an error message to
 * history or left one pending (API errors wait in the pending area with a
 * Ctrl+Y retry hint until the next submit), `idle` if the user cancelled
 * it, and `done` otherwise. The result is held until the next turn starts.
 */
export function useTurnOutcome(
  streamingState: StreamingState,
  history: readonly HistoryItem[],
  pendingItems: readonly HistoryItemWithoutId[],
  turnCancelledRef: RefObject<boolean> | undefined,
): 'idle' | 'done' | 'error' {
  const [turnStart, setTurnStart] = useState<number | undefined>();
  const previousStateRef = useRef(streamingState);
  const historyLengthRef = useRef(history.length);
  historyLengthRef.current = history.length;

  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = streamingState;
    if (
      previous === StreamingState.Idle &&
      streamingState !== StreamingState.Idle
    ) {
      setTurnStart(historyLengthRef.current);
    }
  }, [streamingState]);

  return useMemo(() => {
    if (turnStart === undefined || streamingState !== StreamingState.Idle) {
      return 'idle';
    }
    // History shrank (e.g. /clear): the turn is gone, so is its result.
    if (history.length < turnStart) return 'idle';
    if (turnCancelledRef?.current) return 'idle';
    const isError = (item: HistoryItemWithoutId) =>
      item.type === MessageType.ERROR;
    const failed =
      pendingItems.some(isError) || history.slice(turnStart).some(isError);
    return failed ? 'error' : 'done';
  }, [turnStart, streamingState, history, pendingItems, turnCancelledRef]);
}

/**
 * Report interactive status to the terminal with OSC 7501 so tabs and
 * agent inboxes can show whether Qwen Code is working, waiting on the user,
 * or finished. Writes only to a TTY and only when the record changes.
 */
export function useProgramStatus(
  inputs: Omit<ProgramStatusInputs, 'turnOutcome'> & {
    history: readonly HistoryItem[];
    pendingHistoryItems: readonly HistoryItemWithoutId[];
    turnCancelledRef?: RefObject<boolean>;
  },
): void {
  const turnOutcome = useTurnOutcome(
    inputs.streamingState,
    inputs.history,
    inputs.pendingHistoryItems,
    inputs.turnCancelledRef,
  );
  const status = deriveProgramStatus({ ...inputs, turnOutcome });
  const { state, kind, msg } = status;

  useEffect(() => {
    reportProgramStatus({ state, kind, msg });
  }, [state, kind, msg]);

  useEffect(() => {
    // After `fg` the terminal may have dropped working/blocked records
    // (the shell prompt in between clears them), so write ours again.
    const onSigcont = () => resendProgramStatus();
    process.on('SIGCONT', onSigcont);
    // Only 'exit', like useTerminalProgress: signal handling belongs to the
    // shutdown path, which ends in process.exit().
    const onExit = () => finalizeProgramStatus();
    process.on('exit', onExit);
    return () => {
      process.removeListener('SIGCONT', onSigcont);
      process.removeListener('exit', onExit);
      // /quit unmounts the UI before process.exit(), which would otherwise
      // drop the 'exit' listener above before it runs.
      finalizeProgramStatus();
    };
  }, []);
}
