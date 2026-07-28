/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { LiveHostCoordinator } from '../live/live-host-coordinator.js';
import {
  LIVE_HOST_BUNDLE_ID,
  LIVE_HOST_PROTOCOL_VERSION,
} from '../live/types.js';
import { registerLiveRoutes } from './live.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;

  send(): void {}

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

function harness(providerReady = true) {
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
  });
  return { app, coordinator };
}

function connectReady(coordinator: LiveHostCoordinator): void {
  const socket = new FakeSocket();
  coordinator.attachHost(
    socket as unknown as WebSocket,
    coordinator.daemonInstanceNonce,
  );
  socket.hello();
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

  it('returns 503 when Conversations computer-use tools are unavailable', async () => {
    const { app, coordinator } = harness();
    connectReady(coordinator);
    coordinator.setAppshotReadiness({
      state: 'unavailable',
      message: 'Computer Use is disabled in the Conversations runtime.',
    });

    const status = await request(app).get('/live/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      available: false,
      blocker: 'appshot',
      message: 'Computer Use is disabled in the Conversations runtime.',
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
});
