/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { LiveSetupController } from '../live/live-setup-controller.js';
import { registerLiveSetupRoutes } from './live-setup.js';

function createApp() {
  const update = vi.fn(async (value: unknown) => ({ v: 1, echoed: value }));
  const controller = { update } as unknown as LiveSetupController;
  const app = express();
  app.use(express.json());
  const passthrough: RequestHandler = (_req, _res, next) => next();
  registerLiveSetupRoutes(app, { controller, mutate: () => passthrough });
  return { app, update };
}

describe('POST /live/setup', () => {
  it('forwards a model and voice selection to the controller', async () => {
    const { app, update } = createApp();
    const response = await request(app)
      .post('/live/setup')
      .send({ model: 'openai:qwen3.5-omni-plus-realtime', voice: 'Ethan' });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      model: 'openai:qwen3.5-omni-plus-realtime',
      voice: 'Ethan',
    });
  });

  it.each([
    ['model', 7],
    ['model', '   '],
    ['voice', ''],
    ['voice', 'x'.repeat(257)],
  ])(
    'rejects an invalid %s before reaching the controller',
    async (field, value) => {
      const { app, update } = createApp();
      const response = await request(app)
        .post('/live/setup')
        .send({ [field]: value });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_live_model');
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('forwards an endpoint to the controller', async () => {
    const { app, update } = createApp();
    const response = await request(app).post('/live/setup').send({
      endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    });
  });

  it('forwards an empty endpoint, which restores the default', async () => {
    const { app, update } = createApp();
    const response = await request(app)
      .post('/live/setup')
      .send({ endpoint: '' });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ endpoint: '' });
  });

  it.each([7, null, 'x'.repeat(2049)])(
    'rejects an invalid endpoint %j before reaching the controller',
    async (value) => {
      const { app, update } = createApp();
      const response = await request(app)
        .post('/live/setup')
        .send({ endpoint: value });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('invalid_live_endpoint');
      expect(update).not.toHaveBeenCalled();
    },
  );
});
