/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import { safeBody } from '../server/request-helpers.js';
import { LiveUnavailableError } from '../live/live-host-coordinator.js';
import type { LiveHostCoordinator } from '../live/live-host-coordinator.js';
import { ConversationRuntimeOwnershipError } from '../conversations/conversation-runtime-errors.js';

export interface RegisterLiveRoutesDeps {
  coordinator: LiveHostCoordinator;
  ensureRuntimeReady?: () => Promise<void>;
  mutate: (options?: { strict?: boolean }) => RequestHandler;
  persistShortcut?: (shortcut: string) => Promise<void>;
}

function sendUnavailable(res: Parameters<RequestHandler>[1], error: unknown) {
  if (error instanceof ConversationRuntimeOwnershipError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      retryable: error.retryable,
    });
    return true;
  }
  if (!(error instanceof LiveUnavailableError)) return false;
  res
    .status(503)
    .json({ error: error.message, code: error.code, status: error.status });
  return true;
}

export function registerLiveRoutes(
  app: Application,
  deps: RegisterLiveRoutesDeps,
): void {
  app.get('/live/status', (_req, res) => {
    res.status(200).json(deps.coordinator.getStatus());
  });

  app.post('/live/start', deps.mutate(), async (_req, res) => {
    try {
      await deps.ensureRuntimeReady?.();
      res.status(200).json(deps.coordinator.start('resume').status);
    } catch (error) {
      if (sendUnavailable(res, error)) return;
      throw error;
    }
  });

  app.post('/live/new', deps.mutate(), async (_req, res) => {
    try {
      await deps.ensureRuntimeReady?.();
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

  app.post(
    '/live/shortcut',
    deps.mutate({ strict: true }),
    async (req, res) => {
      const shortcut = safeBody(req)['shortcut'];
      if (typeof shortcut !== 'string' || shortcut.trim().length > 128) {
        res.status(400).json({
          error:
            '`shortcut` must be an Electron accelerator or an empty string.',
          code: 'invalid_live_shortcut',
        });
        return;
      }
      if (!deps.persistShortcut) {
        res.status(501).json({
          error: 'Live shortcut persistence is unavailable.',
          code: 'live_shortcut_persistence_unavailable',
        });
        return;
      }
      const previous = deps.coordinator.getStatus().shortcut;
      try {
        const status = await deps.coordinator.setShortcut(shortcut);
        try {
          await deps.persistShortcut(status.shortcut);
        } catch {
          await deps.coordinator.setShortcut(previous);
          res.status(500).json({
            error: 'The Live shortcut could not be saved.',
            code: 'live_shortcut_persist_failed',
          });
          return;
        }
        res.status(200).json(status);
      } catch (error) {
        res.status(409).json({
          error:
            error instanceof Error
              ? error.message
              : 'The Live shortcut could not be changed.',
          code: 'live_shortcut_unavailable',
          status: deps.coordinator.getStatus(),
        });
      }
    },
  );
}
