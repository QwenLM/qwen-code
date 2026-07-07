/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Application, Request } from 'express';
import type {
  ChannelWebhookConfig,
  ChannelWebhookTask,
} from '@qwen-code/channel-base';
import type { ChannelWebhookAccepted } from '../channel-webhook-ipc.js';

export interface ChannelWebhookRouteDeps {
  channelsConfig: Record<string, { webhooks?: ChannelWebhookConfig }>;
  safeBody: (req: Request) => Record<string, unknown>;
  enqueueWebhookTask: (
    task: ChannelWebhookTask,
  ) => Promise<ChannelWebhookAccepted>;
}

export function registerChannelWebhookRoutes(
  app: Application,
  deps: ChannelWebhookRouteDeps,
): void {
  app.post('/channels/:channelName/webhooks/:source', async (req, res) => {
    const channelName = req.params['channelName'];
    const source = req.params['source'];
    if (!channelName || !source) {
      res.status(404).json({ error: 'Channel webhook route not found' });
      return;
    }

    const sources = deps.channelsConfig[channelName]?.webhooks?.sources;
    if (!sources || !Object.hasOwn(sources, source)) {
      res.status(404).json({ error: 'Unknown channel webhook source' });
      return;
    }
    const sourceConfig = sources[source];

    const secret = sourceConfig.secret;
    if (
      typeof secret !== 'string' ||
      secret.length === 0 ||
      !matchesWebhookSecret(req.get('x-qwen-webhook-secret'), secret)
    ) {
      res.status(401).json({ error: 'Invalid webhook secret' });
      return;
    }

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

    const task: ChannelWebhookTask = {
      channelName,
      source,
      eventType,
      targetRef,
      title,
      payload: readPayload(body),
    };
    if (typeof body['summary'] === 'string') {
      task.summary = body['summary'];
    }

    try {
      await deps.enqueueWebhookTask(task);
    } catch {
      res.status(500).json({
        error: 'Failed to enqueue channel webhook task',
        code: 'channel_webhook_enqueue_failed',
      });
      return;
    }

    res.status(202).json({ accepted: true });
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

function readPayload(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body['payload'];
  return typeof payload === 'object' &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}
