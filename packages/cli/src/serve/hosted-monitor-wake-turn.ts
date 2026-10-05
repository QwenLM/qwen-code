/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { ManagedSessionRecordSink } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-record-sink.js';
import { randomUUID } from 'node:crypto';
import type { HostedMonitorWakeTurn } from './hosted-monitor-wake.js';
import { wakeHasPriorAttempt } from './hosted-monitor-wake.js';
import { HostedToolRecoveryRequiredError } from './hosted-workspace-tool-turn.js';
import { HostedMcpRecoveryRequiredError } from './hosted-mcp-session.js';
import { HostedHookRecoveryRequiredError } from './hosted-hook-session.js';

/**
 * The Session's one wake-recovery classification, shared by its wiring
 * and its witnesses — the classes do not set `name`, so matching by name
 * would silently consume every recovery exception while the wiring stays
 * green, which is exactly how the round-9 regression shipped.
 */
export function monitorWakeNeedsRecovery(cause: unknown): boolean {
  return (
    cause instanceof HostedToolRecoveryRequiredError ||
    cause instanceof HostedMcpRecoveryRequiredError ||
    cause instanceof HostedHookRecoveryRequiredError
  );
}

// H3 of #12827: the wake turn's admission arm, lifted out of the Session
// builder so the pump's own integrity rule — the busy verdict must be
// re-read after every journal read — can be verified directly rather than
// behind a private closure. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

/** The narrow slice of the Session the wake turn writes and reads. */
export interface MonitorWakeTurnSession {
  session: {
    active?: {
      readonly promptId: string;
      readonly digest: string;
      readonly abort: AbortController;
    };
    blocked: boolean;
    managed: {
      sink: Pick<ManagedSessionRecordSink, 'project' | 'write'>;
    };
  };
}

export function createMonitorWakeRunTurn(params: {
  readonly session: MonitorWakeTurnSession['session'];
  readonly sessionId: string;
  readonly cwd: string;
  readonly executeHostedTurn: (
    promptId: string,
    text: string,
    abort: AbortController,
  ) => Promise<unknown>;
  readonly busy: () => boolean;
  /**
   * The recovery-required classification. It is injected because the three
   * RecoveryRequiredError classes must be matched by type — their
   * constructors never assign `name`, so every instance reads `name ===
   * 'Error'` and a name comparison silently reclassifies a recovery
   * exception as an ordinary failure, settling its unconsumed input.
   */
  readonly needsRecovery: (cause: unknown) => boolean;
  readonly writeStderr: (line: string) => void;
}): (turn: HostedMonitorWakeTurn) => Promise<'settled' | 'busy'> {
  const { session } = params;
  return async (turn) => {
    if (params.busy() || session.blocked) return 'busy';
    const attempted = await session.managed.sink.project();
    if (wakeHasPriorAttempt(attempted, turn.turnId)) {
      // The notification ran and died inside the turn it started.
      // Re-driving it text-only would mint a second user record and an
      // unanswered first call in the model's history, so it is for the
      // recovery fleet, never for the pump.
      session.blocked = true;
      params.writeStderr(
        'qwen serve: Monitor wake turn ' +
          turn.turnId +
          ' needs recovery, not a re-drive.',
      );
      return 'settled';
    }
    // The busy verdict must be re-read after every journal read: a prompt
    // route's own claim in this window would otherwise be cleared here,
    // losing its turn instead of queuing this one.
    if (params.busy() || session.blocked) return 'busy';
    const abort = new AbortController();
    session.active = { promptId: turn.turnId, digest: '', abort };
    try {
      await params.executeHostedTurn(turn.turnId, turn.text, abort);
    } catch (cause) {
      if (params.needsRecovery(cause)) {
        // Something parked mid-turn: a later settle or takeover consumes
        // the input, exactly like a parked prompt.
        session.blocked = true;
        params.writeStderr(
          'qwen serve: Monitor wake turn ' +
            turn.turnId +
            ' is recovery blocked: ' +
            String(cause),
        );
        return 'settled';
      }
      try {
        await session.managed.sink.write({
          uuid: randomUUID(),
          parentUuid: null,
          sessionId: params.sessionId,
          timestamp: new Date().toISOString(),
          type: 'system',
          cwd: params.cwd,
          version: 'hosted-harness/1',
          subtype: 'turn_result',
          systemPayload: {
            promptId: turn.turnId,
            state: 'error',
            stopReason: 'error',
            endedAt: Date.now(),
          },
        } as ChatRecord);
      } catch {
        // The settle log is best-effort; the pump's caller decides what a
        // lost journal write means.
      }
      throw cause;
    } finally {
      session.active = undefined;
    }
    return 'settled';
  };
}
