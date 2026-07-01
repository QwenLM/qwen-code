/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { AcpHttpHandle } from '../acp-http/index.js';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type {
  DeviceFlowProviderId,
  DeviceFlowRegistry,
} from '../auth/device-flow.js';
import type { DaemonLogger } from '../daemon-logger.js';
import {
  buildDaemonStatusResponse,
  type DaemonStartupSnapshot,
  parseDaemonStatusDetail,
} from '../daemon-status.js';
import type { RateLimiterInstance } from '../rate-limit.js';
import type { ServeOptions } from '../types.js';
import type { ChannelWorkerSnapshot } from '../channel-worker-supervisor.js';
import type { DaemonWorkspaceService } from '../workspace-service/index.js';
import { getServeProtocolVersions } from '../capabilities.js';

interface RegisterDaemonStatusRoutesDeps {
  opts: ServeOptions;
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspace: DaemonWorkspaceService;
  daemonLog?: DaemonLogger;
  startup?: DaemonStartupSnapshot;
  qwenCodeVersion?: string;
  getAcpHandle: () => AcpHttpHandle | undefined;
  getRateLimiter: () => RateLimiterInstance | undefined;
  getRestSseActive: () => number;
  currentServeFeatures: () => ReturnType<
    typeof import('../capabilities.js').getAdvertisedServeFeatures
  >;
  getSupportedDeviceFlowProviders: () => DeviceFlowProviderId[];
  deviceFlowRegistry: DeviceFlowRegistry;
  sessionShellCommandEnabled: boolean;
  getChannelWorkerSnapshot?: () => ChannelWorkerSnapshot;
}

export function registerDaemonStatusRoutes(
  app: Application,
  deps: RegisterDaemonStatusRoutesDeps,
): void {
  app.get('/daemon/status', async (req, res) => {
    const detail = parseDaemonStatusDetail(req.query['detail']);
    if (!detail.ok || !detail.detail) {
      res.status(400).json({
        error: 'detail must be one of: summary, full',
        code: 'invalid_detail',
      });
      return;
    }
    try {
      res.status(200).json(
        await buildDaemonStatusResponse(detail.detail, {
          opts: deps.opts,
          boundWorkspace: deps.boundWorkspace,
          bridge: deps.bridge,
          workspace: deps.workspace,
          daemonLog: deps.daemonLog,
          startup: deps.startup,
          qwenCodeVersion: deps.qwenCodeVersion,
          acpHandle: deps.getAcpHandle(),
          rateLimiter: deps.getRateLimiter(),
          getRestSseActive: deps.getRestSseActive,
          features: deps.currentServeFeatures(),
          protocolVersions: getServeProtocolVersions(),
          supportedDeviceFlowProviders: deps.getSupportedDeviceFlowProviders(),
          deviceFlowRegistry: deps.deviceFlowRegistry,
          sessionShellCommandEnabled: deps.sessionShellCommandEnabled,
          getChannelWorkerSnapshot: deps.getChannelWorkerSnapshot,
        }),
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: /daemon/status failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({
        error: 'Failed to build daemon status',
        code: 'daemon_status_failed',
      });
    }
  });
}
