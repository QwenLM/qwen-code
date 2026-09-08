import assert from 'node:assert/strict';
import { liveText, liveMessage } from '@qwen-code/qwen-live/i18n';
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
  encodeOutputAudioFrame,
  type HostAction,
  type HostControlMessage,
  type OutputAudioFrame,
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
    const outputFrames: OutputAudioFrame[] = [];
    const outputEvents: string[] = [];
    const shortcuts: string[] = [];
    let visualCaptureCalls = 0;
    let visualCaptureSource: 'screen' | 'camera' = 'screen';
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
        onSnapshot: (snapshot) => snapshots.push(snapshot.phase),
        onOutputAudio: (frame) => {
          outputFrames.push(frame);
          outputEvents.push(`audio:${frame.epoch}:${frame.outputId}`);
        },
        onOutputAudioFinished: (identity) => {
          outputEvents.push(`finished:${identity.epoch}:${identity.outputId}`);
        },
        onClearOutput: () => undefined,
        setShortcut: (shortcut) => {
          shortcuts.push(shortcut);
          return { success: true };
        },
        captureVisual: async (request) => {
          visualCaptureCalls += 1;
          if (visualCaptureCalls === 3) {
            throw new Error('x'.repeat(100_000));
          }
          if (visualCaptureCalls === 4)
            throw new Error(liveMessage('host.error.visualUnavailable'));
          assert.deepEqual(request, {
            source: 'screen',
            snapshotWidth: 1920,
            snapshotHeight: 1080,
            ...(visualCaptureCalls === 1 ? { persistAsset: false } : {}),
          });
          return {
            source: visualCaptureSource,
            image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
            width: 1920,
            height: 1080,
            appName: 'Safari',
            windowTitle: 'LIVE_APP_A',
            accessibilityText: 'AXWindow LIVE_APP_A',
            ...(request.persistAsset === false
              ? {}
              : {
                  screenshotPath: '/private/tmp/qwen-live-appshot/visual.png',
                }),
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
    assert.deepEqual(hello.capabilities, {
      outputAudioEndMarkerV1: true,
    });

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
        capabilities: { outputAudioEndMarkerV1: true },
        visualInput: {
          source: 'camera',
          mode: 'live-feed',
          fps: 1,
          liveWidth: 1280,
          liveHeight: 720,
        },
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
    assert.deepEqual(connection.getSnapshot().capabilities, {
      outputAudioEndMarkerV1: true,
    });
    assert.deepEqual(connection.getSnapshot().visualInput, {
      source: 'camera',
      mode: 'live-feed',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
    });

    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    assert.equal(connection.sendVisualFrame('camera', image, 1), false);
    const imageFramePromise = nextMessage(peer);
    assert.equal(connection.sendVisualFrame('camera', image, 0), true);
    const imageFrame = await imageFramePromise;
    assert.equal(imageFrame.isBinary, false);
    assert.deepEqual(JSON.parse(imageFrame.data.toString('utf8')), {
      type: 'host.visual_frame',
      epoch: 0,
      source: 'camera',
      image,
    });

    const visualSourcePromise = nextMessage(peer);
    assert.equal(connection.sendVisualSettings({ source: 'screen' }, 0), true);
    const visualSource = await visualSourcePromise;
    assert.deepEqual(JSON.parse(visualSource.data.toString('utf8')), {
      type: 'host.visual_settings',
      epoch: 0,
      source: 'screen',
      mode: 'live-feed',
      permissions: {
        camera: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      appshot: true,
    });
    const visualModePromise = nextMessage(peer);
    assert.equal(connection.sendVisualSettings({ mode: 'on-demand' }, 0), true);
    const visualMode = await visualModePromise;
    assert.deepEqual(JSON.parse(visualMode.data.toString('utf8')), {
      type: 'host.visual_settings',
      epoch: 0,
      source: 'screen',
      mode: 'on-demand',
      permissions: {
        camera: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      appshot: true,
    });
    assert.deepEqual(connection.getSnapshot().visualInput, {
      source: 'camera',
      mode: 'live-feed',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
    });

    peer.send(
      JSON.stringify({
        type: 'host.capture_visual',
        requestId: 'visual-1',
        epoch: 0,
        source: 'screen',
        snapshotWidth: 1920,
        snapshotHeight: 1080,
        persistAsset: false,
      }),
    );
    const visualCaptureFrame = await nextMessage(peer);
    assert.deepEqual(JSON.parse(visualCaptureFrame.data.toString('utf8')), {
      type: 'host.visual_capture_result',
      requestId: 'visual-1',
      success: true,
      source: 'screen',
      image,
      width: 1920,
      height: 1080,
      appName: 'Safari',
      windowTitle: 'LIVE_APP_A',
      accessibilityText: 'AXWindow LIVE_APP_A',
    });
    assert.equal(visualCaptureCalls, 1);

    peer.send(
      JSON.stringify({
        type: 'host.state',
        epoch: 0,
        visualInput: {
          source: 'screen',
          mode: 'on-demand',
          fps: 1,
          liveWidth: 1280,
          liveHeight: 720,
        },
        status: {
          v: 1,
          available: true,
          state: 'idle',
          shortcut: 'Command+Q',
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(connection.getSnapshot().visualInput, {
      source: 'screen',
      mode: 'on-demand',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
    });
    assert.deepEqual(connection.getSnapshot().capabilities, {
      outputAudioEndMarkerV1: true,
    });

    visualCaptureSource = 'camera';
    peer.send(
      JSON.stringify({
        type: 'host.capture_visual',
        requestId: 'visual-wrong-source',
        epoch: 0,
        source: 'screen',
        snapshotWidth: 1920,
        snapshotHeight: 1080,
      }),
    );
    const mismatchedVisualCapture = await nextMessage(peer);
    assert.deepEqual(
      JSON.parse(mismatchedVisualCapture.data.toString('utf8')),
      {
        type: 'host.visual_capture_result',
        requestId: 'visual-wrong-source',
        success: false,
        error: liveText('en', 'host.error.visualWrongSource'),
      },
    );
    assert.equal(visualCaptureCalls, 2);

    visualCaptureSource = 'screen';
    peer.send(
      JSON.stringify({
        type: 'host.capture_visual',
        requestId: 'visual-error',
        epoch: 0,
        source: 'screen',
        snapshotWidth: 1920,
        snapshotHeight: 1080,
      }),
    );
    const failedVisualCaptureFrame = await nextMessage(peer);
    const failedVisualCapture = JSON.parse(
      failedVisualCaptureFrame.data.toString('utf8'),
    ) as { success: boolean; error: string };
    assert.equal(failedVisualCapture.success, false);
    assert.equal(failedVisualCapture.error.length, 1_024);
    assert.equal(
      Buffer.byteLength(
        failedVisualCaptureFrame.data.toString('utf8'),
        'utf8',
      ) <= MAX_CONTROL_FRAME_BYTES,
      true,
    );
    assert.equal(visualCaptureCalls, 3);

    peer.send(
      JSON.stringify({
        type: 'host.capture_visual',
        requestId: 'visual-localized-error',
        epoch: 0,
        source: 'screen',
      }),
    );
    const localizedVisualFrame = await nextMessage(peer);
    const localizedVisualResult = JSON.parse(
      localizedVisualFrame.data.toString('utf8'),
    );
    assert.equal(localizedVisualResult.error, 'Visual capture is unavailable.');
    assert.equal(localizedVisualResult.error.includes('qwen-live-ui:'), false);

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

    const outputFrame = encodeOutputAudioFrame(0, 23, Buffer.alloc(1_920));
    assert(outputFrame);
    peer.send(outputFrame, { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(outputFrames.at(-1)?.epoch, 0);
    assert.equal(outputFrames.at(-1)?.outputId, 23);
    assert.equal(outputFrames.at(-1)?.audio.byteLength, 1_920);

    peer.send(
      JSON.stringify({
        type: 'host.output_audio_finished',
        epoch: 0,
        outputId: 23,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(outputEvents, ['audio:0:23', 'finished:0:23']);
    peer.send(
      JSON.stringify({
        type: 'host.output_audio_finished',
        epoch: 1,
        outputId: 24,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(outputEvents, ['audio:0:23', 'finished:0:23']);

    const startedPromise = nextMessage(peer);
    assert.equal(connection.sendPlaybackStarted(0, 23), true);
    const started = await startedPromise;
    assert.equal(started.isBinary, false);
    assert.deepEqual(JSON.parse(started.data.toString('utf8')), {
      type: 'host.playback_started',
      epoch: 0,
      outputId: 23,
    });

    const completedPromise = nextMessage(peer);
    assert.equal(connection.sendPlaybackCompleted(0, 23), true);
    const completed = await completedPromise;
    assert.equal(completed.isBinary, false);
    assert.deepEqual(JSON.parse(completed.data.toString('utf8')), {
      type: 'host.playback_completed',
      epoch: 0,
      outputId: 23,
    });
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
    let readyPeer: WebSocket | undefined;
    server.on('connection', async (socket) => {
      connectionCount += 1;
      await nextMessage(socket);
      if (connectionCount < 3) {
        socket.close(1012, 'retry');
        return;
      }
      readyPeer = socket;
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
    const finishedOutputs: string[] = [];
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
        onSnapshot: (snapshot) => errors.push(snapshot.error),
        onOutputAudio: () => undefined,
        onOutputAudioFinished: (identity) => {
          finishedOutputs.push(`${identity.epoch}:${identity.outputId}`);
        },
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
    assert(readyPeer);
    readyPeer.send(
      JSON.stringify({
        type: 'host.output_audio_finished',
        epoch: 0,
        outputId: 1,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(finishedOutputs, []);
  });
});
