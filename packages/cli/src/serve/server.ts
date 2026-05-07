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
import type { BridgeEvent } from './eventBus.js';
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
      res.status(500).json({ error: errorMessage(err) });
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
      res.status(400).json({
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

  app.get('/workspace/:id/sessions', (req, res) => {
    // Express decodes URL-encoded path params automatically; clients pass
    // the absolute workspace cwd encoded (e.g.
    // GET /workspace/%2Fwork%2Fa/sessions).
    const workspaceCwd = req.params['id'] ?? '';
    if (!path.isAbsolute(workspaceCwd)) {
      res
        .status(400)
        .json({ error: '`:id` must decode to an absolute workspace path' });
      return;
    }
    const sessions = bridge.listWorkspaceSessions(workspaceCwd);
    res.status(200).json({ sessions });
  });

  app.post('/session/:id/model', async (req, res) => {
    const sessionId = req.params['id'];
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const modelId = body['modelId'];
    if (typeof modelId !== 'string' || !modelId) {
      res.status(400).json({
        error: '`modelId` is required and must be a non-empty string',
      });
      return;
    }
    try {
      const response = await bridge.setSessionModel(sessionId, {
        ...(body as object),
        sessionId,
        modelId,
      } as Parameters<HttpAcpBridge['setSessionModel']>[1]);
      res.status(200).json(response);
    } catch (err) {
      sendBridgeError(res, err);
    }
  });

  app.post('/permission/:requestId', (req, res) => {
    const requestId = req.params['requestId'];
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const outcome = body['outcome'];
    if (!isValidOutcome(outcome)) {
      res.status(400).json({
        error:
          '`outcome` must be `{ outcome: "cancelled" }` or `{ outcome: "selected", optionId: string }`',
      });
      return;
    }
    const accepted = bridge.respondToPermission(requestId, {
      ...(body as object),
      outcome,
    } as Parameters<HttpAcpBridge['respondToPermission']>[1]);
    if (!accepted) {
      // Either the requestId never existed or another client already won
      // the race. Stage 1 doesn't distinguish — both surface as 404.
      res
        .status(404)
        .json({ error: 'No pending permission request', requestId });
      return;
    }
    res.status(200).json({});
  });

  app.get('/session/:id/events', (req, res) => {
    const sessionId = req.params['id'];
    const lastEventId = parseLastEventId(req.headers['last-event-id']);

    let iter: AsyncIterator<BridgeEvent> | undefined;
    const abort = new AbortController();
    try {
      const iterable = bridge.subscribeEvents(sessionId, {
        signal: abort.signal,
        lastEventId,
      });
      iter = iterable[Symbol.asyncIterator]();
    } catch (err) {
      sendBridgeError(res, err);
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (nginx); event-stream content type alone
    // doesn't always reach the client through every proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    // Tell EventSource to retry after 3s on disconnect.
    res.write('retry: 3000\n\n');

    // Heartbeat keeps NAT/proxy connections alive and lets the server
    // notice a dead client through write-back-pressure. Comment frame is
    // ignored by EventSource.
    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15_000);
    heartbeatTimer.unref?.();

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      abort.abort();
    };
    req.on('close', cleanup);

    void (async () => {
      try {
        while (true) {
          const next = await iter!.next();
          if (next.done) break;
          if (res.writableEnded) break;
          res.write(formatSseFrame(next.value));
        }
      } catch (err) {
        if (!res.writableEnded) {
          res.write(
            formatSseFrame({
              id: 0,
              v: 1,
              type: 'stream_error',
              data: { error: err instanceof Error ? err.message : String(err) },
            }),
          );
        }
      } finally {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    })();
  });

  return app;
}

function isValidOutcome(
  raw: unknown,
): raw is { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (obj['outcome'] === 'cancelled') return true;
  return obj['outcome'] === 'selected' && typeof obj['optionId'] === 'string';
}

function parseLastEventId(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function formatSseFrame(event: BridgeEvent): string {
  // SSE format: id (optional), event (optional), data, blank line.
  // Splitting `data` on newlines lets browsers reassemble multi-line JSON.
  const dataJson = JSON.stringify(event);
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${dataJson}\n\n`;
}

function sendBridgeError(res: import('express').Response, err: unknown): void {
  if (err instanceof SessionNotFoundError) {
    res.status(404).json({ error: err.message, sessionId: err.sessionId });
    return;
  }
  res.status(500).json({ error: errorMessage(err) });
}

/**
 * Coerce an arbitrary thrown value to a useful string. Plain `String(err)`
 * yields `[object Object]` for JSON-RPC-shaped errors (`{code, message,
 * data}`) which are exactly what the ACP SDK forwards from the agent. Try
 * the `message` field first, fall back to JSON-stringify, then `String`.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe.length > 0) return maybe;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}
