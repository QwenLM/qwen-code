/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { WebBridgeRegistry } from '../web-bridge/web-bridge-registry.js';
import { WebBridgeService } from '../web-bridge/web-bridge-service.js';
import { registerWebBridgeRoutes } from './web-bridge.js';

function setup() {
  const app = express();
  app.use(express.json());
  registerWebBridgeRoutes(app, {
    service: new WebBridgeService(new WebBridgeRegistry(), '1.2.3'),
  });
  return app;
}

describe('WebBridge routes', () => {
  it('reports daemon and extension status', async () => {
    const response = await request(setup()).get('/status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      running: true,
      version: '1.2.3',
      extension_connected: false,
    });
  });

  it('returns 503 when no extension is connected', async () => {
    const response = await request(setup()).post('/command').send({
      action: 'snapshot',
      args: {},
      session: 'test',
    });

    expect(response.status).toBe(503);
    expect(response.body.error).toContain('not connected');
  });

  it('returns 504 when the extension action times out', async () => {
    const registry = new WebBridgeRegistry(1);
    registry.register({ connectionId: 'extension', send() {} });
    const app = express();
    app.use(express.json());
    registerWebBridgeRoutes(app, {
      service: new WebBridgeService(registry, '1.2.3'),
    });

    const response = await request(app).post('/command').send({
      action: 'snapshot',
      args: {},
      session: 'test',
    });

    expect(response.status).toBe(504);
    expect(response.body.error).toContain('timed out');
  });
});
