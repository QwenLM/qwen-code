import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
} from '../../shared/protocol.ts';

describe('Live Host protocol', () => {
  it('accepts a bounded welcome and normalizes its heartbeat', () => {
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.welcome',
          protocolVersion: LIVE_PROTOCOL_VERSION,
          daemonInstanceNonce: 'abcdefghijklmnop',
          heartbeatIntervalMs: 50,
          epoch: 2,
          status: { v: 1, available: true, state: 'idle' },
        }),
      ),
      {
        type: 'host.welcome',
        protocolVersion: LIVE_PROTOCOL_VERSION,
        daemonInstanceNonce: 'abcdefghijklmnop',
        heartbeatIntervalMs: 1_000,
        epoch: 2,
        status: { v: 1, available: true, state: 'idle' },
      },
    );
  });

  it('rejects invalid state and oversized control frames', () => {
    assert.equal(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.state',
          epoch: 1,
          status: { v: 1, available: true, state: 'invented' },
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
        type: 'host.action',
        action: 'open_session',
        locator: {
          workspaceCwd: 'x'.repeat(MAX_CONTROL_FRAME_BYTES),
          sessionId: 'session',
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

  it('accepts only complete daemon-validated WebShell targets', () => {
    assert.deepEqual(
      parseDaemonControlMessage(
        JSON.stringify({
          type: 'host.open_session',
          target: {
            workspaceId: 'live-conversation',
            workspaceCwd: '/tmp/live-conversation',
            sessionId: 'worker-1',
          },
        }),
      ),
      {
        type: 'host.open_session',
        target: {
          workspaceId: 'live-conversation',
          workspaceCwd: '/tmp/live-conversation',
          sessionId: 'worker-1',
        },
      },
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
});
