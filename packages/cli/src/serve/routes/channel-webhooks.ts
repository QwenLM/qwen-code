/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Application, Request, RequestHandler, Response } from 'express';
import type {
  ChannelWebhookConfig,
  ChannelWebhookSourceConfig,
  ChannelWebhookTask,
} from '@qwen-code/channel-base';
import type {
  ChannelWebhookAccepted,
  ChannelWebhookEnqueueErrorCode,
} from '../channel-webhook-ipc.js';
import { isChannelWebhookEnqueueError } from '../channel-webhook-ipc.js';
import type { DaemonLogger } from '../daemon-logger.js';
import type { RateLimiterInstance } from '../rate-limit.js';

const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const MAX_PAYLOAD_DEPTH = 64;

export interface ChannelWebhookRouteDeps {
  channelsConfig: Record<string, { webhooks?: ChannelWebhookConfig }>;
  safeBody: (req: Request) => Record<string, unknown>;
  enqueueWebhookTask: (
    task: ChannelWebhookTask,
  ) => Promise<ChannelWebhookAccepted>;
  rateLimiter?: Pick<RateLimiterInstance, 'checkRate'>;
  daemonLog?: Pick<DaemonLogger, 'info' | 'warn'>;
}

export function registerChannelWebhookRoutes(
  app: Application,
  deps: ChannelWebhookRouteDeps,
): void {
  app.post(
    '/channels/:channelName/webhooks/:source',
    ...(deps.rateLimiter ? [createWebhookRateLimitMiddleware(deps)] : []),
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

      if (
        deps.rateLimiter &&
        !deps.rateLimiter.checkRate(
          `webhook:${channelName}:${source}`,
          'mutation',
        )
      ) {
        sendWebhookRateLimitExceeded(res);
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
          ...(enqueueError.detail ? { detail: enqueueError.detail } : {}),
        });
        return;
      }

      res.status(202).json({ accepted: true });
    },
  );
}

function createWebhookRateLimitMiddleware(
  deps: Pick<ChannelWebhookRouteDeps, 'rateLimiter'>,
): RequestHandler {
  return (req, res, next) => {
    if (!deps.rateLimiter) {
      next();
      return;
    }
    if (
      deps.rateLimiter.checkRate(
        `webhook:preauth:${readRequestAddress(req)}`,
        'mutation',
      )
    ) {
      next();
      return;
    }
    sendWebhookRateLimitExceeded(res);
  };
}

function readRequestAddress(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function sendWebhookRateLimitExceeded(res: Response): void {
  res.status(429).json({
    error: 'Rate limit exceeded',
    code: 'rate_limit_exceeded',
    tier: 'mutation',
  });
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
    if (!isWithinPayloadDepth(payload, MAX_PAYLOAD_DEPTH)) {
      res.status(400).json({
        error: `Body field "payload" exceeds maximum nesting depth (${MAX_PAYLOAD_DEPTH})`,
      });
      return undefined;
    }
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

function isWithinPayloadDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current.depth > maxDepth) return false;
    if (typeof current.value !== 'object' || current.value === null) continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function classifyChannelWebhookEnqueueError(error: unknown): {
  status: number;
  code: ChannelWebhookEnqueueErrorCode;
  detail?: string;
} {
  if (isChannelWebhookEnqueueError(error)) {
    return {
      status: statusForChannelWebhookEnqueueCode(error.code),
      code: error.code,
    };
  }
  return {
    status: 500,
    code: 'channel_webhook_enqueue_failed',
    detail: error instanceof Error ? error.message : String(error),
  };
}

function statusForChannelWebhookEnqueueCode(
  code: ChannelWebhookEnqueueErrorCode,
): number {
  switch (code) {
    case 'channel_webhook_invalid_task':
      return 400;
    case 'channel_webhook_target_unavailable':
      return 409;
    case 'channel_webhook_enqueue_timeout':
      return 504;
    case 'channel_worker_unavailable':
    case 'channel_webhook_queue_full':
      return 503;
    case 'channel_webhook_enqueue_failed':
      return 500;
    default:
      return 500;
  }
}
