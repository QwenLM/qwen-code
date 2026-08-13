/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { gradeActiveWorkCoverage } from '@qwen-code/acp-bridge/bridgeTypes';
import type { Application, Request, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { isDeepHealthQuery } from '../health-query.js';
import { isLoopbackBind } from '../loopback-binds.js';
import type { RateLimiterInstance } from '../rate-limit.js';
import type { ServeOptions } from '../types.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

interface CreateHealthRoutesDeps {
  opts: Pick<ServeOptions, 'hostname' | 'requireAuth'>;
  workspaceRegistry: WorkspaceRegistry;
  getActiveSseCount: () => number;
  getRateLimiter: () => RateLimiterInstance | undefined;
}

interface HealthRoutes {
  exposeHealthPreAuth: boolean;
  register(app: Application): void;
}

export function createHealthRoutes(deps: CreateHealthRoutesDeps): HealthRoutes {
  const { opts, workspaceRegistry, getActiveSseCount, getRateLimiter } = deps;

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
    let failedWorkspaceId: string | undefined;
    try {
      if (
        workspaceRegistry
          .listEntries()
          .some((entry) => entry.state === 'blocked')
      ) {
        res.status(503).json({
          status: 'degraded',
          reason: 'workspace_runtime_blocked',
        });
        return;
      }
      const runtimes = workspaceRegistry.listManaged();
      let sessions = 0;
      let pendingPermissions = 0;
      let activePrompts = 0;
      let activeWork = false;
      let channelAlive = false;
      let lastActivity: number | null = null;
      // Coverage is summed as counts and graded once, at the end. Grading per
      // runtime and combining the grades does not work: a runtime with zero
      // Sessions is vacuously `full`, and treating that as evidence let an
      // empty workspace vouch for another workspace's unreported Sessions.
      let coveredSessions = 0;
      let sessionsOnNegotiatedChannel = 0;
      let oldestReportAt: number | null = null;

      for (const runtime of runtimes) {
        failedWorkspaceId = runtime.workspaceId;
        const bridge = runtime.bridge;
        const runtimeSessions = bridge.sessionCount;
        const runtimePendingPermissions = bridge.pendingPermissionCount;
        const runtimeActivePrompts = bridge.activePromptCount;
        const runtimeActiveWork = bridge.activeWork;
        const runtimeCoverage = bridge.activeWorkCoverage;
        const runtimeOldestReportAt = runtimeCoverage.oldestCoveredReportAt;
        const runtimeChannelAlive = bridge.isChannelLive();
        const runtimeLastActivity = bridge.lastActivityAt;

        sessions += runtimeSessions;
        pendingPermissions += runtimePendingPermissions;
        activePrompts += runtimeActivePrompts;
        activeWork = activeWork || runtimeActiveWork;
        coveredSessions += runtimeCoverage.covered;
        sessionsOnNegotiatedChannel += runtimeCoverage.onNegotiatedChannel;
        if (
          runtimeOldestReportAt !== null &&
          (oldestReportAt === null || runtimeOldestReportAt < oldestReportAt)
        ) {
          oldestReportAt = runtimeOldestReportAt;
        }
        channelAlive = channelAlive || runtimeChannelAlive;
        if (
          runtimeLastActivity !== null &&
          (lastActivity === null || runtimeLastActivity > lastActivity)
        ) {
          lastActivity = runtimeLastActivity;
        }
        failedWorkspaceId = undefined;
      }

      const now = Date.now();
      const rateLimiter = getRateLimiter();
      res.status(200).json({
        status: 'ok',
        workspaceCount: runtimes.length,
        sessions,
        pendingPermissions,
        activePrompts,
        activeWork,
        activeWorkReporting: gradeActiveWorkCoverage({
          total: sessions,
          covered: coveredSessions,
          onNegotiatedChannel: sessionsOnNegotiatedChannel,
        }),
        // 0 rather than null when nothing is covered: an idle daemon with no
        // sessions must not read as infinitely stale to a controller applying
        // its own freshness floor. `oldestReportAt` is the oldest *covered*
        // report, so this never disagrees with the grade above.
        activeWorkStaleMs: oldestReportAt === null ? 0 : now - oldestReportAt,
        connectedClients: getActiveSseCount(),
        channelAlive,
        lastActivityAt:
          lastActivity !== null ? new Date(lastActivity).toISOString() : null,
        idleSinceMs: lastActivity !== null ? now - lastActivity : null,
        ...(rateLimiter ? { rateLimitHits: rateLimiter.getHitCounts() } : {}),
      });
    } catch (err) {
      const workspaceContext =
        failedWorkspaceId !== undefined
          ? ` for workspace ${JSON.stringify(failedWorkspaceId)}`
          : '';
      writeStderrLine(
        `qwen serve: /health deep probe failed${workspaceContext}: ${err instanceof Error ? err.message : String(err)}`,
      );
      res
        .status(503)
        .json({ status: 'degraded', reason: 'aggregation_failed' });
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
    },
  };
}
