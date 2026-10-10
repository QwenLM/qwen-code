import assert from 'node:assert/strict';
import { displayLiveMessage } from '@qwen-code/qwen-live/i18n';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { LiveDaemonConnection } from '../daemon-connection.ts';
import {
  LIVE_PROTOCOL_VERSION,
  type MemoryState,
} from '../../shared/protocol.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

const memory: MemoryState = {
  enabled: true,
  visualEnabled: false,
  libraryId: 'default',
  model: 'qwen3.7-plus',
  libraries: [{ id: 'default', name: 'Default' }],
  locked: false,
};

function nextMessage(peer: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Missing memory action')),
      3_000,
    );
    peer.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

async function connectedMemory(locked = false) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => {
    for (const peer of server.clients) peer.terminate();
    server.close();
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-memory-host-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const discovery = join(directory, 'daemon.json');
  await writeFile(
    discovery,
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token: 'memory-token',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      pid: process.pid,
      instanceNonce: 'abcdefghijklmnop',
    }),
    { mode: 0o600 },
  );
  let onReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    onReady = resolve;
  });
  const peerPromise = new Promise<WebSocket>((resolve) => {
    server.once('connection', async (peer) => {
      await nextMessage(peer);
      peer.send(
        JSON.stringify({
          type: 'host.welcome',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          daemonInstanceNonce: 'abcdefghijklmnop',
          heartbeatIntervalMs: 10_000,
          epoch: 3,
          memory: { ...memory, locked },
          status: {
            v: 1,
            available: true,
            state: locked ? 'listening' : 'idle',
            shortcut: 'Command+Q',
          },
        }),
      );
      resolve(peer);
    });
  });
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
      onSnapshot: (snapshot) => {
        if (snapshot.phase === 'ready') onReady();
      },
      onOutputAudio: () => undefined,
      onOutputAudioFinished: () => undefined,
      onClearOutput: () => undefined,
    },
    discovery,
  );
  cleanup.push(() => connection.stop());
  connection.start();
  const peer = await peerPromise;
  await ready;
  return { peer, connection };
}

describe('memory requests over the Host connection', () => {
  it('waits for a matching authoritative reply and prevents duplicate changes', async () => {
    const { peer, connection } = await connectedMemory();
    const frame = nextMessage(peer);
    const result = connection.requestMemoryAction({
      action: 'set_enabled',
      enabled: false,
    });
    assert.equal(connection.getSnapshot().memory?.enabled, true);
    await assert.rejects(
      connection.requestMemoryAction({ action: 'create', name: 'Work' }),
      (error: Error) =>
        /already in progress/.test(displayLiveMessage('en', error.message)),
    );
    const request = await frame;
    assert.equal(request.type, 'host.memory_action');
    assert.equal(request.action, 'set_enabled');
    assert.equal(request.epoch, 3);
    peer.send(
      JSON.stringify({
        type: 'host.memory_result',
        requestId: 'unrelated',
        ok: true,
        memory: { ...memory, enabled: false },
      }),
    );
    peer.send(
      JSON.stringify({
        type: 'host.memory_result',
        requestId: request.requestId,
        ok: true,
        memory: { ...memory, enabled: false },
      }),
    );
    assert.equal((await result).enabled, false);
    assert.equal(connection.getSnapshot().memory?.enabled, false);
  });

  it('surfaces rejected changes without altering the current library', async () => {
    const { peer, connection } = await connectedMemory();
    const frame = nextMessage(peer);
    const result = connection.requestMemoryAction({
      action: 'create',
      name: 'Work',
    });
    const rejection = assert.rejects(result, /Disk is full/);
    const request = await frame;
    peer.send(
      JSON.stringify({
        type: 'host.memory_result',
        requestId: request.requestId,
        ok: false,
        error: 'Disk is full',
      }),
    );
    await rejection;
    assert.equal(connection.getSnapshot().memory?.libraryId, 'default');
  });

  it('locks library/model changes during calls but allows rename and immediately rejects disconnects', async () => {
    const { peer, connection } = await connectedMemory(true);
    for (const action of [
      { action: 'select', libraryId: 'work' },
      { action: 'create', name: 'Work' },
      { action: 'set_model', model: 'other-model' },
    ] as const) {
      await assert.rejects(
        connection.requestMemoryAction(action),
        (error: Error) =>
          /End the current call/.test(displayLiveMessage('en', error.message)),
      );
    }
    const frame = nextMessage(peer);
    const result = connection.requestMemoryAction({
      action: 'rename',
      libraryId: 'default',
      name: 'Personal',
    });
    const rejection = assert.rejects(result, (error: Error) =>
      /disconnected/.test(displayLiveMessage('en', error.message)),
    );
    assert.equal((await frame).action, 'rename');
    peer.close();
    await rejection;
    await assert.rejects(
      connection.requestMemoryAction({ action: 'set_enabled', enabled: false }),
      (error: Error) =>
        /disconnected/.test(displayLiveMessage('en', error.message)),
    );
  });
});
