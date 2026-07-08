/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Application, Request, RequestHandler } from 'express';
import type {
  ChannelWebhookConfig,
  ChannelWebhookSourceConfig,
  ChannelWebhookTask,
} from '@qwen-code/channel-base';
import type { ChannelWebhookAccepted } from '../channel-webhook-ipc.js';
import type { DaemonLogger } from '../daemon-logger.js';

const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export interface ChannelWebhookRouteDeps {
  channelsConfig: Record<string, { webhooks?: ChannelWebhookConfig }>;
  safeBody: (req: Request) => Record<string, unknown>;
  enqueueWebhookTask: (
    task: ChannelWebhookTask,
  ) => Promise<ChannelWebhookAccepted>;
  rateLimitMiddleware?: RequestHandler;
  daemonLog?: Pick<DaemonLogger, 'info' | 'warn'>;
}

export function registerChannelWebhookRoutes(
  app: Application,
  deps: ChannelWebhookRouteDeps,
): void {
  app.post(
    '/channels/:channelName/webhooks/:source',
    ...(deps.rateLimitMiddleware ? [deps.rateLimitMiddleware] : []),
    (req, res, next) => {
      const channelName = req.params['channelName'];
      const source = req.params['source'];
      if (!channelName || !source) {
        res.status(404).json({ error: 'Channel webhook route not found' });
        return;
      }

      const sources = deps.channelsConfig[channelName]?.webhooks?.sources;
      const sourceConfig =
        sources && Object.hasOwn(sources, source) ? sources[source] : undefined;
      if (!sourceConfig) {
        deps.daemonLog?.warn('channel webhook authentication failed', {
          channelName,
          source,
        });
        res.status(401).json({ error: 'Invalid webhook secret' });
        return;
      }

      const secret = sourceConfig.secret;
      if (
        typeof secret !== 'string' ||
        secret.length === 0 ||
        !matchesWebhookSecret(req.get('x-qwen-webhook-secret'), secret)
      ) {
        deps.daemonLog?.warn('channel webhook authentication failed', {
          channelName,
          source,
        });
        res.status(401).json({ error: 'Invalid webhook secret' });
        return;
      }

      const locals = res.locals as {
        channelWebhook?: {
          channelName: string;
          source: string;
          sourceConfig: ChannelWebhookSourceConfig;
        };
      };
      locals.channelWebhook = { channelName, source, sourceConfig };
      next();
    },
    express.json({ limit: '1mb' }),
    async (req, res) => {
      const locals = res.locals as {
        channelWebhook?: {
          channelName: string;
          source: string;
          sourceConfig: ChannelWebhookSourceConfig;
        };
      };
      const webhook = locals.channelWebhook;
      if (!webhook) {
        res.status(401).json({ error: 'Invalid webhook secret' });
        return;
      }
      const { channelName, source, sourceConfig } = webhook;

      const body = deps.safeBody(req);
      const eventType = readRequiredBodyString(body, 'eventType', res);
      if (!eventType) {
        return;
      }
      const targetRef = readRequiredBodyString(body, 'targetRef', res);
      if (!targetRef) {
        return;
      }
      const title = readRequiredBodyString(body, 'title', res);
      if (!title) {
        return;
      }

      if (!Object.hasOwn(sourceConfig.targets, targetRef)) {
        res.status(404).json({ error: 'Unknown channel webhook target' });
        return;
      }

      const payload = readPayload(body, res);
      if (!payload) {
        return;
      }

      const task: ChannelWebhookTask = {
        channelName,
        source,
        eventType,
        targetRef,
        title,
        payload,
      };
      if (typeof body['summary'] === 'string') {
        task.summary = body['summary'];
      }

      try {
        await deps.enqueueWebhookTask(task);
        deps.daemonLog?.info('channel webhook task accepted', {
          channelName,
          source,
          eventType,
          targetRef,
        });
      } catch (error) {
        const enqueueError = classifyChannelWebhookEnqueueError(error);
        deps.daemonLog?.warn('channel webhook task enqueue failed', {
          channelName,
          source,
          eventType,
          targetRef,
          code: enqueueError.code,
        });
        res.status(enqueueError.status).json({
          error: 'Failed to enqueue channel webhook task',
          code: enqueueError.code,
        });
        return;
      }

      res.status(202).json({ accepted: true });
    },
  );
}

function readRequiredBodyString(
  body: Record<string, unknown>,
  key: 'eventType' | 'targetRef' | 'title',
  res: {
    status: (code: number) => {
      json: (body: Record<string, string>) => void;
    };
  },
): string | undefined {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    res.status(400).json({
      error: `Body field "${key}" must be a non-empty string`,
    });
    return undefined;
  }
  return value;
}

function matchesWebhookSecret(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (typeof candidate !== 'string') {
    return false;
  }

  const expectedDigest = createHash('sha256').update(expected).digest();
  const candidateDigest = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function readPayload(
  body: Record<string, unknown>,
  res: {
    status: (code: number) => {
      json: (body: Record<string, string>) => void;
    };
  },
): Record<string, unknown> | undefined {
  const payload = body['payload'];
  if (payload === undefined) {
    return {};
  }
  if (
    typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    return Object.fromEntries(
      Object.entries(payload).filter(
        ([key]) => !PROTOTYPE_POLLUTION_KEYS.has(key),
      ),
    );
  }
  res.status(400).json({
    error: 'Body field "payload" must be an object when provided',
  });
  return undefined;
}

function classifyChannelWebhookEnqueueError(error: unknown): {
  status: number;
  code: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === 'Channel worker is not running.' ||
    message === 'Channel worker exited.' ||
    message === 'Channel worker stopped.' ||
    /^Channel ".+" is not running\.$/u.test(message)
  ) {
    return { status: 503, code: 'channel_worker_unavailable' };
  }
  if (message === 'Channel webhook task IPC timed out.') {
    return { status: 504, code: 'channel_webhook_enqueue_timeout' };
  }
  if (
    message === 'Webhook tasks require unattended approval mode.' ||
    message ===
      'Webhook tasks are not supported when sessionScope is single.' ||
    message === 'Channel does not support proactive webhook messages.' ||
    message ===
      'Channel does not support proactive webhook messages for this chat target.'
  ) {
    return { status: 409, code: 'channel_webhook_target_unavailable' };
  }
  if (
    message.startsWith('Unknown webhook source "') ||
    message.startsWith('Unknown webhook target "') ||
    message.startsWith('Webhook task belongs to ')
  ) {
    return { status: 400, code: 'channel_webhook_invalid_task' };
  }
  return { status: 500, code: 'channel_webhook_enqueue_failed' };
}
