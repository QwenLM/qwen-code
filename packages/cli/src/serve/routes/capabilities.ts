/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { getServeProtocolVersions } from '../capabilities.js';
import type { getAdvertisedServeFeatures } from '../capabilities.js';
import {
  advertisedMaxPendingPromptsPerSession,
  advertisedMaxSessions,
} from '../server/serve-features.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  type CapabilitiesEnvelope,
  type ServeOptions,
} from '../types.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

interface RegisterCapabilitiesRoutesDeps {
  qwenCodeVersion?: string;
  mode: ServeOptions['mode'];
  currentServeFeatures: () => ReturnType<typeof getAdvertisedServeFeatures>;
  boundWorkspace: string;
  workspaceRegistry: WorkspaceRegistry;
  permissionPolicy: AcpSessionBridge['permissionPolicy'];
  maxSessionsPerWorkspace: ServeOptions['maxSessions'];
  maxTotalSessions: ServeOptions['maxTotalSessions'];
  maxPendingPromptsPerSession: ServeOptions['maxPendingPromptsPerSession'];
  languageCodes: string[];
}

export function registerCapabilitiesRoutes(
  app: Application,
  deps: RegisterCapabilitiesRoutesDeps,
): void {
  app.get('/capabilities', (_req, res) => {
    const runtimes = deps.workspaceRegistry.list();
    const multiWorkspace = runtimes.length > 1;
    const envelope: CapabilitiesEnvelope = {
      v: CAPABILITIES_SCHEMA_VERSION,
      protocolVersions: getServeProtocolVersions(),
      ...(deps.qwenCodeVersion
        ? { qwenCodeVersion: deps.qwenCodeVersion }
        : {}),
      mode: deps.mode,
      features: deps.currentServeFeatures(),
      modelServices: [],
      // Surface the primary workspace so clients can omit `cwd` on
      // `POST /session`; multi-workspace clients use `workspaces[]`.
      workspaceCwd: deps.boundWorkspace,
      // Advertise supported transport families so SDK clients can
      // auto-negotiate the best available transport via negotiateTransport().
      transports: ['rest'],
      // Active mediation policy under the `policy` namespace.
      policy: { permission: deps.permissionPolicy },
      limits: {
        maxPendingPromptsPerSession: advertisedMaxPendingPromptsPerSession(
          deps.maxPendingPromptsPerSession,
        ),
        ...(multiWorkspace
          ? {
              maxSessionsPerWorkspace: advertisedMaxSessions(
                deps.maxSessionsPerWorkspace,
              ),
              maxTotalSessions:
                deps.maxTotalSessions === undefined ||
                deps.maxTotalSessions === 0 ||
                deps.maxTotalSessions === Number.POSITIVE_INFINITY
                  ? null
                  : deps.maxTotalSessions,
            }
          : {}),
      },
      workspaces: runtimes.map((runtime) => ({
        id: runtime.workspaceId,
        cwd: runtime.workspaceCwd,
        primary: runtime.primary,
        trusted: runtime.trusted,
      })),
      supportedLanguages: deps.languageCodes,
    };
    res.status(200).json(envelope);
  });
}
