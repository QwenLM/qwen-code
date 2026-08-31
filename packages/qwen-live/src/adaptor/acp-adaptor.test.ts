/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import type { Client } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveLogger } from '../logger.js';
import { AcpAdaptor, type AcpConnectionLike } from './acp-adaptor.js';
import type { BackendEvent } from './types.js';

/**
 * In-process fake connection. The adaptor hands its Client to `connect`;
 * the fake captures it so tests can drive inbound notifications, ext
 * methods, and permission requests exactly like a real child would.
 */
class FakeConnection implements AcpConnectionLike {
  client!: Client;
  initialized!: Promise<Record<string, unknown>>;
  promptCalls: Array<Record<string, unknown>> = [];
  cancelCalls: Array<Record<string, unknown>> = [];
  extCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  authCalls: Array<Record<string, unknown>> = [];
  sessionSeq = 0;
  /** Resolve the in-flight prompt; defaults to end_turn. */
  settlePrompt: (stopReason?: string, error?: unknown) => void = () => {};
  /** Reject newSession once with this, then succeed. */
  newSessionError: unknown = undefined;
  private promptWaiter?: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  };

  constructor(
    private readonly initializeResponse: Record<string, unknown> = {},
  ) {}

  connect(): (
    client: Client,
    onExit: (info: { code: number | null; signal: string | null }) => void,
  ) => Promise<AcpConnectionLike> {
    return (client, onExit) => {
      this.client = client;
      this.onExit = onExit;
      this.initialized = Promise.resolve({
        agentInfo: { name: 'fake' },
        agentCapabilities: {
          promptCapabilities: { image: true },
        },
        authMethods: [{ id: 'openai' }],
        ...this.initializeResponse,
      });
      return Promise.resolve(this);
    };
  }

  onExit: (info: { code: number | null; signal: string | null }) => void =
    () => {};

  initialize(): Promise<Record<string, unknown>> {
    return this.initialized;
  }

  authenticate(params: Record<string, unknown>): Promise<unknown> {
    this.authCalls.push(params);
    return Promise.resolve({});
  }

  newSession(): Promise<Record<string, unknown>> {
    if (this.newSessionError !== undefined) {
      const error = this.newSessionError;
      this.newSessionError = undefined;
      return Promise.reject(error);
    }
    this.sessionSeq += 1;
    return Promise.resolve({ sessionId: `acp-${this.sessionSeq}` });
  }

  prompt(params: Record<string, unknown>): Promise<{ stopReason?: string }> {
    this.promptCalls.push(params);
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pendingStopReason = 'end_turn';
    this.promptWaiter = { promise, resolve, reject };
    return promise.then(() => ({ stopReason: this.pendingStopReason }));
  }

  pendingStopReason: string = 'end_turn';

  cancel(params: Record<string, unknown>): Promise<void> {
    this.cancelCalls.push(params);
    return Promise.resolve();
  }

  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.extCalls.push({ method, params });
    return Promise.resolve({});
  }

  setSessionMode(params: Record<string, unknown>): Promise<unknown> {
    this.setModeCalls.push(params);
    return Promise.resolve({});
  }

  setModeCalls: Array<Record<string, unknown>> = [];

  settle(stopReason = 'end_turn', error?: unknown): void {
    const waiter = this.promptWaiter;
    this.promptWaiter = undefined;
    if (waiter === undefined) return;
    if (error !== undefined) waiter.reject(error);
    else {
      this.pendingStopReason = stopReason;
      waiter.resolve({});
    }
  }

  // Inbound helpers driving the adaptor's client handlers.
  update(sessionId: string, update: Record<string, unknown>): void {
    void this.client.sessionUpdate({ sessionId, update } as never);
  }

  drain(sessionId: string): void {
    void this.client.extMethod?.('craft/drainMidTurnQueue', { sessionId });
  }

  speak(sessionId: string, message: string): void {
    void this.client.extMethod?.('qwen/control/live/speak-to-user', {
      callerSessionId: sessionId,
      message,
    });
  }

  unknownMethod(): void {
    void this.client.extMethod?.('some/other/method', {});
  }
}

const logger: LiveLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as LiveLogger;

function makeAdaptor(connection: FakeConnection): AcpAdaptor {
  return new AcpAdaptor({
    name: 'acp',
    command: 'unused',
    defaultCwd: '/ws',
    logger,
    connect: connection.connect(),
  });
}

/** Collects events while subscribed; never resolves on its own. */
function eventCollector(adaptor: AcpAdaptor, sessionId: string) {
  const events: BackendEvent[] = [];
  const subscribed = (async () => {
    for await (const event of adaptor.events({
      id: sessionId,
      adaptor: 'acp',
    })) {
      events.push(event);
    }
  })();
  return {
    events,
    /** Resolves once the given predicate holds over the collected events. */
    waitFor: async (
      predicate: (events: readonly BackendEvent[]) => boolean,
    ): Promise<readonly BackendEvent[]> => {
      await vi.waitFor(() => {
        if (!predicate(events)) throw new Error('events not ready');
      });
      return events;
    },
    /** Resolves when the stream ends (session_closed was consumed). */
    ended: subscribed.then(() => events),
  };
}

const adaptors: AcpAdaptor[] = [];

afterEach(async () => {
  for (const adaptor of adaptors.splice(0)) await adaptor.close();
});

describe('AcpAdaptor sessions and receipts', () => {
  it('preflight initializes and captures image capability', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    await adaptor.preflight();
    expect(adaptor.capabilities().imageInput).toBe(true);
    // authenticate was attempted (authMethods advertised openai)
    expect(connection.authCalls).toHaveLength(1);
  });

  it('authenticates and retries when newSession returns auth_required', async () => {
    const connection = new FakeConnection();
    connection.newSessionError = Object.assign(new Error('auth required'), {
      code: -32000,
    });
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    expect(handle.adaptor).toBe('acp');
    expect(connection.authCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts an idle prompt and emits turn lifecycle events', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    await adaptor.preflight();
    const handle = await adaptor.createSession({ cwd: '/ws' });

    const collector = eventCollector(adaptor, handle.id);
    const receipt = await adaptor.prompt(handle, [
      { type: 'text', text: 'do it' },
    ]);
    expect(receipt).toEqual({ status: 'accepted', jobRef: 'turn-1' });
    connection.update(handle.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { text: 'working' },
    });
    connection.settle('end_turn');
    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'turn_complete'),
    );

    expect(events).toEqual([
      { type: 'turn_started', jobRef: 'turn-1' },
      {
        type: 'turn_complete',
        jobRef: 'turn-1',
        summary: 'working',
        detail: 'working',
      },
    ]);
  });

  it('maps stopReasons to turn_error semantics', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });

    const cases: Array<[string, string]> = [
      ['cancelled', 'cancelled'],
      ['refusal', 'the agent declined to continue the task'],
    ];
    for (const [stopReason, expected] of cases) {
      const collector = eventCollector(adaptor, handle.id);
      await adaptor.prompt(handle, [{ type: 'text', text: 'go' }]);
      connection.settle(stopReason);
      const events = await collector.waitFor((collected) =>
        collected.some((event) => event.type === 'turn_error'),
      );
      expect(events[events.length - 1]).toMatchObject({
        type: 'turn_error',
        error: expected,
      });
    }
  });

  it('steers into the drain queue once the agent has drained', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    await adaptor.preflight();
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    expect(adaptor.isBusy(handle)).toBe(true);

    // Before any drain: honest 'queued', never a joinedActiveTurn lie.
    const before = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'also this' }],
      { steer: true },
    );
    expect(before).toMatchObject({ status: 'queued' });

    connection.drain(handle.id);
    const after = await adaptor.prompt(
      handle,
      [{ type: 'text', text: 'and that' }],
      { steer: true },
    );
    expect(after).toMatchObject({
      status: 'accepted',
      joinedActiveTurn: true,
      jobRef: 'turn-1',
    });
  });

  it('delivers queued prompts and undrained steers after the turn ends', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    const queued = await adaptor.prompt(handle, [
      { type: 'text', text: 'second task' },
    ]);
    expect(queued).toMatchObject({ status: 'queued', jobRef: 'turn-2' });

    const collector = eventCollector(adaptor, handle.id);
    connection.settle('end_turn');
    await vi.waitFor(() => {
      expect(connection.promptCalls).toHaveLength(2);
    });
    connection.settle('end_turn');
    const events = await collector.waitFor(
      (collected) =>
        collected.filter((event) => event.type === 'turn_complete').length ===
        2,
    );
    // The queued prompt starts under its pre-minted jobRef, not a new one.
    expect(
      events.map(
        (event) => `${event.type}:${'jobRef' in event ? event.jobRef : ''}`,
      ),
    ).toEqual([
      'turn_started:turn-1',
      'turn_complete:turn-1',
      'turn_started:turn-2',
      'turn_complete:turn-2',
    ]);
  });

  it('rejects when the queue is full', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'first' }]);
    for (let index = 0; index < 8; index++) {
      await adaptor.prompt(handle, [{ type: 'text', text: `q${index}` }]);
    }
    const overflow = await adaptor.prompt(handle, [
      { type: 'text', text: 'one too many' },
    ]);
    expect(overflow).toMatchObject({ status: 'rejected' });
    expect(String(overflow.note)).toContain('queue is full');
  });

  it('surfaces a crashed child to every session and rejects stale handles', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    await adaptor.prompt(handle, [{ type: 'text', text: 'running' }]);

    const collector = eventCollector(adaptor, handle.id);
    connection.onExit({ code: 1, signal: null });
    const events = await collector.ended;
    // Cascade order: busy turn errored, then closed.
    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'turn_error',
      'session_closed',
    ]);

    const stale = await adaptor.prompt(handle, [
      { type: 'text', text: 'again' },
    ]);
    expect(stale).toMatchObject({ status: 'rejected' });

    // The next createSession respawns a fresh generation and works.
    const fresh = await adaptor.createSession({ cwd: '/ws' });
    expect(fresh.id).toBe('acp-2');
    const freshReceipt = await adaptor.prompt(fresh, [
      { type: 'text', text: 'after respawn' },
    ]);
    expect(freshReceipt).toMatchObject({ status: 'accepted' });
  });

  it('responds to speak-to-user and ignores unknown ext methods', async () => {
    const connection = new FakeConnection();
    const adaptor = makeAdaptor(connection);
    adaptors.push(adaptor);
    const handle = await adaptor.createSession({ cwd: '/ws' });
    const collector = eventCollector(adaptor, handle.id);

    connection.speak(handle.id, 'the tests passed');
    connection.update(handle.id, {
      sessionUpdate: 'something-unknown',
      anything: true,
    });
    // Unknown update kinds never throw; speak lands as a speak event.
    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'speak'),
    );
    expect(events).toContainEqual({ type: 'speak', text: 'the tests passed' });
  });
});

describe('AcpAdaptor real child lifecycle', () => {
  const fixturePath = join(
    fileURLToPath(
      new URL('../../test-fixtures/fake-acp-agent.mjs', import.meta.url),
    ),
  );

  function spawnedAdaptor(): AcpAdaptor {
    return new AcpAdaptor({
      name: 'acp',
      command: process.execPath,
      args: [fixturePath],
      defaultCwd: '/tmp',
      logger,
    });
  }

  it('spawns, initializes, runs a prompt round-trip, and closes', async () => {
    const adaptor = spawnedAdaptor();
    adaptors.push(adaptor);
    await adaptor.preflight();
    expect(adaptor.capabilities().imageInput).toBe(true);
    const handle = await adaptor.createSession({ cwd: '/tmp' });

    const collector = eventCollector(adaptor, handle.id);
    const receipt = await adaptor.prompt(handle, [
      { type: 'text', text: 'hello fixture' },
    ]);
    expect(receipt).toMatchObject({ status: 'accepted', jobRef: 'turn-1' });
    const events = await collector.waitFor((collected) =>
      collected.some((event) => event.type === 'turn_complete'),
    );
    expect(events).toEqual([
      { type: 'turn_started', jobRef: 'turn-1' },
      {
        type: 'turn_complete',
        jobRef: 'turn-1',
        summary: 'echo: hello fixture',
        detail: 'echo: hello fixture',
      },
    ]);
  });

  it('fails preflight in milliseconds when the child crashes at boot', async () => {
    const adaptor = new AcpAdaptor({
      name: 'acp',
      command: process.execPath,
      args: [fixturePath],
      defaultCwd: '/tmp',
      logger,
      env: { FAKE_ACP_MODE: 'crash-after-init' },
    });
    adaptors.push(adaptor);
    const started = Date.now();
    await expect(adaptor.preflight()).rejects.toThrow();
    // The 10s handshake timeout must not be the failure path.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
