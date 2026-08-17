import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type {
  LiveDaemonMessage as DaemonMessage,
  LiveHostAction as DaemonHostAction,
  LiveHostHello as DaemonHostHello,
  LiveStatus as DaemonLiveStatus,
} from '../../../../../../cli/src/serve/live/types.ts';
import {
  LIVE_HOST_BUNDLE_ID,
  MAX_CONTROL_FRAME_BYTES,
  MAX_INPUT_AUDIO_FRAME_BYTES,
  INPUT_AUDIO_EPOCH_BYTES,
  LIVE_PROTOCOL_VERSION,
  encodeInputAudioFrame,
  MAX_OUTPUT_AUDIO_FRAME_BYTES,
  encodeHostControlMessage,
  isValidInputAudioFrame,
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
  helloKeys: HasSameKeys<HostHello, DaemonHostHello>;
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
    MessageType<HostDaemonMessage>,
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
  '../../../../../../cli/src/serve/live/types.ts',
  import.meta.url,
);

describe('Live Host protocol', () => {
  it('stays synchronized with the daemon protocol contract', async () => {
    const source = await readFile(
      fileURLToPath(DAEMON_PROTOCOL_TYPES_URL),
      'utf8',
    );
    const daemonVersion = Number(
      source.match(/LIVE_HOST_PROTOCOL_VERSION = (\d+)/u)?.[1],
    );
    const daemonBundleId = source.match(
      /LIVE_HOST_BUNDLE_ID = '([^']+)'/u,
    )?.[1];

    assert.equal(LIVE_PROTOCOL_VERSION, 6);
    assert.equal(daemonVersion, LIVE_PROTOCOL_VERSION);
    assert.equal(daemonBundleId, LIVE_HOST_BUNDLE_ID);
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
      permissions: {
        microphone: 'granted',
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
        status: {
          v: 1,
          available: true,
          state: 'idle',
          shortcut: 'Command+Q',
        },
      },
    );
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
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.state',
          epoch: 1,
          status: {
            v: 1,
            available: true,
            state: 'idle',
            shortcut: '',
          },
        }),
      )?.type,
      'host.state',
    );
  });

  it('requires a shortcut and rejects the removed session-window message', () => {
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
