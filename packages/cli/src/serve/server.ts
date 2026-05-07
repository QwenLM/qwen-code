/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Application } from 'express';
import { bearerAuth, denyBrowserOriginCors, hostAllowlist } from './auth.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  STAGE1_FEATURES,
  type CapabilitiesEnvelope,
  type ServeOptions,
} from './types.js';

/**
 * Build the Express app for `qwen serve`. Pure function — no side effects on
 * the network or process; `runQwenServe` does the listen/signal handling.
 *
 * `getPort` is invoked lazily by the host-allowlist middleware so callers
 * binding to port 0 (ephemeral) can supply the actual port after `listen()`
 * resolves. Defaults to `opts.port` for callers (e.g. tests) that pin a port
 * up front.
 *
 * Stage 1 ships only `/health` and `/capabilities`; session/prompt/event
 * routes follow once HttpAcpBridge is wired (see httpAcpBridge.ts TODOs).
 */
export function createServeApp(
  opts: ServeOptions,
  getPort: () => number = () => opts.port,
): Application {
  const app = express();

  app.use(express.json({ limit: '10mb' }));
  app.use(denyBrowserOriginCors);
  app.use(hostAllowlist(opts.hostname, getPort));
  app.use(bearerAuth(opts.token));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/capabilities', (_req, res) => {
    const envelope: CapabilitiesEnvelope = {
      v: CAPABILITIES_SCHEMA_VERSION,
      mode: opts.mode,
      features: [...STAGE1_FEATURES],
      modelServices: [],
    };
    res.status(200).json(envelope);
  });

  return app;
}
