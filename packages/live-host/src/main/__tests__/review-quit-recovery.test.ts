import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { liveMessage } from '@qwen-code/qwen-live/i18n';
import {
  LiveDaemonConnection,
  type ConnectionSnapshot,
} from '../daemon-connection.ts';
import { BoundedReconnectPolicy } from '../reconnect-policy.ts';
import {
  LIVE_PROTOCOL_VERSION,
  MAX_SOCKET_BUFFERED_BYTES,
  encodeOutputAudioFrame,
} from '../../shared/protocol.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  mock.restoreAll();
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function waitFor(check: () => boolean, description: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert(check(), description);
}

async function fixture(
  options: {
    standalone?: boolean;
    welcomeNonce?: string;
    protocolVersion?: number;
    handleQuit?: (response: ServerResponse, attempt: number) => void;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-host-review-quit-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const discovery = join(directory, 'daemon.json');
  const nonce = 'review_authenticated_instance_01';
  const requests: Array<{ url?: string; nonce?: string | string[] }> = [];
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200).end('alive');
      return;
    }
    requests.push({
      url: request.url,
      nonce: request.headers['x-qwen-live-nonce'],
    });
    if (options.handleQuit) options.handleQuit(response, requests.length);
    else
      response
        .writeHead(200)
        .end(JSON.stringify({ stopped: true, instanceNonce: nonce }));
  });
  const peers = new WebSocketServer({ server });
  const stopHttp = async () => {
    for (const peer of peers.clients) peer.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  cleanup.push(async () => {
    peers.close();
    await stopHttp();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const record = {
    url: `http://127.0.0.1:${address.port}`,
    token: 'review-fixture-token',
    protocolVersion: LIVE_PROTOCOL_VERSION,
    pid: process.pid,
    instanceNonce: nonce,
  };
  await writeFile(discovery, JSON.stringify(record), { mode: 0o600 });
  let handshakes = 0;
  let firstPeer: WebSocket | undefined;
  peers.on('connection', (peer) => {
    handshakes++;
    firstPeer ??= peer;
    peer.once('message', () => {
      peer.send(
        JSON.stringify({
          type: 'host.welcome',
          protocolVersion: options.protocolVersion ?? LIVE_PROTOCOL_VERSION,
          daemonInstanceNonce: options.welcomeNonce ?? nonce,
          ...(options.standalone !== false ? { daemonShutdownV1: true } : {}),
          heartbeatIntervalMs: 10_000,
          epoch: 7,
          status: {
            v: 1,
            available: true,
            state: 'listening',
            shortcut: 'Command+E',
          },
        }),
      );
    });
  });
  const snapshots: ConnectionSnapshot[] = [];
  let outputFrames = 0;
  const connection = new LiveDaemonConnection(
    '0.0.6',
    {
      getReadiness: () => ({
        permissions: {
          microphone: 'granted',
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        selfChecks: {
          audioInput: true,
          audioOutput: true,
          globalShortcut: true,
          appshot: true,
        },
      }),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onOutputAudio: () => {
        outputFrames++;
      },
      onOutputAudioFinished: () => undefined,
      onClearOutput: () => undefined,
    },
    discovery,
    { policy: new BoundedReconnectPolicy([5, 5, 5], 0) },
  );
  cleanup.push(() => connection.stop());
  connection.start();
  await waitFor(
    () =>
      snapshots.some((snapshot) =>
        ['ready', 'error', 'incompatible'].includes(snapshot.phase),
      ),
    'Host handshake settled',
  );
  assert(firstPeer);
  return {
    connection,
    peer: firstPeer,
    requests,
    snapshots,
    record,
    discovery,
    server,
    stopHttp,
    handshakes: () => handshakes,
    outputFrames: () => outputFrames,
  };
}

describe('Host Quit review recovery regressions', () => {
  for (const invalid of ['nonce', 'version'] as const) {
    it(`preserves the ${invalid} rejection after its WebSocket closes`, async () => {
      const value = await fixture(
        invalid === 'nonce'
          ? { welcomeNonce: 'unverified_instance_0001' }
          : { protocolVersion: LIVE_PROTOCOL_VERSION - 1 },
      );
      await waitFor(
        () => value.peer.readyState === WebSocket.CLOSED,
        'Rejected peer closes',
      );
      await delay(20);
      assert.equal(
        value.connection.getSnapshot().phase,
        invalid === 'nonce' ? 'error' : 'incompatible',
      );
      assert.equal(
        value.connection.getSnapshot().error,
        invalid === 'nonce' ? 'daemon_identity' : 'host_version',
      );
    });
  }

  it('does not retain a ready snapshot after failed shared stop and socket close', async () => {
    const value = await fixture({ standalone: false });
    const internals = value.connection as unknown as { socket: WebSocket };
    Object.defineProperty(internals.socket, 'bufferedAmount', {
      configurable: true,
      value: MAX_SOCKET_BUFFERED_BYTES + 1,
    });
    await assert.rejects(value.connection.requestQuit());
    assert.deepEqual(value.connection.getSnapshot(), {
      phase: 'error',
      error: liveMessage('host.error.quitUnconfirmed'),
    });
    const closed = once(value.peer, 'close');
    value.peer.close(1001, 'fixture disconnection after failed stop');
    await closed;
    await delay(20);
    assert.notEqual(
      value.connection.getSnapshot().phase,
      'ready',
      `After closed peer: ${JSON.stringify(value.connection.getSnapshot())}`,
    );
  });

  it('latches a failed shared Quit against late state, errors and media until explicit retry', async () => {
    const value = await fixture({ standalone: false });
    const internals = value.connection as unknown as { socket: WebSocket };
    Object.defineProperty(internals.socket, 'bufferedAmount', {
      configurable: true,
      value: MAX_SOCKET_BUFFERED_BYTES + 1,
    });
    await assert.rejects(value.connection.requestQuit());
    const failed = value.connection.getSnapshot();
    assert.equal(failed.phase, 'error');
    Reflect.deleteProperty(internals.socket, 'bufferedAmount');
    const before = [...value.snapshots];
    for (const message of [
      {
        type: 'host.state',
        epoch: 8,
        status: {
          v: 1,
          available: true,
          state: 'listening',
          shortcut: 'Command+E',
        },
      },
      { type: 'host.error', code: 'provider_config' },
    ]) {
      value.peer.send(JSON.stringify(message));
      await delay(20);
      assert.deepEqual(value.connection.getSnapshot(), failed);
    }
    const output = encodeOutputAudioFrame(7, 1, Buffer.alloc(8));
    assert(output);
    value.peer.send(output, { binary: true });
    await delay(20);
    assert.equal(value.outputFrames(), 0);
    assert.equal(value.connection.getEpoch(), 7);
    assert.equal(value.connection.sendAudio(Buffer.alloc(8), 7), false);
    assert.equal(
      value.connection.sendAction({
        type: 'host.action',
        action: 'toggle',
        epoch: 7,
      }),
      false,
    );
    value.connection.start();
    value.connection.reconnectNow();
    value.connection.forceReconnectNow();
    assert.equal(value.handshakes(), 1);
    assert.deepEqual(value.snapshots, before);
    const action = once(value.peer, 'message');
    await value.connection.requestQuit();
    assert.deepEqual(JSON.parse(String((await action)[0])), {
      type: 'host.action',
      action: 'stop',
      epoch: 7,
    });
  });

  it('still sends a stop frame when retrying the same shared connection', async () => {
    const value = await fixture({ standalone: false });
    const internals = value.connection as unknown as { socket: WebSocket };
    Object.defineProperty(internals.socket, 'bufferedAmount', {
      configurable: true,
      value: MAX_SOCKET_BUFFERED_BYTES + 1,
    });
    await assert.rejects(value.connection.requestQuit());
    Reflect.deleteProperty(internals.socket, 'bufferedAmount');
    const messages: unknown[] = [];
    value.peer.once('message', (data) =>
      messages.push(JSON.parse(String(data))),
    );
    await value.connection.requestQuit();
    await waitFor(
      () => messages.length === 1,
      'Retry must not resolve without sending the shared stop frame',
    );
    assert.deepEqual(messages, [
      { type: 'host.action', action: 'stop', epoch: 7 },
    ]);
    assert.equal(value.requests.length, 0);
    assert.equal(value.handshakes(), 1);
  });

  it('requests authenticated standalone shutdown during a reconnect window', async () => {
    const value = await fixture();
    value.connection.forceReconnectNow();
    assert.equal(value.connection.getSnapshot().phase, 'connecting');
    await value.connection.requestQuit();
    assert.deepEqual(value.requests, [
      { url: '/live/quit', nonce: value.record.instanceNonce },
    ]);
  });

  it('revokes a cached shutdown target when discovery changes before authentication', async () => {
    const value = await fixture();
    await writeFile(
      value.discovery,
      JSON.stringify({
        ...value.record,
        instanceNonce: 'replacement_unverified_instance_01',
      }),
    );
    await waitFor(
      () => value.connection.getSnapshot().error === 'daemon_identity',
      'Replacement must fail authentication',
    );
    await delay(20);
    assert.equal(value.connection.getSnapshot().error, 'daemon_identity');
    await value.connection.requestQuit();
    assert.deepEqual(value.requests, []);
  });

  for (const failure of [404, 410, 'reset'] as const) {
    it(`does not treat ${failure} as evidence a still-live daemon exited`, async () => {
      const value = await fixture({
        handleQuit: (response, attempt) => {
          if (attempt === 1) {
            if (failure === 'reset') response.destroy();
            else response.writeHead(failure).end('not confirmed');
          } else
            response.writeHead(200).end(
              JSON.stringify({
                stopped: true,
                instanceNonce: value.record.instanceNonce,
              }),
            );
        },
      });
      await assert.rejects(value.connection.requestQuit());
      assert.equal(value.server.listening, true);
      assert.equal(
        await (await fetch(`${value.record.url}/health`)).text(),
        'alive',
      );
      value.connection.reconnectNow();
      value.connection.forceReconnectNow();
      await value.connection.requestQuit();
      assert.equal(value.requests.length, 2);
      assert(
        value.requests.every(
          (request) => request.nonce === value.record.instanceNonce,
        ),
      );
      assert.equal(value.handshakes(), 1);
    });
  }

  for (const failure of [404, 410, 500, 'reset'] as const) {
    it(`still attempts authenticated Quit with an absent PID when the live listener returns ${failure}`, async () => {
      const value = await fixture({
        handleQuit: (response) => {
          if (failure === 'reset') response.destroy();
          else response.writeHead(failure).end('not confirmed');
        },
      });
      const probe = mock.method(process, 'kill', () => {
        throw Object.assign(new Error('fixture process gone'), {
          code: 'ESRCH',
        });
      });
      await assert.rejects(value.connection.requestQuit());
      await assert.rejects(value.connection.requestQuit());
      assert.equal(value.requests.length, 2);
      assert(
        value.requests.every(
          (request) => request.nonce === value.record.instanceNonce,
        ),
      );
      assert.equal(probe.mock.callCount(), 0);
      assert.equal(
        await (await fetch(`${value.record.url}/health`)).text(),
        'alive',
      );
    });
  }

  it('keeps a failed quit unconfirmed when the fixture listener actually disappears', async () => {
    const value = await fixture({
      handleQuit: (response) => response.writeHead(500).end('cleanup failed'),
    });
    await assert.rejects(value.connection.requestQuit());
    await value.stopHttp();
    assert.equal(value.server.listening, false);
    await assert.rejects(value.connection.requestQuit());
    await assert.rejects(value.connection.requestQuit());
    assert.equal(value.requests.length, 1);
  });

  it('permits retry to finish only after a refused HTTP attempt and an absent original authenticated PID', async () => {
    const value = await fixture({
      handleQuit: (response) => response.writeHead(500).end('cleanup failed'),
    });
    await assert.rejects(value.connection.requestQuit());
    await value.stopHttp();
    const fetchProbe = mock.method(globalThis, 'fetch');
    const probe = mock.method(
      process,
      'kill',
      (pid: number, signal?: number | string) => {
        assert.equal(pid, value.record.pid);
        assert.equal(signal, 0);
        throw Object.assign(new Error('fixture process gone'), {
          code: 'ESRCH',
        });
      },
    );
    await value.connection.requestQuit();
    assert.equal(fetchProbe.mock.callCount(), 1);
    assert.equal(
      String(fetchProbe.mock.calls[0]?.arguments[0]),
      `${value.record.url}/live/quit`,
    );
    assert.equal(probe.mock.callCount(), 1);
    assert.equal(value.requests.length, 1);
  });

  for (const code of ['EPERM', 'EACCES', 'UNKNOWN']) {
    it(`does not mistake a ${code} process probe for shutdown proof`, async () => {
      const value = await fixture({
        handleQuit: (response) => response.writeHead(500).end('cleanup failed'),
      });
      await assert.rejects(value.connection.requestQuit());
      await value.stopHttp();
      mock.method(process, 'kill', (pid: number, signal?: number | string) => {
        assert.equal(pid, value.record.pid);
        assert.equal(signal, 0);
        throw Object.assign(new Error('fixture ambiguous process state'), {
          code,
        });
      });
      await assert.rejects(value.connection.requestQuit());
      assert.equal(value.requests.length, 1);
    });
  }
});
