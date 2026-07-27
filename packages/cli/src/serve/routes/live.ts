/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import { safeBody } from '../server/request-helpers.js';
import { LiveUnavailableError } from '../live/live-host-coordinator.js';
import type { LiveHostCoordinator } from '../live/live-host-coordinator.js';

export interface RegisterLiveRoutesDeps {
  coordinator: LiveHostCoordinator;
  mutate: (options?: { strict?: boolean }) => RequestHandler;
}

function sendUnavailable(res: Parameters<RequestHandler>[1], error: unknown) {
  if (!(error instanceof LiveUnavailableError)) return false;
  res.status(503).json({
    error: error.message,
    code: error.code,
    status: error.status,
  });
  return true;
}

export function registerLiveRoutes(
  app: Application,
  deps: RegisterLiveRoutesDeps,
): void {
  app.get('/live/status', (_req, res) => {
    res.status(200).json(deps.coordinator.getStatus());
  });

  app.post('/live/start', deps.mutate(), (_req, res) => {
    try {
      res.status(200).json(deps.coordinator.start('resume').status);
    } catch (error) {
      if (sendUnavailable(res, error)) return;
      throw error;
    }
  });

  app.post('/live/new', deps.mutate(), (_req, res) => {
    try {
      res.status(200).json(deps.coordinator.start('new').status);
    } catch (error) {
      if (sendUnavailable(res, error)) return;
      throw error;
    }
  });

  app.post('/live/stop', deps.mutate(), (_req, res) => {
    res.status(200).json(deps.coordinator.stop());
  });

  app.post('/live/mute', deps.mutate(), (req, res) => {
    const body = safeBody(req);
    const inputMuted = body['inputMuted'];
    const outputMuted = body['outputMuted'];
    if (
      (inputMuted === undefined && outputMuted === undefined) ||
      (inputMuted !== undefined && typeof inputMuted !== 'boolean') ||
      (outputMuted !== undefined && typeof outputMuted !== 'boolean')
    ) {
      res.status(400).json({
        error:
          'At least one of `inputMuted` or `outputMuted` must be a boolean.',
        code: 'invalid_live_mute',
      });
      return;
    }
    res.status(200).json(
      deps.coordinator.setMute({
        ...(inputMuted !== undefined ? { inputMuted } : {}),
        ...(outputMuted !== undefined ? { outputMuted } : {}),
      }),
    );
  });
}
