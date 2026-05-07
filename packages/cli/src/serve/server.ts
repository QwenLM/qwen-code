/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import express from 'express';
import type { Application } from 'express';
import { bearerAuth, denyBrowserOriginCors, hostAllowlist } from './auth.js';
import {
  createHttpAcpBridge,
  SessionNotFoundError,
  type HttpAcpBridge,
} from './httpAcpBridge.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  STAGE1_FEATURES,
  type CapabilitiesEnvelope,
  type ServeOptions,
} from './types.js';

export interface ServeAppDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: HttpAcpBridge;
}

/**
 * Build the Express app for `qwen serve`. Pure function — no side effects on
 * the network or process; `runQwenServe` does the listen/signal handling.
 *
 * `getPort` is invoked lazily by the host-allowlist middleware so callers
 * binding to port 0 (ephemeral) can supply the actual port after `listen()`
 * resolves. Defaults to `opts.port` for callers (e.g. tests) that pin a port
 * up front.
 *
 * Stage 1 routes shipped: `/health`, `/capabilities`, `POST /session`.
 * Session prompt/cancel/events and permission voting follow in the next PRs.
 */
export function createServeApp(
  opts: ServeOptions,
  getPort: () => number = () => opts.port,
  deps: ServeAppDeps = {},
): Application {
  const app = express();
  const bridge = deps.bridge ?? createHttpAcpBridge();

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

  app.post('/session', async (req, res) => {
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const cwd = typeof body['cwd'] === 'string' ? (body['cwd'] as string) : '';
    if (!cwd || !path.isAbsolute(cwd)) {
      res
        .status(400)
        .json({ error: '`cwd` is required and must be an absolute path' });
      return;
    }
    const modelServiceId =
      typeof body['modelServiceId'] === 'string'
        ? (body['modelServiceId'] as string)
        : undefined;
    try {
      const session = await bridge.spawnOrAttach({
        workspaceCwd: cwd,
        modelServiceId,
      });
      res.status(200).json(session);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/session/:id/prompt', async (req, res) => {
    const sessionId = req.params['id'];
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const prompt = body['prompt'];
    if (!Array.isArray(prompt)) {
      res
        .status(400)
        .json({
          error: '`prompt` is required and must be an array of content blocks',
        });
      return;
    }
    try {
      const result = await bridge.sendPrompt(sessionId, {
        ...(body as object),
        sessionId,
        prompt,
      } as Parameters<HttpAcpBridge['sendPrompt']>[1]);
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  app.post('/session/:id/cancel', async (req, res) => {
    const sessionId = req.params['id'];
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    try {
      await bridge.cancelSession(sessionId, {
        ...(body as object),
        sessionId,
      } as Parameters<HttpAcpBridge['cancelSession']>[1]);
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  return app;
}

function sendBridgeError(res: import('express').Response, err: unknown): void {
  if (err instanceof SessionNotFoundError) {
    res.status(404).json({ error: err.message, sessionId: err.sessionId });
    return;
  }
  res
    .status(500)
    .json({ error: err instanceof Error ? err.message : String(err) });
}
