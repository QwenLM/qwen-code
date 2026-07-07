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
  app.use(express.json());
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

  return { app, enqueueWebhookTask };
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
});
