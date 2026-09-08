/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveLogger } from '../logger.js';
import { SubagentsLedger } from '../subagents/ledger.js';
import {
  LiveHostCoordinator,
  LiveUnavailableError,
} from './live-host-coordinator.js';
import {
  LIVE_HOST_BUNDLE_ID,
  LIVE_HOST_PROTOCOL_VERSION,
  LIVE_INPUT_AUDIO_EPOCH_BYTES,
  LIVE_OUTPUT_AUDIO_EPOCH_BYTES,
  LIVE_OUTPUT_AUDIO_HEADER_BYTES,
  type LiveDaemonMessage,
  type LiveHostHello,
  type LiveMemoryAction,
  type LiveMemoryResult,
  type LiveMemoryState,
} from './types.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  closeCode?: number;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  receive(message: unknown): void {
    const data =
      typeof message === 'string'
        ? Buffer.from(message)
        : Buffer.from(JSON.stringify(message));
    this.emit('message', data, false);
  }

  receiveAudio(epoch: number, bytes: readonly number[]): void {
    const frame = Buffer.alloc(LIVE_INPUT_AUDIO_EPOCH_BYTES + bytes.length);
    frame.writeBigUInt64BE(BigInt(epoch), 0);
    Buffer.from(bytes).copy(frame, LIVE_INPUT_AUDIO_EPOCH_BYTES);
    this.emit('message', frame, true);
  }

  receiveRawAudio(bytes: readonly number[]): void {
    this.emit('message', Buffer.from(bytes), true);
  }

  messages(): LiveDaemonMessage[] {
    return this.sent
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value) as LiveDaemonMessage);
  }

  outputFrames(): Array<{ epoch: number; outputId: number; audio: Buffer }> {
    return this.sent
      .filter((value): value is Uint8Array => typeof value !== 'string')
      .map((value) => {
        const frame = Buffer.from(value);
        return {
          epoch: Number(frame.readBigUInt64BE(0)),
          outputId: Number(
            frame.readBigUInt64BE(LIVE_OUTPUT_AUDIO_EPOCH_BYTES),
          ),
          audio: frame.subarray(LIVE_OUTPUT_AUDIO_HEADER_BYTES),
        };
      });
  }
}

const coordinators: LiveHostCoordinator[] = [];

function readyHello(overrides: Partial<LiveHostHello> = {}): LiveHostHello {
  return {
    type: 'host.hello',
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    hostVersion: '1.0.0',
    bundleId: LIVE_HOST_BUNDLE_ID,
    instanceNonce: 'host_instance_nonce_0001',
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
    ...overrides,
  };
}

function coordinator(
  options: Partial<ConstructorParameters<typeof LiveHostCoordinator>[0]> = {},
): LiveHostCoordinator {
  const value = new LiveHostCoordinator({
    daemonInstanceNonce: 'daemon_instance_nonce_0001',
    getProviderReadiness: () => ({ state: 'ready' }),
    ...options,
  });
  value.setAppshotReadiness({ state: 'ready' });
  coordinators.push(value);
  return value;
}

function connectReady(
  value: LiveHostCoordinator,
  hello = readyHello(),
): FakeSocket {
  const socket = new FakeSocket();
  value.attachHost(socket as unknown as WebSocket, value.daemonInstanceNonce);
  socket.receive(hello);
  return socket;
}

afterEach(() => {
  for (const value of coordinators.splice(0)) value.dispose();
  vi.useRealTimers();
});

describe('LiveHostCoordinator', () => {
  it('publishes optional task snapshots on handshake and separate updates without changing call state', () => {
    const ledger = new SubagentsLedger();
    const value = coordinator({ getSubagents: () => ledger.snapshot() });
    const socket = connectReady(value, {
      ...readyHello(),
      subagentsV1: true,
    } as LiveHostHello);
    expect(
      socket.messages().find((message) => message.type === 'host.welcome'),
    ).toHaveProperty('subagentsV1.revision', 0);
    socket.sent.length = 0;
    ledger.upsert({
      id: 'harness:job_1',
      kind: 'harness',
      title: 'Task',
      request: 'Task',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    });
    value.refreshSubagentsState();
    expect(socket.messages()).toEqual([
      { type: 'host.subagents', subagentsV1: ledger.snapshot() },
    ]);
    expect(value.getStatus().state).toBe('idle');
    const legacy = coordinator();
    const legacySocket = connectReady(legacy);
    expect(
      legacySocket
        .messages()
        .find((message) => message.type === 'host.welcome'),
    ).not.toHaveProperty('subagentsV1');
    legacySocket.sent.length = 0;
    legacy.refreshSubagentsState();
    expect(legacySocket.sent).toEqual([]);
    const oldHostCoordinator = coordinator({
      getSubagents: () => ledger.snapshot(),
    });
    const oldHost = connectReady(oldHostCoordinator);
    expect(
      oldHost.messages().find((message) => message.type === 'host.welcome'),
    ).not.toHaveProperty('subagentsV1');
    oldHost.sent.length = 0;
    oldHostCoordinator.refreshSubagentsState();
    expect(oldHost.sent).toEqual([]);
  });
  it('advertises and persists language independently of Memory during a call', () => {
    let language: 'en' | 'zh-CN' = 'en';
    const onLanguageAction = vi.fn((next: 'en' | 'zh-CN') => ({
      language: (language = next),
    }));
    const value = coordinator({
      getUiLanguage: () => ({ language }),
      onLanguageAction,
    });
    const socket = connectReady(value);
    expect(
      socket.messages().find((message) => message.type === 'host.welcome'),
    ).toMatchObject({ uiLanguageV1: { language: 'en' } });
    const call = value.start('resume');
    const action = {
      type: 'host.language_action',
      requestId: 'language-1',
      epoch: call.epoch,
      language: 'zh-CN',
    };
    socket.receive(action);
    socket.receive(action);
    expect(onLanguageAction).toHaveBeenCalledOnce();
    expect(
      socket
        .messages()
        .filter((message) => message.type === 'host.language_result'),
    ).toEqual([
      {
        type: 'host.language_result',
        requestId: 'language-1',
        ok: true,
        uiLanguageV1: { language: 'zh-CN' },
      },
      {
        type: 'host.language_result',
        requestId: 'language-1',
        ok: true,
        uiLanguageV1: { language: 'zh-CN' },
      },
    ]);
    expect(
      socket
        .messages()
        .filter((message) => message.type === 'host.state')
        .at(-1),
    ).toMatchObject({ uiLanguageV1: { language: 'zh-CN' } });
    expect(value.getStatus().callId).toBe(call.callId);
    socket.receive({
      ...action,
      requestId: 'language-stale',
      epoch: call.epoch - 1,
    });
    expect(onLanguageAction).toHaveBeenCalledOnce();
    expect(
      socket
        .messages()
        .filter((message) => message.type === 'host.language_result')
        .at(-1),
    ).toMatchObject({ ok: false, uiLanguageV1: { language: 'zh-CN' } });
  });

  it('rejects malformed or unsupported language requests and reports failed saves without changing language', () => {
    const save = vi.fn(() => {
      throw new Error('private disk error');
    });
    const value = coordinator({
      getUiLanguage: () => ({ language: 'en' }),
      onLanguageAction: save,
    });
    const socket = connectReady(value);
    socket.receive({
      type: 'host.language_action',
      requestId: 'failed',
      epoch: 0,
      language: 'zh-CN',
    });
    const failure = socket
      .messages()
      .find((message) => message.type === 'host.language_result');
    expect(failure).toMatchObject({
      ok: false,
      uiLanguageV1: { language: 'en' },
    });
    expect(JSON.stringify(failure)).not.toContain('private disk error');
    socket.receive({
      type: 'host.language_action',
      requestId: 'bad',
      epoch: 0,
      language: 'fr',
    });
    expect(socket.closeCode).toBe(1002);
    expect(save).toHaveBeenCalledOnce();
    const legacy = coordinator();
    const legacySocket = connectReady(legacy);
    expect(
      legacySocket
        .messages()
        .find((message) => message.type === 'host.welcome'),
    ).not.toHaveProperty('uiLanguageV1');
    legacySocket.receive({
      type: 'host.language_action',
      requestId: 'unsupported',
      epoch: 0,
      language: 'en',
    });
    expect(
      legacySocket
        .messages()
        .find((message) => message.type === 'host.language_result'),
    ).toMatchObject({ ok: false });
  });

  it('advertises process shutdown only when explicitly owned by a standalone daemon', () => {
    for (const enabled of [false, true]) {
      const value = coordinator({ daemonShutdownV1: enabled });
      const socket = connectReady(value);
      const welcome = socket
        .messages()
        .find((message) => message.type === 'host.welcome');
      expect(welcome).toBeDefined();
      expect(
        welcome && 'daemonShutdownV1' in welcome
          ? welcome.daemonShutdownV1
          : undefined,
      ).toBe(enabled ? true : undefined);
    }
  });

  it('routes playback receipts only for the active output generation', () => {
    const onPlaybackStarted = vi.fn();
    const onPlaybackCompleted = vi.fn();
    const value = coordinator({
      handlers: { onPlaybackStarted, onPlaybackCompleted },
    });
    const socket = connectReady(value);

    socket.receive({ type: 'host.playback_started', epoch: 0, outputId: 1 });
    socket.receive({
      type: 'host.playback_completed',
      epoch: 0,
      outputId: 1,
    });
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    expect(onPlaybackCompleted).not.toHaveBeenCalled();

    const call = value.start('resume');
    expect(value.sendOutputAudio(call.epoch, Buffer.from([1, 0]))).toBe(true);
    expect(value.sendOutputAudio(call.epoch, Buffer.from([2, 0]))).toBe(true);
    const firstFrames = socket.outputFrames();
    expect(firstFrames).toHaveLength(2);
    expect(firstFrames[0]).toEqual({
      epoch: call.epoch,
      outputId: 1,
      audio: Buffer.from([1, 0]),
    });
    expect(firstFrames[1]).toEqual({
      epoch: call.epoch,
      outputId: 1,
      audio: Buffer.from([2, 0]),
    });
    socket.receive({
      type: 'host.playback_started',
      epoch: call.epoch - 1,
      outputId: 1,
    });
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch - 1,
      outputId: 1,
    });
    socket.receive({
      type: 'host.playback_started',
      epoch: call.epoch,
      outputId: 2,
    });
    socket.receive({
      type: 'host.playback_started',
      epoch: call.epoch,
      outputId: 1,
    });

    expect(onPlaybackStarted).toHaveBeenCalledExactlyOnceWith({
      epoch: call.epoch,
    });
    expect(onPlaybackCompleted).not.toHaveBeenCalled();

    value.clearOutput(call.epoch);
    expect(value.sendOutputAudio(call.epoch, Buffer.from([3, 0]))).toBe(true);
    const secondFrame = socket.outputFrames().at(-1);
    expect(secondFrame).toEqual({
      epoch: call.epoch,
      outputId: 2,
      audio: Buffer.from([3, 0]),
    });
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 1,
    });
    expect(onPlaybackCompleted).not.toHaveBeenCalled();
    socket.receive({
      type: 'host.playback_started',
      epoch: call.epoch,
      outputId: 2,
    });
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 2,
    });
    expect(onPlaybackStarted).toHaveBeenCalledTimes(2);
    expect(onPlaybackCompleted).not.toHaveBeenCalled();
    value.finishOutputAudio(call.epoch - 1);
    expect(onPlaybackCompleted).not.toHaveBeenCalled();
    value.finishOutputAudio(call.epoch);
    expect(onPlaybackCompleted).toHaveBeenCalledOnce();
    expect(onPlaybackCompleted).toHaveBeenCalledWith({ epoch: call.epoch });

    value.stop();
    socket.receive({
      type: 'host.playback_started',
      epoch: call.epoch,
      outputId: 2,
    });
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 2,
    });
    expect(onPlaybackStarted).toHaveBeenCalledTimes(2);
    expect(onPlaybackCompleted).toHaveBeenCalledOnce();
  });

  it('keeps one output id across audio bursts until the stream is finished', () => {
    const onPlaybackCompleted = vi.fn();
    const value = coordinator({ handlers: { onPlaybackCompleted } });
    const socket = connectReady(value);
    const call = value.start('resume');

    expect(value.sendOutputAudio(call.epoch, Buffer.from([1, 0]))).toBe(true);
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 1,
    });
    expect(onPlaybackCompleted).not.toHaveBeenCalled();

    expect(value.sendOutputAudio(call.epoch, Buffer.from([2, 0]))).toBe(true);
    expect(socket.outputFrames()).toEqual([
      { epoch: call.epoch, outputId: 1, audio: Buffer.from([1, 0]) },
      { epoch: call.epoch, outputId: 1, audio: Buffer.from([2, 0]) },
    ]);

    value.finishOutputAudio(call.epoch);
    expect(onPlaybackCompleted).not.toHaveBeenCalled();
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 1,
    });
    expect(onPlaybackCompleted).toHaveBeenCalledOnce();

    expect(value.sendOutputAudio(call.epoch, Buffer.from([3, 0]))).toBe(true);
    expect(socket.outputFrames().at(-1)?.outputId).toBe(2);
  });

  it('waits for an end-marker-aware Host to drain every sent audio frame', () => {
    const onPlaybackCompleted = vi.fn();
    const value = coordinator({ handlers: { onPlaybackCompleted } });
    const socket = connectReady(
      value,
      readyHello({
        capabilities: { outputAudioEndMarkerV1: true },
      }),
    );
    const call = value.start('resume');
    expect(
      socket.messages().find((message) => message.type === 'host.welcome'),
    ).toMatchObject({
      capabilities: { outputAudioEndMarkerV1: true },
    });

    expect(value.sendOutputAudio(call.epoch, Buffer.from([1, 0]))).toBe(true);
    expect(value.sendOutputAudio(call.epoch, Buffer.from([2, 0]))).toBe(true);
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 1,
    });
    expect(onPlaybackCompleted).not.toHaveBeenCalled();

    value.finishOutputAudio(call.epoch);
    expect(socket.messages()).toContainEqual({
      type: 'host.output_audio_finished',
      epoch: call.epoch,
      outputId: 1,
    });
    expect(onPlaybackCompleted).not.toHaveBeenCalled();

    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 1,
    });
    expect(onPlaybackCompleted).toHaveBeenCalledOnce();
  });

  it('seals each marked output and waits for consecutive outputs as one playback window', () => {
    const onPlaybackStarted = vi.fn();
    const onPlaybackCompleted = vi.fn();
    const value = coordinator({
      handlers: { onPlaybackStarted, onPlaybackCompleted },
    });
    const socket = connectReady(
      value,
      readyHello({
        capabilities: { outputAudioEndMarkerV1: true },
      }),
    );
    const call = value.start('resume');

    expect(value.sendOutputAudio(call.epoch, Buffer.from([1, 0]))).toBe(true);
    value.finishOutputAudio(call.epoch);
    expect(value.sendOutputAudio(call.epoch, Buffer.from([2, 0]))).toBe(true);
    expect(socket.outputFrames()).toEqual([
      { epoch: call.epoch, outputId: 1, audio: Buffer.from([1, 0]) },
      { epoch: call.epoch, outputId: 2, audio: Buffer.from([2, 0]) },
    ]);
    expect(
      socket
        .messages()
        .filter((message) => message.type === 'host.output_audio_finished'),
    ).toEqual([
      {
        type: 'host.output_audio_finished',
        epoch: call.epoch,
        outputId: 1,
      },
    ]);

    socket.receive({
      type: 'host.playback_started',
      epoch: call.epoch,
      outputId: 1,
    });
    socket.receive({
      type: 'host.playback_started',
      epoch: call.epoch,
      outputId: 2,
    });
    expect(onPlaybackStarted).toHaveBeenCalledOnce();

    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 1,
    });
    expect(onPlaybackCompleted).not.toHaveBeenCalled();

    value.finishOutputAudio(call.epoch);
    expect(
      socket
        .messages()
        .filter((message) => message.type === 'host.output_audio_finished'),
    ).toEqual([
      {
        type: 'host.output_audio_finished',
        epoch: call.epoch,
        outputId: 1,
      },
      {
        type: 'host.output_audio_finished',
        epoch: call.epoch,
        outputId: 2,
      },
    ]);
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 2,
    });
    expect(onPlaybackCompleted).toHaveBeenCalledExactlyOnceWith({
      epoch: call.epoch,
    });
  });

  it('advertises visual settings and routes only matching Live Feed frames', () => {
    const onInputImage = vi.fn();
    const onVisualSettings = vi.fn();
    const value = coordinator({
      visualInput: {
        source: 'camera',
        mode: 'live-feed',
        fps: 2,
        liveWidth: 1280,
        liveHeight: 720,
      },
      handlers: { onInputImage, onVisualSettings },
    });
    const socket = connectReady(value);
    expect(
      socket.messages().find((message) => message.type === 'host.welcome'),
    ).toMatchObject({
      visualInput: {
        source: 'camera',
        mode: 'live-feed',
        fps: 2,
        liveWidth: 1280,
        liveHeight: 720,
      },
    });

    const call = value.start('resume');
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    socket.receive({
      type: 'host.visual_frame',
      epoch: call.epoch,
      source: 'camera',
      image,
    });
    socket.receive({
      type: 'host.visual_frame',
      epoch: call.epoch,
      source: 'screen',
      image,
    });
    socket.receive({
      type: 'host.visual_frame',
      epoch: call.epoch - 1,
      source: 'camera',
      image,
    });

    expect(onInputImage).toHaveBeenCalledTimes(1);
    expect(onInputImage).toHaveBeenCalledWith({
      epoch: call.epoch,
      callId: call.callId,
      source: 'camera',
      image,
    });
    socket.receive({
      type: 'host.visual_settings',
      epoch: call.epoch,
      source: 'screen',
      mode: 'on-demand',
      permissions: {
        camera: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      appshot: true,
    });
    expect(onVisualSettings).toHaveBeenCalledWith({
      epoch: call.epoch,
      callId: call.callId,
      visualInput: {
        source: 'screen',
        mode: 'on-demand',
        fps: 2,
        liveWidth: 1280,
        liveHeight: 720,
      },
    });
    expect(socket.messages().at(-1)).toMatchObject({
      type: 'host.state',
      visualInput: {
        source: 'screen',
        mode: 'on-demand',
        fps: 2,
        liveWidth: 1280,
        liveHeight: 720,
      },
    });
    value.stop();
  });

  it('rejects a malformed visual frame at the Host protocol boundary', () => {
    const onInputImage = vi.fn();
    const value = coordinator({
      visualInput: {
        source: 'camera',
        mode: 'live-feed',
        fps: 1,
        liveWidth: 1280,
        liveHeight: 720,
      },
      handlers: { onInputImage },
    });
    const socket = connectReady(value);
    const call = value.start('resume');

    socket.receive({
      type: 'host.visual_frame',
      epoch: call.epoch,
      source: 'camera',
      image: 'not-a-jpeg',
    });

    expect(onInputImage).not.toHaveBeenCalled();
    expect(socket.closeCode).toBe(1002);
  });

  it('logs visual-frame acceptance without logging image data', () => {
    const debug = vi.fn();
    const logger = {
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as LiveLogger;
    const value = coordinator({
      logger,
      visualInput: {
        source: 'camera',
        mode: 'live-feed',
        fps: 1,
        liveWidth: 1280,
        liveHeight: 720,
      },
      handlers: { onInputImage: () => false },
    });
    const socket = connectReady(value);
    const call = value.start('resume');
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

    socket.receive({
      type: 'host.visual_frame',
      epoch: call.epoch,
      source: 'camera',
      image,
    });

    const visualLog = debug.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith('visual.frame '));
    expect(visualLog).toContain('"accepted":false');
    expect(visualLog).toContain('"bytes":4');
    expect(visualLog).not.toContain(image);
  });

  it('routes one correlated On Demand capture only for the active Live session', async () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    await expect(value.captureVisualContext('worker-1')).rejects.toThrow(
      'active Live session',
    );
    const capture = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    expect(request).toMatchObject({
      type: 'host.capture_visual',
      epoch: call.epoch,
      source: 'screen',
    });
    if (!request || request.type !== 'host.capture_visual') {
      throw new Error('Missing visual capture request');
    }
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    socket.receive({
      type: 'host.visual_capture_result',
      requestId: request.requestId,
      success: true,
      source: 'screen',
      image,
      width: 1280,
      height: 720,
      appName: 'Google Chrome',
      windowTitle: 'LIVE_APP_A',
      accessibilityText: 'AXWindow LIVE_APP_A',
      screenshotPath: '/private/tmp/qwen-live-appshot/test.png',
    });

    await expect(capture).resolves.toEqual({
      source: 'screen',
      image,
      width: 1280,
      height: 720,
      appName: 'Google Chrome',
      windowTitle: 'LIVE_APP_A',
      accessibilityText: 'AXWindow LIVE_APP_A',
      screenshotPath: '/private/tmp/qwen-live-appshot/test.png',
    });
    value.stop();
  });

  it('requests a non-persistent capture for background visual sampling', async () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    const capture = value.captureVisualContext('coordinator-1', {
      persistAsset: false,
    });
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    expect(request).toMatchObject({
      type: 'host.capture_visual',
      epoch: call.epoch,
      source: 'screen',
      persistAsset: false,
    });
    if (!request || request.type !== 'host.capture_visual') {
      throw new Error('Missing visual capture request');
    }
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    socket.receive({
      type: 'host.visual_capture_result',
      requestId: request.requestId,
      success: true,
      source: 'screen',
      image,
      width: 1280,
      height: 720,
      appName: 'Google Chrome',
      accessibilityText: '',
    });

    await expect(capture).resolves.toEqual({
      source: 'screen',
      image,
      width: 1280,
      height: 720,
      appName: 'Google Chrome',
      accessibilityText: '',
    });
    value.stop();
  });

  it('rejects a persistent capture when the Host omits its asset path', async () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    const capture = value.captureVisualContext('coordinator-1', {
      persistAsset: true,
    });
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    if (!request || request.type !== 'host.capture_visual') {
      throw new Error('Missing visual capture request');
    }
    socket.receive({
      type: 'host.visual_capture_result',
      requestId: request.requestId,
      success: true,
      source: 'screen',
      image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      width: 1280,
      height: 720,
      appName: 'Google Chrome',
      accessibilityText: '',
    });

    await expect(capture).rejects.toThrow('did not persist');
    expect(socket.closeCode).toBeUndefined();
    value.stop();
  });

  it('captures Camera on demand without requiring Screen readiness', async () => {
    const value = coordinator({
      visualInput: {
        source: 'camera',
        mode: 'on-demand',
        fps: 1,
        liveWidth: 1280,
        liveHeight: 720,
        snapshotWidth: 1024,
        snapshotHeight: 768,
        cameraSnapshotWidth: 3840,
        cameraSnapshotHeight: 2160,
      },
    });
    const socket = connectReady(
      value,
      readyHello({
        permissions: {
          microphone: 'granted',
          camera: 'granted',
          accessibility: 'denied',
          screenRecording: 'denied',
        },
        selfChecks: {
          audioInput: true,
          audioOutput: true,
          globalShortcut: true,
          appshot: false,
        },
      }),
    );
    expect(value.getStatus()).toMatchObject({ available: true, state: 'idle' });
    expect(value.getStatus().requirements).not.toHaveProperty('appshot');

    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });
    const capture = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    expect(request).toMatchObject({
      type: 'host.capture_visual',
      epoch: call.epoch,
      source: 'camera',
      snapshotWidth: 3840,
      snapshotHeight: 2160,
    });
    if (!request || request.type !== 'host.capture_visual') {
      throw new Error('Missing visual capture request');
    }
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    socket.receive({
      type: 'host.visual_capture_result',
      requestId: request.requestId,
      success: true,
      source: 'camera',
      image,
      width: 1920,
      height: 1080,
      screenshotPath: '/private/tmp/qwen-live-appshot/test.jpg',
    });

    await expect(capture).resolves.toEqual({
      source: 'camera',
      image,
      width: 1920,
      height: 1080,
      screenshotPath: '/private/tmp/qwen-live-appshot/test.jpg',
    });
    value.stop();
  });

  it('does not request an On Demand camera frame without Camera permission', async () => {
    const value = coordinator({
      handlers: { onStop: () => new Promise<void>(() => undefined) },
    });
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    socket.receive({
      type: 'host.visual_settings',
      epoch: call.epoch,
      source: 'camera',
      mode: 'on-demand',
      permissions: {
        camera: 'denied',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      appshot: true,
    });

    await expect(value.captureVisualContext('coordinator-1')).rejects.toThrow(
      'ready selected source',
    );
    expect(
      socket
        .messages()
        .filter((message) => message.type === 'host.capture_visual'),
    ).toHaveLength(0);
  });

  it('rejects an On Demand result from a different visual source', async () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });
    const capture = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    if (!request || request.type !== 'host.capture_visual') {
      throw new Error('Missing visual capture request');
    }
    socket.receive({
      type: 'host.visual_capture_result',
      requestId: request.requestId,
      success: true,
      source: 'camera',
      image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
      width: 1280,
      height: 720,
    });

    await expect(capture).rejects.toThrow('wrong visual capture source');
    value.stop();
  });

  it('requires Camera permission when Camera is the configured source', () => {
    const value = coordinator({
      visualInput: {
        source: 'camera',
        mode: 'on-demand',
        fps: 1,
        liveWidth: 1280,
        liveHeight: 720,
      },
    });
    connectReady(
      value,
      readyHello({
        permissions: {
          ...readyHello().permissions,
          camera: 'denied',
          accessibility: 'denied',
          screenRecording: 'denied',
        },
      }),
    );

    expect(() => value.start('resume')).toThrow(LiveUnavailableError);
    expect(value.getStatus()).toMatchObject({
      available: false,
      blocker: 'camera_permission',
      requirements: { camera: 'denied' },
    });
    expect(value.getStatus().requirements).not.toHaveProperty('appshot');
  });

  it('changes idle visual settings and uses fresh source readiness', () => {
    const onStart = vi.fn();
    const value = coordinator({ handlers: { onStart } });
    const socket = connectReady(
      value,
      readyHello({
        permissions: {
          ...readyHello().permissions,
          camera: 'denied',
        },
      }),
    );

    socket.receive({
      type: 'host.visual_settings',
      epoch: 0,
      source: 'camera',
      mode: 'live-feed',
      permissions: {
        camera: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      appshot: true,
    });

    expect(value.getStatus()).toMatchObject({
      available: true,
      state: 'idle',
      requirements: { camera: 'ready' },
    });
    const call = value.start('resume');
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        epoch: call.epoch,
        visualInput: expect.objectContaining({
          source: 'camera',
          mode: 'live-feed',
        }),
      }),
    );
    value.stop();
  });

  it('updates permissions atomically while switching an active source', () => {
    const onStop = vi.fn();
    const value = coordinator({
      visualInput: {
        source: 'camera',
        mode: 'on-demand',
        fps: 1,
        liveWidth: 1280,
        liveHeight: 720,
      },
      handlers: { onStop },
    });
    const socket = connectReady(
      value,
      readyHello({
        permissions: {
          ...readyHello().permissions,
          accessibility: 'denied',
          screenRecording: 'denied',
        },
      }),
    );
    const call = value.start('resume');

    socket.receive({
      type: 'host.visual_settings',
      epoch: call.epoch,
      source: 'screen',
      mode: 'on-demand',
      permissions: {
        camera: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      appshot: true,
    });

    expect(value.getStatus()).toMatchObject({
      available: true,
      callId: call.callId,
      requirements: {
        accessibility: 'ready',
        screenRecording: 'ready',
        appshot: 'ready',
      },
    });
    expect(onStop).not.toHaveBeenCalled();
    value.stop();
  });

  it('rejects an obsolete On Demand capture when Source or Mode changes', async () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });
    const capture = value.captureVisualContext('coordinator-1');
    const settled = capture.catch((error: unknown) => error);

    socket.receive({
      type: 'host.visual_settings',
      epoch: call.epoch,
      source: 'camera',
      mode: 'live-feed',
      permissions: {
        camera: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
      appshot: true,
    });

    await expect(settled).resolves.toMatchObject({
      message: expect.stringContaining('visual settings changed'),
    });
    expect(pendingVisualCaptureCount(value)).toBe(0);
    value.stop();
  });

  it('projects a WebShell target only while the coordinator awaits permission', () => {
    const value = coordinator();
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      workspaceId: 'conversations-workspace',
      sessionId: 'coordinator-1',
    });

    expect(value.setPendingPermission(call.epoch, true)).toBe(true);
    expect(value.getStatus().pendingPermission).toEqual({
      workspaceId: 'conversations-workspace',
      sessionId: 'coordinator-1',
    });

    expect(value.setPendingPermission(call.epoch, false)).toBe(true);
    expect(value.getStatus().pendingPermission).toBeUndefined();
    expect(value.setPendingPermission(call.epoch + 1, true)).toBe(false);
  });

  it('lets the active Live session finish On Demand capture during stop drain', async () => {
    let finishStop: (() => void) | undefined;
    const value = coordinator({
      handlers: {
        onStop: () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      },
    });
    const socket = connectReady(value);
    const call = value.start('resume');

    expect(value.stop()).toMatchObject({
      state: 'stopping',
      callId: call.callId,
    });
    expect(
      value.setCoordinator(call.epoch, {
        workspaceCwd: '/conversations/live-1',
        sessionId: 'coordinator-1',
      }),
    ).toBe(true);

    const capture = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    if (!request || request.type !== 'host.capture_visual') {
      throw new Error('Missing visual capture request');
    }
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    socket.receive({
      type: 'host.visual_capture_result',
      requestId: request.requestId,
      success: true,
      source: 'screen',
      image,
      width: 1280,
      height: 720,
      appName: 'TextEdit',
      accessibilityText: 'APPSHOT-MARKER-AMBER-4827',
      screenshotPath: '/private/tmp/qwen-live-appshot/test.png',
    });

    await expect(capture).resolves.toMatchObject({
      appName: 'TextEdit',
      accessibilityText: 'APPSHOT-MARKER-AMBER-4827',
    });
    finishStop?.();
    await vi.waitFor(() => {
      expect(value.getStatus()).toMatchObject({ state: 'idle' });
    });
  });

  it('bounds a Host capture that never answers', async () => {
    vi.useFakeTimers();
    const value = coordinator({ visualCaptureTimeoutMs: 100 });
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });
    const capture = value.captureVisualContext('coordinator-1');
    const settled = capture.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);

    await expect(settled).resolves.toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    value.stop();
  });

  it('fails closed until Appshot has been verified', () => {
    const value = new LiveHostCoordinator({
      daemonInstanceNonce: 'daemon_instance_nonce_0002',
      getProviderReadiness: () => ({ state: 'ready' }),
      shortcut: 'Command+Shift+L',
    });
    coordinators.push(value);
    connectReady(value);

    expect(value.getStatus()).toMatchObject({
      available: false,
      blocker: 'appshot',
      shortcut: 'Command+Shift+L',
      requirements: { appshot: 'unavailable' },
    });
  });

  it('commits a shortcut only after the Host confirms registration', async () => {
    const value = coordinator();
    const socket = connectReady(value);

    const update = value.setShortcut('Command+Shift+E');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.set_shortcut');
    expect(request).toMatchObject({
      type: 'host.set_shortcut',
      shortcut: 'Command+Shift+E',
    });
    expect(value.getStatus().shortcut).toBe('Command+E');
    if (!request || request.type !== 'host.set_shortcut') {
      throw new Error('Missing shortcut request');
    }
    socket.receive({
      type: 'host.shortcut_result',
      requestId: request.requestId,
      shortcut: request.shortcut,
      success: true,
    });

    await expect(update).resolves.toMatchObject({
      shortcut: 'Command+Shift+E',
    });
    expect(value.getStatus().shortcut).toBe('Command+Shift+E');
  });

  it('keeps the previous shortcut when the Host rejects a conflict', async () => {
    const value = coordinator();
    const socket = connectReady(value);

    const update = value.setShortcut('Command+Shift+E');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.set_shortcut');
    if (!request || request.type !== 'host.set_shortcut') {
      throw new Error('Missing shortcut request');
    }
    socket.receive({
      type: 'host.shortcut_result',
      requestId: request.requestId,
      shortcut: request.shortcut,
      success: false,
      error: 'That shortcut is already in use.',
    });

    await expect(update).rejects.toThrow('already in use');
    expect(value.getStatus().shortcut).toBe('Command+E');
  });

  it('can turn the global shortcut off without disabling Live', async () => {
    const value = coordinator();
    const socket = connectReady(value);

    const update = value.setShortcut('');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.set_shortcut');
    if (!request || request.type !== 'host.set_shortcut') {
      throw new Error('Missing shortcut request');
    }
    socket.receive({
      type: 'host.shortcut_result',
      requestId: request.requestId,
      shortcut: '',
      success: true,
    });

    await expect(update).resolves.toMatchObject({
      available: true,
      shortcut: '',
    });
  });

  it('requires the discovery nonce before accepting a Host', () => {
    const value = coordinator();
    const socket = new FakeSocket();

    value.attachHost(socket as unknown as WebSocket, 'wrong_nonce_value_0000');

    expect(socket.closeCode).toBe(4003);
    expect(value.getStatus()).toMatchObject({
      available: false,
      blocker: 'host_missing',
    });
  });

  it('reports a pre-camera Host hello as an incompatible protocol', () => {
    const value = coordinator();
    const socket = new FakeSocket();
    value.attachHost(socket as unknown as WebSocket, value.daemonInstanceNonce);
    const legacyHello = readyHello({ protocolVersion: 7 }) as unknown as {
      permissions: Record<string, unknown>;
    };
    delete legacyHello.permissions['camera'];

    socket.receive(legacyHello);

    expect(socket.closeCode).toBe(4006);
    expect(value.getStatus()).toMatchObject({
      available: false,
      blocker: 'host_version',
    });
  });

  it('rejects a v9 Host hello that omits camera readiness', () => {
    const value = coordinator();
    const socket = new FakeSocket();
    value.attachHost(socket as unknown as WebSocket, value.daemonInstanceNonce);
    const invalidHello = readyHello() as unknown as {
      permissions: Record<string, unknown>;
    };
    delete invalidHello.permissions['camera'];

    socket.receive(invalidHello);

    expect(socket.closeCode).toBe(1002);
    expect(value.getStatus()).toMatchObject({
      available: false,
      blocker: 'host_missing',
    });
  });

  it('welcomes one compatible, fully-authorized Host', () => {
    const value = coordinator();
    const socket = connectReady(value);

    expect(value.getStatus()).toMatchObject({
      available: true,
      state: 'idle',
      host: {
        version: '1.0.0',
        protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      },
      requirements: {
        host: 'ready',
        microphone: 'ready',
        accessibility: 'ready',
        screenRecording: 'ready',
        audioInput: 'ready',
        audioOutput: 'ready',
        globalShortcut: 'ready',
        appshot: 'ready',
        provider: 'ready',
      },
    });
    expect(socket.messages().map((message) => message.type)).toEqual([
      'host.welcome',
      'host.state',
    ]);

    const duplicate = new FakeSocket();
    value.attachHost(
      duplicate as unknown as WebSocket,
      value.daemonInstanceNonce,
    );
    expect(duplicate.closeCode).toBe(4009);
  });

  it('never sends WebShell session locators to the native Host', () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('new');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/private/conversations/coordinator',
      sessionId: 'coordinator-session',
    });
    value.setWorkers(call.epoch, [
      {
        workspaceCwd: '/private/conversations/worker',
        sessionId: 'worker-session',
      },
    ]);

    expect(value.getStatus()).not.toHaveProperty('coordinator');
    expect(value.getStatus()).not.toHaveProperty('workers');
    expect(value.isActiveSession('coordinator-session')).toBe(true);
    expect(value.isActiveSession('worker-session')).toBe(true);
    expect(value.isActiveSession('unrelated-session')).toBe(false);
    for (const message of socket.messages()) {
      if (message.type !== 'host.welcome' && message.type !== 'host.state') {
        continue;
      }
      expect(message.status).not.toHaveProperty('coordinator');
      expect(message.status).not.toHaveProperty('workers');
      expect(JSON.stringify(message)).not.toContain('/private/conversations');
    }
  });

  it('hard-gates start on every permission and self-check', () => {
    const value = coordinator();
    connectReady(
      value,
      readyHello({
        permissions: {
          ...readyHello().permissions,
          screenRecording: 'denied',
        },
      }),
    );

    expect(() => value.start('resume')).toThrow(LiveUnavailableError);
    expect(value.getStatus()).toMatchObject({
      available: false,
      state: 'unavailable',
      blocker: 'screen_recording_permission',
      requirements: { screenRecording: 'denied' },
    });
  });

  it('hard-gates start when the built-in Appshot channel is unavailable', () => {
    const value = coordinator();
    connectReady(value);

    value.setAppshotReadiness({
      state: 'unavailable',
      message: 'The built-in Appshot channel is unavailable.',
    });

    expect(() => value.start('resume')).toThrow(LiveUnavailableError);
    expect(value.getStatus()).toMatchObject({
      available: false,
      state: 'unavailable',
      blocker: 'appshot',
      message: 'The built-in Appshot channel is unavailable.',
      requirements: { appshot: 'unavailable' },
    });
  });

  it('owns one call epoch and ignores stale updates and actions', () => {
    const starts = vi.fn();
    const stops = vi.fn();
    const value = coordinator({ handlers: { onStart: starts, onStop: stops } });
    const socket = connectReady(value);

    const first = value.start('resume');
    expect(value.start('resume').callId).toBe(first.callId);
    const second = value.start('new');

    expect(second.callId).not.toBe(first.callId);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(starts).toHaveBeenCalledTimes(2);
    expect(stops).toHaveBeenCalledWith({
      epoch: first.epoch,
      callId: first.callId,
    });
    expect(value.setCallState(first.epoch, 'speaking')).toBe(false);

    socket.receive({
      type: 'host.action',
      action: 'stop',
      epoch: first.epoch,
    });
    expect(value.getStatus().callId).toBe(second.callId);
    expect(socket.messages()).toContainEqual({
      type: 'host.error',
      code: 'stale_epoch',
      message: 'The Live action epoch is stale.',
    });

    value.stop();
    socket.receive({
      type: 'host.action',
      action: 'new',
      epoch: second.epoch,
    });
    expect(value.getStatus().state).toBe('idle');
  });

  it('keeps the stopping call epoch until the session drain succeeds', async () => {
    let finishStop: (() => void) | undefined;
    const onStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const value = coordinator({ handlers: { onStop } });
    connectReady(value);
    const call = value.start('resume');

    expect(value.stop()).toMatchObject({
      state: 'stopping',
      callId: call.callId,
    });
    expect(value.setTranscript(call.epoch, 'late final transcript')).toBe(true);
    expect(value.getStatus()).toMatchObject({
      state: 'stopping',
      callId: call.callId,
      transcript: 'late final transcript',
    });

    finishStop?.();
    await vi.waitFor(() => {
      expect(value.getStatus()).toMatchObject({ state: 'idle' });
      expect(value.getStatus().callId).toBeUndefined();
    });
  });

  it('projects user transcript, assistant caption, and task status separately', () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');

    expect(value.setTranscript(call.epoch, '检查当前页面')).toBe(true);
    expect(value.setCaption(call.epoch, '当前页面是文档编辑器。')).toBe(true);
    expect(value.setStatusText(call.epoch, 'Reading screen…')).toBe(true);

    expect(value.getStatus()).toMatchObject({
      transcript: '检查当前页面',
      caption: '当前页面是文档编辑器。',
      statusText: 'Reading screen…',
    });
    expect(socket.messages().at(-1)).toMatchObject({
      type: 'host.state',
      status: {
        transcript: '检查当前页面',
        caption: '当前页面是文档编辑器。',
        statusText: 'Reading screen…',
      },
    });
  });

  it('starts a replacement only after the exact pending input is persisted', async () => {
    let finishPersistence!: () => void;
    const persisted = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const lifecycle: string[] = [];
    const onStart = vi.fn((call: { mode: 'resume' | 'new' }) => {
      lifecycle.push(`start:${call.mode}`);
    });
    const onStop = vi.fn(async () => {
      lifecycle.push('stop:requested');
      await persisted;
      lifecycle.push('persist:exact-final');
    });
    const value = coordinator({ handlers: { onStart, onStop } });
    connectReady(value);
    const first = value.start('resume');

    const pending = value.start('new');

    expect(pending).toMatchObject({
      epoch: first.epoch,
      callId: first.callId,
      status: { state: 'stopping', callId: first.callId },
    });
    expect(onStart).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(['start:resume', 'stop:requested']);

    finishPersistence();
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledTimes(2));

    expect(lifecycle).toEqual([
      'start:resume',
      'stop:requested',
      'persist:exact-final',
      'start:new',
    ]);
    expect(value.getStatus()).toMatchObject({ state: 'starting' });
    expect(value.getStatus().callId).not.toBe(first.callId);
  });

  it('does not rotate when persistence fails during replacement', async () => {
    const onStart = vi.fn();
    const value = coordinator({
      handlers: {
        onStart,
        onStop: async () => ({
          error: 'Exact final transcript was not saved.',
        }),
      },
    });
    connectReady(value);
    value.start('resume');

    value.start('new');

    await vi.waitFor(() => {
      expect(value.getStatus()).toMatchObject({
        state: 'error',
        message: 'Exact final transcript was not saved.',
      });
    });
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('lets an explicit stop cancel a pending replacement', async () => {
    let finishStop!: () => void;
    const onStart = vi.fn();
    const value = coordinator({
      handlers: {
        onStart,
        onStop: () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      },
    });
    connectReady(value);
    value.start('resume');
    value.start('new');

    value.stop();
    finishStop();

    await vi.waitFor(() =>
      expect(value.getStatus()).toMatchObject({ state: 'idle' }),
    );
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('publishes a visible error when the session drain cannot be confirmed', async () => {
    let finishStop: ((outcome: { error: string }) => void) | undefined;
    const onStop = vi.fn(
      () =>
        new Promise<{ error: string }>((resolve) => {
          finishStop = resolve;
        }),
    );
    const value = coordinator({ handlers: { onStop } });
    connectReady(value);
    value.start('resume');
    value.stop();

    finishStop?.({ error: 'The final spoken input was not persisted.' });
    await vi.waitFor(() => {
      expect(value.getStatus()).toMatchObject({
        state: 'error',
        message: 'The final spoken input was not persisted.',
      });
    });
  });

  it('rejects removed Host messages', () => {
    const removedMessages = [
      {
        type: 'host.action',
        action: 'request_permission',
        permission: 'microphone',
      },
      {
        type: 'host.action',
        action: 'open_session',
        locator: { workspaceCwd: '/work/one', sessionId: 'session-1' },
      },
      {
        type: 'host.screen_context_result',
        requestId: 'capture-1',
        success: false,
        error: 'removed',
      },
    ];

    for (const message of removedMessages) {
      const value = coordinator();
      const socket = connectReady(value);

      socket.receive(message);

      expect(socket.closeCode).toBe(1002);
      expect(socket.messages()).toContainEqual({
        type: 'host.error',
        code: 'invalid_message',
        message: 'Invalid Live Host message.',
      });
    }
  });

  it('contains a synchronous start-handler failure in the call state', async () => {
    const value = coordinator({
      handlers: {
        onStart: () => {
          throw new Error('start failed');
        },
      },
    });
    connectReady(value);

    expect(() => value.start('resume')).not.toThrow();
    await vi.waitFor(() => {
      expect(value.getStatus()).toMatchObject({
        available: true,
        state: 'error',
        message: 'Live Voice failed to start.',
      });
    });
  });

  it('preserves the first call failure while the call is stopping', () => {
    const value = coordinator({
      handlers: { onStop: () => new Promise<void>(() => undefined) },
    });
    connectReady(value);
    const call = value.start('resume');

    expect(value.failCall(call.epoch, 'Specific provider failure.')).toBe(true);
    expect(value.failCall(call.epoch, 'Generic start failure.')).toBe(false);
    expect(value.getStatus()).toMatchObject({
      state: 'stopping',
      message: 'Specific provider failure.',
    });
  });

  it('forwards bounded PCM only for an active, unmuted call', () => {
    const onInputAudio = vi.fn();
    const onOutputMuted = vi.fn();
    const onPlaybackStarted = vi.fn();
    const onPlaybackCompleted = vi.fn();
    const value = coordinator({
      handlers: {
        onInputAudio,
        onOutputMuted,
        onPlaybackStarted,
        onPlaybackCompleted,
      },
    });
    const socket = connectReady(value);
    const call = value.start('resume');

    socket.receiveAudio(call.epoch, [0, 0, 1, 0]);
    expect(onInputAudio).toHaveBeenCalledWith({
      epoch: call.epoch,
      callId: call.callId,
      pcm16: Buffer.from([0, 0, 1, 0]),
    });

    value.setMute({ inputMuted: true, outputMuted: true });
    socket.receiveAudio(call.epoch, [2, 0]);
    expect(onInputAudio).toHaveBeenCalledTimes(1);
    const sentBeforeMutedOutput = socket.sent.length;
    expect(onOutputMuted).toHaveBeenCalledExactlyOnceWith({
      epoch: call.epoch,
    });
    expect(value.isOutputMuted()).toBe(true);
    expect(value.sendOutputAudio(call.epoch, Buffer.from([0, 0]))).toBe(false);
    expect(value.sendOutputAudio(call.epoch, Buffer.from([1, 0]))).toBe(false);
    socket.receive({
      type: 'host.playback_started',
      epoch: call.epoch,
      outputId: 1,
    });
    socket.receive({
      type: 'host.playback_completed',
      epoch: call.epoch,
      outputId: 1,
    });
    expect(onPlaybackStarted).not.toHaveBeenCalled();
    expect(onPlaybackCompleted).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(sentBeforeMutedOutput);
    expect(value.getStatus()).toMatchObject({
      callId: call.callId,
      outputMuted: true,
    });
    expect(socket.messages()).toContainEqual({
      type: 'host.clear_output',
      epoch: call.epoch,
    });
  });

  it('fails the call when the provider audio path rejects a frame', () => {
    const value = coordinator({
      handlers: { onInputAudio: () => false },
    });
    const socket = connectReady(value);
    const call = value.start('resume');

    socket.receiveAudio(call.epoch, [0, 0]);

    expect(value.getStatus()).toMatchObject({
      state: 'error',
      message: 'Live Voice audio transport dropped input.',
    });
  });

  it('drops same-epoch audio while stop is draining', async () => {
    let finishStop: (() => void) | undefined;
    const onInputAudio = vi.fn(() => false);
    const onStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const value = coordinator({ handlers: { onInputAudio, onStop } });
    const socket = connectReady(value);
    const call = value.start('resume');

    value.stop();
    socket.receiveAudio(call.epoch, [0, 0]);

    expect(onInputAudio).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledOnce();
    expect(value.getStatus()).toMatchObject({
      state: 'stopping',
      callId: call.callId,
    });
    expect(value.getStatus().message).toBeUndefined();

    finishStop?.();
    await vi.waitFor(() => {
      expect(value.getStatus()).toMatchObject({ state: 'idle' });
    });
    expect(value.getStatus().callId).toBeUndefined();
    expect(value.getStatus().message).toBeUndefined();
    expect(value.start('resume').epoch).toBeGreaterThan(call.epoch);
  });

  it('drops audio from the previous epoch after starting a new call', () => {
    const onInputAudio = vi.fn();
    const value = coordinator({ handlers: { onInputAudio } });
    const socket = connectReady(value);
    const first = value.start('resume');
    const second = value.start('new');

    socket.receiveAudio(first.epoch, [1, 0]);
    expect(onInputAudio).not.toHaveBeenCalled();

    socket.receiveAudio(second.epoch, [2, 0]);
    expect(onInputAudio).toHaveBeenCalledExactlyOnceWith({
      epoch: second.epoch,
      callId: second.callId,
      pcm16: Buffer.from([2, 0]),
    });
  });

  it('fails the call instead of crashing when onInputAudio stops and throws', () => {
    const onStop = vi.fn();
    const ref: { current: LiveHostCoordinator | undefined } = {
      current: undefined,
    };
    const onInputAudio = vi.fn(() => {
      ref.current!.stop();
      throw new Error('handler bug');
    });
    const value = coordinator({ handlers: { onInputAudio, onStop } });
    ref.current = value;
    const socket = connectReady(value);
    const call = value.start('resume');

    socket.receiveAudio(call.epoch, [1, 0]);

    expect(onInputAudio).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(socket.closeCode).toBeUndefined();
  });

  it('rejects binary input without the protocol-v2 epoch header', () => {
    const value = coordinator();
    const socket = connectReady(value);
    value.start('resume');

    socket.receiveRawAudio([1, 0]);

    expect(socket.closeCode).toBe(1009);
  });

  it('fails closed and stops the call when provider readiness is lost', () => {
    const onStop = vi.fn();
    const value = coordinator({ handlers: { onStop } });
    connectReady(value);
    const call = value.start('resume');

    value.setProviderReachability({
      state: 'unavailable',
      blocker: 'provider_unreachable',
    });

    expect(value.getStatus()).toMatchObject({
      available: false,
      state: 'unavailable',
      blocker: 'provider_unreachable',
    });
    expect(onStop).toHaveBeenCalledWith({
      epoch: call.epoch,
      callId: call.callId,
    });
  });

  it('retains session ownership while readiness-loss persistence drains', async () => {
    let finishStop: (() => void) | undefined;
    const stopPending = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const value = coordinator({
      handlers: { onStop: () => stopPending },
    });
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'session-live-1',
    });

    value.setProviderReachability({
      state: 'unavailable',
      blocker: 'provider_unreachable',
    });

    expect(value.isActiveSession('session-live-1')).toBe(true);
    expect(value.getStatus()).toMatchObject({
      available: false,
      state: 'unavailable',
      callId: call.callId,
    });

    finishStop?.();
    await vi.waitFor(() => {
      expect(value.isActiveSession('session-live-1')).toBe(false);
    });
  });

  it('keeps the active call while provider readiness is checking but rejects a new start', () => {
    const onStop = vi.fn();
    const value = coordinator({ handlers: { onStop } });
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'session-live-1',
    });

    value.setProviderReachability({ state: 'checking' });

    expect(value.getStatus()).toMatchObject({
      available: false,
      state: 'starting',
      callId: call.callId,
      requirements: { provider: 'checking' },
    });
    expect(value.getStatus().blocker).toBeUndefined();
    expect(onStop).not.toHaveBeenCalled();
    expect(() => value.start('new')).toThrow(LiveUnavailableError);
    expect(onStop).not.toHaveBeenCalled();

    value.setProviderReachability(undefined);
    value.stop();
  });

  it('stops an active call when Appshot is lost while the provider is checking', () => {
    const onStop = vi.fn();
    const value = coordinator({ handlers: { onStop } });
    connectReady(value);
    const call = value.start('resume');
    value.setProviderReachability({ state: 'checking' });

    value.setAppshotReadiness({
      state: 'unavailable',
      message: 'Appshot tools became unavailable.',
    });

    expect(value.getStatus()).toMatchObject({
      available: false,
      state: 'unavailable',
      blocker: 'appshot',
      message: 'Appshot tools became unavailable.',
      requirements: { provider: 'checking', appshot: 'unavailable' },
    });
    expect(value.getStatus().callId).toBeUndefined();
    expect(onStop).toHaveBeenCalledExactlyOnceWith({
      epoch: call.epoch,
      callId: call.callId,
    });
  });

  it('stops an active call when a permission is lost while the provider is checking', () => {
    const onStop = vi.fn();
    const value = coordinator({ handlers: { onStop } });
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setProviderReachability({ state: 'checking' });

    socket.receive(
      readyHello({
        permissions: {
          ...readyHello().permissions,
          screenRecording: 'denied',
        },
      }),
    );

    expect(value.getStatus()).toMatchObject({
      available: false,
      state: 'unavailable',
      blocker: 'screen_recording_permission',
      requirements: { provider: 'checking', screenRecording: 'denied' },
    });
    expect(value.getStatus().callId).toBeUndefined();
    expect(onStop).toHaveBeenCalledExactlyOnceWith({
      epoch: call.epoch,
      callId: call.callId,
    });
  });

  it('stops exactly once when readiness changes during an explicit stop', () => {
    let providerReady = true;
    const onStop = vi.fn();
    const value = coordinator({
      getProviderReadiness: () =>
        providerReady
          ? { state: 'ready' }
          : { state: 'unavailable', blocker: 'provider_unreachable' },
      handlers: { onStop },
    });
    connectReady(value);
    value.start('resume');

    providerReady = false;
    value.stop();

    expect(onStop).toHaveBeenCalledOnce();
    expect(value.getStatus()).toMatchObject({
      available: false,
      blocker: 'provider_unreachable',
    });
  });

  it('expires a Host that misses the application heartbeat', async () => {
    vi.useFakeTimers();
    let now = 0;
    const onStop = vi.fn();
    const value = coordinator({
      now: () => now,
      heartbeatIntervalMs: 5,
      heartbeatTimeoutMs: 10,
      handlers: { onStop },
    });
    const socket = connectReady(value);
    value.start('resume');

    now = 20;
    await vi.advanceTimersByTimeAsync(5);

    expect(socket.closeCode).toBe(4008);
    expect(value.getStatus()).toMatchObject({
      available: false,
      blocker: 'host_disconnected',
    });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('stops the active call before disconnecting the Host on disable', async () => {
    let finishStop: (() => void) | undefined;
    const value = coordinator({
      handlers: {
        onStop: () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      },
    });
    const socket = connectReady(value);
    value.start('resume');

    const deactivating = value.deactivate();
    expect(socket.closeCode).toBeUndefined();
    expect(value.getStatus().state).toBe('stopping');

    finishStop?.();
    await deactivating;
    expect(socket.closeCode).toBe(1001);
    expect(value.getStatus().callId).toBeUndefined();
  });

  it('applies a configured shortcut before a Host connects', () => {
    const value = coordinator();
    expect(value.setConfiguredShortcut('Command+K').shortcut).toBe('Command+K');
  });

  it('accepts a maximum-size visual capture without closing the socket', async () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    const capture = value.captureVisualContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_visual');
    if (!request || request.type !== 'host.capture_visual') {
      throw new Error('Missing visual capture request');
    }
    // Unpaired surrogates occupy six bytes each after JSON escaping. Combined
    // with a maximum JPEG, this exercises the largest field-valid frame.
    const accessibilityText = '\ud800'.repeat(32_000);
    const jpeg = Buffer.alloc(190 * 1024);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[jpeg.length - 2] = 0xff;
    jpeg[jpeg.length - 1] = 0xd9;
    const image = jpeg.toString('base64');
    socket.receive({
      type: 'host.visual_capture_result',
      requestId: request.requestId,
      success: true,
      source: 'screen',
      image,
      width: Number.MAX_SAFE_INTEGER,
      height: Number.MAX_SAFE_INTEGER,
      appName: '\ud800'.repeat(512),
      windowTitle: '\ud800'.repeat(2_048),
      accessibilityText,
      screenshotPath: '\ud800'.repeat(4_096),
    });

    await expect(capture).resolves.toMatchObject({ accessibilityText });
    expect(socket.closeCode).toBeUndefined();
    expect(pendingVisualCaptureCount(value)).toBe(0);
  });

  it('ignores host-initiated starts while deactivating', async () => {
    let finishStop: (() => void) | undefined;
    const onStart = vi.fn();
    const value = coordinator({
      handlers: {
        onStart,
        onStop: () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      },
    });
    const socket = connectReady(value);
    const call = value.start('resume');
    expect(onStart).toHaveBeenCalledTimes(1);

    const deactivating = value.deactivate();
    // The stopping call's epoch still passes the epoch gate, but the start
    // must be ignored during the deactivation drain.
    socket.receive({ type: 'host.action', action: 'new', epoch: call.epoch });
    finishStop?.();
    await deactivating;

    expect(value.getStatus().callId).toBeUndefined();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('lets a host-initiated start work again after the Host reattaches', async () => {
    const onStart = vi.fn();
    const value = coordinator({ handlers: { onStart } });
    connectReady(value);
    await value.deactivate();

    const socket = connectReady(value);
    socket.receive({ type: 'host.action', action: 'new' });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('removes a timed-out visual capture from the pending map', async () => {
    vi.useFakeTimers();
    const value = coordinator({ visualCaptureTimeoutMs: 50 });
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    const capture = value.captureVisualContext('coordinator-1');
    // Attach the rejection handler BEFORE advancing the clock: the
    // timeout fires synchronously inside advanceTimersByTimeAsync, and an
    // unhandled rejection at that instant fails the whole CI run (vitest
    // counts it as an error even though every test passes).
    // The handler must exist before the clock advances (see comment above);
    // awaited on the line after advanceTimersByTimeAsync, which the lint
    // rule cannot see across the assignment.
    // eslint-disable-next-line vitest/valid-expect
    const rejection = expect(capture).rejects.toThrow('timed out');
    expect(pendingVisualCaptureCount(value)).toBe(1);
    await vi.advanceTimersByTimeAsync(51);

    await rejection;
    expect(pendingVisualCaptureCount(value)).toBe(0);
  });

  it('drops a rejected visual capture from the pending map when the call stops', async () => {
    const value = coordinator();
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    const capture = value.captureVisualContext('coordinator-1');
    expect(pendingVisualCaptureCount(value)).toBe(1);
    value.stop();

    await expect(capture).rejects.toThrow(
      'ended before visual capture completed',
    );
    expect(pendingVisualCaptureCount(value)).toBe(0);
  });

  it('clears resolved inactive waiters instead of retaining them', async () => {
    let finishStop: (() => void) | undefined;
    const value = coordinator({
      handlers: {
        onStop: () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      },
    });
    connectReady(value);
    value.start('resume');

    const deactivating = value.deactivate();
    expect(inactiveWaiterCount(value)).toBe(1);
    finishStop?.();
    await deactivating;

    expect(inactiveWaiterCount(value)).toBe(0);
  });
});

describe('LiveHostCoordinator memory RPC', () => {
  function initialMemory(): LiveMemoryState {
    return {
      enabled: true,
      visualEnabled: false,
      libraryId: 'default',
      model: 'qwen3.7-plus',
      libraries: [{ id: 'default', name: 'Default memory' }],
      locked: false,
    };
  }

  function results(socket: FakeSocket): LiveMemoryResult[] {
    return socket
      .messages()
      .filter(
        (message): message is LiveMemoryResult =>
          message.type === 'host.memory_result',
      );
  }

  it('publishes the authoritative memory state and projects call ownership into the lock', () => {
    let memory = { ...initialMemory(), locked: true };
    const value = coordinator({ getMemoryState: () => memory });
    const socket = connectReady(value);
    const welcome = socket
      .messages()
      .find((message) => message.type === 'host.welcome');
    expect(welcome).toMatchObject({
      type: 'host.welcome',
      memory: { ...memory, locked: false },
    });
    expect(socket.messages().at(-1)).toMatchObject({
      type: 'host.state',
      memory: { ...memory, locked: false },
    });
    memory = { ...memory, enabled: false, model: 'another-model' };
    value.refreshMemoryState();
    expect(socket.messages().at(-1)).toMatchObject({
      type: 'host.state',
      memory: { ...memory, locked: false },
    });
    value.start('resume');
    expect(socket.messages().at(-1)).toMatchObject({
      type: 'host.state',
      memory: { ...memory, locked: true },
    });
  });

  it('dispatches all six actions and replies with the updated state', async () => {
    let memory = initialMemory();
    const onMemoryAction = vi.fn((action: LiveMemoryAction) => {
      switch (action.action) {
        case 'set_enabled':
          memory = { ...memory, enabled: action.enabled };
          break;
        case 'set_visual_enabled':
          memory = { ...memory, visualEnabled: action.enabled };
          break;
        case 'create':
          memory = {
            ...memory,
            libraryId: 'lib_work',
            libraries: [
              ...memory.libraries,
              { id: 'lib_work', name: action.name },
            ],
          };
          break;
        case 'rename':
          memory = {
            ...memory,
            libraries: memory.libraries.map((library) =>
              library.id === action.libraryId
                ? { ...library, name: action.name }
                : library,
            ),
          };
          break;
        case 'select':
          memory = { ...memory, libraryId: action.libraryId };
          break;
        case 'set_model':
          memory = { ...memory, model: action.model };
          break;
        default:
          throw new Error('Unexpected memory action');
      }
      return memory;
    });
    const value = coordinator({ getMemoryState: () => memory, onMemoryAction });
    const socket = connectReady(value);
    const actions: LiveMemoryAction[] = [
      { action: 'set_enabled', enabled: false },
      { action: 'set_visual_enabled', enabled: true },
      { action: 'create', name: 'Work' },
      { action: 'rename', libraryId: 'lib_work', name: 'Projects' },
      { action: 'select', libraryId: 'default' },
      { action: 'set_model', model: 'another-model' },
    ];
    for (const [index, action] of actions.entries()) {
      const request = {
        type: 'host.memory_action',
        requestId: `memory-${index}`,
        epoch: 0,
        ...action,
      };
      socket.receive(request);
      await Promise.resolve();
      expect(onMemoryAction).toHaveBeenLastCalledWith(request);
      expect(results(socket).at(-1)).toEqual({
        type: 'host.memory_result',
        requestId: request.requestId,
        ok: true,
        memory,
      });
      expect(socket.messages().at(-1)).toMatchObject({
        type: 'host.state',
        memory,
      });
    }
    expect(onMemoryAction).toHaveBeenCalledTimes(6);
    expect(memory.libraryId).toBe('default');
    expect(memory.libraries).toContainEqual({
      id: 'lib_work',
      name: 'Projects',
    });
  });

  it('rejects stale epochs before calling the memory service', async () => {
    const memory = initialMemory();
    const onMemoryAction = vi.fn(() => memory);
    const value = coordinator({ getMemoryState: () => memory, onMemoryAction });
    const socket = connectReady(value);
    const call = value.start('resume');
    socket.receive({
      type: 'host.memory_action',
      requestId: 'stale-memory',
      epoch: call.epoch - 1,
      action: 'set_enabled',
      enabled: false,
    });
    await Promise.resolve();
    expect(onMemoryAction).not.toHaveBeenCalled();
    expect(results(socket)).toEqual([
      {
        type: 'host.memory_result',
        requestId: 'stale-memory',
        ok: false,
        error: expect.stringMatching(/call changed/i),
        memory: { ...memory, locked: true },
      },
    ]);
  });

  it('locks select, create, and model changes for the whole call, including stop drain', async () => {
    const memory = initialMemory();
    let completeStop: (() => void) | undefined;
    const onMemoryAction = vi.fn(() => memory);
    const value = coordinator({
      getMemoryState: () => memory,
      onMemoryAction,
      handlers: {
        onStop: () =>
          new Promise<void>((resolve) => {
            completeStop = resolve;
          }),
      },
    });
    const socket = connectReady(value);
    const call = value.start('resume');
    const locked: LiveMemoryAction[] = [
      { action: 'select', libraryId: 'other' },
      { action: 'create', name: 'Other' },
      { action: 'set_model', model: 'other-model' },
    ];
    for (const phase of ['active', 'stopping'] as const) {
      if (phase === 'stopping') value.stop();
      for (const action of locked) {
        socket.receive({
          type: 'host.memory_action',
          requestId: `${phase}-${action.action}`,
          epoch: call.epoch,
          ...action,
        });
        await Promise.resolve();
        expect(results(socket).at(-1)).toMatchObject({
          ok: false,
          error: expect.stringMatching(/End the current call/),
          memory: { locked: true },
        });
      }
    }
    expect(onMemoryAction).not.toHaveBeenCalled();
    completeStop?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(value.getStatus().callId).toBeUndefined();
    expect(socket.messages().at(-1)).toMatchObject({
      type: 'host.state',
      memory: { locked: false },
    });
  });

  it('allows rename and both toggles in an active call', async () => {
    const memory = initialMemory();
    const onMemoryAction = vi.fn(() => memory);
    const value = coordinator({ getMemoryState: () => memory, onMemoryAction });
    const socket = connectReady(value);
    const call = value.start('resume');
    const actions: LiveMemoryAction[] = [
      { action: 'rename', libraryId: 'default', name: 'Personal' },
      { action: 'set_enabled', enabled: false },
      { action: 'set_visual_enabled', enabled: true },
    ];
    for (const action of actions) {
      socket.receive({
        type: 'host.memory_action',
        requestId: action.action,
        epoch: call.epoch,
        ...action,
      });
      await Promise.resolve();
      expect(results(socket).at(-1)).toMatchObject({
        ok: true,
        memory: { locked: true },
      });
    }
    expect(onMemoryAction).toHaveBeenCalledTimes(3);
    expect(value.getStatus().callId).toBe(call.callId);
  });

  it('deduplicates an in-flight create and replays its cached result', async () => {
    let memory = initialMemory();
    let complete: ((memory: LiveMemoryState) => void) | undefined;
    const onMemoryAction = vi.fn(
      () =>
        new Promise<LiveMemoryState>((resolve) => {
          complete = resolve;
        }),
    );
    const value = coordinator({ getMemoryState: () => memory, onMemoryAction });
    const socket = connectReady(value);
    const request = {
      type: 'host.memory_action',
      requestId: 'create-once',
      epoch: 0,
      action: 'create',
      name: 'Work',
    };
    socket.receive(request);
    socket.receive(request);
    expect(onMemoryAction).toHaveBeenCalledTimes(1);
    expect(results(socket)).toHaveLength(0);
    memory = {
      ...memory,
      libraryId: 'lib_work',
      libraries: [...memory.libraries, { id: 'lib_work', name: 'Work' }],
    };
    complete?.(memory);
    await Promise.resolve();
    expect(results(socket)).toHaveLength(1);
    const result = results(socket)[0];
    socket.receive(request);
    expect(onMemoryAction).toHaveBeenCalledTimes(1);
    expect(results(socket)).toEqual([result, result]);
  });

  it('contains service errors and reports unavailability without changing call state', async () => {
    const memory = initialMemory();
    const value = coordinator({
      getMemoryState: () => memory,
      onMemoryAction: () => {
        throw new Error('disk full');
      },
    });
    const socket = connectReady(value);
    socket.receive({
      type: 'host.memory_action',
      requestId: 'failed-create',
      epoch: 0,
      action: 'create',
      name: 'Work',
    });
    await Promise.resolve();
    expect(results(socket).at(-1)).toMatchObject({
      ok: false,
      error: 'disk full',
      memory,
    });
    expect(value.getStatus().state).toBe('idle');

    const unsupported = coordinator();
    const legacySocket = connectReady(unsupported);
    expect(
      legacySocket
        .messages()
        .find((message) => message.type === 'host.welcome'),
    ).not.toHaveProperty('memory');
    legacySocket.receive({
      type: 'host.memory_action',
      requestId: 'unavailable',
      epoch: 0,
      action: 'set_enabled',
      enabled: true,
    });
    await Promise.resolve();
    expect(results(legacySocket).at(-1)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unavailable/),
    });
  });

  it('does not deliver late memory results into a replacement Host lease', async () => {
    const memory = initialMemory();
    let complete: ((memory: LiveMemoryState) => void) | undefined;
    const onMemoryAction = vi.fn(
      () =>
        new Promise<LiveMemoryState>((resolve) => {
          complete = resolve;
        }),
    );
    const value = coordinator({ getMemoryState: () => memory, onMemoryAction });
    const first = connectReady(value);
    first.receive({
      type: 'host.memory_action',
      requestId: 'old-lease-request',
      epoch: 0,
      action: 'create',
      name: 'Work',
    });
    first.close();
    const next = connectReady(
      value,
      readyHello({
        instanceNonce: 'host_instance_nonce_0002',
      }),
    );
    const messagesBeforeCompletion = next.messages();
    complete?.(memory);
    await Promise.resolve();
    expect(onMemoryAction).toHaveBeenCalledTimes(1);
    expect(results(first)).toHaveLength(0);
    expect(results(next)).toHaveLength(0);
    expect(next.messages()).toEqual(messagesBeforeCompletion);
    expect(next.readyState).toBe(WebSocket.OPEN);
  });
});

/** Reach into the private pending-capture map to pin its cleanup paths. */
function pendingVisualCaptureCount(value: LiveHostCoordinator): number {
  return (value as unknown as { pendingVisualCaptures: Map<string, unknown> })
    .pendingVisualCaptures.size;
}

/** Reach into the private inactive-waiter set to pin notifyInactive. */
function inactiveWaiterCount(value: LiveHostCoordinator): number {
  return (value as unknown as { inactiveWaiters: Set<() => void> })
    .inactiveWaiters.size;
}
