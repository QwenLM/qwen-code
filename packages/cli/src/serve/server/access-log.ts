/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import type { Application } from 'express';
import type { DaemonLogContext, DaemonLogger } from '../daemon-logger.js';

const SESSION_ID_RE = /\/session\/([^/]+)/;
const ACCESS_LOG_BURST = 60;
const ACCESS_LOG_REFILL_PER_SECOND = 2;
const ROUTE_MAX_BYTES = 2 * 1024;
const SESSION_ID_MAX_BYTES = 256;
const CLIENT_ID_MAX_BYTES = 256;

export const ACCESS_LOG_CONTROLLER_LOCAL = 'accessLogController';

export interface AccessLogController {
  sealAndFlushSuppressed(): void;
}

export interface AccessLogAppLocals {
  [ACCESS_LOG_CONTROLLER_LOCAL]?: AccessLogController;
}

interface SuppressedCounts extends DaemonLogContext {
  suppressed: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  statusOther: number;
}

function emptySuppressedCounts(): SuppressedCounts {
  return {
    suppressed: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    statusOther: 0,
  };
}

function countSuppressed(counts: SuppressedCounts, status: number): void {
  counts.suppressed += 1;
  if (status >= 200 && status < 300) counts.status2xx += 1;
  else if (status >= 300 && status < 400) counts.status3xx += 1;
  else if (status >= 400 && status < 500) counts.status4xx += 1;
  else if (status >= 500 && status < 600) counts.status5xx += 1;
  else counts.statusOther += 1;
}

function firstRawHeader(
  rawHeaders: readonly string[],
  targetName: string,
): string | undefined {
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === targetName) return rawHeaders[i + 1];
  }
  return undefined;
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { value: string; originalBytes?: number } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { value };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    value: bytes.subarray(0, end).toString('utf8'),
    originalBytes: bytes.length,
  };
}

export function installAccessLogMiddleware(
  app: Application,
  daemonLog: DaemonLogger | undefined,
  monotonicNow: () => number = () => performance.now(),
): AccessLogController {
  let sealed = false;
  let tokens = ACCESS_LOG_BURST;
  let refillBaseline = monotonicNow();
  let suppressed = emptySuppressedCounts();

  const refill = (): void => {
    const now = Math.max(monotonicNow(), refillBaseline);
    tokens = Math.min(
      ACCESS_LOG_BURST,
      tokens + ((now - refillBaseline) / 1_000) * ACCESS_LOG_REFILL_PER_SECOND,
    );
    refillBaseline = now;
  };

  const flushSuppressed = (): boolean => {
    if (!daemonLog || suppressed.suppressed === 0) return false;
    daemonLog.warn('access logs suppressed', suppressed);
    suppressed = emptySuppressedCounts();
    return true;
  };

  const controller: AccessLogController = {
    sealAndFlushSuppressed: () => {
      if (sealed) return;
      sealed = true;
      try {
        flushSuppressed();
      } catch {
        // Diagnostic logging must not prevent daemon shutdown.
      }
    },
  };
  (app.locals as AccessLogAppLocals)[ACCESS_LOG_CONTROLLER_LOCAL] = controller;

  if (!daemonLog) return controller;

  app.use((req, res, next) => {
    const { method, path: reqPath } = req;
    if (
      (method === 'GET' && reqPath === '/health') ||
      (method === 'POST' && reqPath.endsWith('/heartbeat'))
    ) {
      return next();
    }
    const startMs = monotonicNow();
    res.on('finish', () => {
      try {
        if (sealed) return;
        const status = res.statusCode;
        if (method === 'GET' && reqPath.endsWith('/events') && status === 200) {
          return;
        }
        refill();
        if (suppressed.suppressed > 0 && tokens >= 1) {
          tokens -= 1;
          flushSuppressed();
        }
        if (tokens < 1) {
          countSuppressed(suppressed, status);
          return;
        }
        tokens -= 1;

        const route = truncateUtf8(`${method} ${reqPath}`, ROUTE_MAX_BYTES);
        const sessionMatch = reqPath.match(SESSION_ID_RE);
        const sessionId = sessionMatch?.[1]
          ? truncateUtf8(sessionMatch[1], SESSION_ID_MAX_BYTES)
          : undefined;
        const rawClientId = firstRawHeader(req.rawHeaders, 'x-qwen-client-id');
        const clientId = rawClientId
          ? truncateUtf8(rawClientId, CLIENT_ID_MAX_BYTES)
          : undefined;
        const ctx = {
          route: route.value,
          ...(route.originalBytes
            ? { routeOriginalBytes: route.originalBytes }
            : {}),
          ...(sessionId
            ? {
                sessionId: sessionId.value,
                ...(sessionId.originalBytes
                  ? { sessionIdOriginalBytes: sessionId.originalBytes }
                  : {}),
              }
            : {}),
          ...(clientId
            ? {
                clientId: clientId.value,
                ...(clientId.originalBytes
                  ? { clientIdOriginalBytes: clientId.originalBytes }
                  : {}),
              }
            : {}),
          status,
          durationMs: Math.max(0, Math.round(monotonicNow() - startMs)),
        };
        if (status >= 400) daemonLog.warn('request completed', ctx);
        else daemonLog.info('request completed', ctx);
      } catch {
        // Logging failure must not affect the request.
      }
    });
    next();
  });

  return controller;
}
