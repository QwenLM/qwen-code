/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedSessionStoreHttpError,
  ManagedSessionStoreTransportError,
  type ManagedEventIngestRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import { eventEnvelope } from './observation-routes.js';
import type { HostedSession } from './session-state.js';

const MAX_EVENTS = 64;
const NOT_READY_LIMIT_MS = 60_000;
const DEFAULT_RENEW_AFTER_MS = 20_000;

/** Pushes one admitted Turn's committed envelopes to the control plane. */
export interface HostedEventIngest {
  /** Stops pushing and waits for a request in flight. */
  pause(): Promise<void>;
  /** After a clean seal: posts the remaining tail with the park marker. */
  park(): Promise<void>;
  stop(): void;
}

export function startHostedEventIngest(options: {
  readonly session: HostedSession;
  readonly sessionId: string;
  readonly epoch: string;
  readonly promptId: string;
  readonly turnId: string;
  readonly afterSequence: number;
  readonly intervalMs?: number;
}): HostedEventIngest {
  const { session, sessionId, epoch, promptId, turnId } = options;
  const stores = session.stores!;
  const authority = session.managed.authority;
  let cursor = options.afterSequence;
  // The deltas already streamed through `seededThrough`, as the events
  // route keeps them, so a committed message never projects a second chunk.
  let streamedDeltaIds = new Set<string>();
  let seededThrough = -1;
  let renewAfterMs = DEFAULT_RENEW_AFTER_MS;
  let lastSentAt = 0;
  let notReadySince: number | undefined;
  let stopped = false;
  let paused = false;
  let inFlight: Promise<void> | undefined;

  const finish = (): void => {
    stopped = true;
    clearInterval(timer);
    session.streams.delete(stop);
    if (session.eventIngests?.get(promptId) === handle)
      session.eventIngests.delete(promptId);
  };
  const stop = (): void => finish();

  const batch = async (): Promise<{ events: unknown[]; through: number }> => {
    if (seededThrough !== cursor) {
      streamedDeltaIds = new Set(
        authority
          .eventsInSequenceRange(1, cursor)
          .filter((event) => event.kind === 'message.delta')
          .map((event) => event.payload['messageId'] as string),
      );
    }
    const events: unknown[] = [];
    let through = cursor;
    for (const event of authority.readEvents({
      afterSequence: cursor,
      limit: MAX_EVENTS,
    })) {
      events.push(await eventEnvelope(session, event, streamedDeltaIds));
      through = event.sequence;
    }
    seededThrough = through;
    return { events, through };
  };

  const send = async (request: ManagedEventIngestRequest): Promise<void> => {
    try {
      const receipt = await stores.ingestEvents(request);
      notReadySince = undefined;
      lastSentAt = Date.now();
      cursor = receipt.cursor;
      renewAfterMs = receipt.leaseRenewAfterMillis;
      if (receipt.terminal || request.end !== undefined) finish();
      return;
    } catch (cause) {
      if (cause instanceof ManagedSessionStoreTransportError) return;
      if (cause instanceof ManagedSessionStoreHttpError) {
        const reported = cause.details?.['cursor'];
        if (
          cause.remoteCode === 'managed_event_ingest_cursor_mismatch' &&
          typeof reported === 'number'
        ) {
          cursor = reported;
          return;
        }
        if (cause.remoteCode === 'managed_event_ingest_not_ready') {
          notReadySince ??= Date.now();
          if (Date.now() - notReadySince < NOT_READY_LIMIT_MS) return;
        } else if (cause.status >= 500 || cause.contentionExhausted) {
          return;
        }
      }
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${sessionId} stopped event ingest for ${promptId}: ${String(cause)}`,
      );
      finish();
    }
  };

  // The control plane's recovery probe, evaluated where its evidence lives.
  const recoveryBlocked = (): boolean =>
    session.active === undefined &&
    session.recoveredTurn === undefined &&
    (session.blocked ||
      (session.mcp?.recoveryBlocked ?? false) ||
      (session.hooks?.hasPendingOperations ?? false));

  const tick = async (): Promise<void> => {
    if (stopped || paused || inFlight) return;
    inFlight = (async () => {
      const { events, through } = await batch();
      const blocked =
        through === authority.committedSequence && recoveryBlocked();
      if (
        events.length === 0 &&
        !blocked &&
        Date.now() - lastSentAt < renewAfterMs
      )
        return;
      await send({
        eventEpoch: epoch,
        turnId,
        promptId,
        afterSequence: cursor,
        throughSequence: through,
        events,
        ...(blocked ? { end: 'recovery_blocked' as const } : {}),
      });
    })()
      .catch((cause: unknown) => {
        writeStderrLineSafe(
          `qwen serve: Hosted Session ${sessionId} event ingest failed: ${String(cause)}`,
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
    await inFlight;
  };

  const handle: HostedEventIngest = {
    async pause() {
      paused = true;
      clearInterval(timer);
      await inFlight;
    },
    async park() {
      await handle.pause();
      if (stopped) return;
      try {
        const { events, through } = await batch();
        if (through === authority.committedSequence)
          await send({
            eventEpoch: epoch,
            turnId,
            promptId,
            afterSequence: cursor,
            throughSequence: through,
            events,
            end: 'parked',
          });
      } catch (cause) {
        writeStderrLineSafe(
          `qwen serve: Hosted Session ${sessionId} park marker failed: ${String(cause)}`,
        );
      } finally {
        finish();
      }
    },
    stop,
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? 250);
  timer.unref();
  session.eventIngests?.get(promptId)?.stop();
  session.eventIngests ??= new Map();
  session.eventIngests.set(promptId, handle);
  session.streams.add(stop);
  void tick();
  return handle;
}
