import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type {
  LiveDaemonMessage as DaemonMessage,
  LiveHostAction as DaemonHostAction,
  LiveHostHello as DaemonHostHello,
  LiveStatus as DaemonLiveStatus,
} from '../../../../cli/src/serve/live/types.ts';
import {
  LIVE_HOST_BUNDLE_ID,
  MAX_CONTROL_FRAME_BYTES,
  MAX_INPUT_AUDIO_FRAME_BYTES,
  MAX_INPUT_IMAGE_FRAME_BYTES,
  MAX_CAPTURE_ASSET_BYTES,
  INPUT_AUDIO_EPOCH_BYTES,
  LIVE_PROTOCOL_VERSION,
  MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES,
  OUTPUT_AUDIO_EPOCH_BYTES,
  OUTPUT_AUDIO_HEADER_BYTES,
  OUTPUT_AUDIO_ID_BYTES,
  decodeOutputAudioFrame,
  encodeInputAudioFrame,
  encodeOutputAudioFrame,
  fitRealtimeVisualDimensions,
  MAX_OUTPUT_AUDIO_FRAME_BYTES,
  encodeHostControlMessage,
  isValidInputAudioFrame,
  isValidInputImageFrame,
  isValidCameraSnapshotAsset,
  isValidOutputAudioFrame,
  parseDaemonControlMessage,
  type DaemonControlMessage as HostDaemonMessage,
  type HostAction,
  type HostHello,
  type HostPermissions,
  type HostSelfChecks,
  type LiveStatus as HostLiveStatus,
} from '../../shared/protocol.ts';

type HasSameKeys<Left, Right> =
  Exclude<keyof Left, keyof Right> extends never
    ? Exclude<keyof Right, keyof Left> extends never
      ? true
      : false
    : false;

type IsEqual<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

type MessageType<Message> = Message extends { type: infer Type } ? Type : never;
type HostVisibleDaemonStatus = Omit<
  DaemonLiveStatus,
  'coordinator' | 'workers'
>;
type HostSimpleAction = Extract<
  HostAction,
  { action: 'toggle' | 'new' | 'stop' }
>;
type DaemonSimpleAction = Extract<
  DaemonHostAction,
  { action: 'toggle' | 'new' | 'stop' }
>;
type HostMuteAction = Extract<HostAction, { action: 'mute' }>;
type DaemonMuteAction = Extract<DaemonHostAction, { action: 'mute' }>;

const PROTOCOL_TYPE_PARITY: {
  helloAssignable: HostHello extends DaemonHostHello ? true : false;
  helloKeys: HasSameKeys<Omit<HostHello, 'subagentsV1'>, DaemonHostHello>;
  permissionKeys: HasSameKeys<HostPermissions, DaemonHostHello['permissions']>;
  permissionStates: IsEqual<
    HostPermissions[keyof HostPermissions],
    DaemonHostHello['permissions'][keyof DaemonHostHello['permissions']]
  >;
  selfCheckKeys: HasSameKeys<HostSelfChecks, DaemonHostHello['selfChecks']>;
  actionAssignable: HostAction extends DaemonHostAction ? true : false;
  actionNames: IsEqual<HostAction['action'], DaemonHostAction['action']>;
  simpleActionKeys: HasSameKeys<HostSimpleAction, DaemonSimpleAction>;
  muteActionKeys: HasSameKeys<HostMuteAction, DaemonMuteAction>;
  statusAssignable: HostVisibleDaemonStatus extends HostLiveStatus
    ? true
    : false;
  statusKeys: HasSameKeys<HostLiveStatus, HostVisibleDaemonStatus>;
  stateNames: IsEqual<
    HostLiveStatus['state'],
    HostVisibleDaemonStatus['state']
  >;
  requirementKeys: HasSameKeys<
    NonNullable<HostLiveStatus['requirements']>,
    NonNullable<HostVisibleDaemonStatus['requirements']>
  >;
  hostMetadataKeys: HasSameKeys<
    NonNullable<HostLiveStatus['host']>,
    NonNullable<HostVisibleDaemonStatus['host']>
  >;
  daemonMessageNames: IsEqual<
    Exclude<MessageType<HostDaemonMessage>, 'host.subagents'>,
    MessageType<DaemonMessage>
  >;
} = {
  helloAssignable: true,
  helloKeys: true,
  permissionKeys: true,
  permissionStates: true,
  selfCheckKeys: true,
  actionAssignable: true,
  actionNames: true,
  simpleActionKeys: true,
  muteActionKeys: true,
  statusAssignable: true,
  statusKeys: true,
  stateNames: true,
  requirementKeys: true,
  hostMetadataKeys: true,
  daemonMessageNames: true,
};

const DAEMON_PROTOCOL_TYPES_URL = new URL(
  '../../../../cli/src/serve/live/types.ts',
  import.meta.url,
);

const QWEN_LIVE_PROTOCOL_TYPES_URL = new URL(
  '../../../../qwen-live/src/host/types.ts',
  import.meta.url,
);

const ELECTRON_BUILDER_CONFIG_URL = new URL(
  '../../../electron-builder.yml',
  import.meta.url,
);

describe('Live Host protocol', () => {
  it('keeps the qwen-live daemon contract byte-identical to the cli copy', async () => {
    // PROTOCOL_TYPE_PARITY type-checks against the cli copy only; the
    // standalone qwen-live daemon validates and emits against its own copy.
    // Byte-identity keeps a change to either copy from drifting silently.
    const [cliSource, qwenLiveSource] = await Promise.all([
      readFile(fileURLToPath(DAEMON_PROTOCOL_TYPES_URL), 'utf8'),
      readFile(fileURLToPath(QWEN_LIVE_PROTOCOL_TYPES_URL), 'utf8'),
    ]);
    assert.equal(qwenLiveSource, cliSource);
  });

  it('stays synchronized with the daemon protocol contract', async () => {
    const [source, builderConfig] = await Promise.all([
      readFile(fileURLToPath(DAEMON_PROTOCOL_TYPES_URL), 'utf8'),
      readFile(fileURLToPath(ELECTRON_BUILDER_CONFIG_URL), 'utf8'),
    ]);
    const daemonVersion = Number(
      source.match(/LIVE_HOST_PROTOCOL_VERSION = (\d+)/u)?.[1],
    );
    const daemonBundleId = source.match(
      /LIVE_HOST_BUNDLE_ID = '([^']+)'/u,
    )?.[1];

    assert.equal(LIVE_PROTOCOL_VERSION, 9);
    assert.equal(daemonVersion, LIVE_PROTOCOL_VERSION);
    assert.equal(daemonBundleId, LIVE_HOST_BUNDLE_ID);
    assert.equal(
      Number(builderConfig.match(/QwenLiveProtocolVersion: (\d+)/u)?.[1]),
      LIVE_PROTOCOL_VERSION,
    );
    assert.equal(Object.values(PROTOCOL_TYPE_PARITY).every(Boolean), true);
    assert.doesNotMatch(
      source,
      /request_permission|host\.open_session|installUrl/u,
    );
  });

  it('encodes the complete hello and action contract accepted by the daemon', () => {
    const hello = {
      type: 'host.hello',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      hostVersion: '0.0.6',
      bundleId: LIVE_HOST_BUNDLE_ID,
      instanceNonce: 'host-instance-nonce',
      capabilities: { outputAudioEndMarkerV1: true },
      permissions: {
        microphone: 'granted',
        camera: 'granted',
        accessibility: 'denied',
        screenRecording: 'not_determined',
      },
      selfChecks: {
        audioInput: true,
        audioOutput: false,
        globalShortcut: true,
        appshot: false,
      },
    } satisfies HostHello;
    const daemonHello: DaemonHostHello = hello;
    assert.deepEqual(JSON.parse(encodeHostControlMessage(hello)), daemonHello);

    const actions = [
      { type: 'host.action', action: 'toggle' },
      { type: 'host.action', action: 'new', epoch: 4 },
      { type: 'host.action', action: 'stop', epoch: 5 },
      {
        type: 'host.action',
        action: 'mute',
        inputMuted: true,
        outputMuted: false,
        epoch: 6,
      },
    ] satisfies HostAction[];
    const daemonActions: DaemonHostAction[] = actions;
    assert.deepEqual(
      actions.map((action) => JSON.parse(encodeHostControlMessage(action))),
      daemonActions,
    );
    assert.deepEqual(
      JSON.parse(
        encodeHostControlMessage({
          type: 'host.shortcut_result',
          requestId: 'shortcut-1',
          shortcut: 'Command+E',
          success: true,
        }),
      ),
      {
        type: 'host.shortcut_result',
        requestId: 'shortcut-1',
        shortcut: 'Command+E',
        success: true,
      },
    );
  });

  it('parses the complete daemon status into the Host-visible projection', () => {
    const daemonStatus = {
      v: 1,
      available: false,
      state: 'error',
      shortcut: 'Command+Shift+L',
      blocker: 'provider_unreachable',
      message: 'Realtime provider unavailable.',
      callId: 'call-1',
      inputMuted: true,
      outputMuted: false,
      transcript: 'Check the current screen.',
      caption: 'The current window is a document editor.',
      statusText: 'Reading screen…',
      pendingPermission: {
        workspaceId: 'conversations-workspace',
        sessionId: 'coordinator-1',
      },
      requirements: {
        host: 'ready',
        microphone: 'denied',
        accessibility: 'missing',
        screenRecording: 'checking',
        audioInput: 'unavailable',
        audioOutput: 'ready',
        globalShortcut: 'ready',
        appshot: 'checking',
        provider: 'unavailable',
      },
      host: { version: '0.0.6', protocolVersion: LIVE_PROTOCOL_VERSION },
    } satisfies DaemonLiveStatus;
    const daemonMessage = {
      type: 'host.state',
      epoch: 7,
      status: daemonStatus,
    } satisfies DaemonMessage;
    const hostStatus = {
      v: 1,
      available: false,
      state: 'error',
      shortcut: 'Command+Shift+L',
      blocker: 'provider_unreachable',
      message: 'Realtime provider unavailable.',
      callId: 'call-1',
      inputMuted: true,
      outputMuted: false,
      transcript: 'Check the current screen.',
      caption: 'The current window is a document editor.',
      statusText: 'Reading screen…',
      pendingPermission: daemonStatus.pendingPermission,
      requirements: daemonStatus.requirements,
      host: daemonStatus.host,
    } satisfies HostLiveStatus;

    assert.deepEqual(parseDaemonControlMessage(JSON.stringify(daemonMessage)), {
      type: 'host.state',
      epoch: 7,
      status: hostStatus,
    });
  });

  it('accepts a bounded welcome and normalizes its heartbeat', () => {
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.welcome',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          daemonInstanceNonce: 'abcdefghijklmnop',
          heartbeatIntervalMs: 50,
          epoch: 2,
          capabilities: { outputAudioEndMarkerV1: true },
          visualInput: {
            source: 'screen',
            mode: 'on-demand',
            fps: 1,
            cameraWidth: 1280,
            cameraHeight: 720,
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
      ),
      {
        type: 'host.welcome',
        protocolVersion: LIVE_PROTOCOL_VERSION,
        daemonInstanceNonce: 'abcdefghijklmnop',
        heartbeatIntervalMs: 1_000,
        epoch: 2,
        capabilities: { outputAudioEndMarkerV1: true },
        visualInput: {
          source: 'screen',
          mode: 'on-demand',
          fps: 1,
          cameraWidth: 1280,
          cameraHeight: 720,
          liveWidth: 1280,
          liveHeight: 720,
        },
        status: {
          v: 1,
          available: true,
          state: 'idle',
          shortcut: 'Command+Q',
        },
      },
    );
  });

  it('strictly negotiates output audio end markers and validates identities', () => {
    const welcome = {
      type: 'host.welcome',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      daemonInstanceNonce: 'abcdefghijklmnop',
      heartbeatIntervalMs: 1_000,
      epoch: 2,
      status: {
        v: 1,
        available: true,
        state: 'idle',
        shortcut: 'Command+Q',
      },
    };
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({ ...welcome, daemonShutdownV1: true }),
      ),
      { ...welcome, daemonShutdownV1: true },
    );
    for (const daemonShutdownV1 of [false, 'true', 1, null]) {
      assert.equal(
        parseDaemonControlMessage(
          JSON.stringify({ ...welcome, daemonShutdownV1 }),
        ),
        undefined,
      );
    }
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({
          ...welcome,
          capabilities: { outputAudioEndMarkerV1: true },
        }),
      ),
      {
        ...welcome,
        capabilities: { outputAudioEndMarkerV1: true },
      },
    );
    for (const capabilities of [
      {},
      { outputAudioEndMarkerV1: false },
      { outputAudioEndMarkerV1: true, unknown: true },
      null,
    ]) {
      assert.equal(
        parseDaemonControlMessage(JSON.stringify({ ...welcome, capabilities })),
        undefined,
      );
    }

    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.output_audio_finished',
          epoch: 2,
          outputId: 17,
        }),
      ),
      { type: 'host.output_audio_finished', epoch: 2, outputId: 17 },
    );
    for (const identity of [
      { epoch: -1, outputId: 17 },
      { epoch: 2, outputId: -1 },
      { epoch: 2.5, outputId: 17 },
      { epoch: 2, outputId: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      assert.equal(
        parseDaemonControlMessage(
          JSON.stringify({
            type: 'host.output_audio_finished',
            ...identity,
          }),
        ),
        undefined,
      );
    }
  });

  it('rejects invalid state and oversized control frames', () => {
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.state',
          epoch: 1,
          status: {
            v: 1,
            available: true,
            state: 'invented',
            shortcut: 'Command+Q',
          },
        }),
      ),
      undefined,
    );
    assert.equal(
      parseDaemonControlMessage(' '.repeat(MAX_CONTROL_FRAME_BYTES + 1)),
      undefined,
    );
  });

  it('requires bounded visual resolutions as complete pairs', () => {
    const welcome = {
      type: 'host.welcome',
      protocolVersion: LIVE_PROTOCOL_VERSION,
      daemonInstanceNonce: 'abcdefghijklmnop',
      heartbeatIntervalMs: 1_000,
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
    };
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          ...welcome,
          visualInput: {
            ...welcome.visualInput,
            cameraWidth: 1280,
          },
        }),
      ),
      undefined,
    );
    const cameraSettings = {
      ...welcome.visualInput,
      cameraSnapshotWidth: 3840,
      cameraSnapshotHeight: 2160,
      snapshotWidth: 2560,
      snapshotHeight: 1440,
    };
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({ ...welcome, visualInput: cameraSettings }),
      ),
      { ...welcome, visualInput: cameraSettings },
    );
    for (const override of [
      { cameraSnapshotHeight: undefined },
      { cameraSnapshotWidth: 8000 },
      { cameraSnapshotHeight: 100 },
    ]) {
      assert.equal(
        parseDaemonControlMessage(
          JSON.stringify({
            ...welcome,
            visualInput: { ...cameraSettings, ...override },
          }),
        ),
        undefined,
      );
    }
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          ...welcome,
          visualInput: {
            ...welcome.visualInput,
            snapshotWidth: 1280,
          },
        }),
      ),
      undefined,
    );
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          ...welcome,
          visualInput: {
            ...welcome.visualInput,
            liveWidth: 4096,
          },
        }),
      ),
      undefined,
    );
  });

  it('validates visual settings messages', () => {
    assert.equal(
      encodeHostControlMessage({
        type: 'host.visual_settings',
        epoch: 3,
        source: 'camera',
        mode: 'live-feed',
        permissions: {
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        appshot: true,
      }),
      JSON.stringify({
        type: 'host.visual_settings',
        epoch: 3,
        source: 'camera',
        mode: 'live-feed',
        permissions: {
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        appshot: true,
      }),
    );
    assert.throws(() =>
      encodeHostControlMessage({
        type: 'host.visual_settings',
        epoch: 3,
        source: 'camera',
        mode: 'invalid' as 'live-feed',
        permissions: {
          camera: 'granted',
          accessibility: 'granted',
          screenRecording: 'granted',
        },
        appshot: true,
      }),
    );
  });

  it('parses optional visual capture persistence without coercion', () => {
    const base = {
      type: 'host.capture_visual',
      requestId: 'visual-1',
      epoch: 3,
      source: 'screen',
    };
    assert.deepEqual(parseDaemonControlMessage(JSON.stringify(base)), base);
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({ ...base, persistAsset: false }),
      ),
      { ...base, persistAsset: false },
    );
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({ ...base, persistAsset: 'false' }),
      ),
      undefined,
    );
  });

  it('allows larger local camera assets without relaxing provider image limits', () => {
    const jpeg = Buffer.alloc(MAX_INPUT_IMAGE_FRAME_BYTES + 1);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[jpeg.length - 2] = 0xff;
    jpeg[jpeg.length - 1] = 0xd9;
    const encoded = jpeg.toString('base64');
    assert.equal(isValidCameraSnapshotAsset(encoded), true);
    assert.equal(isValidInputImageFrame(encoded), false);
    assert.equal(isValidCameraSnapshotAsset(`${encoded}\n`), false);
    assert.equal(isValidCameraSnapshotAsset('not an image'), false);
    assert.equal(
      isValidCameraSnapshotAsset(
        'A'.repeat(Math.ceil(MAX_CAPTURE_ASSET_BYTES / 3) * 4 + 4),
      ),
      false,
    );
  });

  it('bounds audio frames and requires complete PCM16 samples', () => {
    assert.equal(isValidInputAudioFrame(new Uint8Array(640)), true);
    assert.equal(isValidInputAudioFrame(new Uint8Array(641)), false);
    assert.equal(
      isValidInputAudioFrame(new Uint8Array(MAX_INPUT_AUDIO_FRAME_BYTES + 2)),
      false,
    );
    assert.equal(isValidOutputAudioFrame(new Uint8Array(1_920)), true);
    assert.equal(
      isValidOutputAudioFrame(new Uint8Array(MAX_OUTPUT_AUDIO_FRAME_BYTES + 2)),
      false,
    );
  });

  it('frames output PCM with a bounded epoch and output identity', () => {
    const pcm16 = new Uint8Array([1, 0, 2, 0]);
    const encoded = encodeOutputAudioFrame(42, 7, pcm16);
    assert(encoded);
    assert.equal(OUTPUT_AUDIO_EPOCH_BYTES, 8);
    assert.equal(OUTPUT_AUDIO_ID_BYTES, 8);
    assert.equal(OUTPUT_AUDIO_HEADER_BYTES, 16);
    assert.equal(encoded.byteLength, OUTPUT_AUDIO_HEADER_BYTES + pcm16.length);
    const header = new DataView(
      encoded.buffer,
      encoded.byteOffset,
      encoded.byteLength,
    );
    assert.equal(header.getBigUint64(0, false), 42n);
    assert.equal(header.getBigUint64(OUTPUT_AUDIO_EPOCH_BYTES, false), 7n);
    assert.deepEqual(decodeOutputAudioFrame(encoded), {
      epoch: 42,
      outputId: 7,
      audio: pcm16,
    });
  });

  it('rejects invalid or oversized output audio wire frames', () => {
    const pcm16 = new Uint8Array([1, 0]);
    assert.equal(encodeOutputAudioFrame(-1, 1, pcm16), undefined);
    assert.equal(encodeOutputAudioFrame(1, -1, pcm16), undefined);
    assert.equal(
      encodeOutputAudioFrame(Number.MAX_SAFE_INTEGER + 1, 1, pcm16),
      undefined,
    );
    assert.equal(
      encodeOutputAudioFrame(1, Number.MAX_SAFE_INTEGER + 1, pcm16),
      undefined,
    );
    assert.equal(encodeOutputAudioFrame(1, 1, new Uint8Array(1)), undefined);
    assert.equal(
      decodeOutputAudioFrame(new Uint8Array(OUTPUT_AUDIO_HEADER_BYTES)),
      undefined,
    );
    assert.equal(
      decodeOutputAudioFrame(
        new Uint8Array(MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES + 1),
      ),
      undefined,
    );
    const maximum = encodeOutputAudioFrame(
      1,
      1,
      new Uint8Array(MAX_OUTPUT_AUDIO_FRAME_BYTES),
    );
    assert(maximum);
    assert.equal(maximum.byteLength, MAX_OUTPUT_AUDIO_WIRE_FRAME_BYTES);
    assert.equal(
      decodeOutputAudioFrame(maximum)?.audio.byteLength,
      MAX_OUTPUT_AUDIO_FRAME_BYTES,
    );

    const unsafeEpoch = new Uint8Array(OUTPUT_AUDIO_HEADER_BYTES + 2);
    new DataView(unsafeEpoch.buffer).setBigUint64(
      0,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      false,
    );
    assert.equal(decodeOutputAudioFrame(unsafeEpoch), undefined);

    const unsafeOutputId = new Uint8Array(OUTPUT_AUDIO_HEADER_BYTES + 2);
    new DataView(unsafeOutputId.buffer).setBigUint64(
      OUTPUT_AUDIO_EPOCH_BYTES,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      false,
    );
    assert.equal(decodeOutputAudioFrame(unsafeOutputId), undefined);
  });

  it('encodes only bounded JPEG visual frames', () => {
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    assert.equal(isValidInputImageFrame(image), true);
    assert.deepEqual(
      JSON.parse(
        encodeHostControlMessage({
          type: 'host.visual_frame',
          epoch: 7,
          source: 'camera',
          image,
        }),
      ),
      { type: 'host.visual_frame', epoch: 7, source: 'camera', image },
    );
    assert.equal(
      isValidInputImageFrame(Buffer.from('not a jpeg').toString('base64')),
      false,
    );

    const oversized = Buffer.alloc(MAX_INPUT_IMAGE_FRAME_BYTES + 1);
    oversized[0] = 0xff;
    oversized[1] = 0xd8;
    oversized[oversized.length - 2] = 0xff;
    oversized[oversized.length - 1] = 0xd9;
    assert.equal(isValidInputImageFrame(oversized.toString('base64')), false);
  });

  it('admits a visual capture with every text and image field at its limit', () => {
    const jpeg = Buffer.alloc(MAX_INPUT_IMAGE_FRAME_BYTES);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[jpeg.length - 2] = 0xff;
    jpeg[jpeg.length - 1] = 0xd9;
    const encoded = encodeHostControlMessage({
      type: 'host.visual_capture_result',
      requestId: '\ud800'.repeat(128),
      success: true,
      source: 'screen',
      image: jpeg.toString('base64'),
      width: Number.MAX_SAFE_INTEGER,
      height: Number.MAX_SAFE_INTEGER,
      appName: '\ud800'.repeat(512),
      windowTitle: '\ud800'.repeat(2_048),
      accessibilityText: '\ud800'.repeat(32_000),
      screenshotPath: '\ud800'.repeat(4_096),
    });

    assert.equal(
      Buffer.byteLength(encoded, 'utf8') <= MAX_CONTROL_FRAME_BYTES,
      true,
    );
  });

  it('fits every Omni-bound image within 1080p without upscaling', () => {
    assert.deepEqual(fitRealtimeVisualDimensions(3840, 2160), {
      width: 1920,
      height: 1080,
    });
    assert.deepEqual(fitRealtimeVisualDimensions(2560, 1600, 1280, 720), {
      width: 1152,
      height: 720,
    });
    assert.deepEqual(fitRealtimeVisualDimensions(640, 480), {
      width: 640,
      height: 480,
    });
  });

  it('binds input PCM to a safe call epoch', () => {
    const pcm16 = new Uint8Array([1, 0, 2, 0]);
    const encoded = encodeInputAudioFrame(42, pcm16);
    assert(encoded);
    assert.equal(
      encoded.byteLength,
      INPUT_AUDIO_EPOCH_BYTES + pcm16.byteLength,
    );
    assert.equal(new DataView(encoded.buffer).getBigUint64(0, false), 42n);
    assert.deepEqual(encoded.subarray(INPUT_AUDIO_EPOCH_BYTES), pcm16);
    assert.equal(encodeInputAudioFrame(-1, pcm16), undefined);
    assert.equal(
      encodeInputAudioFrame(Number.MAX_SAFE_INTEGER + 1, pcm16),
      undefined,
    );
  });

  it('never emits an oversized control frame', () => {
    assert.throws(() =>
      encodeHostControlMessage({
        type: 'host.hello',
        protocolVersion: LIVE_PROTOCOL_VERSION,
        hostVersion: 'x'.repeat(MAX_CONTROL_FRAME_BYTES),
        bundleId: 'com.alibaba.qwen-code.live-host',
        instanceNonce: 'abcdefghijklmnop',
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
    );
  });

  it('encodes new conversation as its own host action', () => {
    assert.deepEqual(
      JSON.parse(
        encodeHostControlMessage({
          type: 'host.action',
          action: 'new',
          epoch: 4,
        }),
      ),
      { type: 'host.action', action: 'new', epoch: 4 },
    );
  });

  it('parses shortcut replacement commands including Off', () => {
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.set_shortcut',
          requestId: 'shortcut-1',
          shortcut: 'Command+E',
        }),
      ),
      {
        type: 'host.set_shortcut',
        requestId: 'shortcut-1',
        shortcut: 'Command+E',
      },
    );
    const state = {
      type: 'host.state',
      epoch: 1,
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
        shortcut: '',
      },
    };
    assert.deepEqual(parseDaemonControlMessage(JSON.stringify(state)), state);
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          ...state,
          visualInput: { ...state.visualInput, fps: 0 },
        }),
      ),
      undefined,
    );
  });

  it('rejects removed protocol messages', () => {
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.state',
          epoch: 1,
          status: { v: 1, available: true, state: 'idle' },
        }),
      ),
      undefined,
    );
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.open_session',
          target: {
            workspaceId: '',
            workspaceCwd: '/tmp',
            sessionId: 'worker-1',
          },
        }),
      ),
      undefined,
    );
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.capture_screen_context',
          requestId: 'capture-1',
          epoch: 1,
        }),
      ),
      undefined,
    );
  });

  it('does not retain the removed install URL field', () => {
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.state',
          epoch: 1,
          status: {
            v: 1,
            available: false,
            state: 'unavailable',
            shortcut: 'Command+Q',
            installUrl: 'https://example.com/host',
          },
        }),
      ),
      {
        type: 'host.state',
        epoch: 1,
        status: {
          v: 1,
          available: false,
          state: 'unavailable',
          shortcut: 'Command+Q',
        },
      },
    );
  });
});
