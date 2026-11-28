/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedSessionStoreHttpError,
  type ManagedEventIngestReceipt,
  type ManagedEventIngestRequest,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import { describe, expect, it, vi } from 'vitest';
import { startHostedEventIngest } from './event-ingest.js';
import type { HostedSession } from './session-state.js';

const PROMPT = '11111111-1111-4111-8111-111111111111';

function delta(sequence: number) {
  return {
    v: 1 as const,
    sequence,
    eventId: `event-${sequence}`,
    kind: 'message.delta',
    occurredAt: sequence,
    payload: { text: `t${sequence}`, turnId: PROMPT, messageId: 'message-1' },
  };
}

function fixture(
  count: number,
  replies: Array<
    (request: ManagedEventIngestRequest) => Promise<ManagedEventIngestReceipt>
  >,
) {
  const events = Array.from({ length: count }, (_, index) => delta(index + 1));
  const requests: ManagedEventIngestRequest[] = [];
  const ingestEvents = vi.fn(async (request: ManagedEventIngestRequest) => {
    requests.push(request);
    const reply = replies.shift();
    return reply
      ? reply(request)
      : {
          cursor: request.throughSequence,
          leaseRenewAfterMillis: 60_000,
          terminal: false,
        };
  });
  const session = {
    streams: new Set<() => void>(),
    blocked: false,
    active: { promptId: PROMPT },
    stores: { ingestEvents },
    managed: {
      authority: {
        get committedSequence() {
          return events.length;
        },
        sessionHeader: { sessionKey: { sessionId: 'session-1' } },
        readEvents: ({
          afterSequence,
          limit,
        }: {
          afterSequence: number;
          limit: number;
        }) =>
          events
            .filter((event) => event.sequence > afterSequence)
            .slice(0, limit),
        eventsInSequenceRange: (from: number, to: number) =>
          events.filter(
            (event) => event.sequence >= from && event.sequence <= to,
          ),
      },
    },
  } as unknown as HostedSession;
  const start = (afterSequence: number) =>
    startHostedEventIngest({
      session,
      sessionId: 'session-1',
      epoch: 'epoch_1',
      promptId: PROMPT,
      turnId: 'turn_1',
      afterSequence,
      intervalMs: 5,
    });
  return { session, events, requests, ingestEvents, start };
}

const settled = async (request: ManagedEventIngestRequest) => ({
  cursor: request.throughSequence,
  leaseRenewAfterMillis: 60_000,
  terminal: true,
});

describe('startHostedEventIngest', () => {
  it('pushes the envelopes after the admission cursor and stops once the Turn settles', async () => {
    const { session, requests, start } = fixture(3, [settled]);
    start(1);

    await vi.waitFor(() => expect(session.streams.size).toBe(0));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      eventEpoch: 'epoch_1',
      turnId: 'turn_1',
      promptId: PROMPT,
      afterSequence: 1,
      throughSequence: 3,
    });
    expect(
      (requests[0]!.events as Array<{ id: number }>).map((event) => event.id),
    ).toEqual([2, 3]);
    expect(session.eventIngests?.size).toBe(0);
  });

  it('resumes from the cursor the control plane reports', async () => {
    const { session, requests, start } = fixture(3, [
      async () => {
        throw new ManagedSessionStoreHttpError(
          409,
          'managed_event_ingest_cursor_mismatch',
          'behind',
          undefined,
          { cursor: 0 },
        );
      },
      settled,
    ]);
    start(2);

    await vi.waitFor(() => expect(session.streams.size).toBe(0));
    expect(requests.map((request) => request.afterSequence)).toEqual([2, 0]);
    expect(
      (requests[1]!.events as Array<{ id: number }>).map((event) => event.id),
    ).toEqual([1, 2, 3]);
  });

  it('retries before the admission is recorded and stops when the Turn is not its own', async () => {
    const refusal = (code: string) => async () => {
      throw new ManagedSessionStoreHttpError(409, code, code);
    };
    const { session, requests, start } = fixture(1, [
      refusal('managed_event_ingest_not_ready'),
      refusal('managed_event_ingest_not_owner'),
    ]);
    start(0);

    await vi.waitFor(() => expect(session.streams.size).toBe(0));
    expect(requests).toHaveLength(2);
  });

  it('ends with the recovery-blocked marker once no prompt is active and the journal is drained', async () => {
    const { session, requests, start } = fixture(2, []);
    session.active = undefined;
    session.blocked = true;
    start(0);

    await vi.waitFor(() => expect(session.streams.size).toBe(0));
    expect(requests.at(-1)).toMatchObject({
      throughSequence: 2,
      end: 'recovery_blocked',
    });
  });

  it('retries a refused recovery-blocked marker on the next tick', async () => {
    const { session, events, requests, start } = fixture(2, [
      async () => {
        events.push(delta(3));
        throw new ManagedSessionStoreHttpError(
          409,
          'managed_event_ingest_end_refused',
          'The end marker does not follow the committed journal.',
        );
      },
    ]);
    session.active = undefined;
    session.blocked = true;
    start(0);

    await vi.waitFor(() => expect(session.streams.size).toBe(0));
    expect(
      requests.map(({ throughSequence, end }) => [throughSequence, end]),
    ).toEqual([
      [2, 'recovery_blocked'],
      [3, 'recovery_blocked'],
    ]);
  });

  it('drains multiple batches before sending the parked marker', async () => {
    const { session, events, requests, start } = fixture(2, []);
    const ingest = start(0);
    await ingest.pause();
    for (let sequence = 3; sequence <= 130; sequence++) {
      events.push(delta(sequence));
    }

    await ingest.flush();
    expect(requests.every((request) => request.end === undefined)).toBe(true);
    await ingest.park();

    expect(
      requests.map(({ afterSequence, throughSequence, events, end }) => [
        afterSequence,
        throughSequence,
        events.length,
        end,
      ]),
    ).toEqual([
      [0, 2, 2, undefined],
      [2, 66, 64, undefined],
      [66, 130, 64, undefined],
      [130, 130, 0, 'parked'],
    ]);
    expect(session.streams.size).toBe(0);
  });

  it('parks with the remaining tail after the seal', async () => {
    const { session, requests, start } = fixture(2, []);
    const ingest = start(0);
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    await ingest.park();

    expect(requests.at(-1)).toMatchObject({
      afterSequence: 2,
      throughSequence: 2,
      end: 'parked',
    });
    expect(session.streams.size).toBe(0);
  });
});
