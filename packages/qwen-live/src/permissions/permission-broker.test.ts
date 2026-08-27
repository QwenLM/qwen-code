/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  BackendAdaptor,
  BackendHandle,
  PermissionOption,
} from '../adaptor/types.js';
import { PermissionBroker } from './permission-broker.js';

const BACKEND: BackendHandle = { id: 's1', adaptor: 'fake' };

const OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow', kind: 'proceed' },
  { optionId: 'deny', kind: 'reject' },
];

function createAdaptor() {
  return {
    respondPermission: vi.fn(
      async (): Promise<'delivered' | 'already_resolved'> => 'delivered',
    ),
  };
}

type FakeAdaptor = ReturnType<typeof createAdaptor>;

interface Rig {
  adaptor: FakeAdaptor;
  broker: PermissionBroker;
  clock: { now: number };
  logEvents: Array<{ type: string; payload: Record<string, unknown> }>;
}

function createBroker(options?: { ruleTtlMs?: number }): Rig {
  const adaptor = createAdaptor();
  const clock = { now: 1_000_000 };
  const logEvents: Rig['logEvents'] = [];
  const broker = new PermissionBroker({
    adaptor: adaptor as unknown as BackendAdaptor,
    now: () => clock.now,
    ...(options?.ruleTtlMs !== undefined
      ? { ruleTtlMs: options.ruleTtlMs }
      : {}),
    log: (type, payload) => {
      logEvents.push({ type, payload });
    },
  });
  return { adaptor, broker, clock, logEvents };
}

function request(
  broker: PermissionBroker,
  fields?: { requestId?: string; sessionHandle?: string; title?: string },
) {
  return broker.onRequest({
    requestId: fields?.requestId ?? 'r1',
    backend: BACKEND,
    sessionHandle: fields?.sessionHandle ?? 'session_1',
    title: fields?.title ?? 'Bash: rm -rf /a',
    options: OPTIONS,
  });
}

describe('PermissionBroker', () => {
  it('records pending asks with incrementing handles when no rule matches', async () => {
    const { adaptor, broker } = createBroker();

    const first = await request(broker, { requestId: 'r1' });
    expect(first.autoAnswered).toBe(false);
    expect(first.pending.requestHandle).toBe('req_1');
    expect(first.pending.requestId).toBe('r1');
    expect(first.pending.sessionHandle).toBe('session_1');

    const second = await request(broker, { requestId: 'r2' });
    expect(second.autoAnswered).toBe(false);
    expect(second.pending.requestHandle).toBe('req_2');

    expect(broker.pendingCount).toBe(2);
    expect(adaptor.respondPermission).not.toHaveBeenCalled();
  });

  it('delivers an allow vote and clears the pending ask', async () => {
    const { adaptor, broker } = createBroker();
    await request(broker, { requestId: 'r1' });

    const outcome = await broker.respond('req_1', 'allow');

    expect(outcome).toBe('delivered');
    expect(adaptor.respondPermission).toHaveBeenCalledWith(
      BACKEND,
      'r1',
      'allow',
    );
    expect(broker.pendingCount).toBe(0);
    expect(broker.resolveHandle('req_1')).toBeUndefined();
  });

  it('translates allow_always to a one-shot allow and auto-answers similar requests', async () => {
    const { adaptor, broker } = createBroker();
    await request(broker, { requestId: 'r1', title: 'Bash: rm -rf /a' });

    await broker.respond('req_1', 'allow_always');
    // The protocol vote never carries the standing grant.
    expect(adaptor.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r1',
      'allow',
    );

    // Same session, same title key (tool name + first detail word).
    const ask = await request(broker, {
      requestId: 'r2',
      title: 'Bash: rm -rf /b',
    });
    expect(ask.autoAnswered).toBe(true);
    expect(adaptor.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r2',
      'allow',
    );
    expect(broker.pendingCount).toBe(0);
  });

  it('does not auto-answer requests with a different title key', async () => {
    const { broker } = createBroker();
    await request(broker, { requestId: 'r1', title: 'Bash: rm -rf /a' });
    await broker.respond('req_1', 'allow_always');

    const ask = await request(broker, {
      requestId: 'r2',
      title: 'Bash: ls -la',
    });
    expect(ask.autoAnswered).toBe(false);
  });

  it('stops auto-answering once the standing rule expires', async () => {
    const { broker, clock } = createBroker({ ruleTtlMs: 60_000 });
    await request(broker, { requestId: 'r1' });
    await broker.respond('req_1', 'allow_always');

    clock.now += 59_999;
    const beforeExpiry = await request(broker, { requestId: 'r2' });
    expect(beforeExpiry.autoAnswered).toBe(true);

    clock.now += 2;
    const afterExpiry = await request(broker, { requestId: 'r3' });
    expect(afterExpiry.autoAnswered).toBe(false);
  });

  it('scopes standing rules to the session that granted them', async () => {
    const { broker } = createBroker();
    await request(broker, { requestId: 'r1', sessionHandle: 'session_1' });
    await broker.respond('req_1', 'allow_always');

    const otherSession = await request(broker, {
      requestId: 'r2',
      sessionHandle: 'session_2',
    });
    expect(otherSession.autoAnswered).toBe(false);
  });

  it('delivers deny votes and reports unknown handles', async () => {
    const { adaptor, broker } = createBroker();
    await request(broker, { requestId: 'r1' });

    const denied = await broker.respond('req_1', 'deny');
    expect(denied).toBe('delivered');
    expect(adaptor.respondPermission).toHaveBeenCalledWith(
      BACKEND,
      'r1',
      'deny',
    );

    const missing = await broker.respond('req_99', 'allow');
    expect(missing).toBe('not_found');
    expect(adaptor.respondPermission).toHaveBeenCalledTimes(1);
  });

  it('onResolved returns the pending ask once and clears it', async () => {
    const { broker } = createBroker();
    await request(broker, { requestId: 'r1' });

    const pending = broker.onResolved('r1');
    expect(pending?.requestHandle).toBe('req_1');
    expect(broker.pendingCount).toBe(0);

    expect(broker.onResolved('r1')).toBeUndefined();
  });

  it('logs requests and decisions with the auto flag', async () => {
    const { broker, logEvents } = createBroker();

    await request(broker, { requestId: 'r1', title: 'Bash: rm -rf /a' });
    await broker.respond('req_1', 'allow_always');
    await request(broker, { requestId: 'r2', title: 'Bash: rm -rf /b' });

    expect(logEvents.map((event) => event.type)).toEqual([
      'permission.request',
      'permission.decision',
      'permission.request',
      'permission.decision',
    ]);
    expect(logEvents[0]?.payload).toMatchObject({
      requestHandle: 'req_1',
      requestId: 'r1',
      session: 'session_1',
      title: 'Bash: rm -rf /a',
    });
    expect(logEvents[1]?.payload).toMatchObject({
      requestHandle: 'req_1',
      decision: 'allow',
      auto: false,
      outcome: 'delivered',
    });
    expect(logEvents[3]?.payload).toMatchObject({
      requestHandle: 'req_2',
      requestId: 'r2',
      decision: 'allow',
      auto: true,
    });
  });
});
