/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerChannelWebhookRoutes } from './channel-webhooks.js';

function appHarness(opts?: { enqueueWebhookTask?: ReturnType<typeof vi.fn> }) {
  const app = express();
  let jsonCallCount = 0;
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      jsonCallCount += 1;
      return originalJson(body);
    }) as typeof res.json;
    next();
  });
  const enqueueWebhookTask =
    opts?.enqueueWebhookTask ??
    vi.fn(async () => ({
      accepted: true as const,
    }));

  registerChannelWebhookRoutes(app, {
    channelsConfig: {
      'dingtalk-main': {
        webhooks: {
          sources: {
            'github-ci': {
              secret: 'secret-value',
              targets: {
                default: {
                  chatId: 'group-1',
                  senderId: 'webhook:github-ci',
                  isGroup: true,
                },
              },
            },
          },
        },
      },
    },
    safeBody: (req) =>
      req.body && typeof req.body === 'object' ? req.body : {},
    enqueueWebhookTask,
  });

  return {
    app,
    enqueueWebhookTask,
    getJsonCallCount: () => jsonCallCount,
  };
}

describe('channel webhook routes', () => {
  it('accepts an authenticated webhook task', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
        summary: 'main is red',
        payload: { branch: 'main' },
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    expect(h.enqueueWebhookTask).toHaveBeenCalledWith({
      channelName: 'dingtalk-main',
      source: 'github-ci',
      eventType: 'ci_failed',
      targetRef: 'default',
      title: 'CI failed',
      summary: 'main is red',
      payload: { branch: 'main' },
    });
  });

  it('defaults payload to an empty object', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
      });

    expect(res.status).toBe(202);
    expect(h.enqueueWebhookTask).toHaveBeenCalledWith({
      channelName: 'dingtalk-main',
      source: 'github-ci',
      eventType: 'ci_failed',
      targetRef: 'default',
      title: 'CI failed',
      payload: {},
    });
  });

  it.each(['string payload', 123, true, ['array']])(
    'rejects non-object payload values: %s',
    async (payload) => {
      const h = appHarness();
      const res = await request(h.app)
        .post('/channels/dingtalk-main/webhooks/github-ci')
        .set('x-qwen-webhook-secret', 'secret-value')
        .send({
          eventType: 'ci_failed',
          targetRef: 'default',
          title: 'CI failed',
          payload,
        });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Body field "payload" must be an object when provided',
      });
      expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid secrets', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'wrong')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
        payload: {},
      });

    expect(res.status).toBe(401);
    expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it('returns a uniform auth failure for unknown sources', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/missing-source')
      .set('x-qwen-webhook-secret', 'wrong')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
        payload: {},
      });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid webhook secret' });
    expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied unconfigured target refs', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: 'other',
        title: 'CI failed',
        payload: {},
      });

    expect(res.status).toBe(404);
    expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it('rejects inherited target refs like __proto__', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: '__proto__',
        title: 'CI failed',
        payload: {},
      });

    expect(res.status).toBe(404);
    expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it.each(['eventType', 'targetRef', 'title'])(
    'rejects missing required string field %s',
    async (field) => {
      const h = appHarness();
      const res = await request(h.app)
        .post('/channels/dingtalk-main/webhooks/github-ci')
        .set('x-qwen-webhook-secret', 'secret-value')
        .send({
          eventType: 'ci_failed',
          targetRef: 'default',
          title: 'CI failed',
          [field]: '',
        });

      expect(res.status).toBe(400);
      expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty body with a single 400 response', async () => {
    const h = appHarness();
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Body field "eventType" must be a non-empty string',
    });
    expect(h.getJsonCallCount()).toBe(1);
    expect(h.enqueueWebhookTask).not.toHaveBeenCalled();
  });

  it('returns 500 when enqueueing fails', async () => {
    const h = appHarness({
      enqueueWebhookTask: vi.fn(async () => {
        throw new Error('worker offline');
      }),
    });
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to enqueue channel webhook task',
      code: 'channel_webhook_enqueue_failed',
    });
  });

  it.each([
    'Channel worker is not running.',
    'Channel worker exited.',
    'Channel worker stopped.',
  ])('returns 503 when the worker is unavailable: %s', async (message) => {
    const h = appHarness({
      enqueueWebhookTask: vi.fn(async () => {
        throw new Error(message);
      }),
    });
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
      });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'Failed to enqueue channel webhook task',
      code: 'channel_worker_unavailable',
    });
  });

  it('returns 504 when enqueueing the webhook task times out', async () => {
    const h = appHarness({
      enqueueWebhookTask: vi.fn(async () => {
        throw new Error('Channel webhook task IPC timed out.');
      }),
    });
    const res = await request(h.app)
      .post('/channels/dingtalk-main/webhooks/github-ci')
      .set('x-qwen-webhook-secret', 'secret-value')
      .send({
        eventType: 'ci_failed',
        targetRef: 'default',
        title: 'CI failed',
      });

    expect(res.status).toBe(504);
    expect(res.body).toEqual({
      error: 'Failed to enqueue channel webhook task',
      code: 'channel_webhook_enqueue_timeout',
    });
  });
});
