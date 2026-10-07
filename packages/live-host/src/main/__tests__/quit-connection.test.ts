import assert from 'node:assert/strict';
import { displayLiveMessage } from '@qwen-code/qwen-live/i18n';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { LiveDaemonConnection } from '../daemon-connection.ts';
import { LIVE_PROTOCOL_VERSION } from '../../shared/protocol.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  mock.restoreAll();
  for (const task of cleanup.splice(0).reverse()) await task();
});

const callbacks = {
  getReadiness: () => ({
    permissions: {
      microphone: 'granted' as const,
      camera: 'granted' as const,
      accessibility: 'granted' as const,
      screenRecording: 'granted' as const,
    },
    selfChecks: {
      audioInput: true,
      audioOutput: true,
      globalShortcut: true,
      appshot: true,
    },
  }),
  onSnapshot: () => undefined,
  onOutputAudio: () => undefined,
  onOutputAudioFinished: () => undefined,
  onClearOutput: () => undefined,
};

async function fixture(
  options: {
    standalone?: boolean;
    token?: string | null;
    welcomeNonce?: string;
    handleQuit?: (request: IncomingMessage, response: ServerResponse) => void;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-quit-host-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const nonce = 'authenticated_instance_01';
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    if (options.handleQuit) options.handleQuit(request, response);
    else
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ stopped: true, instanceNonce: nonce }));
  });
  const peers = new WebSocketServer({ server });
  cleanup.push(async () => {
    for (const peer of peers.clients) peer.terminate();
    peers.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const discovery = join(directory, 'daemon.json');
  const record = {
    url: `http://127.0.0.1:${address.port}`,
    ...(options.token !== null ? { token: options.token ?? 'quit-token' } : {}),
    protocolVersion: LIVE_PROTOCOL_VERSION,
    pid: process.pid,
    instanceNonce: nonce,
  };
  await writeFile(discovery, JSON.stringify(record), { mode: 0o600 });
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let handshakes = 0;
  const peerPromise = new Promise<WebSocket>((resolve) => {
    peers.on('connection', (peer) => {
      handshakes++;
      peer.once('message', () => {
        peer.send(
          JSON.stringify({
            type: 'host.welcome',
            protocolVersion: LIVE_PROTOCOL_VERSION,
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
        resolve(peer);
      });
    });
  });
  const snapshots: string[] = [];
  const connection = new LiveDaemonConnection(
    '0.0.6',
    {
      ...callbacks,
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot.phase);
        if (snapshot.phase === 'ready' || snapshot.phase === 'error') ready();
      },
    },
    discovery,
  );
  cleanup.push(() => connection.stop());
  connection.start();
  const peer = await peerPromise;
  await waiting;
  return {
    connection,
    peer,
    requests,
    record,
    discovery,
    snapshots,
    handshakes: () => handshakes,
  };
}

describe('Host Quit ownership and acknowledgement', () => {
  it('closes only Host when there is no authenticated connection', async () => {
    const connection = new LiveDaemonConnection('0.0.6', callbacks);
    await connection.requestQuit();
    connection.stop();
    const wrongInstance = await fixture({
      welcomeNonce: 'not_the_authenticated_instance',
    });
    await wrongInstance.connection.requestQuit();
    assert.equal(wrongInstance.requests.length, 0);
  });

  it('waits for the instance-specific shutdown receipt and deduplicates Quit', async () => {
    let reply!: () => void;
    let received!: () => void;
    const requestArrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const value = await fixture({
      handleQuit: (_request, response) => {
        reply = () =>
          response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              stopped: true,
              instanceNonce: value.record.instanceNonce,
            }),
          );
        received();
      },
    });
    const before = [...value.snapshots];
    let completed = false;
    const first = value.connection.requestQuit();
    const second = value.connection.requestQuit();
    assert.equal(first, second);
    void first.then(() => {
      completed = true;
    });
    await requestArrived;
    assert.equal(completed, false);
    assert.equal(value.requests[0]?.method, 'POST');
    assert.equal(value.requests[0]?.url, '/live/quit');
    assert.equal(value.requests[0]?.headers.authorization, 'Bearer quit-token');
    assert.equal(
      value.requests[0]?.headers['x-qwen-live-nonce'],
      value.record.instanceNonce,
    );
    value.peer.close(1001, 'Daemon is shutting down');
    value.connection.reconnectNow();
    value.connection.forceReconnectNow();
    reply();
    await first;
    assert.equal(value.handshakes(), 1);
    assert.deepEqual(value.snapshots, before);
  });

  it('sends only a Live stop action to a shared WebShell daemon', async () => {
    const value = await fixture({ standalone: false });
    const action = new Promise<unknown>((resolve) =>
      value.peer.once('message', (data) => resolve(JSON.parse(String(data)))),
    );
    await value.connection.requestQuit();
    assert.deepEqual(await action, {
      type: 'host.action',
      action: 'stop',
      epoch: 7,
    });
    assert.equal(value.requests.length, 0);
  });

  it('rejects a shutdown capability without bearer credentials', async () => {
    const value = await fixture({ token: null });
    await assert.rejects(value.connection.requestQuit(), (error: Error) =>
      /not confirmed/.test(displayLiveMessage('en', error.message)),
    );
    assert.equal(value.requests.length, 0);
  });

  it('retries the same authenticated target after cleanup failure and disconnect', async () => {
    let attempts = 0;
    const value = await fixture({
      handleQuit: (_request, response) => {
        attempts++;
        if (attempts === 1) {
          value.peer.close(1001, 'Daemon cleanup failed');
          response.writeHead(500).end('failure');
        } else
          response.writeHead(200).end(
            JSON.stringify({
              stopped: true,
              instanceNonce: value.record.instanceNonce,
            }),
          );
      },
    });
    await assert.rejects(value.connection.requestQuit(), (error: Error) =>
      /not confirmed/.test(displayLiveMessage('en', error.message)),
    );
    await writeFile(
      value.discovery,
      JSON.stringify({
        ...value.record,
        url: 'http://127.0.0.1:1',
        instanceNonce: 'different_instance_0001',
      }),
      { mode: 0o600 },
    );
    value.connection.reconnectNow();
    await value.connection.requestQuit();
    assert.equal(attempts, 2);
    assert.equal(value.handshakes(), 1);
    assert(
      value.requests.every(
        (request) =>
          request.headers['x-qwen-live-nonce'] === value.record.instanceNonce,
      ),
    );
  });

  it('rejects mismatched receipts, redirects and lost responses', async () => {
    for (const mode of ['nonce', 'redirect', 'lost'] as const) {
      const value = await fixture({
        handleQuit: (request, response) => {
          if (mode === 'lost') request.socket.destroy();
          else if (mode === 'redirect')
            response.writeHead(302, { location: 'http://127.0.0.1:1' }).end();
          else
            response.writeHead(200).end(
              JSON.stringify({
                stopped: true,
                instanceNonce: 'wrong_instance_0001',
              }),
            );
        },
      });
      await assert.rejects(value.connection.requestQuit(), (error: Error) =>
        /not confirmed/.test(displayLiveMessage('en', error.message)),
      );
      assert.equal(value.requests.length, 1);
    }
  });

  it(
    'does not report a timed-out shutdown as success',
    { timeout: 2_000 },
    async () => {
      const controller = new AbortController();
      const value = await fixture({
        handleQuit: () => {
          setImmediate(() =>
            controller.abort(new DOMException('Timed out', 'TimeoutError')),
          );
        },
      });
      mock.method(AbortSignal, 'timeout', () => controller.signal);
      await assert.rejects(value.connection.requestQuit(), (error: Error) =>
        /not confirmed/.test(displayLiveMessage('en', error.message)),
      );
      assert.equal(value.requests.length, 1);
    },
  );
});
