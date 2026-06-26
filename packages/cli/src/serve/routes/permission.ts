/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler, Response } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  detectFromLoopback,
  parseClientIdHeader,
  parsePermissionVoteBody,
} from '../server/request-helpers.js';

type SendPermissionVoteError = (
  res: Response,
  err: unknown,
  ctx: { route: string; sessionId?: string },
) => void;

interface RegisterPermissionRoutesDeps {
  bridge: AcpSessionBridge;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  sendPermissionVoteError: SendPermissionVoteError;
}

export function registerPermissionRoutes(
  app: Application,
  deps: RegisterPermissionRoutesDeps,
): void {
  const { bridge, mutate, sendPermissionVoteError } = deps;

  app.post('/session/:id/permission/:requestId', mutate(), (req, res) => {
    const sessionId = req.params['id'];
    const requestId = req.params['requestId'];
    const response = parsePermissionVoteBody(req, res);
    if (response === undefined) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    // Thread the kernel-stamped peer-IP loopback bit through the bridge
    // context so the `local-only` policy can gate votes by transport.
    const fromLoopback = detectFromLoopback(req);
    const context = {
      ...(clientId !== undefined ? { clientId } : {}),
      fromLoopback,
    };
    let accepted: boolean;
    try {
      accepted = bridge.respondToSessionPermission(
        sessionId,
        requestId,
        response,
        context,
      );
    } catch (err) {
      sendPermissionVoteError(res, err, {
        route: 'POST /session/:id/permission/:requestId',
        sessionId,
      });
      return;
    }
    if (!accepted) {
      res.status(404).json({
        error: 'No pending permission request for session',
        sessionId,
        requestId,
      });
      return;
    }
    res.status(200).json({});
  });

  app.post('/permission/:requestId', mutate(), (req, res) => {
    const requestId = req.params['requestId'];
    const response = parsePermissionVoteBody(req, res);
    if (response === undefined) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    // Same loopback bit threading as the session-scoped route above.
    const fromLoopback = detectFromLoopback(req);
    const context = {
      ...(clientId !== undefined ? { clientId } : {}),
      fromLoopback,
    };
    let accepted: boolean;
    try {
      accepted = bridge.respondToPermission(requestId, response, context);
    } catch (err) {
      sendPermissionVoteError(res, err, {
        route: 'POST /permission/:requestId',
      });
      return;
    }
    if (!accepted) {
      // Either the requestId never existed or another client already won
      // the race. Stage 1 doesn't distinguish — both surface as 404.
      res
        .status(404)
        .json({ error: 'No pending permission request', requestId });
      return;
    }
    res.status(200).json({});
  });
}
