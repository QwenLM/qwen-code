/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveHostCoordinator } from '../live/live-host-coordinator.js';
import {
  LIVE_HOST_BUNDLE_ID,
  LIVE_HOST_PROTOCOL_VERSION,
} from '../live/types.js';
import { registerLiveRoutes } from './live.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;

  shortcutError?: string;

  send(data: string | Uint8Array): void {
    if (typeof data !== 'string') return;
    const message = JSON.parse(data) as Record<string, unknown>;
    if (message['type'] !== 'host.set_shortcut') return;
    queueMicrotask(() => {
      this.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'host.shortcut_result',
            requestId: message['requestId'],
            shortcut: message['shortcut'],
            success: !this.shortcutError,
            ...(this.shortcutError ? { error: this.shortcutError } : {}),
          }),
        ),
        false,
      );
    });
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  hello(): void {
    this.emit(
      'message',
      Buffer.from(
        JSON.stringify({
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
        }),
      ),
      false,
    );
  }
}

const coordinators: LiveHostCoordinator[] = [];

function harness(
  providerReady = true,
  persistShortcut?: (shortcut: string) => Promise<void>,
) {
  const coordinator = new LiveHostCoordinator({
    daemonInstanceNonce: 'daemon_instance_nonce_0001',
    getProviderReadiness: () =>
      providerReady
        ? { state: 'ready' }
        : { state: 'unavailable', blocker: 'provider_config' },
  });
  coordinator.setAppshotReadiness({ state: 'ready' });
  coordinators.push(coordinator);
  const app = express();
  app.use(express.json());
  registerLiveRoutes(app, {
    coordinator,
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    ...(persistShortcut ? { persistShortcut } : {}),
  });
  return { app, coordinator };
}

function connectReady(coordinator: LiveHostCoordinator): FakeSocket {
  const socket = new FakeSocket();
  coordinator.attachHost(
    socket as unknown as WebSocket,
    coordinator.daemonInstanceNonce,
  );
  socket.hello();
  return socket;
}

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.dispose();
});

describe('Live routes', () => {
  it('returns non-secret readiness and a structured unavailable response', async () => {
    const { app } = harness(false);

    const status = await request(app).get('/live/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      v: 1,
      available: false,
      blocker: 'provider_config',
    });
    expect(JSON.stringify(status.body)).not.toContain('apiKey');

    const start = await request(app).post('/live/start').send({});
    expect(start.status).toBe(503);
    expect(start.body).toMatchObject({
      code: 'live_unavailable',
      status: { available: false, blocker: 'provider_config' },
    });
  });

  it('returns 503 when the built-in Appshot channel is unavailable', async () => {
    const { app, coordinator } = harness();
    connectReady(coordinator);
    coordinator.setAppshotReadiness({
      state: 'unavailable',
      message: 'The built-in Appshot channel is unavailable.',
    });

    const status = await request(app).get('/live/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      available: false,
      blocker: 'appshot',
      message: 'The built-in Appshot channel is unavailable.',
      requirements: { appshot: 'unavailable' },
    });

    const start = await request(app).post('/live/start').send({});
    expect(start.status).toBe(503);
    expect(start.body).toMatchObject({
      code: 'live_unavailable',
      status: { available: false, blocker: 'appshot' },
    });
  });

  it('starts, mutes, creates a new call, and stops', async () => {
    const { app, coordinator } = harness();
    connectReady(coordinator);

    const start = await request(app).post('/live/start').send({});
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ available: true, state: 'starting' });
    const firstCallId = start.body.callId as string;

    const mute = await request(app)
      .post('/live/mute')
      .send({ inputMuted: true, outputMuted: true });
    expect(mute.status).toBe(200);
    expect(mute.body).toMatchObject({
      callId: firstCallId,
      inputMuted: true,
      outputMuted: true,
    });

    const next = await request(app).post('/live/new').send({});
    expect(next.status).toBe(200);
    expect(next.body.callId).not.toBe(firstCallId);

    const stop = await request(app).post('/live/stop').send({});
    expect(stop.status).toBe(200);
    expect(stop.body).toMatchObject({ available: true, state: 'idle' });
    expect(stop.body.callId).toBeUndefined();
  });

  it('rejects an empty or non-boolean mute body', async () => {
    const { app } = harness();
    for (const body of [{}, { inputMuted: 'yes' }]) {
      const response = await request(app).post('/live/mute').send(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_live_mute');
    }
  });

  it('persists a Host-confirmed user shortcut and supports Off', async () => {
    const persistShortcut = vi.fn(async () => {});
    const { app, coordinator } = harness(true, persistShortcut);
    connectReady(coordinator);

    const changed = await request(app)
      .post('/live/shortcut')
      .send({ shortcut: 'Command+Shift+E' });
    expect(changed.status).toBe(200);
    expect(changed.body.shortcut).toBe('Command+Shift+E');
    expect(persistShortcut).toHaveBeenCalledWith('Command+Shift+E');

    const off = await request(app)
      .post('/live/shortcut')
      .send({ shortcut: '' });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ available: true, shortcut: '' });
    expect(persistShortcut).toHaveBeenLastCalledWith('');
  });

  it('reports a conflict without persisting or replacing the old shortcut', async () => {
    const persistShortcut = vi.fn(async () => {});
    const { app, coordinator } = harness(true, persistShortcut);
    const socket = connectReady(coordinator);
    socket.shortcutError = 'That shortcut is already in use.';

    const response = await request(app)
      .post('/live/shortcut')
      .send({ shortcut: 'Command+Shift+E' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'live_shortcut_unavailable',
      status: { shortcut: 'Command+E' },
    });
    expect(persistShortcut).not.toHaveBeenCalled();
    expect(coordinator.getStatus().shortcut).toBe('Command+E');
  });

  it('restores the old registration when user persistence fails', async () => {
    const persistShortcut = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { app, coordinator } = harness(true, persistShortcut);
    connectReady(coordinator);

    const response = await request(app)
      .post('/live/shortcut')
      .send({ shortcut: 'Command+Shift+E' });

    expect(response.status).toBe(500);
    expect(response.body.code).toBe('live_shortcut_persist_failed');
    expect(coordinator.getStatus().shortcut).toBe('Command+E');
  });
});
