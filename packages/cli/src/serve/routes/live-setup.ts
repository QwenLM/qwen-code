/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import {
  LiveSetupError,
  type LiveSetupApiKeyMutation,
  type LiveSetupController,
  type LiveSetupUpdate,
} from '../live/live-setup-controller.js';
import { safeBody } from '../server/request-helpers.js';

export interface RegisterLiveSetupRoutesDeps {
  controller: LiveSetupController;
  mutate: (options?: { strict?: boolean }) => RequestHandler;
}

function sendError(res: Parameters<RequestHandler>[1], error: unknown): void {
  if (error instanceof LiveSetupError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({
    error: 'Live Voice setup failed.',
    code: 'live_setup_failed',
  });
}

function parseApiKeyMutation(value: unknown): LiveSetupApiKeyMutation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LiveSetupError(
      'apiKey must be an explicit replace or clear operation.',
      'invalid_live_api_key',
      400,
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record['operation'] === 'replace' &&
    typeof record['value'] === 'string' &&
    record['value'].trim().length > 0 &&
    record['value'].length <= 4096
  ) {
    return { operation: 'replace', value: record['value'] };
  }
  if (record['operation'] === 'clear') return { operation: 'clear' };
  throw new LiveSetupError(
    'apiKey must be an explicit replace or clear operation.',
    'invalid_live_api_key',
    400,
  );
}

function parseUpdate(body: Record<string, unknown>): LiveSetupUpdate {
  const update: LiveSetupUpdate = {};
  if (body['enabled'] !== undefined) {
    if (typeof body['enabled'] !== 'boolean') {
      throw new LiveSetupError(
        'enabled must be a boolean.',
        'invalid_live_enabled',
        400,
      );
    }
    update.enabled = body['enabled'];
  }
  if (body['shortcut'] !== undefined) {
    if (typeof body['shortcut'] !== 'string' || body['shortcut'].length > 128) {
      throw new LiveSetupError(
        'shortcut must be an Electron accelerator or an empty string.',
        'invalid_live_shortcut',
        400,
      );
    }
    update.shortcut = body['shortcut'];
  }
  if (body['apiKey'] !== undefined) {
    update.apiKey = parseApiKeyMutation(body['apiKey']);
  }
  if (Object.keys(update).length === 0) {
    throw new LiveSetupError(
      'At least one Live Voice setting is required.',
      'empty_live_setup_update',
      400,
    );
  }
  return update;
}

export function registerLiveSetupRoutes(
  app: Application,
  deps: RegisterLiveSetupRoutesDeps,
): void {
  app.get('/live/setup', async (_req, res) => {
    try {
      res.status(200).json(await deps.controller.getStatus());
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/live/setup', deps.mutate({ strict: true }), async (req, res) => {
    try {
      res
        .status(200)
        .json(await deps.controller.update(parseUpdate(safeBody(req))));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post(
    '/live/setup/install',
    deps.mutate({ strict: true }),
    async (_req, res) => {
      try {
        res.status(200).json(await deps.controller.retryInstall());
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  app.post(
    '/live/setup/launch',
    deps.mutate({ strict: true }),
    async (_req, res) => {
      try {
        res.status(200).json(await deps.controller.launchHost());
      } catch (error) {
        sendError(res, error);
      }
    },
  );
}
