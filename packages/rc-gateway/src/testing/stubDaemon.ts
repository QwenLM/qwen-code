/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export interface StubDaemon {
  baseUrl: string;
  /** Last-Event-ID header value seen on the most recent /events request. */
  lastEventIdHeader: string | undefined;
  /** True once an /events request socket closed before the stub ended it. */
  eventsAbortedByClient: boolean;
  close: () => Promise<void>;
}

export interface StubDaemonOptions {
  /** Frames to emit on /session/:id/events, as {id, type, data}. */
  frames?: Array<{ id: number; type: string; data: unknown }>;
  /** When set, /events responds with this status instead of streaming. */
  eventsStatus?: number;
  /**
   * Keep the SSE response open for this many ms after emitting frames
   * (instead of ending immediately). Lets a test disconnect mid-stream and
   * observe that the upstream subscription was aborted.
   */
  holdOpenMs?: number;
  /** Status for POST /session/:id/permission/:requestId (default 200 = accepted). */
  permissionStatus?: number;
}

/** Start a minimal daemon-shaped SSE server on an ephemeral loopback port. */
export async function startStubDaemon(
  opts: StubDaemonOptions = {},
): Promise<StubDaemon> {
  const frames = opts.frames ?? [
    { id: 1, type: 'session_update', data: { text: 'one' } },
    { id: 2, type: 'session_update', data: { text: 'two' } },
  ];
  const state = {
    lastEventIdHeader: undefined as string | undefined,
    eventsAbortedByClient: false,
  };
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/session/:id/events', (req, res) => {
    state.lastEventIdHeader = req.headers['last-event-id'] as
      | string
      | undefined;
    if (opts.eventsStatus && opts.eventsStatus !== 200) {
      res.status(opts.eventsStatus).json({ error: 'stub error' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const f of frames) {
      // IMPORTANT: the SDK's parseSseStream reads the event id from INSIDE
      // the data JSON envelope (`parsed.id`, required to be an integer >= 1),
      // and ignores the SSE `id:` line. So the id MUST live in the JSON. We
      // also emit the `id:` line to mirror real SSE framing (harmless; the
      // DaemonClient ignores it, but downstream EventSource clients use it).
      res.write(`id: ${f.id}\n`);
      res.write(
        `data: ${JSON.stringify({ v: 1, id: f.id, type: f.type, data: f.data })}\n\n`,
      );
    }
    if (opts.holdOpenMs) {
      let ended = false;
      const timer = setTimeout(() => {
        ended = true;
        res.end();
      }, opts.holdOpenMs);
      req.on('close', () => {
        if (!ended) {
          state.eventsAbortedByClient = true;
          clearTimeout(timer);
        }
      });
      return;
    }
    res.end();
  });

  app.post('/session/:id/permission/:requestId', (_req, res) => {
    const status = opts.permissionStatus ?? 200;
    res.status(status).json(status === 200 ? {} : { error: 'no pending' });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get lastEventIdHeader() {
      return state.lastEventIdHeader;
    },
    get eventsAbortedByClient() {
      return state.eventsAbortedByClient;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
