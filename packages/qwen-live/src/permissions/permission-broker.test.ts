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
    adaptorFor: () => adaptor as unknown as BackendAdaptor,
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
  fields?: {
    requestId?: string;
    sessionHandle?: string;
    jobRef?: string;
    title?: string;
  },
) {
  return broker.onRequest({
    requestId: fields?.requestId ?? 'r1',
    backend: BACKEND,
    sessionHandle: fields?.sessionHandle ?? 'session_1',
    ...(fields?.jobRef !== undefined ? { jobRef: fields.jobRef } : {}),
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
    expect(
      broker.pendingRequests.map((pending) => pending.requestHandle),
    ).toEqual(['req_1', 'req_2']);
    expect(
      broker.pendingUserRequests.map((pending) => pending.requestHandle),
    ).toEqual(['req_1', 'req_2']);
    expect(broker.pendingForSession('session_1')?.requestHandle).toBe('req_2');
    expect(broker.pendingForSession('session_99')).toBeUndefined();
  });

  it('keeps a replayed backend request idempotent', async () => {
    const { broker } = createBroker();
    const first = await request(broker, { requestId: 'r1' });
    const replay = await request(broker, { requestId: 'r1' });

    expect(replay.pending).toBe(first.pending);
    expect(replay.alreadyPending).toBe(true);
    expect(first.alreadyPending).toBe(false);
    expect(broker.pendingCount).toBe(1);
    expect(broker.pendingRequests[0]?.requestHandle).toBe('req_1');
  });

  it('finds pending permissions only for their exact backend job', async () => {
    const { broker } = createBroker();
    await request(broker, { requestId: 'r1', jobRef: 'job-ref-1' });
    await request(broker, { requestId: 'r2', jobRef: 'job-ref-2' });

    expect(broker.pendingForJob(BACKEND, 'job-ref-1')?.requestHandle).toBe(
      'req_1',
    );
    expect(broker.pendingForJob(BACKEND, 'job-ref-2')?.requestHandle).toBe(
      'req_2',
    );
    expect(broker.pendingForJob(BACKEND, 'job-ref-3')).toBeUndefined();
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

  it('clears pending requests when a session closes', async () => {
    const { broker } = createBroker();
    await request(broker, { requestId: 'r1', sessionHandle: 'session_1' });
    await request(broker, { requestId: 'r2', sessionHandle: 'session_2' });

    broker.clearSession('session_1');

    expect(broker.resolveHandle('req_1')).toBeUndefined();
    expect(broker.resolveHandle('req_2')).toBeDefined();
  });

  it('translates allow_always to a one-shot allow and auto-answers identical repeats', async () => {
    const { adaptor, broker } = createBroker();
    await request(broker, { requestId: 'r1', title: 'Bash: rm -rf /a' });

    await broker.respond('req_1', 'allow_always');
    // The protocol vote never carries the standing grant.
    expect(adaptor.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r1',
      'allow',
    );

    // Same session, same normalized title: the grant covers the repeat.
    const ask = await request(broker, {
      requestId: 'r2',
      title: 'Bash:  rm  -rf /a ',
    });
    expect(ask.autoAnswered).toBe(true);
    expect(adaptor.respondPermission).toHaveBeenLastCalledWith(
      BACKEND,
      'r2',
      'allow',
    );
    expect(broker.pendingCount).toBe(0);
  });

  it('scopes the standing rule to the whole approved command, not its prefix', async () => {
    const { broker } = createBroker();
    await request(broker, {
      requestId: 'r1',
      title: 'Bash: git push origin main',
    });
    await broker.respond('req_1', 'allow_always');
    await request(broker, { requestId: 'r2', title: 'Bash: rm -rf /a' });
    await broker.respond('req_2', 'allow_always');

    // A flag variant is a different command; the user approved a command,
    // not its destructive variants.
    const forced = await request(broker, {
      requestId: 'r3',
      title: 'Bash: git push --force origin main',
    });
    expect(forced.autoAnswered).toBe(false);

    // Same two-token prefix, different target: likewise not covered.
    const differentTarget = await request(broker, {
      requestId: 'r4',
      title: 'Bash: rm -rf /b',
    });
    expect(differentTarget.autoAnswered).toBe(false);

    // The identical repeat is.
    const repeat = await request(broker, {
      requestId: 'r5',
      title: 'Bash: git push origin main',
    });
    expect(repeat.autoAnswered).toBe(true);
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

    const pending = broker.onResolved(BACKEND, 'r1');
    expect(pending?.requestHandle).toBe('req_1');
    expect(broker.pendingCount).toBe(0);

    expect(broker.onResolved(BACKEND, 'r1')).toBeUndefined();
  });

  it('scopes requestIds by owning adaptor — one backend never retracts another', async () => {
    // Request ids are adaptor-local (serve UUIDs vs an ACP counter), so two
    // backends can mint the same id; a resolution from one must leave the
    // other's pending ask intact.
    const { broker } = createBroker();
    const otherBackend: BackendHandle = { id: 's1', adaptor: 'acp' };
    await request(broker, { requestId: 'perm-1' });
    await broker.onRequest({
      requestId: 'perm-1',
      backend: otherBackend,
      sessionHandle: 'session_2',
      title: 'write_file: other.txt',
      options: OPTIONS,
    });
    expect(broker.pendingCount).toBe(2);

    const resolved = broker.onResolved(BACKEND, 'perm-1');
    expect(resolved?.requestHandle).toBe('req_1');

    // The acp backend's identical id is untouched…
    expect(broker.pendingCount).toBe(1);
    // …and resolves only against its own backend.
    expect(broker.onResolved(otherBackend, 'perm-1')?.requestHandle).toBe(
      'req_2',
    );
    expect(broker.pendingCount).toBe(0);
  });

  it('logs requests and decisions with the auto flag', async () => {
    const { broker, logEvents } = createBroker();

    await request(broker, { requestId: 'r1', title: 'Bash: rm -rf /a' });
    await broker.respond('req_1', 'allow_always');
    await request(broker, { requestId: 'r2', title: 'Bash: rm -rf /a' });

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

  it("records the user's spoken constraint note in the decision log", async () => {
    const { broker, logEvents } = createBroker();
    await request(broker, { requestId: 'r1' });

    const outcome = await broker.respond('req_1', 'allow', 'only this file');

    expect(outcome).toBe('delivered');
    const decision = logEvents.find(
      (event) => event.type === 'permission.decision',
    );
    expect(decision?.payload).toMatchObject({
      requestHandle: 'req_1',
      decision: 'allow',
      note: 'only this file',
    });
  });

  it('clears the pending ask when the backend reports it already resolved', async () => {
    const { adaptor, broker } = createBroker();
    await request(broker, { requestId: 'r1' });
    adaptor.respondPermission.mockResolvedValueOnce('already_resolved');

    const outcome = await broker.respond('req_1', 'allow');

    expect(outcome).toBe('already_resolved');
    expect(broker.pendingCount).toBe(0);
    expect(broker.resolveHandle('req_1')).toBeUndefined();
    // The handle is gone: a second relay reports not_found instead of
    // re-voting on a settled request.
    expect(await broker.respond('req_1', 'allow')).toBe('not_found');
    expect(adaptor.respondPermission).toHaveBeenCalledTimes(1);
  });

  it('falls back to a spoken ask when the silent auto-approval fails to deliver', async () => {
    const { adaptor, broker, logEvents } = createBroker();
    const first = await request(broker, { requestId: 'r1' });
    await broker.respond(first.pending.requestHandle, 'allow_always');

    // The standing rule matches, but the backend is unreachable: the ask
    // must surface to the user instead of crashing the caller.
    adaptor.respondPermission.mockRejectedValueOnce(
      new Error('daemon unreachable'),
    );
    const second = await request(broker, { requestId: 'r2' });

    expect(second.autoAnswered).toBe(false);
    expect(broker.resolveHandle(second.pending.requestHandle)).toBeDefined();
    const failure = logEvents.find(
      (event) =>
        event.type === 'permission.decision' &&
        event.payload['outcome'] === 'delivery_failed',
    );
    expect(failure?.payload).toMatchObject({ auto: true, decision: 'allow' });
  });

  it('keeps the whole command after colons in the standing-rule key', async () => {
    // `git commit -m "fix: bug"` — the command itself contains a colon;
    // the key must not truncate at it (or a different -m message with the
    // same prefix would silently match).
    const { broker } = createBroker();
    await request(broker, {
      requestId: 'r1',
      title: 'Shell: git commit -m "fix: bug"',
    });
    await broker.respond('req_1', 'allow_always');

    const different = await request(broker, {
      requestId: 'r2',
      title: 'Shell: git commit -m "fix: something else entirely"',
    });
    expect(different.autoAnswered).toBe(false);

    const identical = await request(broker, {
      requestId: 'r3',
      title: 'Shell: git commit -m "fix: bug"',
    });
    expect(identical.autoAnswered).toBe(true);
  });

  it('does not case-fold the standing-rule key — /a and /A are different paths', async () => {
    const { broker } = createBroker();
    await request(broker, { requestId: 'r1', title: 'Bash: rm -rf /a' });
    await broker.respond('req_1', 'allow_always');

    const different = await request(broker, {
      requestId: 'r2',
      title: 'Bash: rm -rf /A',
    });
    expect(different.autoAnswered).toBe(false);
  });

  it('an explicit deny revokes the standing rule that matched the request', async () => {
    const { broker, adaptor } = createBroker();
    await request(broker, { requestId: 'r1', title: 'Bash: rm -rf /a' });
    await broker.respond('req_1', 'allow_always');

    // The silent auto-answer fails and falls back to a spoken ask…
    adaptor.respondPermission.mockImplementation(async () => {
      throw new Error('daemon unreachable');
    });
    const fallback = await request(broker, {
      requestId: 'r2',
      title: 'Bash: rm -rf /a',
    });
    expect(fallback.autoAnswered).toBe(false);

    // …and the user says deny. The rule must not survive the refusal.
    adaptor.respondPermission.mockImplementation(
      async () => 'delivered' as const,
    );
    await broker.respond('req_2', 'deny');
    const again = await request(broker, {
      requestId: 'r3',
      title: 'Bash: rm -rf /a',
    });
    expect(again.autoAnswered).toBe(false);
  });
});
