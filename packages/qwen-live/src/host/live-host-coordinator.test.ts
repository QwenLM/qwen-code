/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveHostCoordinator,
  LiveUnavailableError,
} from './live-host-coordinator.js';
import {
  LIVE_HOST_BUNDLE_ID,
  LIVE_HOST_PROTOCOL_VERSION,
  LIVE_INPUT_AUDIO_EPOCH_BYTES,
  type LiveDaemonMessage,
  type LiveHostHello,
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
  it('routes one correlated Appshot only for the active Live session', async () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    await expect(value.captureScreenContext('worker-1')).rejects.toThrow(
      'active Live session',
    );
    const capture = value.captureScreenContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_screen_context');
    expect(request).toMatchObject({
      type: 'host.capture_screen_context',
      epoch: call.epoch,
    });
    if (!request || request.type !== 'host.capture_screen_context') {
      throw new Error('Missing Appshot request');
    }
    socket.receive({
      type: 'host.screen_context_result',
      requestId: request.requestId,
      success: true,
      appName: 'Google Chrome',
      windowTitle: 'LIVE_APP_A',
      accessibilityText: 'AXWindow LIVE_APP_A',
      screenshotPath: '/private/tmp/qwen-live-appshot/test.png',
    });

    await expect(capture).resolves.toEqual({
      appName: 'Google Chrome',
      windowTitle: 'LIVE_APP_A',
      accessibilityText: 'AXWindow LIVE_APP_A',
      screenshotPath: '/private/tmp/qwen-live-appshot/test.png',
    });
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

  it('lets the active Live session finish Appshot during stop drain', async () => {
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

    const capture = value.captureScreenContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_screen_context');
    if (!request || request.type !== 'host.capture_screen_context') {
      throw new Error('Missing Appshot request');
    }
    socket.receive({
      type: 'host.screen_context_result',
      requestId: request.requestId,
      success: true,
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
    const value = coordinator({ appshotTimeoutMs: 100 });
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });
    const capture = value.captureScreenContext('coordinator-1');
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

  it('rejects the removed permission and session actions', () => {
    const removedActions = [
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
    ];

    for (const action of removedActions) {
      const value = coordinator();
      const socket = connectReady(value);

      socket.receive(action);

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

  it('forwards bounded PCM only for an active, unmuted call', () => {
    const onInputAudio = vi.fn();
    const value = coordinator({ handlers: { onInputAudio } });
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
    expect(value.sendOutputAudio(call.epoch, Buffer.from([0, 0]))).toBe(true);
    expect(value.sendOutputAudio(call.epoch, Buffer.from([1, 0]))).toBe(true);
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
    expect(onInputAudio).toHaveBeenCalledOnce();
    expect(onInputAudio).toHaveBeenCalledWith({
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
    expect(onStop).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledWith({
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
    expect(onStop).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledWith({
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

  it('accepts a maximum-length CJK accessibility dump without closing the socket', async () => {
    const value = coordinator();
    const socket = connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    const capture = value.captureScreenContext('coordinator-1');
    const request = socket
      .messages()
      .find((message) => message.type === 'host.capture_screen_context');
    if (!request || request.type !== 'host.capture_screen_context') {
      throw new Error('Missing Appshot request');
    }
    // 32,000 CJK chars are conformant per MAX_APPSHOT_TEXT_LENGTH but weigh
    // ~96 KiB in UTF-8: the frame cap must admit them.
    const accessibilityText = '中'.repeat(32_000);
    socket.receive({
      type: 'host.screen_context_result',
      requestId: request.requestId,
      success: true,
      appName: '微信',
      accessibilityText,
      screenshotPath: '/private/tmp/qwen-live-appshot/test.png',
    });

    await expect(capture).resolves.toMatchObject({ accessibilityText });
    expect(socket.closeCode).toBeUndefined();
    expect(pendingAppshotCount(value)).toBe(0);
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

  it('removes a timed-out Appshot from the pending map', async () => {
    vi.useFakeTimers();
    const value = coordinator({ appshotTimeoutMs: 50 });
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    const capture = value.captureScreenContext('coordinator-1');
    expect(pendingAppshotCount(value)).toBe(1);
    await vi.advanceTimersByTimeAsync(51);

    await expect(capture).rejects.toThrow('timed out');
    expect(pendingAppshotCount(value)).toBe(0);
  });

  it('drops a rejected Appshot from the pending map when the call stops', async () => {
    const value = coordinator();
    connectReady(value);
    const call = value.start('resume');
    value.setCoordinator(call.epoch, {
      workspaceCwd: '/conversations/live-1',
      sessionId: 'coordinator-1',
    });

    const capture = value.captureScreenContext('coordinator-1');
    expect(pendingAppshotCount(value)).toBe(1);
    value.stop();

    await expect(capture).rejects.toThrow('ended before Appshot completed');
    expect(pendingAppshotCount(value)).toBe(0);
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

/** Reach into the private pending-Appshot map to pin its cleanup paths. */
function pendingAppshotCount(value: LiveHostCoordinator): number {
  return (value as unknown as { pendingAppshots: Map<string, unknown> })
    .pendingAppshots.size;
}

/** Reach into the private inactive-waiter set to pin notifyInactive. */
function inactiveWaiterCount(value: LiveHostCoordinator): number {
  return (value as unknown as { inactiveWaiters: Set<() => void> })
    .inactiveWaiters.size;
}
