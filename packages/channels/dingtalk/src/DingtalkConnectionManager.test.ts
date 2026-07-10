import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DingtalkConnectionManager,
  type DingtalkConnectionManagerOptions,
} from './DingtalkConnectionManager.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  ping = vi.fn();
}

class FakeClient {
  connected = true;
  registered = true;
  socket = new FakeSocket();
  connect = vi.fn(async () => undefined);
  disconnect = vi.fn();
}

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createManager(
  initialClient: FakeClient,
  overrides: Partial<DingtalkConnectionManagerOptions<FakeClient>> = {},
): DingtalkConnectionManager<FakeClient> {
  return new DingtalkConnectionManager({
    initialClient,
    createClient: () => new FakeClient(),
    getSocket: (client) => client.socket,
    onClientChanged: () => undefined,
    log: () => undefined,
    ...overrides,
  });
}

describe('DingtalkConnectionManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects the initial client and stops it idempotently', async () => {
    const initialClient = new FakeClient();
    const onClientChanged = vi.fn();
    const manager = createManager(initialClient, { onClientChanged });

    await manager.start();
    manager.stop();
    manager.stop();

    expect(initialClient.connect).toHaveBeenCalledOnce();
    expect(onClientChanged).toHaveBeenCalledOnce();
    expect(onClientChanged).toHaveBeenCalledWith(initialClient);
    expect(initialClient.disconnect).toHaveBeenCalledOnce();
  });

  it('does not publish a client before its stream is registered', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    initialClient.connected = false;
    initialClient.registered = false;
    initialClient.socket.readyState = 0;
    const onClientChanged = vi.fn();
    const manager = createManager(initialClient, { onClientChanged });

    const start = manager.start();
    await Promise.resolve();

    expect(onClientChanged).not.toHaveBeenCalled();

    initialClient.connected = true;
    initialClient.registered = true;
    initialClient.socket.readyState = 1;
    await vi.advanceTimersByTimeAsync(100);
    await start;

    expect(onClientChanged).toHaveBeenCalledWith(initialClient);
    manager.stop();
  });

  it('allows startup to be retried after the initial connect fails', async () => {
    const initialClient = new FakeClient();
    initialClient.connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('invalid endpoint'))
      .mockResolvedValueOnce(undefined);
    const manager = createManager(initialClient);

    await expect(manager.start()).rejects.toThrow('invalid endpoint');
    await manager.start();

    expect(initialClient.connect).toHaveBeenCalledTimes(2);
    expect(initialClient.disconnect).toHaveBeenCalledOnce();
    manager.stop();
  });

  it('replaces the client after two consecutive missed heartbeats', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const replacement = new FakeClient();
    const createClient = vi.fn(() => replacement);
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    await vi.advanceTimersByTimeAsync(40_000);

    expect(createClient).toHaveBeenCalledOnce();
    manager.stop();
  });

  it('keeps a connection that responds to every heartbeat', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const createClient = vi.fn(() => new FakeClient());
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    for (let tick = 0; tick < 3; tick++) {
      await vi.advanceTimersByTimeAsync(20_000);
      initialClient.socket.emit('pong');
    }

    expect(initialClient.socket.ping).toHaveBeenCalledTimes(3);
    expect(createClient).not.toHaveBeenCalled();
    manager.stop();
  });

  it('reconnects instead of propagating a socket ping failure', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    initialClient.socket.ping.mockImplementation(() => {
      throw new Error('WebSocket is not open');
    });
    const createClient = vi.fn(() => new FakeClient());
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(createClient).toHaveBeenCalledOnce();
    manager.stop();
  });

  it('retries a failed replacement after one second', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const failedReplacement = new FakeClient();
    failedReplacement.connect = vi.fn().mockRejectedValue(new Error('offline'));
    const recoveredClient = new FakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(failedReplacement)
      .mockReturnValueOnce(recoveredClient);
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    initialClient.socket.emit('close');
    await vi.advanceTimersByTimeAsync(999);
    expect(createClient).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(failedReplacement.disconnect).toHaveBeenCalledOnce();
    expect(initialClient.disconnect).toHaveBeenCalledOnce();
    manager.stop();
  });

  it('retries when creating a replacement client throws', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const recoveredClient = new FakeClient();
    const createClient = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('client construction failed');
      })
      .mockReturnValueOnce(recoveredClient);
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    initialClient.socket.emit('close');
    await vi.advanceTimersByTimeAsync(999);
    expect(createClient).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(createClient).toHaveBeenCalledTimes(2);
    manager.stop();
  });

  it('caps reconnect backoff at thirty seconds', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const createClient = vi.fn(() => {
      const client = new FakeClient();
      client.connect = vi.fn().mockRejectedValue(new Error('offline'));
      return client;
    });
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    initialClient.socket.emit('close');
    await vi.advanceTimersByTimeAsync(61_000);

    expect(createClient).toHaveBeenCalledTimes(7);
    manager.stop();
  });

  it('coalesces simultaneous reconnect signals', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const pendingConnect = deferredPromise<void>();
    const createClient = vi.fn(() => {
      const client = new FakeClient();
      client.connect = vi.fn(() => pendingConnect.promise);
      return client;
    });
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    initialClient.socket.emit('close');
    initialClient.socket.emit('error', new Error('closed'));
    manager.requestReconnect(initialClient, 'SYSTEM disconnect');

    expect(createClient).toHaveBeenCalledOnce();
    manager.stop();
    pendingConnect.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('replaces the client immediately after a socket error', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const createClient = vi.fn(() => new FakeClient());
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    initialClient.socket.emit('error', new Error('network failure'));
    await vi.advanceTimersByTimeAsync(0);

    expect(createClient).toHaveBeenCalledOnce();
    manager.stop();
  });

  it('ignores reconnect signals from a replaced client', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const replacement = new FakeClient();
    const createClient = vi.fn(() => replacement);
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    initialClient.socket.emit('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(createClient).toHaveBeenCalledOnce();
    expect(initialClient.disconnect).toHaveBeenCalledOnce();

    manager.requestReconnect(initialClient, 'late close');
    expect(createClient).toHaveBeenCalledOnce();
    manager.stop();
  });

  it('keeps a healthy replacement when old-client cleanup fails', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    initialClient.disconnect.mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    const replacement = new FakeClient();
    const onClientChanged = vi.fn();
    const log = vi.fn();
    const manager = createManager(initialClient, {
      createClient: () => replacement,
      onClientChanged,
      log,
    });
    await manager.start();

    initialClient.socket.emit('close');
    await vi.advanceTimersByTimeAsync(0);

    expect(onClientChanged).toHaveBeenLastCalledWith(replacement);
    expect(replacement.disconnect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'));
    manager.stop();
  });

  it('replaces a client after two unhealthy state checks', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const createClient = vi.fn(() => new FakeClient());
    const manager = createManager(initialClient, { createClient });
    await manager.start();
    initialClient.connected = false;
    initialClient.registered = false;

    for (let tick = 0; tick < 6; tick++) {
      manager.noteActivity(initialClient);
      await vi.advanceTimersByTimeAsync(20_000);
    }

    expect(createClient).toHaveBeenCalledOnce();
    manager.stop();
  });

  it('cancels a pending retry when stopped', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const failedReplacement = new FakeClient();
    failedReplacement.connect = vi.fn().mockRejectedValue(new Error('offline'));
    const createClient = vi.fn(() => failedReplacement);
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    initialClient.socket.emit('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    manager.stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('resets reconnect backoff after a successful replacement', async () => {
    vi.useFakeTimers();
    const initialClient = new FakeClient();
    const firstFailure = new FakeClient();
    firstFailure.connect = vi.fn().mockRejectedValue(new Error('offline'));
    const firstRecovery = new FakeClient();
    const secondFailure = new FakeClient();
    secondFailure.connect = vi.fn().mockRejectedValue(new Error('offline'));
    const secondRecovery = new FakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(firstFailure)
      .mockReturnValueOnce(firstRecovery)
      .mockReturnValueOnce(secondFailure)
      .mockReturnValueOnce(secondRecovery);
    const manager = createManager(initialClient, { createClient });
    await manager.start();

    initialClient.socket.emit('close');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(createClient).toHaveBeenCalledTimes(2);

    firstRecovery.socket.emit('close');
    await vi.advanceTimersByTimeAsync(999);
    expect(createClient).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(createClient).toHaveBeenCalledTimes(4);
    manager.stop();
  });
});
