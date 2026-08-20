/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DaemonSessionSummary } from '@qwen-code/sdk';
import type { DaemonRewindSnapshotInfo } from '@qwen-code/sdk/daemon';

export interface StubDaemon {
  baseUrl: string;
  /** Last-Event-ID header value seen on the most recent /events request. */
  lastEventIdHeader: string | undefined;
  /** True once an /events request socket closed before the stub ended it. */
  eventsAbortedByClient: boolean;
  /** Session id passed to the most recent DELETE /session/:id request. */
  lastEndedSessionId: string | undefined;
  /** Number of POST /session calls the stub has served. */
  createdSessionCount: number;
  /** Body of the most recent POST /session request. */
  lastCreateSessionBody: unknown;
  /** Body of the most recent POST /session/:id/resume request. */
  lastResumeSessionBody: unknown;
  /** Body of the most recent POST /session/:id/prompt request. */
  lastPromptBody: unknown;
  /** Body of the most recent POST /session/:id/rewind request. */
  lastRewindBody: unknown;
  /** Body of the most recent POST /session/:id/approval-mode request. */
  lastApprovalModeBody: unknown;
  /**
   * `{ requestId, response }` captured from the most recent
   * POST /session/:id/permission/:requestId request. Lets a test assert
   * which vote the review permission bridge actually sent upstream.
   */
  lastRespondedPermission: { requestId: string; response: unknown } | undefined;
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
  /**
   * Extra frames emitted on /session/:id/events immediately after `frames`,
   * for tests that want to script permission-request notifications a
   * `subscribeEvents` consumer (e.g. the review permission bridge, which
   * subscribes with `lastEventId: 0` and expects a full replay) will see.
   * Ids are assigned sequentially continuing on from `frames` — so with the
   * default two `frames`, the first `permissionFrames` entry lands at id 3.
   * Pass `frames: []` alongside this if a test needs the replay to contain
   * only the scripted permission frames.
   */
  permissionFrames?: Array<{ type: string; data: unknown }>;
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
  /**
   * Status for DELETE /session/:id (default 204). The "success" statuses
   * (200/204) respond 204 (the SDK's closeSession accepts 204/404); any other
   * value is returned verbatim as an error.
   */
  endSessionStatus?: number;
  /** Status for POST /session/:id/rewind (default 200). */
  rewindStatus?: number;
  /**
   * Response body for POST /session/:id/rewind on success. Defaults to
   * `{ rewound: true, targetTurnIndex: 0, filesChanged: [], filesFailed: [] }`.
   */
  rewindResult?: {
    rewound: boolean;
    targetTurnIndex: number;
    filesChanged: string[];
    filesFailed: string[];
  };
  /**
   * Snapshots served by GET /session/:id/rewind/snapshots (default []). The
   * SDK's `daemon.getRewindSnapshots(sessionId)` hits this route; the
   * gateway's rewind route maps a resolved `toTurn` onto
   * `snapshots.find(s => s.turnIndex === toTurn).promptId`.
   */
  rewindSnapshots?: DaemonRewindSnapshotInfo[];
  /** Status for POST /session/:id/approval-mode (default 200). */
  approvalModeStatus?: number;
  /**
   * Response body for POST /session/:id/approval-mode on success. Defaults to
   * `{ sessionId, mode, previous, persisted }` so a test that doesn't care
   * about the exact value still gets one that's consistent with what it sent.
   */
  approvalModeResult?: {
    sessionId?: string;
    mode: string;
    previous: string;
    persisted: boolean;
  };
  /** JSON body to return on a non-200 approval-mode response. */
  approvalModeBody?: unknown;
  /** Status for POST /session (default 200). Non-200 → { error }. */
  createSessionStatus?: number;
  /** Status for POST /session/:id/resume (default 200). Non-200 → { error }. */
  resumeSessionStatus?: number;
  /**
   * Skills reported by GET /session/:id/supported-commands, the route the
   * SDK's `daemon.sessionSupportedCommands(sessionId)` hits (default
   * `['review']`).
   */
  supportedSkills?: string[];
  /** Status for GET /session/:id/context (default 200). Non-200 → { error }. */
  contextStatusCode?: number;
  /** Full body to return from GET /session/:id/context (overrides the default). */
  contextStatus?: unknown;
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
    lastResumeSessionBody: undefined as unknown,
    lastPromptBody: undefined as unknown,
    lastRewindBody: undefined as unknown,
    lastApprovalModeBody: undefined as unknown,
    lastRespondedPermission: undefined as
      | { requestId: string; response: unknown }
      | undefined,
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
    // Extend `frames` with any scripted `permissionFrames`, assigning ids
    // sequentially so both sets replay through the same JSON-envelope
    // convention documented below.
    const allFrames = opts.permissionFrames
      ? [
          ...frames,
          ...opts.permissionFrames.map((f, i) => ({
            id: frames.length + i + 1,
            type: f.type,
            data: f.data,
          })),
        ]
      : frames;
    for (const f of allFrames) {
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

  app.post('/session/:id/permission/:requestId', (req, res) => {
    state.lastRespondedPermission = {
      requestId: req.params.requestId,
      response: req.body,
    };
    const status = opts.permissionStatus ?? 200;
    res.status(status).json(status === 200 ? {} : { error: 'no pending' });
  });

  app.get('/session/:id/supported-commands', (req, res) => {
    res.json({
      v: 1,
      sessionId: req.params.id,
      availableSkills: opts.supportedSkills ?? ['review'],
      availableCommands: [],
    });
  });

  app.get('/session/:id/context', (req, res) => {
    const status = opts.contextStatusCode ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const cwd = opts.workspaceCwd ?? '/proj';
    res.status(200).json(
      opts.contextStatus ?? {
        v: 1,
        sessionId: req.params.id,
        workspaceCwd: cwd,
        state: {
          models: {
            v: 1,
            workspaceCwd: cwd,
            initialized: true,
            current: { authType: 'openai', modelId: 'qwen3-coder:30b' },
            providers: [
              {
                kind: 'model_provider',
                authType: 'openai',
                current: true,
                models: [
                  {
                    modelId: 'qwen3-coder:30b',
                    baseModelId: 'qwen3-coder:30b',
                    name: 'Qwen3 Coder 30B',
                    contextLimit: 262144,
                    isCurrent: true,
                    isRuntime: false,
                  },
                ],
              },
            ],
          },
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Auto mode', description: 'auto' },
              { id: 'yolo', name: 'YOLO', description: 'yolo' },
            ],
          },
          configOptions: [],
        },
      },
    );
  });

  app.delete('/session/:id', (req, res) => {
    state.lastEndedSessionId = req.params.id;
    const status = opts.endSessionStatus ?? 204;
    // The SDK's closeSession resolves on 204 (closed) or 404 (already gone)
    // and throws on anything else. Map the "success" statuses (200/204) to a
    // 204 so a real DaemonClient resolves cleanly; pass other statuses through.
    if (status === 200 || status === 204) {
      res.status(204).end();
    } else {
      res.status(status).json({ error: 'stub error' });
    }
  });

  app.get('/session/:id/rewind/snapshots', (_req, res) => {
    res.json({ snapshots: opts.rewindSnapshots ?? [] });
  });

  app.post('/session/:id/rewind', (req, res) => {
    state.lastRewindBody = req.body;
    const status = opts.rewindStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    res.status(200).json(
      opts.rewindResult ?? {
        rewound: true,
        targetTurnIndex: 0,
        filesChanged: [],
        filesFailed: [],
      },
    );
  });

  app.post('/session/:id/approval-mode', express.json(), (req, res) => {
    state.lastApprovalModeBody = req.body;
    const status = opts.approvalModeStatus ?? 200;
    if (status !== 200) {
      res.status(status).json(opts.approvalModeBody ?? { error: 'stub' });
      return;
    }
    const r = opts.approvalModeResult ?? {
      sessionId: req.params.id,
      mode: req.body?.mode ?? 'default',
      previous: 'default',
      persisted: false,
    };
    res.status(200).json({
      sessionId: r.sessionId ?? req.params.id,
      mode: r.mode,
      previous: r.previous,
      persisted: r.persisted,
    });
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

  app.post('/session/:id/resume', (req, res) => {
    state.lastResumeSessionBody = req.body;
    const status = opts.resumeSessionStatus ?? 200;
    if (status !== 200) {
      res.status(status).json({ error: 'stub error' });
      return;
    }
    const cwd = (req.body as { cwd?: unknown })?.cwd;
    res.status(200).json({
      sessionId: req.params.id,
      workspaceCwd:
        typeof cwd === 'string' && cwd.length > 0
          ? cwd
          : (opts.workspaceCwd ?? '/stub/workspace'),
      attached: true,
      state: {},
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
    get lastResumeSessionBody() {
      return state.lastResumeSessionBody;
    },
    get lastPromptBody() {
      return state.lastPromptBody;
    },
    get lastRewindBody() {
      return state.lastRewindBody;
    },
    get lastApprovalModeBody() {
      return state.lastApprovalModeBody;
    },
    get lastRespondedPermission() {
      return state.lastRespondedPermission;
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
