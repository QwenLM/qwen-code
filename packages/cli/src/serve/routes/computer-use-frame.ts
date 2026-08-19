/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import type { ComputerUseFrame } from '@qwen-code/acp-bridge/bridgeTypes';
import type { Application, RequestHandler, Response } from 'express';
import type { DaemonLogger } from '../daemon-logger.js';
import { detectFromLoopback } from '../server/request-helpers.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { requireSessionRuntime } from './session-runtime.js';

type SendBridgeError = (
  res: Response,
  err: unknown,
  ctx: { route: string; sessionId?: string },
) => void;

interface RegisterComputerUseFrameRoutesDeps {
  workspaceRegistry: WorkspaceRegistry;
  daemonLog?: DaemonLogger;
  requireToken: RequestHandler;
  sendBridgeError: SendBridgeError;
}

const ROUTE = 'GET /session/:id/computer-use/frame';

export function registerComputerUseFrameRoutes(
  app: Application,
  deps: RegisterComputerUseFrameRoutesDeps,
): void {
  app.get('/session/:id/computer-use/frame', deps.requireToken, (req, res) => {
    if (!detectFromLoopback(req)) {
      res.status(403).json({
        error: 'Computer Use frames are available only over loopback',
        code: 'local_only',
      });
      return;
    }
    const sessionId = req.params['id'];
    const runtime = requireSessionRuntime({
      sessionId,
      route: ROUTE,
      res,
      workspaceRegistry: deps.workspaceRegistry,
      daemonLog: deps.daemonLog,
    });
    if (!runtime) return;

    let frame: ComputerUseFrame | undefined;
    try {
      frame = runtime.bridge.getComputerUseFrame(sessionId);
    } catch (error) {
      deps.sendBridgeError(res, error, { route: ROUTE, sessionId });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!frame) {
      res.status(204).end();
      return;
    }

    const etag = `"${frame.version}"`;
    res.setHeader('ETag', etag);
    if (req.header('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    res.type(frame.mimeType);
    res.send(Buffer.from(frame.data, 'base64'));
  });
}
