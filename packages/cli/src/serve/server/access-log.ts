/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import type { DaemonLogger } from '../daemon-logger.js';

const SESSION_ID_RE = /\/session\/([^/]+)/;

export function installAccessLogMiddleware(
  app: Application,
  daemonLog: DaemonLogger | undefined,
): void {
  if (!daemonLog) return;

  app.use((req, res, next) => {
    const { method, path: reqPath } = req;
    if (
      (method === 'GET' && reqPath === '/health') ||
      (method === 'POST' && reqPath.endsWith('/heartbeat'))
    ) {
      return next();
    }
    const startMs = Date.now();
    res.on('finish', () => {
      try {
        const status = res.statusCode;
        if (method === 'GET' && reqPath.endsWith('/events') && status === 200) {
          return;
        }
        const durationMs = Date.now() - startMs;
        const sessionMatch = reqPath.match(SESSION_ID_RE);
        const sessionId = sessionMatch?.[1];
        const clientId = req.headers['x-qwen-client-id'] as string | undefined;
        const ctx = {
          route: `${method} ${reqPath}`,
          ...(sessionId ? { sessionId } : {}),
          ...(clientId ? { clientId } : {}),
          status,
          durationMs,
        };
        if (status >= 400) {
          daemonLog.warn('request completed', ctx);
        } else {
          daemonLog.info('request completed', ctx);
        }
      } catch {
        // Logging failure must not affect the request.
      }
    });
    next();
  });
}
