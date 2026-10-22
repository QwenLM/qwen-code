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
  mcp?: { readonly recoveryBlocked: boolean };
  hooks?: { readonly hasPendingOperations: boolean };
}

/** Reads committed evidence only; a moving or unreadable view cannot admit work. */
export async function inspectHostedRecovery(
  session: HostedRecoverySession,
  requestedPromptId?: string,
): Promise<HostedRecoveryStatus> {
  const authority = session.managed.authority;
  const sequence = authority.committedSequence;
  const events = authority.eventsInSequenceRange(1, sequence);
  const pending = new Set<string>();
  const accepted = new Set<string>();
  const settled = new Map<string, number>();
  for (const event of events) {
    const turnId = event.payload['turnId'];
    if (typeof turnId !== 'string') continue;
    if (event.kind === 'input.accepted') {
      accepted.add(turnId);
      pending.add(turnId);
    } else if (event.kind === 'turn.settled') {
      pending.delete(turnId);
      settled.set(turnId, event.sequence);
    }
  }
  const promptId = requestedPromptId ?? [...accepted].at(-1) ?? null;
  const inputSettled =
    promptId === null || (accepted.has(promptId) && !pending.has(promptId));
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
  if (requestedPromptId && !accepted.has(requestedPromptId))
    return status('operator_required', 'original_input_missing');
  try {
    const authorization = await authority.harnessRunAuthorization();
    const history = await readHostedFileHistory(session.managed);
    if (authority.committedSequence !== sequence)
      return status('awaiting_evidence', 'evidence_changed');
    if (authorization.status === 'initial') {
      continuationReady = inputSettled && pending.size === 0;
    } else if (authorization.status === 'runnable') {
      const checkpoint = authorization.checkpoint;
      continuationReady =
        inputSettled &&
        pending.size === 0 &&
        (promptId === null ||
          checkpoint.identity.coveredSequence >=
            (settled.get(promptId) ?? Infinity) - 1) &&
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
    if (pending.size > 0)
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
      hasHostedCleanupDebt(session.managed) ||
      session.runtimeLeaseOwedByTerminalRoute ||
      session.cleanupBlocked
    )
      return status('cleanup_pending', 'runtime_cleanup_pending');
    if (session.hooks?.hasPendingOperations || session.mcp?.recoveryBlocked)
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
