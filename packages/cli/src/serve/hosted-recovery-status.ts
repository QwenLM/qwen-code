/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { readHostedFileHistory } from './hosted-file-history.js';
import { isDurableBlockedVerdict } from './hosted-runtime-recovery.js';
import { hasHostedCleanupDebt } from './hosted-turn-cleanup.js';

export interface HostedRecoveryStatus {
  state:
    | 'recovering'
    | 'awaiting_evidence'
    | 'cleanup_pending'
    | 'ready'
    | 'operator_required';
  reasonCode: string | null;
  promptId: string | null;
  inputSettled: boolean;
  continuationReady: boolean;
  nextTurnAllowed: boolean;
}

export interface HostedRecoverySession {
  managed: ManagedSession;
  active?: { promptId: string };
  recoveredTurn?: string;
  blocked: boolean;
  recoveryReason?: string;
  cleanupBlocked?: boolean;
  fileHistoryOwed?: string;
  runtimeLeaseOwedByTerminalRoute?: boolean;
  mcpBusy?: boolean;
  mcpRecovering: number;
  mcpClosing?: boolean;
  hooksBusy?: boolean;
  mcp?: { recoveryBlocked(): Promise<boolean> };
  hooks?: { hasPendingOperations(): Promise<boolean> };
}

/** Reads committed evidence only; a moving or unreadable view cannot admit work. */
export async function inspectHostedRecovery(
  session: HostedRecoverySession,
  requestedPromptId?: string,
): Promise<HostedRecoveryStatus> {
  const authority = session.managed.authority;
  const sequence = authority.committedSequence;
  const pending = await authority.pendingInputsAt(sequence);
  const input = requestedPromptId
    ? await authority.findEvent('input.accepted', 'turnId', requestedPromptId, {
        throughSequence: sequence,
      })
    : await authority.findEvent('input.accepted', 'kind', 'input.accepted', {
        last: true,
        throughSequence: sequence,
      });
  const promptId =
    requestedPromptId ??
    (typeof input?.payload['turnId'] === 'string'
      ? input.payload['turnId']
      : null);
  const settled =
    promptId === null
      ? undefined
      : await authority.findEvent('turn.settled', 'turnId', promptId, {
          throughSequence: sequence,
        });
  const inputSettled =
    promptId === null || (input !== undefined && settled !== undefined);
  let continuationReady = false;
  const status = (
    state: HostedRecoveryStatus['state'],
    reasonCode: string | null,
  ): HostedRecoveryStatus => ({
    state,
    reasonCode,
    promptId,
    inputSettled,
    continuationReady,
    nextTurnAllowed: state === 'ready',
  });
  if (requestedPromptId && input === undefined)
    return status('operator_required', 'original_input_missing');
  try {
    const authorization = await authority.harnessRunAuthorization();
    const history = await readHostedFileHistory(session.managed);
    if (authority.committedSequence !== sequence)
      return status('awaiting_evidence', 'evidence_changed');
    if (authorization.status === 'initial') {
      continuationReady = inputSettled && pending.length === 0;
    } else if (authorization.status === 'runnable') {
      const checkpoint = authorization.checkpoint;
      continuationReady =
        inputSettled &&
        pending.length === 0 &&
        (promptId === null ||
          checkpoint.identity.coveredSequence >=
            (settled?.sequence ?? Infinity) - 1) &&
        checkpoint.continuation.phase === 'before_model' &&
        checkpoint.continuation.pendingEventIds.length === 0 &&
        checkpoint.attempt === null &&
        checkpoint.tools === null &&
        checkpoint.runtime === null &&
        checkpoint.approval === null &&
        (checkpoint.agentWait ?? null) === null &&
        (checkpoint.commandWait ?? null) === null;
    }
    if (
      session.active ||
      session.recoveredTurn ||
      session.mcpBusy ||
      session.mcpRecovering ||
      session.hooksBusy
    ) {
      continuationReady = false;
      return status('recovering', 'turn_active');
    }
    if (session.mcpClosing)
      return status('operator_required', 'session_closing');
    if (authorization.status === 'blocked')
      return status(
        isDurableBlockedVerdict(authorization)
          ? 'operator_required'
          : 'awaiting_evidence',
        `checkpoint_${authorization.reason}`,
      );
    if (pending.length > 0)
      return status(
        session.hooks || session.mcp
          ? 'operator_required'
          : 'awaiting_evidence',
        session.hooks || session.mcp
          ? 'unsupported_extension_recovery'
          : 'inputs_unsettled',
      );
    if (!continuationReady)
      return status('operator_required', 'continuation_unready');
    if (history?.pendingUndo)
      return status('operator_required', 'file_history_undo_pending');
    if (history?.pendingTurn || session.fileHistoryOwed)
      return status('cleanup_pending', 'file_history_pending');
    if (
      (await hasHostedCleanupDebt(session.managed)) ||
      session.runtimeLeaseOwedByTerminalRoute ||
      session.cleanupBlocked
    )
      return status('cleanup_pending', 'runtime_cleanup_pending');
    if (
      (await session.hooks?.hasPendingOperations()) ||
      (await session.mcp?.recoveryBlocked())
    )
      return status('operator_required', 'unsupported_extension_recovery');
    if (session.blocked || authority.writesStopped)
      return status(
        'awaiting_evidence',
        session.recoveryReason ?? 'recovery_blocked',
      );
    return status('ready', null);
  } catch {
    return status('awaiting_evidence', 'recovery_evidence_unavailable');
  }
}
