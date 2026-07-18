/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DaemonSessionSummary } from '@qwen-code/sdk';

export interface StubDaemon {
  baseUrl: string;
  /** Last-Event-ID header value seen on the most recent /events request. */
  lastEventIdHeader: string | undefined;
  /** True once an /events request socket closed before the stub ended it. */
  eventsAbortedByClient: boolean;
  /** Session id passed to the most recent POST /session/:id/end request. */
  lastEndedSessionId: string | undefined;
  /** Number of POST /session calls the stub has served. */
  createdSessionCount: number;
  /** Body of the most recent POST /session request. */
  lastCreateSessionBody: unknown;
  /** Body of the most recent POST /session/:id/prompt request. */
  lastPromptBody: unknown;
  /** Body of the most recent POST /session/:id/rewind request. */
  lastRewindBody: unknown;
  /**
   * Start/end wall-clock timestamps (ms, `Date.now()`) for every
   * POST /session/:id/prompt call the stub has served, in completion order.
   * Lets a test assert non-overlap ("call B started after call A ended") to
   * prove per-session prompt serialization without relying on fragile
   * fixed-delay timing assumptions.
   */
  promptCallLog: Array<{
    sessionId: string;
    startedAt: number;
    endedAt: number;
  }>;
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
  /** Status for POST /session/:id/prompt (default 200). */
  promptStatus?: number;
  /** stopReason returned by POST /session/:id/prompt on success (default 'end_turn'). */
  promptStopReason?: string;
  /**
   * Artificial delay (ms) before the stub daemon responds to a prompt POST.
   * Lets tests drive queue-wait and prompt-execution timeout scenarios without
   * real timing dependencies in the production code path.
   */
  promptDelayMs?: number;
  /** workspaceCwd reported by GET /capabilities (default '/stub/workspace'). */
  workspaceCwd?: string;
  /**
   * Sessions returned by GET /workspace/:cwd/sessions (default []). Read live
   * per-request, so a test can mutate the passed array (e.g. `sessions.length=0`)
   * and have the next poll tick observe the change.
   */
  sessions?: DaemonSessionSummary[];
  /** Status for GET /capabilities (default 200). Non-200 → { error }. */
  capabilitiesStatus?: number;
  /** Status for POST /session/:id/end (default 200). Non-200 → { error }. */
  endSessionStatus?: number;
  /** Status for POST /session/:id/rewind (default 200). */
  rewindStatus?: number;
  /**
   * Response body for POST /session/:id/rewind on success. Defaults to
   * `{ targetTurnIndex: <the request's toTurn>, apiTruncateIndex: 0 }` so a
   * test that doesn't care about the exact value still gets one that's
   * consistent with what it sent.
   */
  rewindResult?: { targetTurnIndex: number; apiTruncateIndex: number };
  /** Status for POST /session (default 200). Non-200 → { error }. */
  createSessionStatus?: number;
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
    lastEndedSessionId: undefined as string | undefined,
    createdSessionCount: 0,
    lastCreateSessionBody: undefined as unknown,
    lastPromptBody: undefined as unknown,
    lastRewindBody: undefined as unknown,
    promptCallLog: [] as Array<{
      sessionId: string;
      startedAt: number;
      endedAt: number;
    }>,
  };
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/capabilities', (_req, res) => {
    const status = opts.capabilitiesStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    res.json({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: opts.workspaceCwd ?? '/stub/workspace',
    });
  });

  app.get('/workspace/:cwd/sessions', (_req, res) => {
    res.json({ sessions: opts.sessions ?? [] });
  });

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

  app.post('/session/:id/end', (req, res) => {
    state.lastEndedSessionId = req.params.id;
    const status = opts.endSessionStatus ?? 200;
    if (status === 200) {
      res.status(200).json({ sessionId: req.params.id, ended: true });
    } else {
      res.status(status).json({ error: 'stub error' });
    }
  });

  app.post('/session/:id/rewind', (req, res) => {
    state.lastRewindBody = req.body;
    const status = opts.rewindStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const toTurn = (req.body as { toTurn?: unknown })?.toTurn;
    res.status(200).json(
      opts.rewindResult ?? {
        targetTurnIndex: typeof toTurn === 'number' ? toTurn : 0,
        apiTruncateIndex: 0,
      },
    );
  });

  app.post('/session/:id/prompt', (req, res) => {
    const status = opts.promptStatus ?? 200;
    state.lastPromptBody = req.body;
    const startedAt = Date.now();
    const respond = () => {
      state.promptCallLog.push({
        sessionId: req.params.id,
        startedAt,
        endedAt: Date.now(),
      });
      if (status === 200) {
        res
          .status(200)
          .json({ stopReason: opts.promptStopReason ?? 'end_turn' });
      } else {
        res.status(status).json({ error: 'stub error' });
      }
    };
    if (opts.promptDelayMs) {
      // Detect real client disconnection via the socket — NOT req, which emits
      // 'close' immediately after the POST body is consumed by express.json(),
      // even though the TCP connection is still open.
      let settled = false;
      // Box the timer so socketClose (defined before the setTimeout call) can
      // reference and clear it without a let/reassignment lint error.
      const timerRef: { id?: ReturnType<typeof setTimeout> } = {};
      const socketClose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timerRef.id);
          // Socket is gone; nothing to send back.
        }
      };
      req.socket?.on('close', socketClose);
      timerRef.id = setTimeout(() => {
        if (settled) return;
        settled = true;
        req.socket?.off('close', socketClose);
        respond();
      }, opts.promptDelayMs);
    } else {
      respond();
    }
  });

  app.post('/session', (req, res) => {
    const status = opts.createSessionStatus ?? 200;
    state.lastCreateSessionBody = req.body;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    state.createdSessionCount += 1;
    res.status(200).json({
      sessionId: `stub-agent-${state.createdSessionCount}`,
      workspaceCwd: opts.workspaceCwd ?? '/stub/workspace',
      attached: false,
    });
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
    get lastEndedSessionId() {
      return state.lastEndedSessionId;
    },
    get createdSessionCount() {
      return state.createdSessionCount;
    },
    get lastCreateSessionBody() {
      return state.lastCreateSessionBody;
    },
    get lastPromptBody() {
      return state.lastPromptBody;
    },
    get lastRewindBody() {
      return state.lastRewindBody;
    },
    get promptCallLog() {
      return state.promptCallLog;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
