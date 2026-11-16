/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, type RefObject } from 'react';
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

type TurnOutcome = 'idle' | 'done' | 'error';

interface TurnTracker {
  streamingState: StreamingState;
  /** Id of the last history item when the current or last turn started. */
  startId: number;
  /**
   * Failure items already pending when the turn started. A terminal API
   * error stays pending across a Goal turn, so it is not that turn's.
   */
  pendingFailuresAtStart: readonly HistoryItemWithoutId[];
  outcome: TurnOutcome;
}

/** Items that mean the turn did not produce the result the user asked for. */
function isTurnFailure(item: HistoryItemWithoutId): boolean {
  return (
    item.type === MessageType.ERROR ||
    item.type === 'user_prompt_submit_blocked' ||
    item.type === 'stop_hook_loop'
  );
}

/**
 * Work out how the last turn ended. A turn is a stretch where streaming
 * state is not idle; it ended in `error` if it added a failure item to
 * history or left an error pending (API errors wait in the pending area
 * with a Ctrl+Y retry hint until the next submit; one already pending when
 * the turn started is not counted), `idle` if the user
 * cancelled it, and `done` otherwise.
 *
 * The outcome is decided once, when the turn ends, and held until the next
 * turn starts or history is cleared. Errors added while idle and history
 * compaction must not rewrite it. The turn is
 * bounded by item id, not array index, because compaction drops items.
 */
export function useTurnOutcome(
  streamingState: StreamingState,
  history: readonly HistoryItem[],
  pendingItems: readonly HistoryItemWithoutId[],
  turnCancelledRef: RefObject<boolean> | undefined,
): TurnOutcome {
  const [tracker, setTracker] = useState<TurnTracker>({
    streamingState,
    startId: 0,
    pendingFailuresAtStart: [],
    outcome: 'idle',
  });

  // Update during render rather than in an effect, so the render where the
  // turn ends already carries its outcome and no stale record is written.
  let current = tracker;
  if (streamingState !== tracker.streamingState) {
    const wasIdle = tracker.streamingState === StreamingState.Idle;
    const isIdle = streamingState === StreamingState.Idle;
    if (wasIdle) {
      current = {
        streamingState,
        startId: history[history.length - 1]?.id ?? 0,
        pendingFailuresAtStart: pendingItems.filter(isTurnFailure),
        outcome: 'idle',
      };
    } else if (isIdle) {
      const failed =
        pendingItems.some(
          (item) =>
            isTurnFailure(item) &&
            !tracker.pendingFailuresAtStart.includes(item),
        ) ||
        history.some(
          (item) => item.id > tracker.startId && isTurnFailure(item),
        );
      current = {
        ...tracker,
        streamingState,
        outcome: turnCancelledRef?.current ? 'idle' : failed ? 'error' : 'done',
      };
    } else {
      current = { ...tracker, streamingState };
    }
    setTracker(current);
  }

  // History cleared (/clear): the turn is gone, so is its result. Reset the
  // tracker too, or the next item added while idle would bring it back.
  if (history.length === 0 && current.outcome !== 'idle') {
    current = { ...current, outcome: 'idle' };
    setTracker(current);
  }
  return current.outcome;
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
