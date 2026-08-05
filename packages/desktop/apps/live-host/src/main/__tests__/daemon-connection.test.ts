import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  canSendHostControlMessage,
  LiveDaemonConnection,
} from '../daemon-connection.ts';
import { BoundedReconnectPolicy } from '../reconnect-policy.ts';
import {
  INPUT_AUDIO_EPOCH_BYTES,
  LIVE_PROTOCOL_VERSION,
  MAX_CONTROL_FRAME_BYTES,
  MAX_SOCKET_BUFFERED_BYTES,
  type HostAction,
  type HostControlMessage,
} from '../../shared/protocol.ts';

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

function nextMessage(
  socket: WebSocket,
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for WebSocket frame')),
      3_000,
    );
    socket.once('message', (data, isBinary) => {
      clearTimeout(timeout);
      resolve({ data: Buffer.from(data as ArrayBuffer), isBinary });
    });
  });
}

describe('LiveDaemonConnection', () => {
  it('authenticates, handshakes, handles heartbeat, and enforces binary ownership', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => {
      for (const client of server.clients) client.terminate();
      server.close();
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');
    if (typeof address !== 'object' || address === null)
      throw new Error('Missing server address');

    const directory = await mkdtemp(join(tmpdir(), 'qwen-live-connection-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const discoveryPath = join(directory, 'daemon.json');
    await writeFile(
      discoveryPath,
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        token: 'private-token',
        protocolVersion: LIVE_PROTOCOL_VERSION,
        pid: process.pid,
        instanceNonce: 'abcdefghijklmnop',
      }),
      { mode: 0o600 },
    );

    let peer: WebSocket | undefined;
    const requestPromise = new Promise<import('node:http').IncomingMessage>(
      (resolve) => {
        server.once('connection', (socket, request) => {
          peer = socket;
          resolve(request);
        });
      },
    );
    const snapshots: string[] = [];
    const outputFrames: Uint8Array[] = [];
    const shortcuts: string[] = [];
    let captureCalls = 0;
    const connection = new LiveDaemonConnection(
      '0.0.6',
      {
        getReadiness: () => ({
          permissions: {
            microphone: 'granted',
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
        onSnapshot: (snapshot) => snapshots.push(snapshot.phase),
        onOutputAudio: (frame) => outputFrames.push(frame),
        onClearOutput: () => undefined,
        setShortcut: (shortcut) => {
          shortcuts.push(shortcut);
          return { success: true };
        },
        captureScreenContext: async () => {
          captureCalls += 1;
          if (captureCalls === 3) {
            throw new Error('x'.repeat(100_000));
          }
          return {
            appName: 'Safari',
            windowTitle: 'LIVE_APP_A',
            accessibilityText:
              captureCalls === 1
                ? 'AXWindow LIVE_APP_A'
                : '\u0001'.repeat(32_000),
            screenshotPath: '/private/tmp/qwen-live-appshot/test.png',
          };
        },
      },
      discoveryPath,
    );
    cleanup.push(() => connection.stop());
    connection.start();

    const request = await requestPromise;
    assert.equal(request.url, '/live/host');
    assert.equal(request.headers.authorization, 'Bearer private-token');
    assert.equal(request.headers['x-qwen-live-nonce'], 'abcdefghijklmnop');
    assert.equal(request.headers.origin, undefined);
    assert(peer);

    const helloFrame = await nextMessage(peer);
    assert.equal(helloFrame.isBinary, false);
    const hello = JSON.parse(
      helloFrame.data.toString('utf8'),
    ) as HostControlMessage;
    assert.equal(hello.type, 'host.hello');
    assert.equal(hello.protocolVersion, LIVE_PROTOCOL_VERSION);
    assert.equal(hello.bundleId, 'com.alibaba.qwen-code.live-host');

    const requiredActions: HostAction[] = [
      { type: 'host.action', action: 'stop', epoch: 0 },
      { type: 'host.action', action: 'toggle', epoch: 0 },
      {
        type: 'host.action',
        action: 'mute',
        inputMuted: true,
        outputMuted: false,
        epoch: 0,
      },
    ];
    for (const action of requiredActions) {
      assert.equal(connection.sendAction(action), false);
      assert.equal(
        canSendHostControlMessage(
          action,
          true,
          true,
          MAX_SOCKET_BUFFERED_BYTES + 1,
        ),
        false,
      );
    }

    peer.send(
      JSON.stringify({
        type: 'host.welcome',
        protocolVersion: LIVE_PROTOCOL_VERSION,
        daemonInstanceNonce: 'abcdefghijklmnop',
        heartbeatIntervalMs: 1_000,
        epoch: 0,
        status: {
          v: 1,
          available: true,
          state: 'idle',
          shortcut: 'Command+Q',
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(snapshots.at(-1), 'ready');

    peer.send(
      JSON.stringify({
        type: 'host.set_shortcut',
        requestId: 'shortcut-1',
        shortcut: 'Command+E',
      }),
    );
    const shortcutFrame = await nextMessage(peer);
    assert.deepEqual(JSON.parse(shortcutFrame.data.toString('utf8')), {
      type: 'host.shortcut_result',
      requestId: 'shortcut-1',
      shortcut: 'Command+E',
      success: true,
    });
    assert.deepEqual(shortcuts, ['Command+E']);

    peer.send(
      JSON.stringify({
        type: 'host.capture_screen_context',
        requestId: 'capture-1',
        epoch: 0,
      }),
    );
    const captureFrame = await nextMessage(peer);
    assert.deepEqual(JSON.parse(captureFrame.data.toString('utf8')), {
      type: 'host.screen_context_result',
      requestId: 'capture-1',
      success: true,
      appName: 'Safari',
      windowTitle: 'LIVE_APP_A',
      accessibilityText: 'AXWindow LIVE_APP_A',
      screenshotPath: '/private/tmp/qwen-live-appshot/test.png',
    });
    assert.equal(captureCalls, 1);

    peer.send(
      JSON.stringify({
        type: 'host.capture_screen_context',
        requestId: 'capture-2',
        epoch: 0,
      }),
    );
    const boundedCaptureFrame = await nextMessage(peer);
    const boundedCapture = JSON.parse(
      boundedCaptureFrame.data.toString('utf8'),
    ) as { accessibilityText: string; success: boolean };
    assert.equal(boundedCapture.success, true);
    assert.equal(
      Buffer.byteLength(boundedCaptureFrame.data.toString('utf8'), 'utf8') <=
        MAX_CONTROL_FRAME_BYTES,
      true,
    );
    assert.equal(boundedCapture.accessibilityText.length < 32_000, true);
    assert.equal(captureCalls, 2);

    peer.send(
      JSON.stringify({
        type: 'host.capture_screen_context',
        requestId: 'capture-3',
        epoch: 0,
      }),
    );
    const failedCaptureFrame = await nextMessage(peer);
    const failedCapture = JSON.parse(
      failedCaptureFrame.data.toString('utf8'),
    ) as { success: boolean; error: string };
    assert.equal(failedCapture.success, false);
    assert.equal(failedCapture.error.length, 1_024);
    assert.equal(
      Buffer.byteLength(failedCaptureFrame.data.toString('utf8'), 'utf8') <=
        MAX_CONTROL_FRAME_BYTES,
      true,
    );
    assert.equal(captureCalls, 3);

    peer.send(JSON.stringify({ type: 'host.ping', pingId: 'ping-1' }));
    const pongFrame = await nextMessage(peer);
    assert.deepEqual(JSON.parse(pongFrame.data.toString('utf8')), {
      type: 'host.pong',
      pingId: 'ping-1',
    });

    assert.equal(connection.sendAudio(new Uint8Array(640), 1), false);
    assert.equal(connection.sendAudio(new Uint8Array(640), 0), true);
    const inputFrame = await nextMessage(peer);
    assert.equal(inputFrame.isBinary, true);
    assert.equal(inputFrame.data.byteLength, INPUT_AUDIO_EPOCH_BYTES + 640);
    assert.equal(inputFrame.data.readBigUInt64BE(0), 0n);
    assert.deepEqual(
      inputFrame.data.subarray(INPUT_AUDIO_EPOCH_BYTES),
      Buffer.alloc(640),
    );

    peer.send(Buffer.alloc(1_920), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(outputFrames.at(-1)?.byteLength, 1_920);
  });

  it('keeps retrying the same discovery identity slowly after the fast budget', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => {
      for (const client of server.clients) client.terminate();
      server.close();
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');
    if (typeof address !== 'object' || address === null)
      throw new Error('Missing server address');

    const directory = await mkdtemp(join(tmpdir(), 'qwen-live-reconnect-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const discoveryPath = join(directory, 'daemon.json');
    await writeFile(
      discoveryPath,
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        protocolVersion: LIVE_PROTOCOL_VERSION,
        pid: process.pid,
        instanceNonce: 'sameidentitynonce',
      }),
      { mode: 0o600 },
    );

    let connectionCount = 0;
    server.on('connection', async (socket) => {
      connectionCount += 1;
      await nextMessage(socket);
      if (connectionCount < 3) {
        socket.close(1012, 'retry');
        return;
      }
      socket.send(
        JSON.stringify({
          type: 'host.welcome',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          daemonInstanceNonce: 'sameidentitynonce',
          heartbeatIntervalMs: 1_000,
          epoch: 0,
          status: {
            v: 1,
            available: true,
            state: 'idle',
            shortcut: 'Command+Q',
          },
        }),
      );
    });

    const errors: Array<string | undefined> = [];
    const connection = new LiveDaemonConnection(
      '0.0.6',
      {
        getReadiness: () => ({
          permissions: {
            microphone: 'granted',
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
        onSnapshot: (snapshot) => errors.push(snapshot.error),
        onOutputAudio: () => undefined,
        onClearOutput: () => undefined,
      },
      discoveryPath,
      {
        policy: new BoundedReconnectPolicy([5], 0),
        exhaustedRetryDelayMs: 25,
      },
    );
    cleanup.push(() => connection.stop());
    connection.start();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for slow retry')),
        2_000,
      );
      const interval = setInterval(() => {
        if (connection.getSnapshot().phase !== 'ready') return;
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }, 10);
    });
    assert.equal(connectionCount, 3);
    assert(errors.includes('daemon_reconnect_exhausted'));
    assert.equal(connection.getSnapshot().phase, 'ready');
  });
});
