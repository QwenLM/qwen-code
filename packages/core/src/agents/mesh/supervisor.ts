/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The loop that keeps booked work moving.
 *
 * Runs **inside the hidden host session**, not in the daemon. The design
 * originally placed the dispatcher daemon-side, but the launcher and the
 * background-agent registry live in the host session's process, and the first
 * live slice was driven by hand from exactly there. Ticking where the state is
 * means `inspect` is a local registry read and a start needs no round trip;
 * the daemon's only job is to keep this session resident. That is decision (a)
 * in the design's §5.2 step 6, and it is why nothing here talks over ACP.
 *
 * Two guards make it safe to run unattended:
 *
 * - **Only the claimed host dispatches.** The workspace record names one host
 *   session. A second copy of this loop — a stale session the reaper did not
 *   get to, or a session that lost the claim race — must never start a body,
 *   or one agent would have two.
 * - **Ticks never overlap.** A slow launch must not let the next interval
 *   start a second pass over the same queued runs. A tick requested while one
 *   is in flight joins it and receives its outcome rather than being refused,
 *   so a caller that wants "the state after the next pass" always gets one.
 *
 * Deliberately polling. A post written by the daemon's REST route lands in the
 * store, not in this process, and the design treats in-process notifications
 * as hints rather than the source of truth. A few seconds of latency is the
 * price of never missing a durable trigger.
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  dispatchOnce,
  type DispatchRecord,
  type MeshDispatchPort,
} from './dispatcher.js';
import { readMeshAgents, readMeshWorkspace } from './mesh-store.js';

const log = createDebugLogger('MESH_SUPERVISOR');

/** Long enough that an idle workspace costs nothing noticeable, short enough
 * that a person posting sees the agent start before they wonder. */
export const DEFAULT_MESH_SUPERVISOR_INTERVAL_MS = 2_000;

export type MeshTickOutcome =
  | { kind: 'dispatched'; records: DispatchRecord[] }
  | { kind: 'not_claimed_host'; claimedBy?: string }
  | { kind: 'no_roster' }
  | { kind: 'error'; error: string };

export interface MeshSupervisor {
  /** One pass, now. Returns what it decided; never throws. */
  tick(): Promise<MeshTickOutcome>;
  stop(): void;
}

export interface StartMeshSupervisorInput {
  projectRoot: string;
  /** This process's session id; dispatch only while it holds the claim. */
  sessionId: string;
  port: MeshDispatchPort;
  intervalMs?: number;
  /** Observers for tests and for the daemon's status surface. */
  onTick?: (outcome: MeshTickOutcome) => void;
}

export function startMeshSupervisor(
  input: StartMeshSupervisorInput,
): MeshSupervisor {
  const intervalMs = input.intervalMs ?? DEFAULT_MESH_SUPERVISOR_INTERVAL_MS;
  let inFlight: Promise<MeshTickOutcome> | undefined;
  let stopped = false;

  const pass = async (): Promise<MeshTickOutcome> => {
    const workspace = await readMeshWorkspace(input.projectRoot);
    if (workspace.hostSessionId !== input.sessionId) {
      return {
        kind: 'not_claimed_host',
        ...(workspace.hostSessionId
          ? { claimedBy: workspace.hostSessionId }
          : {}),
      };
    }
    const agents = await readMeshAgents(input.projectRoot);
    if (agents.length === 0) return { kind: 'no_roster' };
    const records = await dispatchOnce(input.projectRoot, input.port);
    return { kind: 'dispatched', records };
  };

  const runPass = async (): Promise<MeshTickOutcome> => {
    let outcome: MeshTickOutcome;
    try {
      outcome = await pass();
    } catch (error) {
      outcome = {
        kind: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      log.warn(`dispatch pass failed: ${outcome.error}`);
    }
    if (outcome.kind === 'dispatched' && outcome.records.length > 0) {
      log.debug(
        `dispatched: ${outcome.records
          .map((record) => `${record.agentId}=${record.kind}`)
          .join(' ')}`,
      );
    }
    input.onTick?.(outcome);
    return outcome;
  };

  const tick = (): Promise<MeshTickOutcome> => {
    if (inFlight) return inFlight;
    inFlight = runPass().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const timer = setInterval(() => {
    if (stopped) return;
    void tick();
  }, intervalMs);
  timer.unref?.();
  // The first pass runs now: a host that was just revived has work waiting
  // for it, and making it wait a full interval is a visible pause.
  void tick();

  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
