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
});
