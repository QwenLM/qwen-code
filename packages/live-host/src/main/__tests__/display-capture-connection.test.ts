import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { LiveDaemonConnection } from '../daemon-connection.ts';
import {
  LIVE_PROTOCOL_VERSION,
  type HostControlMessage,
} from '../../shared/protocol.ts';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

function nextMessage(socket: WebSocket): Promise<HostControlMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Missing fixture frame')),
      3_000,
    );
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as HostControlMessage);
    });
  });
}

async function fixture(displayCaptureV1 = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => {
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address)
    throw new Error('Missing server address');
  const directory = await mkdtemp(join(tmpdir(), 'qwen-live-display-wire-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const discoveryPath = join(directory, 'daemon.json');
  await writeFile(
    discoveryPath,
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}`,
      token: 'fixture-token',
      instanceNonce: 'fixture-display-daemon',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      pid: process.pid,
    }),
    { mode: 0o600 },
  );
  let captureRequest: unknown;
  let resultDisplayId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const connection = new LiveDaemonConnection(
    'fixture',
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
      onSnapshot: () => undefined,
      onOutputAudio: () => undefined,
      onOutputAudioFinished: () => undefined,
      onClearOutput: () => undefined,
      captureVisual: async (request) => {
        captureRequest = request;
        return {
          source: 'screen',
          screenScope: 'display',
          displayId: resultDisplayId,
          image: jpeg,
          width: 1280,
          height: 720,
        };
      },
    },
    discoveryPath,
  );
  cleanup.push(() => connection.stop());
  const connected = new Promise<{
    socket: WebSocket;
    hello: Promise<HostControlMessage>;
  }>((resolve) => {
    server.once('connection', (socket) =>
      resolve({ socket, hello: nextMessage(socket) }),
    );
  });
  connection.start();
  const { socket, hello } = await connected;
  const helloMessage = await hello;
  assert.equal(helloMessage.type, 'host.hello');
  assert('displayCaptureV1' in helloMessage);
  assert.equal(helloMessage.displayCaptureV1, true);
  const status = {
    v: 1,
    available: true,
    state: 'idle',
    shortcut: 'Command+E',
  };
  socket.send(
    JSON.stringify({
      type: 'host.welcome',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      daemonInstanceNonce: 'fixture-display-daemon',
      heartbeatIntervalMs: 30_000,
      epoch: 0,
      ...(displayCaptureV1 ? { displayCaptureV1: true } : {}),
      visualInput: {
        source: 'screen',
        mode: 'on-demand',
        fps: 1,
        liveWidth: 1280,
        liveHeight: 720,
        screenDisplayId: 'primary',
      },
      status,
    }),
  );
  const deadline = Date.now() + 3_000;
  while (connection.getSnapshot().phase !== 'ready') {
    if (Date.now() > deadline) throw new Error('Missing fixture welcome');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    connection,
    socket,
    jpeg,
    status,
    captureRequest: () => captureRequest,
    setResultDisplay: (id: string) => {
      resultDisplayId = id;
    },
  };
}

describe('display capture connection', () => {
  it('retains rejected visual selection errors across state updates and drops the rejected pending UUID before retry', async () => {
    const { connection, socket, status } = await fixture();
    const displayId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const selected = nextMessage(socket);
    assert.equal(
      connection.sendVisualSettings({ screenDisplayId: displayId }, 0),
      true,
    );
    await selected;
    const previousState = {
      type: 'host.state',
      epoch: 0,
      visualInput: {
        source: 'screen',
        mode: 'on-demand',
        screenDisplayId: 'primary',
        fps: 1,
        liveWidth: 1280,
        liveHeight: 720,
      },
      status,
    };
    const error =
      'Could not save the selected display. The previous selection is unchanged.';
    const processed = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'host.error',
        code: 'invalid_message',
        message: error,
      }),
    );
    socket.send(JSON.stringify(previousState));
    socket.send(
      JSON.stringify({ type: 'host.ping', pingId: 'rejected-selection' }),
    );
    assert.deepEqual(await processed, {
      type: 'host.pong',
      pingId: 'rejected-selection',
    });
    assert.equal(connection.getSnapshot().visualSettingsError, error);
    assert.equal(
      connection.getSnapshot().visualInput?.screenDisplayId,
      'primary',
    );

    const repeated = nextMessage(socket);
    socket.send(JSON.stringify(previousState));
    socket.send(JSON.stringify({ type: 'host.ping', pingId: 'later-state' }));
    await repeated;
    assert.equal(connection.getSnapshot().visualSettingsError, error);

    const retry = nextMessage(socket);
    assert.equal(connection.sendVisualSettings({ mode: 'live-feed' }, 0), true);
    assert.equal(connection.getSnapshot().visualSettingsError, undefined);
    const retried = await retry;
    assert.equal(retried.type, 'host.visual_settings');
    assert('screenDisplayId' in retried);
    assert.equal(retried.screenDisplayId, 'primary');

    const rejectedAgain = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'host.error',
        code: 'invalid_message',
        message: error,
      }),
    );
    socket.send(JSON.stringify(previousState));
    socket.send(
      JSON.stringify({ type: 'host.ping', pingId: 'rejected-again' }),
    );
    await rejectedAgain;
    assert.equal(connection.getSnapshot().visualSettingsError, error);
    connection.stop();
    assert.equal(connection.getSnapshot().visualSettingsError, undefined);
  });

  it('negotiates display support, retains pending selection across mode changes, and binds captured frames to a UUID', async () => {
    const { connection, socket, jpeg, captureRequest, setResultDisplay } =
      await fixture();
    const displayId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.equal(connection.getSnapshot().displayCaptureV1, true);
    const select = nextMessage(socket);
    assert.equal(
      connection.sendVisualSettings(
        { screenDisplayId: displayId.toUpperCase() },
        0,
      ),
      true,
    );
    assert.equal((await select).type, 'host.visual_settings');
    const mode = nextMessage(socket);
    assert.equal(connection.sendVisualSettings({ mode: 'live-feed' }, 0), true);
    assert.deepEqual(await mode, {
      type: 'host.visual_settings',
      epoch: 0,
      source: 'screen',
      mode: 'live-feed',
      screenDisplayId: displayId,
      permissions: {
        camera: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      appshot: true,
    });
    assert.equal(connection.sendVisualFrame('screen', jpeg, 0), false);
    const frame = nextMessage(socket);
    assert.equal(
      connection.sendVisualFrame('screen', jpeg, 0, displayId),
      true,
    );
    assert.deepEqual(await frame, {
      type: 'host.visual_frame',
      epoch: 0,
      source: 'screen',
      screenScope: 'display',
      displayId,
      image: jpeg,
    });
    const result = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'host.capture_visual',
        requestId: 'capture-1',
        epoch: 0,
        source: 'screen',
        screenScope: 'display',
        screenDisplayId: displayId,
        persistAsset: false,
      }),
    );
    assert.equal((await result).type, 'host.visual_capture_result');
    assert.deepEqual(captureRequest(), {
      source: 'screen',
      screenScope: 'display',
      screenDisplayId: displayId,
      persistAsset: false,
    });
    setResultDisplay('11111111-2222-3333-4444-555555555555');
    const mismatch = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'host.capture_visual',
        requestId: 'capture-2',
        epoch: 0,
        source: 'screen',
        screenScope: 'display',
        screenDisplayId: displayId,
        persistAsset: false,
      }),
    );
    assert.deepEqual(await mismatch, {
      type: 'host.visual_capture_result',
      requestId: 'capture-2',
      success: false,
      error: 'The captured display does not match the selection.',
    });
  });

  it('does not send full-display settings/frames or route scoped captures against an old daemon', async () => {
    const { connection, socket, jpeg, captureRequest } = await fixture(false);
    const displayId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    assert.equal(
      connection.sendVisualSettings({ screenDisplayId: displayId }, 0),
      false,
    );
    assert.equal(
      connection.sendVisualFrame('screen', jpeg, 0, displayId),
      false,
    );
    const result = nextMessage(socket);
    socket.send(
      JSON.stringify({
        type: 'host.capture_visual',
        requestId: 'capture-1',
        epoch: 0,
        source: 'screen',
        screenScope: 'display',
        screenDisplayId: displayId,
        persistAsset: false,
      }),
    );
    assert.deepEqual(await result, {
      type: 'host.visual_capture_result',
      requestId: 'capture-1',
      success: false,
      error: 'Update Live Host to enable full-display capture.',
    });
    assert.equal(captureRequest(), undefined);
  });
});
