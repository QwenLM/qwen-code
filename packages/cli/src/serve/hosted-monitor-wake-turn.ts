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
import type { HostedChildAgentSession } from './hosted-child-agent-session.js';
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
}): (
  turn: HostedMonitorWakeTurn,
) => Promise<'settled' | 'busy' | 'recovery' | 'settled_incomplete'> {
  const { session } = params;
  return async (turn) => {
    if (params.busy() || session.blocked) return 'busy';
    const attempted = await session.managed.sink.project();
    if (wakeHasPriorAttempt(attempted, turn.turnId)) {
      // The notification ran and died inside the turn it started.
      // Re-driving it text-only would mint a second user record and an
      // unanswered first call in the model's history, so it is for the
      // recovery fleet, never for the pump. Distinct from 'settled', so a
      // caller tracking the turn settles its stop the honest way.
      session.blocked = true;
      params.writeStderr(
        'qwen serve: Monitor wake turn ' +
          turn.turnId +
          ' needs recovery, not a re-drive.',
      );
      return 'recovery';
    }
    // The busy verdict must be re-read after every journal read: a prompt
    // route's own claim in this window would otherwise be cleared here,
    // losing its turn instead of queuing this one.
    if (params.busy() || session.blocked) return 'busy';
    const abort = new AbortController();
    session.active = { promptId: turn.turnId, digest: '', abort };
    let turnResult: { systemPayload?: Record<string, unknown> } | null;
    try {
      turnResult = (await params.executeHostedTurn(
        turn.turnId,
        turn.text,
        abort,
      )) as { systemPayload?: Record<string, unknown> } | null;
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
        return 'recovery';
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
    // A settled turn burns the input either way, so the pump still
    // advances — but only a completed one proves the child result was
    // delivered to the model: anything cancelled or errored answers
    // 'settled_incomplete', which the consumption gate refuses.
    return turnResult?.systemPayload?.['state'] === 'completed'
      ? 'settled'
      : 'settled_incomplete';
  };
}

/**
 * H4b: the wake turn marks the delivered child result consumed only when
 * the turn itself completed. {@link createMonitorWakeRunTurn}'s
 * `'settled'` also answers the two blocked branches (a prior unfinished
 * attempt, a recovery-required error), where the Turn and its input
 * deliberately stay unsettled — those branches set `blocked`, which a
 * genuine settle never does, so the block flag is the witness that the
 * consumption must not commit. A cancelled or errored settle answers
 * `'settled_incomplete'`: the pump advances past the burned input, the
 * consumption gate does not fire, and the acceptance stays at
 * `accepting` — owed evidence that a settled record, never a resend,
 * reconciles.
 */
export function withChildAgentConsumption(
  runWakeTurn: (
    turn: HostedMonitorWakeTurn,
  ) => Promise<'settled' | 'settled_incomplete' | 'busy'>,
  session: {
    blocked: boolean;
    childAgents?: HostedChildAgentSession;
  },
  writeStderr: (line: string) => void = () => {},
): (
  turn: HostedMonitorWakeTurn,
) => Promise<'settled' | 'settled_incomplete' | 'busy'> {
  return async (turn) => {
    const outcome = await runWakeTurn(turn);
    if (
      outcome === 'settled' &&
      !session.blocked &&
      turn.source === 'child_agent' &&
      turn.turnId.endsWith(':accept:notify') &&
      session.childAgents
    ) {
      try {
        await session.childAgents.markConsumed(
          turn.turnId.slice(0, -':accept:notify'.length),
        );
      } catch (cause) {
        // The wake settled the input durably already: a rejected consume
        // commit must never turn that completed turn into a Session
        // block — the acceptance stays at `accepting`, owed evidence the
        // relay's own deliver arm reconciles.
        writeStderr(
          'qwen serve: Hosted acceptance consumption faltered (owed evidence kept): ' +
            String(cause),
        );
      }
    }
    return outcome;
  };
}
