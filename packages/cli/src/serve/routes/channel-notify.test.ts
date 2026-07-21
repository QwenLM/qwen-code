/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ChannelDeliveryError } from '../channel-delivery-ipc.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerChannelNotifyRoutes } from './channel-notify.js';

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted = true,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
  } as WorkspaceRuntime;
}

function setup(options?: {
  deliver?: ReturnType<typeof vi.fn>;
  runtimes?: WorkspaceRuntime[];
}) {
  const app = express();
  app.use(express.json());
  const strictOptions: Array<{ strict?: boolean } | undefined> = [];
  const mutate = (value?: { strict?: boolean }): RequestHandler => {
    strictOptions.push(value);
    return (_req, _res, next) => next();
  };
  const primary = runtime('primary', '/work/main');
  const runtimes = options?.runtimes ?? [primary];
  const deliver =
    options?.deliver ?? vi.fn(async () => ({ delivered: true as const }));
  registerChannelNotifyRoutes(app, {
    boundWorkspace: primary.workspaceCwd,
    workspaceRegistry: createWorkspaceRegistry(runtimes),
    mutate,
    safeBody: (req) => req.body as Record<string, unknown>,
    deliverChannelMessage: deliver,
  });
  return { app, deliver, strictOptions };
}

const body = {
  text: 'service unavailable',
  delivery: {
    kind: 'channel',
    target: {
      channelName: 'dingtalk',
      type: 'user',
      id: 'user-1',
    },
  },
};

describe('channel notify routes', () => {
  it('delivers the primary workspace notification synchronously', async () => {
    const { app, deliver, strictOptions } = setup();

    const response = await request(app).post('/workspace/notify').send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ delivered: true });
    expect(response.body.deliveryId).toEqual(expect.any(String));
    expect(deliver).toHaveBeenCalledWith('/work/main', {
      deliveryId: response.body.deliveryId,
      channelName: 'dingtalk',
      target: { type: 'user', id: 'user-1' },
      text: 'service unavailable',
    });
    expect(strictOptions).toEqual([{ strict: true }, { strict: true }]);
  });

  it('routes a qualified notification only to the selected workspace', async () => {
    const secondary = runtime('secondary', '/work/secondary');
    const { app, deliver } = setup({
      runtimes: [runtime('primary', '/work/main'), secondary],
    });

    const response = await request(app)
      .post('/workspaces/secondary/notify')
      .send(body);

    expect(response.status).toBe(200);
    expect(deliver).toHaveBeenCalledWith(
      secondary.workspaceCwd,
      expect.objectContaining({ channelName: 'dingtalk' }),
    );
  });

  it('rejects invalid bodies before delivery', async () => {
    const { app, deliver } = setup();

    const response = await request(app)
      .post('/workspace/notify')
      .send({ ...body, unexpected: true });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('channel_delivery_invalid');
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([
    ['channel_worker_unavailable', 503],
    ['channel_delivery_queue_full', 503],
    ['channel_delivery_timeout', 504],
    ['channel_delivery_failed', 502],
  ] as const)('maps %s to HTTP %i', async (code, status) => {
    const deliver = vi.fn(async () => {
      throw new ChannelDeliveryError(code, 'sanitized failure');
    });
    const { app } = setup({ deliver });

    const response = await request(app).post('/workspace/notify').send(body);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({
      error: 'sanitized failure',
      code,
    });
  });

  it('rejects untrusted and unknown qualified workspaces', async () => {
    const { app, deliver } = setup({
      runtimes: [
        runtime('primary', '/work/main'),
        runtime('untrusted', '/work/untrusted', false),
      ],
    });

    const untrusted = await request(app)
      .post('/workspaces/untrusted/notify')
      .send(body);
    const unknown = await request(app)
      .post('/workspaces/missing/notify')
      .send(body);

    expect(untrusted.status).toBe(403);
    expect(unknown.status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not mount a separate connectivity-test endpoint', async () => {
    const { app } = setup();

    const response = await request(app)
      .post('/workspace/notify/test')
      .send(body);

    expect(response.status).toBe(404);
  });
});
