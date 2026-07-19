/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChannelAuthDriver,
  ChannelAuthDriverSession,
} from '@qwen-code/channel-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelManagementService } from './channel-management-service.js';
import {
  ChannelAuthSessionError,
  createChannelAuthSessionManager,
  type ChannelAuthSessionKey,
} from './channel-auth-session-manager.js';
import { daemonChannelStateDir } from './channel-state-dir.js';

const key: ChannelAuthSessionKey = {
  workspaceCwd: '/workspace/a',
  runtimeId: 'runtime-a',
  instanceName: 'bot',
  channelType: 'weixin',
  clientId: 'client-a',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function managementService(
  instanceName = key.instanceName,
  channelType = key.channelType,
): ChannelManagementService {
  return {
    list: vi.fn(async () => ({
      revision: 'r1',
      instances: {
        [instanceName]: {
          name: instanceName,
          config: { type: channelType },
          secrets: {},
          startsWithServe: false,
          runtime: { state: 'stopped' as const },
        },
      },
    })),
    upsert: vi.fn(),
    remove: vi.fn(),
    setStartup: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  };
}

interface DriverHarness {
  driver: ChannelAuthDriver<{ token: string }>;
  ready: ReturnType<typeof deferred<{ token: string }>>;
  cancel: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  setSnapshot(snapshot: {
    state: string;
    qrPayload?: string;
    qrRevision: number;
  }): void;
}

function driverHarness(): DriverHarness {
  const ready = deferred<{ token: string }>();
  const cancel = vi.fn();
  const commit = vi.fn(async () => {});
  let snapshot = {
    state: 'pending',
    qrPayload: 'https://example.test/qr?ticket=secret-ticket',
    qrRevision: 1,
  };
  const session: ChannelAuthDriverSession<{ token: string }> = {
    snapshot: () => snapshot,
    ready: ready.promise,
    cancel,
    commit,
  };
  return {
    driver: { kind: 'qr', begin: vi.fn(async () => session) },
    ready,
    cancel,
    commit,
    setSnapshot(next) {
      snapshot = next as typeof snapshot;
    },
  };
}

function createHarness(driver = driverHarness()) {
  const service = managementService();
  const manager = createChannelAuthSessionManager({
    resolve: vi.fn(async (sessionKey) => ({
      driver: driver.driver,
      managementService:
        sessionKey.instanceName === key.instanceName &&
        sessionKey.channelType === key.channelType
          ? service
          : managementService(sessionKey.instanceName, sessionKey.channelType),
    })),
  });
  return { driver, manager, service };
}

async function expectEvicted(
  manager: ReturnType<typeof createChannelAuthSessionManager>,
  sessionKey: ChannelAuthSessionKey,
  sessionId: string,
) {
  expect(() => manager.get(sessionKey, sessionId)).toThrowError(
    expect.objectContaining({ code: 'channel_auth_session_not_found' }),
  );
  expect(() => manager.getQr(sessionKey, sessionId)).toThrowError(
    expect.objectContaining({ code: 'channel_auth_session_not_found' }),
  );
  await expect(manager.commit(sessionKey, sessionId)).rejects.toMatchObject({
    code: 'channel_auth_session_not_found',
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createChannelAuthSessionManager', () => {
  it('allows one active session per exact workspace, runtime, instance, type, and client key', async () => {
    const { manager } = createHarness();
    await manager.begin(key);

    await expect(manager.begin(key)).rejects.toMatchObject({
      code: 'channel_auth_in_progress',
    });

    const variants: ChannelAuthSessionKey[] = [
      { ...key, workspaceCwd: '/workspace/b' },
      { ...key, runtimeId: 'runtime-b' },
      { ...key, instanceName: 'other' },
      { ...key, channelType: 'qqbot' },
      { ...key, clientId: 'client-b' },
    ];
    for (const variant of variants) {
      await expect(manager.begin(variant)).resolves.toMatchObject({
        state: 'awaiting_scan',
      });
    }
    manager.shutdown();
  });

  it('uses unpredictable unique UUID session identifiers', async () => {
    const { manager } = createHarness();
    const first = await manager.begin(key);
    manager.cancel(key, first.id);
    const second = await manager.begin(key);

    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(second.id).not.toBe(first.id);
    manager.shutdown();
  });

  it('requires the exact key to read, cancel, or commit a session', async () => {
    const { manager } = createHarness();
    const session = await manager.begin(key);
    const wrongOwner = { ...key, clientId: 'other-client' };

    expect(() => manager.get(wrongOwner, session.id)).toThrowError(
      expect.objectContaining({ code: 'channel_auth_session_not_found' }),
    );
    expect(() => manager.getQr(wrongOwner, session.id)).toThrowError(
      expect.objectContaining({ code: 'channel_auth_session_not_found' }),
    );
    expect(() => manager.cancel(wrongOwner, session.id)).toThrowError(
      expect.objectContaining({ code: 'channel_auth_session_not_found' }),
    );
    await expect(manager.commit(wrongOwner, session.id)).rejects.toMatchObject({
      code: 'channel_auth_session_not_found',
    });
    manager.shutdown();
  });

  it('keeps QR payloads and credentials out of public snapshots', async () => {
    const { driver, manager } = createHarness();
    const session = await manager.begin(key);

    expect(JSON.stringify(session)).not.toContain('secret-ticket');
    expect(JSON.stringify(manager.get(key, session.id))).not.toContain(
      'secret-ticket',
    );
    expect(manager.getQr(key, session.id)).toEqual({
      payload: 'https://example.test/qr?ticket=secret-ticket',
      revision: 1,
    });

    driver.ready.resolve({ token: 'final-secret-credential' });
    await vi.waitFor(() => {
      expect(manager.get(key, session.id).state).toBe('ready');
    });
    expect(JSON.stringify(manager.get(key, session.id))).not.toContain(
      'final-secret-credential',
    );
    manager.shutdown();
  });

  it('maps driver snapshots to the bounded public state contract', async () => {
    const { driver, manager } = createHarness();
    const session = await manager.begin(key);

    driver.setSnapshot({ state: 'scaned', qrRevision: 1 });
    expect(manager.get(key, session.id).state).toBe('scanned');
    driver.setSnapshot({ state: 'refreshing', qrRevision: 1 });
    expect(manager.get(key, session.id).state).toBe('refreshing');
    driver.setSnapshot({ state: 'unexpected-secret-state', qrRevision: 99 });
    expect(manager.get(key, session.id)).toMatchObject({
      state: 'error',
      qrRevision: 99,
    });
    manager.shutdown();
  });

  it('does not expose an error thrown while reading the QR payload', async () => {
    const ready = deferred<{ token: string }>();
    let snapshotCalls = 0;
    const driver: ChannelAuthDriver<{ token: string }> = {
      kind: 'qr',
      begin: vi.fn(async () => ({
        snapshot() {
          snapshotCalls++;
          if (snapshotCalls === 3) {
            throw new Error('Authorization: Bearer snapshot-secret');
          }
          return {
            state: 'pending',
            qrPayload: 'https://example.test/qr',
            qrRevision: 1,
          };
        },
        ready: ready.promise,
        cancel: vi.fn(),
        commit: vi.fn(),
      })),
    };
    const manager = createChannelAuthSessionManager({
      resolve: async () => ({
        driver,
        managementService: managementService(),
      }),
    });
    const session = await manager.begin(key);

    expect(() => manager.getQr(key, session.id)).toThrowError(
      expect.objectContaining({
        code: 'channel_auth_failed',
        message: expect.not.stringContaining('snapshot-secret'),
      }),
    );
    expect(manager.get(key, session.id)).toMatchObject({
      state: 'error',
      error: expect.not.stringContaining('snapshot-secret'),
    });
  });

  it('clears temporary credentials and cancels the driver on expiry', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-19T00:00:00.000Z') });
    const { driver, manager } = createHarness();
    const session = await manager.begin(key);
    driver.ready.resolve({ token: 'final-secret-credential' });
    await vi.waitFor(() => {
      expect(manager.get(key, session.id).state).toBe('ready');
    });

    await vi.advanceTimersByTimeAsync(600_001);

    expect(manager.get(key, session.id).state).toBe('expired');
    expect(driver.cancel).toHaveBeenCalledOnce();
    await expect(manager.commit(key, session.id)).rejects.toMatchObject({
      code: 'channel_auth_expired',
    });
    manager.shutdown();
  });

  it('ignores credentials that become ready after cancellation or expiry', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-19T00:00:00.000Z') });
    const first = createHarness();
    const cancelled = await first.manager.begin(key);
    first.manager.cancel(key, cancelled.id);
    first.driver.ready.resolve({ token: 'late-cancelled-secret' });
    await Promise.resolve();
    await expect(first.manager.commit(key, cancelled.id)).rejects.toMatchObject(
      { code: 'channel_auth_cancelled' },
    );

    const second = createHarness();
    const expired = await second.manager.begin(key);
    await vi.advanceTimersByTimeAsync(600_001);
    second.driver.ready.resolve({ token: 'late-expired-secret' });
    await Promise.resolve();
    await expect(second.manager.commit(key, expired.id)).rejects.toMatchObject({
      code: 'channel_auth_expired',
    });
    first.manager.shutdown();
    second.manager.shutdown();
  });

  it('cancels matching sessions on workspace removal and all sessions on shutdown', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-19T00:00:00.000Z') });
    const { driver, manager } = createHarness();
    const inRemovedRuntime = await manager.begin(key);
    const otherRuntime = await manager.begin({
      ...key,
      runtimeId: 'runtime-b',
    });
    expect(vi.getTimerCount()).toBe(2);

    manager.removeWorkspace(key.workspaceCwd, key.runtimeId);

    await expectEvicted(manager, key, inRemovedRuntime.id);
    expect(vi.getTimerCount()).toBe(1);
    expect(
      manager.get({ ...key, runtimeId: 'runtime-b' }, otherRuntime.id).state,
    ).toBe('awaiting_scan');
    manager.shutdown();
    await expectEvicted(
      manager,
      { ...key, runtimeId: 'runtime-b' },
      otherRuntime.id,
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(driver.cancel).toHaveBeenCalledTimes(2);
  });

  it('commits ready credentials exactly once under concurrent calls', async () => {
    const harness = driverHarness();
    const committing = deferred<void>();
    harness.commit.mockImplementation(async () => committing.promise);
    const { manager } = createHarness(harness);
    const session = await manager.begin(key);
    harness.ready.resolve({ token: 'ready-secret' });
    await vi.waitFor(() => {
      expect(manager.get(key, session.id).state).toBe('ready');
    });

    const first = manager.commit(key, session.id);
    const second = manager.commit(key, session.id);
    expect(() => manager.cancel(key, session.id)).toThrowError(
      expect.objectContaining({ code: 'channel_auth_commit_in_progress' }),
    );
    await expect(second).rejects.toMatchObject({
      code: 'channel_auth_commit_in_progress',
    });
    expect(harness.commit).toHaveBeenCalledOnce();
    expect(harness.commit).toHaveBeenCalledWith({ token: 'ready-secret' });

    committing.resolve();
    await expect(first).resolves.toMatchObject({ state: 'committed' });
    await expect(manager.commit(key, session.id)).rejects.toMatchObject({
      code: 'channel_auth_already_committed',
    });
    expect(harness.commit).toHaveBeenCalledOnce();
    manager.shutdown();
  });

  it('commits an undefined credential value exactly once', async () => {
    const ready = deferred<undefined>();
    const commit = vi.fn(async (_credentials: undefined) => {});
    const driver: ChannelAuthDriver<undefined> = {
      kind: 'qr',
      begin: vi.fn(async () => ({
        snapshot: () => ({
          state: 'pending',
          qrPayload: 'https://example.test/qr',
          qrRevision: 1,
        }),
        ready: ready.promise,
        cancel: vi.fn(),
        commit,
      })),
    };
    const manager = createChannelAuthSessionManager({
      resolve: async () => ({
        driver,
        managementService: managementService(),
      }),
    });
    const session = await manager.begin(key);
    ready.resolve(undefined);
    await vi.waitFor(() => {
      expect(manager.get(key, session.id).state).toBe('ready');
    });

    await expect(manager.commit(key, session.id)).resolves.toMatchObject({
      state: 'committed',
    });
    await expect(manager.commit(key, session.id)).rejects.toMatchObject({
      code: 'channel_auth_already_committed',
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(undefined);
  });

  it('does not overwrite shutdown cancellation with a late commit result', async () => {
    const harness = driverHarness();
    const committing = deferred<void>();
    harness.commit.mockImplementation(async () => committing.promise);
    const { manager } = createHarness(harness);
    const session = await manager.begin(key);
    harness.ready.resolve({ token: 'ready-secret' });
    await vi.waitFor(() => {
      expect(manager.get(key, session.id).state).toBe('ready');
    });

    const commit = manager.commit(key, session.id);
    manager.shutdown();
    await expectEvicted(manager, key, session.id);
    committing.resolve();

    await expect(commit).rejects.toMatchObject({
      code: 'channel_auth_cancelled',
    });
    await expectEvicted(manager, key, session.id);
    expect(harness.commit).toHaveBeenCalledOnce();
  });

  it('does not let a driver cancellation failure break credential cleanup', async () => {
    const harness = driverHarness();
    harness.cancel.mockImplementation(() => {
      throw new Error('Authorization: Bearer cancellation-secret');
    });
    const { manager } = createHarness(harness);
    const session = await manager.begin(key);
    harness.ready.resolve({ token: 'ready-secret' });
    await vi.waitFor(() => {
      expect(manager.get(key, session.id).state).toBe('ready');
    });

    expect(() => manager.cancel(key, session.id)).not.toThrow();
    expect(manager.get(key, session.id).state).toBe('cancelled');
    await expect(manager.commit(key, session.id)).rejects.toMatchObject({
      code: 'channel_auth_cancelled',
    });
  });

  it('reports a failed commit as terminal without retrying it', async () => {
    const harness = driverHarness();
    harness.commit.mockRejectedValue(
      new Error(`Authorization: Bearer commit-secret\n${'x'.repeat(1_000)}`),
    );
    const { manager } = createHarness(harness);
    const session = await manager.begin(key);
    harness.ready.resolve({ token: 'ready-secret' });
    await vi.waitFor(() => {
      expect(manager.get(key, session.id).state).toBe('ready');
    });

    await expect(manager.commit(key, session.id)).rejects.toMatchObject({
      code: 'channel_auth_commit_failed',
      message: expect.not.stringContaining('commit-secret'),
    });
    expect(manager.get(key, session.id)).toMatchObject({
      state: 'error',
      error: expect.not.stringContaining('commit-secret'),
    });
    await expect(manager.commit(key, session.id)).rejects.toMatchObject({
      code: 'channel_auth_failed',
    });
    expect(harness.commit).toHaveBeenCalledOnce();
  });

  it('retains then evicts committed, cancelled, expired, and error tombstones', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-19T00:00:00.000Z') });
    const retainThenEvict = async (
      manager: ReturnType<typeof createChannelAuthSessionManager>,
      sessionId: string,
      state: 'committed' | 'cancelled' | 'expired' | 'error',
    ) => {
      expect(manager.get(key, sessionId).state).toBe(state);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(manager.get(key, sessionId).state).toBe(state);
      await vi.advanceTimersByTimeAsync(1);
      await expectEvicted(manager, key, sessionId);
    };

    const committedHarness = createHarness();
    const committed = await committedHarness.manager.begin(key);
    committedHarness.driver.ready.resolve({ token: 'ready-secret' });
    await Promise.resolve();
    await committedHarness.manager.commit(key, committed.id);
    await retainThenEvict(committedHarness.manager, committed.id, 'committed');

    const cancelledHarness = createHarness();
    const cancelled = await cancelledHarness.manager.begin(key);
    cancelledHarness.manager.cancel(key, cancelled.id);
    await retainThenEvict(cancelledHarness.manager, cancelled.id, 'cancelled');

    const expiredHarness = createHarness();
    const expired = await expiredHarness.manager.begin(key);
    await vi.advanceTimersByTimeAsync(600_000);
    await retainThenEvict(expiredHarness.manager, expired.id, 'expired');

    const errorHarness = createHarness();
    const failed = await errorHarness.manager.begin(key);
    errorHarness.driver.ready.reject(new Error('driver failed'));
    await Promise.resolve();
    await retainThenEvict(errorHarness.manager, failed.id, 'error');
  });

  it('evicts repeated terminal cycles without retaining timers or sessions', async () => {
    vi.useFakeTimers({ now: new Date('2026-07-19T00:00:00.000Z') });
    const { manager } = createHarness();
    const ids: string[] = [];

    for (let index = 0; index < 100; index++) {
      const session = await manager.begin(key);
      ids.push(session.id);
      manager.cancel(key, session.id);
    }
    expect(vi.getTimerCount()).toBe(100);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.getTimerCount()).toBe(0);
    for (const id of ids) await expectEvicted(manager, key, id);
    await expect(manager.begin(key)).resolves.toMatchObject({
      state: 'awaiting_scan',
    });
    manager.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed when the configured instance type does not match the key', async () => {
    const harness = driverHarness();
    const manager = createChannelAuthSessionManager({
      resolve: async () => ({
        driver: harness.driver,
        managementService: managementService(key.instanceName, 'qqbot'),
      }),
    });

    await expect(manager.begin(key)).rejects.toMatchObject({
      code: 'channel_auth_instance_mismatch',
    });
    expect(harness.driver.begin).not.toHaveBeenCalled();
  });

  it('derives the credential directory from the exact workspace, instance, and type key', async () => {
    const { driver, manager } = createHarness();

    await manager.begin(key);

    expect(driver.driver.begin).toHaveBeenCalledWith({
      channelName: key.instanceName,
      stateDir: daemonChannelStateDir(
        key.workspaceCwd,
        key.instanceName,
        key.channelType,
      ),
      signal: expect.any(AbortSignal),
    });
    manager.shutdown();
  });

  it('sanitizes, redacts, and bounds driver errors in snapshots', async () => {
    const { driver, manager } = createHarness();
    const session = await manager.begin(key);
    driver.ready.reject(
      new Error(`Authorization: Bearer super-secret\n${'x'.repeat(1_000)}`),
    );

    await vi.waitFor(() => {
      expect(manager.get(key, session.id).state).toBe('error');
    });
    const snapshot = manager.get(key, session.id);
    expect(snapshot.error).not.toContain('super-secret');
    expect(snapshot.error).not.toContain('\n');
    expect([...snapshot.error!]).toHaveLength(512);
    expect(snapshot.error).toContain('<redacted>');
    manager.shutdown();
  });

  it('exposes stable coded errors without leaking arbitrary causes', () => {
    const error = new ChannelAuthSessionError('test_code', 'safe message');
    expect(error).toMatchObject({ code: 'test_code', message: 'safe message' });
    expect(JSON.stringify(error)).not.toContain('stack');
  });
});
