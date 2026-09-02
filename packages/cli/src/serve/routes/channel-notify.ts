/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Application, Request, RequestHandler, Response } from 'express';
import {
  ChannelDeliveryError,
  isChannelDeliveryError,
  type ChannelDeliveryAccepted,
  type ChannelDeliveryRequest,
} from '../channel-delivery-ipc.js';
import {
  normalizeChannelDelivery,
  parseChannelDelivery,
} from '../channel-delivery.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
} from '../workspace-route-runtime.js';

interface RegisterChannelNotifyRoutesDeps {
  boundWorkspace: string;
  workspaceRegistry: WorkspaceRegistry;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  deliverChannelMessage?: (
    workspaceCwd: string,
    request: ChannelDeliveryRequest,
  ) => Promise<ChannelDeliveryAccepted>;
}

function sendDeliveryError(res: Response, error: unknown): void {
  if (!isChannelDeliveryError(error)) {
    res.status(502).json({
      error: 'Channel delivery failed.',
      code: 'channel_delivery_failed',
    });
    return;
  }
  const status =
    error.code === 'channel_delivery_invalid'
      ? 400
      : error.code === 'channel_delivery_timeout'
        ? 504
        : error.code === 'channel_worker_unavailable' ||
            error.code === 'channel_delivery_queue_full'
          ? 503
          : 502;
  res.status(status).json({ error: error.message, code: error.code });
}

function parseNotifyBody(
  body: Record<string, unknown>,
): ChannelDeliveryRequest {
  if (!Object.keys(body).every((key) => key === 'text' || key === 'delivery')) {
    throw new ChannelDeliveryError(
      'channel_delivery_invalid',
      'Invalid channel notification.',
    );
  }
  return normalizeChannelDelivery(
    randomUUID(),
    parseChannelDelivery(body['delivery']),
    body['text'] as string,
  );
}

export function registerChannelNotifyRoutes(
  app: Application,
  deps: RegisterChannelNotifyRoutesDeps,
): void {
  const deliver = async (
    workspaceCwd: string,
    req: Request,
    res: Response,
  ): Promise<void> => {
    try {
      if (!deps.deliverChannelMessage) {
        throw new ChannelDeliveryError(
          'channel_worker_unavailable',
          'Channel worker is not running.',
        );
      }
      const request = parseNotifyBody(deps.safeBody(req));
      await deps.deliverChannelMessage(workspaceCwd, request);
      res.status(200).json({ delivered: true, deliveryId: request.deliveryId });
    } catch (error) {
      sendDeliveryError(res, error);
    }
  };

  app.post(
    '/workspace/notify',
    deps.mutate({ strict: true }),
    async (req, res) => {
      if (
        !requireTrustedWorkspaceRuntime(deps.workspaceRegistry.primary, res)
      ) {
        return;
      }
      await deliver(deps.boundWorkspace, req, res);
    },
  );

  app.post(
    '/workspaces/:workspace/notify',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const runtime = resolveWorkspaceRuntimeFromParam(
        deps.workspaceRegistry,
        req,
        res,
      );
      if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
      await deliver(runtime.workspaceCwd, req, res);
    },
  );
}
