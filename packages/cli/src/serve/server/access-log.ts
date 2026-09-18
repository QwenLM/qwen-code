/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Application } from 'express';
import type { DaemonLogContext, DaemonLogger } from '../daemon-logger.js';
import { getDaemonTelemetryInboundTraceId } from './telemetry-context.js';

const SESSION_ID_RE = /\/session\/([^/]+)/;
const ACCESS_LOG_BURST = 60;
const ACCESS_LOG_REFILL_PER_SECOND = 2;
// Gate rejects rejected before authentication (Host allowlist, the CORS
// wall, the remote same-origin credential check) draw from a separate,
// smaller budget AND count suppression into a separate accumulator. They
// share this middleware only because the walls moved above it; without the
// split a credential-less host sustaining >2 req/s of rejected traffic
// drains the burst in ~30 s and holds the OPERATOR's own authenticated
// lines suppressed behind the aggregate warning. bearerAuth's 401s are
// deliberately NOT marked: they were charged below the access log
// pre-change too, so a no-Origin flood starves the operator budget exactly
// as before — the split covers only the reject classes this reorder moved.
const ACCESS_LOG_REJECT_BURST = 30;
const ACCESS_LOG_REJECT_REFILL_PER_SECOND = 1;
const ROUTE_MAX_BYTES = 2 * 1024;
const SESSION_ID_MAX_BYTES = 256;
const CLIENT_ID_MAX_BYTES = 256;

export const ACCESS_LOG_CONTROLLER_LOCAL = 'accessLogController';

/** res.locals key the pre-auth gates set on their reject path. */
export const ACCESS_LOG_REJECT_LOCAL = 'accessLogPreAuthReject';

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
  let rejectTokens = ACCESS_LOG_REJECT_BURST;
  let rejectRefillBaseline = refillBaseline;
  const suppressed = emptySuppressedCounts();
  const suppressedRejects = emptySuppressedCounts();

  const refill = (): void => {
    const now = Math.max(monotonicNow(), refillBaseline);
    tokens = Math.min(
      ACCESS_LOG_BURST,
      tokens + ((now - refillBaseline) / 1_000) * ACCESS_LOG_REFILL_PER_SECOND,
    );
    refillBaseline = now;
  };

  const refillReject = (): void => {
    const now = Math.max(monotonicNow(), rejectRefillBaseline);
    rejectTokens = Math.min(
      ACCESS_LOG_REJECT_BURST,
      rejectTokens +
        ((now - rejectRefillBaseline) / 1_000) *
          ACCESS_LOG_REJECT_REFILL_PER_SECOND,
    );
    rejectRefillBaseline = now;
  };

  const flushSuppressed = (counts: SuppressedCounts): boolean => {
    if (!daemonLog || counts.suppressed === 0) return false;
    context.with(ROOT_CONTEXT, () => {
      // Snapshot before reset: the logger may read the bag asynchronously.
      daemonLog.warn('access logs suppressed', { ...counts });
    });
    Object.assign(counts, emptySuppressedCounts());
    return true;
  };

  const controller: AccessLogController = {
    sealAndFlushSuppressed: () => {
      if (sealed) return;
      sealed = true;
      try {
        flushSuppressed(suppressed);
        flushSuppressed(suppressedRejects);
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
        refillReject();
        const isPreAuthReject = Boolean(
          (res.locals as Record<string, unknown> | undefined)?.[
            ACCESS_LOG_REJECT_LOCAL
          ],
        );
        // Select the accumulator and the budget BEFORE flushing: a reject
        // flood must never spend an operator token, not even on the flush.
        if (isPreAuthReject) {
          if (suppressedRejects.suppressed > 0 && rejectTokens >= 1) {
            rejectTokens -= 1;
            flushSuppressed(suppressedRejects);
          }
          if (rejectTokens < 1) {
            countSuppressed(suppressedRejects, status);
            return;
          }
          rejectTokens -= 1;
        } else {
          if (suppressed.suppressed > 0 && tokens >= 1) {
            tokens -= 1;
            flushSuppressed(suppressed);
          }
          if (tokens < 1) {
            countSuppressed(suppressed, status);
            return;
          }
          tokens -= 1;
        }

        const route = truncateUtf8(`${method} ${reqPath}`, ROUTE_MAX_BYTES);
        const sessionMatch = reqPath.match(SESSION_ID_RE);
        const sessionId = sessionMatch?.[1]
          ? truncateUtf8(sessionMatch[1], SESSION_ID_MAX_BYTES)
          : undefined;
        const rawClientId = firstRawHeader(req.rawHeaders, 'x-qwen-client-id');
        const clientId = rawClientId
          ? truncateUtf8(rawClientId, CLIENT_ID_MAX_BYTES)
          : undefined;
        // With telemetry on, the daemon request span stamps the trace prefix
        // on this line already; this field covers telemetry-off deployments,
        // where it is the only traceId link between a daemon log line and the
        // caller that sent the traceparent header.
        const inboundTraceId = getDaemonTelemetryInboundTraceId(res);
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
          ...(inboundTraceId ? { traceId: inboundTraceId } : {}),
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
