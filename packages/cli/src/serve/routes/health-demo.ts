/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { getDemoHtml } from '../demo.js';
import { isDeepHealthQuery } from '../health-query.js';
import { isLoopbackBind } from '../loopback-binds.js';
import type { RateLimiterInstance } from '../rate-limit.js';
import type { ServeOptions } from '../types.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

interface CreateHealthDemoRoutesDeps {
  opts: Pick<ServeOptions, 'hostname' | 'requireAuth'>;
  getPort: () => number;
  workspaceRegistry: WorkspaceRegistry;
  getActiveSseCount: () => number;
  getRateLimiter: () => RateLimiterInstance | undefined;
}

interface HealthDemoRoutes {
  exposeHealthPreAuth: boolean;
  register(app: Application): void;
}

export function createHealthDemoRoutes(
  deps: CreateHealthDemoRoutesDeps,
): HealthDemoRoutes {
  const {
    opts,
    getPort,
    workspaceRegistry,
    getActiveSseCount,
    getRateLimiter,
  } = deps;

  // --- Demo page: mirrors the `/health` loopback-gating pattern.
  // On loopback binds, registered BEFORE bearerAuth so browsers can
  // reach the page via address-bar navigation (which cannot attach
  // Authorization headers). On non-loopback binds, registered AFTER
  // bearerAuth — an unauthenticated `/demo` on a public interface
  // would leak the full API surface (route enumeration + interactive
  // console), far more than `/health`'s `{"status":"ok"}`.
  // X-Frame-Options: DENY + CSP frame-ancestors 'none' prevent
  // clickjacking — a malicious site embedding the demo in an iframe
  // could trick a user into performing daemon actions via transparent
  // overlay (the iframe's same-origin fetches bypass CORS).
  const demoHandler = (_req: Request, res: Response) => {
    try {
      res
        .type('html')
        .set('X-Frame-Options', 'DENY')
        .set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        )
        .send(getDemoHtml(getPort()));
    } catch (err) {
      writeStderrLine(
        `qwen serve: /demo render failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: 'Failed to render demo page' });
    }
  };

  // `/health` is exempted from `bearerAuth` ONLY on loopback binds —
  // the canonical liveness-probe case (k8s/Compose probes don't
  // carry the daemon's bearer; round-tripping a 401 just to know
  // the listener is up is waste). On non-loopback binds the
  // exemption becomes a low-severity info leak (attacker can probe
  // arbitrary IP:port to confirm a `qwen serve` is listening), so
  // we register `/health` AFTER `bearerAuth` and let it 401 like
  // every other route. Operators using the loopback default get the
  // probe-friendly behavior; operators exposing the daemon publicly
  // gate `/health` behind their token alongside everything else.
  // CORS deny + Host allowlist still apply to `/health` in both
  // cases.
  // Shared handler so loopback (pre-auth) and non-loopback (post-auth)
  // routes return the same shape. `?deep=1` exposes daemon-wide bridge
  // counters for observability, but the accessors don't ping child
  // processes or channels, so this is not a true liveness probe. An
  // unexpected registry or bridge read failure degrades the whole probe
  // instead of returning partial totals. Default (no query) stays cheap so
  // high-frequency liveness probes don't access runtime state.
  const healthHandler = (req: Request, res: Response): void => {
    if (!isDeepHealthQuery(req.query['deep'])) {
      res.status(200).json({ status: 'ok' });
      return;
    }
    try {
      const runtimes = workspaceRegistry.listManaged();
      let sessions = 0;
      let pendingPermissions = 0;
      let activePrompts = 0;
      let channelAlive = false;
      let lastActivity: number | null = null;

      for (const runtime of runtimes) {
        const bridge = runtime.bridge;
        const runtimeSessions = bridge.sessionCount;
        const runtimePendingPermissions = bridge.pendingPermissionCount;
        const runtimeActivePrompts = bridge.activePromptCount;
        const runtimeChannelAlive = bridge.isChannelLive();
        const runtimeLastActivity = bridge.lastActivityAt;

        sessions += runtimeSessions;
        pendingPermissions += runtimePendingPermissions;
        activePrompts += runtimeActivePrompts;
        channelAlive = channelAlive || runtimeChannelAlive;
        if (
          runtimeLastActivity !== null &&
          (lastActivity === null || runtimeLastActivity > lastActivity)
        ) {
          lastActivity = runtimeLastActivity;
        }
      }

      const now = Date.now();
      const rateLimiter = getRateLimiter();
      res.status(200).json({
        status: 'ok',
        workspaceCount: runtimes.length,
        sessions,
        pendingPermissions,
        activePrompts,
        connectedClients: getActiveSseCount(),
        channelAlive,
        lastActivityAt:
          lastActivity !== null ? new Date(lastActivity).toISOString() : null,
        idleSinceMs: lastActivity !== null ? now - lastActivity : null,
        ...(rateLimiter ? { rateLimitHits: rateLimiter.getHitCounts() } : {}),
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: /health deep probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(503).json({ status: 'degraded' });
    }
  };

  const loopback = isLoopbackBind(opts.hostname);
  // `--require-auth` extends the non-loopback "gate /health behind
  // bearer too" rule to loopback.
  const exposeHealthPreAuth = loopback && !opts.requireAuth;

  return {
    exposeHealthPreAuth,
    register(app: Application): void {
      app.get('/health', healthHandler);
      app.get('/demo', demoHandler);
    },
  };
}
