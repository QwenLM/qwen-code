/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { getServeProtocolVersions } from '../capabilities.js';
import type { getAdvertisedServeFeatures } from '../capabilities.js';
import { advertisedMaxPendingPromptsPerSession } from '../server/serve-features.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  type CapabilitiesEnvelope,
  type ServeOptions,
} from '../types.js';

interface RegisterCapabilitiesRoutesDeps {
  qwenCodeVersion?: string;
  mode: ServeOptions['mode'];
  currentServeFeatures: () => ReturnType<typeof getAdvertisedServeFeatures>;
  boundWorkspace: string;
  permissionPolicy: AcpSessionBridge['permissionPolicy'];
  maxPendingPromptsPerSession: ServeOptions['maxPendingPromptsPerSession'];
  languageCodes: string[];
}

export function registerCapabilitiesRoutes(
  app: Application,
  deps: RegisterCapabilitiesRoutesDeps,
): void {
  app.get('/capabilities', (_req, res) => {
    const envelope: CapabilitiesEnvelope = {
      v: CAPABILITIES_SCHEMA_VERSION,
      protocolVersions: getServeProtocolVersions(),
      ...(deps.qwenCodeVersion
        ? { qwenCodeVersion: deps.qwenCodeVersion }
        : {}),
      mode: deps.mode,
      features: deps.currentServeFeatures(),
      modelServices: [],
      // Surface the bound workspace so clients can detect mismatch pre-flight
      // and omit `cwd` on `POST /session`.
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
      },
      supportedLanguages: deps.languageCodes,
    };
    res.status(200).json(envelope);
  });
}
