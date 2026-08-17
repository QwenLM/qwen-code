/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import {
  WebBridgeTimeoutError,
  WebBridgeUnavailableError,
} from '../web-bridge/web-bridge-registry.js';
import {
  WebBridgeRequestError,
  type WebBridgeService,
} from '../web-bridge/web-bridge-service.js';

export function registerWebBridgeRoutes(
  app: Application,
  deps: {
    service: WebBridgeService;
  },
): void {
  const status: RequestHandler = (_req, res) => {
    res.json(deps.service.status());
  };
  const command: RequestHandler = async (req, res) => {
    try {
      res.json(await deps.service.execute(req.body));
    } catch (error) {
      const statusCode =
        error instanceof WebBridgeRequestError
          ? error.statusCode
          : error instanceof WebBridgeUnavailableError
            ? 503
            : error instanceof WebBridgeTimeoutError
              ? 504
              : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  app.get('/status', status);
  app.get('/webbridge/status', status);
  app.post('/command', command);
}
