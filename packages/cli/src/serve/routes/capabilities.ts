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
    const entries = deps.workspaceRegistry.listEntries();
    const activePrimary = entries.find(
      (entry) => entry.primary && entry.state === 'active',
    )?.current?.runtime;
    const multiWorkspace = entries.length > 1;
    const features = deps.currentServeFeatures();
    const runtimeRemoval = features.includes('workspace_runtime_removal');
    const envelope: CapabilitiesEnvelope = {
      v: CAPABILITIES_SCHEMA_VERSION,
      protocolVersions: getServeProtocolVersions(),
      ...(deps.qwenCodeVersion
        ? { qwenCodeVersion: deps.qwenCodeVersion }
        : {}),
      mode: deps.mode,
      features,
      modelServices: [],
      // Surface the primary workspace so clients can omit `cwd` on
      // `POST /session`; multi-workspace clients use `workspaces[]`.
      workspaceCwd: deps.boundWorkspace,
      // Advertise supported transport families so SDK clients can
      // auto-negotiate the best available transport via negotiateTransport().
      transports: ['rest'],
      // Active mediation policy under the `policy` namespace.
      policy: {
        permission:
          activePrimary?.bridge.permissionPolicy ?? deps.permissionPolicy,
      },
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
      workspaces: entries.map((entry) => ({
        id: entry.workspaceId,
        cwd: entry.workspaceCwd,
        ...(entry.current?.runtime.displayName !== undefined
          ? { displayName: entry.current.runtime.displayName }
          : {}),
        primary: entry.primary,
        trusted:
          entry.state === 'active' && entry.current?.runtime.trusted === true,
        ...(runtimeRemoval ? { removable: entry.removable } : {}),
      })),
      supportedLanguages: deps.languageCodes,
    };
    res.status(200).json(envelope);
  });
}
