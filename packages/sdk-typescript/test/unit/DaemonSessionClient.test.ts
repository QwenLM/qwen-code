/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DaemonClient,
  DaemonPendingPromptLimitError,
} from '../../src/daemon/DaemonClient.js';
import {
  DaemonSessionClient,
  type DaemonSessionSubscribeOptions,
} from '../../src/daemon/DaemonSessionClient.js';
import type {
  GoalControlRequest,
  GoalSnapshotV2,
} from '../../src/daemon/types.js';
import { AutoReconnectTransport } from '../../src/daemon/AutoReconnectTransport.js';
import {
  DaemonTransportClosedError,
  type DaemonTransport,
  type DaemonTransportSubscribeOptions,
  type DaemonTransportType,
} from '../../src/daemon/DaemonTransport.js';

const GOAL_SNAPSHOT: GoalSnapshotV2 = {
  v: 2,
  activity: 'idle',
  goal: {
    goalId: 'goal-1',
    revision: 4,
    objective: 'ship it',
    status: 'paused',
    evidenceCursor: { recordId: null },
    turnCount: 1,
    activeTimeMs: 2000,
    createdAt: 1000,
    updatedAt: 3000,
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// Like sseResponse but stamps the daemon's bus epoch response header so
// tests can exercise the DAEMON-001 epoch learning path.
function sseResponseWithEpoch(frames: string, epoch: string): Response {
  const res = sseResponse(frames);
  res.headers.set('x-qwen-event-epoch', epoch);
  return res;
}

function pendingSseResponse(
  onCancel: () => void,
  onStart?: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onStart?.(controller);
      controller.enqueue(encoder.encode(': keepalive\n\n'));
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal | null;
}

function recordingFetch(
  reply: (req: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => (headers[k.toLowerCase()] = v));
      }
      const body = typeof init?.body === 'string' ? init.body : null;
      const captured: CapturedRequest = {
        url,
        method,
        headers,
        body,
        signal: init?.signal,
      };
      calls.push(captured);
      return reply(captured);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function requestPathEndsWith(req: CapturedRequest, suffix: string): boolean {
  return new URL(req.url).pathname.endsWith(suffix);
}

function pendingPromptIds(session: DaemonSessionClient): string[] {
  return [
    ...(
      session as unknown as {
        _pendingPrompts: Map<string, unknown>;
      }
    )._pendingPrompts.keys(),
  ];
}

async function waitForPendingPrompt(
  session: DaemonSessionClient,
  promptId: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(pendingPromptIds(session)).toContain(promptId);
  });
}

function turnCompleteFrame(promptId: string): string {
  return `id: 1\nevent: turn_complete\ndata: {"id":1,"v":1,"type":"turn_complete","promptId":"${promptId}","data":{"promptId":"${promptId}","stopReason":"end_turn"}}\n\n`;
}

describe('DaemonSessionClient', () => {
  it('binds agent, trace, and attachment reads to the session identity', async () => {
    const controller = new AbortController();
    const { signal } = controller;
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/agents')) {
        return jsonResponse(200, { v: 1, sessionId: 's-1', tasks: [] });
      }
      if (req.url.includes('/agent-trace')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          nodes: [],
          rootAgentIds: [],
          warnings: [],
        });
      }
      return jsonResponse(200, { attachments: [] });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(session.agents(signal)).resolves.toMatchObject({ tasks: [] });
    await expect(
      session.agentTrace({ rootAgentId: 'root-1', signal }),
    ).resolves.toMatchObject({ nodes: [] });
    await expect(session.listAttachments(signal)).resolves.toEqual([]);
    expect(calls.map((call) => call.url)).toEqual([
      'http://daemon/session/s-1/agents',
      'http://daemon/session/s-1/agent-trace?rootAgentId=root-1',
      'http://daemon/session/s-1/attachments',
    ]);
    controller.abort();
    expect(calls.every((call) => call.signal?.aborted)).toBe(true);
    expect(
      calls.every((call) => call.headers['x-qwen-client-id'] === 'client-1'),
    ).toBe(true);
  });

  it('binds Goal reads and controls to the session and client identity', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, { snapshot: GOAL_SNAPSHOT }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });
    const request: GoalControlRequest = {
      action: 'resume',
      expectedGoalId: 'goal-1',
      expectedRevision: 4,
    };

    await expect(session.goal()).resolves.toEqual({ snapshot: GOAL_SNAPSHOT });
    await expect(session.controlGoal(request)).resolves.toEqual({
      snapshot: GOAL_SNAPSHOT,
    });

    expect(calls.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: 'http://daemon/session/s-1/goal', method: 'GET' },
      { url: 'http://daemon/session/s-1/goal', method: 'POST' },
    ]);
    expect(calls.map((call) => call.headers['x-qwen-client-id'])).toEqual([
      'client-1',
      'client-1',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual(request);
  });

  it('creates or attaches a daemon session and exposes session metadata', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: false,
        clientId: 'client-1',
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
      modelServiceId: 'qwen-prod',
    });

    expect(session.sessionId).toBe('s-1');
    expect(session.workspaceCwd).toBe('/work/a');
    expect(session.attached).toBe(false);
    expect(session.clientId).toBe('client-1');
    expect(calls[0]?.url).toBe('http://daemon/session');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      cwd: '/work/a',
      modelServiceId: 'qwen-prod',
    });
  });

  it('creates a standalone session with an explicit restore strategy', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/capabilities')) {
        return jsonResponse(200, {
          features: ['standalone_sessions_v1'],
        });
      }
      if (requestPathEndsWith(req, `/session/${sessionId}/events`)) {
        return sseResponse('');
      }
      return jsonResponse(200, {
        sessionId,
        workspaceCwd: '/conversations',
        attached: false,
        clientId: 'client-1',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: '/conversations/conversation-hash',
        workingDirectory: { state: 'ready' },
        eventEpoch: 'epoch-created',
      });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createStandalone(client, {
      sessionId,
    });

    expect(session.sessionId).toBe(sessionId);
    expect(session.restoreStrategy).toEqual({ kind: 'standalone' });
    expect(session.eventEpoch).toBe('epoch-created');
    for await (const _event of session.events()) {
      /* empty */
    }
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/capabilities',
      '/standalone/sessions',
      `/session/${sessionId}/events`,
    ]);
    expect(calls[2]?.headers['last-event-id']).toBe('0');
  });

  it('loads and resumes standalone sessions without a workspace selector', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/capabilities')) {
        return jsonResponse(200, {
          features: ['standalone_sessions_v1'],
        });
      }
      if (req.url.endsWith(`/session/${sessionId}/attachments/media-1`)) {
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      if (requestPathEndsWith(req, `/session/${sessionId}/events`)) {
        return sseResponse('');
      }
      const loading = req.url.endsWith('/load');
      return jsonResponse(200, {
        sessionId,
        workspaceCwd: '/conversations',
        attached: true,
        clientId: 'client-1',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: '/conversations/conversation-hash',
        workingDirectory: { state: 'ready' },
        state: loading ? { mode: 'loaded' } : { mode: 'resumed' },
        hasActivePrompt: true,
        ...(loading
          ? {
              lastEventId: 42,
              eventEpoch: 'epoch-loaded',
              compactedReplay: [
                {
                  id: 1,
                  v: 1,
                  type: 'session_update',
                  data: {
                    sessionUpdate: 'user_message_chunk',
                    content: {
                      type: 'image',
                      attachmentId: 'media-1',
                      mimeType: 'image/png',
                      size: 3,
                    },
                  },
                },
              ],
              replayDegraded: true,
              partial: true,
              replayError: 'journal read failed',
            }
          : { eventEpoch: 'epoch-resumed' }),
      });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const loaded = await DaemonSessionClient.loadStandalone(
      client,
      sessionId,
      { historyPageSize: 20 },
      'client-load',
    );
    const resumed = await DaemonSessionClient.resumeStandalone(
      client,
      sessionId,
      {},
      'client-resume',
    );

    expect(loaded.restoreStrategy).toEqual({ kind: 'standalone' });
    expect(loaded.state).toEqual({ mode: 'loaded' });
    expect(loaded.hasActivePrompt).toBe(true);
    expect(loaded.lastEventId).toBe(42);
    expect(loaded.eventEpoch).toBe('epoch-loaded');
    expect(loaded.replaySnapshotComplete).toBe(false);
    expect(loaded.replayPartial).toBe(true);
    expect(loaded.replayError).toBe('journal read failed');
    expect(loaded.replayDegraded).toBe(true);
    expect(loaded.replaySnapshot.compactedReplay[0]?.data).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'image',
        attachmentId: 'media-1',
        data: 'AQID',
        mimeType: 'image/png',
      },
    });
    expect(resumed.restoreStrategy).toEqual({ kind: 'standalone' });
    expect(resumed.state).toEqual({ mode: 'resumed' });
    expect(resumed.hasActivePrompt).toBe(true);
    expect(resumed.lastEventId).toBe(0);
    expect(resumed.eventEpoch).toBe('epoch-resumed');
    expect(resumed.replaySnapshotComplete).toBe(false);
    const restores = calls.filter((call) =>
      /\/(load|resume)$/u.test(new URL(call.url).pathname),
    );
    expect(restores.map((call) => new URL(call.url).pathname)).toEqual([
      `/standalone/sessions/${sessionId}/load`,
      `/standalone/sessions/${sessionId}/resume`,
    ]);
    expect(JSON.parse(restores[0]?.body ?? '{}')).toEqual({
      historyPageSize: 20,
    });
    expect(JSON.parse(restores[1]?.body ?? '{}')).toEqual({});
    expect(restores[0]?.headers['x-qwen-client-id']).toBe('client-load');
    expect(restores[1]?.headers['x-qwen-client-id']).toBe('client-resume');
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/media-1')),
    ).toHaveLength(1);

    for await (const _event of loaded.events()) {
      /* empty */
    }
    for await (const _event of resumed.events()) {
      /* empty */
    }
    const eventCalls = calls.filter((call) =>
      requestPathEndsWith(call, `/session/${sessionId}/events`),
    );
    expect(eventCalls.map((call) => call.headers['last-event-id'])).toEqual([
      '42',
      '0',
    ]);
  });

  it('uses workspace restore when standalone source metadata is incomplete', () => {
    const { fetch } = recordingFetch(() => jsonResponse(500, {}));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        sourceType: 'standalone',
      },
    });

    expect(session.restoreStrategy).toEqual({
      kind: 'workspace',
      workspaceCwd: '/work/a',
    });
  });

  it('preserves active prompt state from createOrAttach responses', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(200, {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
        hasActivePrompt: true,
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
    });

    expect(session.hasActivePrompt).toBe(true);
  });

  it('forwards a persisted client id through create, load, and resume', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-reuse',
        });
      }
      if (
        req.url.endsWith('/session/s-1/load') ||
        req.url.endsWith('/session/s-1/resume')
      ) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-reuse',
          state: {},
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await DaemonSessionClient.createOrAttach(
      client,
      { workspaceCwd: '/work/a' },
      'client-reuse',
    );
    await DaemonSessionClient.load(
      client,
      's-1',
      { workspaceCwd: '/work/a' },
      'client-reuse',
    );
    await DaemonSessionClient.resume(client, 's-1', {}, 'client-reuse');

    expect(calls.map((c) => c.headers['x-qwen-client-id'])).toEqual([
      'client-reuse',
      'client-reuse',
      'client-reuse',
    ]);
  });

  it('forwards source metadata through resume requests', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/capabilities')) {
        return jsonResponse(200, { features: ['session_source_metadata'] });
      }
      if (req.url.endsWith('/session/s-1/resume')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await DaemonSessionClient.resume(client, 's-1', {
      workspaceCwd: '/work/a',
      sourceType: 'channel',
      sourceId: 'dingtalk-main',
    });

    expect(calls[1]?.url).toBe('http://daemon/session/s-1/resume');
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      cwd: '/work/a',
      sourceType: 'channel',
      sourceId: 'dingtalk-main',
    });
  });

  it('omits source metadata before resuming against an old daemon', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/capabilities')) {
        return jsonResponse(200, { features: [] });
      }
      if (req.url.endsWith('/session/s-1/resume')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await DaemonSessionClient.resume(client, 's-1', {
      workspaceCwd: '/work/a',
      sourceType: 'channel',
      sourceId: 'dingtalk-main',
    });

    expect(calls.map((c) => c.url)).toEqual([
      'http://daemon/capabilities',
      'http://daemon/session/s-1/resume',
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      cwd: '/work/a',
    });
  });

  it('rejects source metadata resume when capability lookup fails', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/capabilities')) {
        return jsonResponse(500, { error: 'capability probe failed' });
      }
      if (req.url.endsWith('/session/s-1/resume')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(
      DaemonSessionClient.resume(client, 's-1', {
        workspaceCwd: '/work/a',
        sourceType: 'channel',
        sourceId: 'dingtalk-main',
      }),
    ).rejects.toThrow('capability probe failed');

    expect(calls.map((c) => c.url)).toEqual(['http://daemon/capabilities']);
  });

  it('replays attach-time model switch events on first subscription', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
      modelServiceId: 'qwen-prod',
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(new URL(calls[1]!.url).pathname).toBe('/session/s-1/events');
    expect(calls[1]?.headers['last-event-id']).toBe('0');
  });

  it('replays attach-time approval mode events on first subscription', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
      approvalMode: 'yolo',
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(new URL(calls[1]!.url).pathname).toBe('/session/s-1/events');
    expect(calls[1]?.headers['last-event-id']).toBe('0');
  });

  it('loads an existing daemon session using server watermark and replay snapshot', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
          clientId: 'client-1',
          state: { configOptions: [] },
          hasActivePrompt: true,
          lastEventId: 42,
          eventEpoch: 'epoch-42',
          compactedReplay: [{ id: 1, v: 1, type: 'session_update', data: {} }],
          liveJournal: [{ id: 42, v: 1, type: 'session_update', data: {} }],
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1', {
      workspaceCwd: '/work/a',
    });

    expect(session.sessionId).toBe('s-1');
    expect(session.clientId).toBe('client-1');
    expect(session.hasActivePrompt).toBe(true);
    expect(session.state).toEqual({ configOptions: [] });
    expect(session.eventEpoch).toBe('epoch-42');
    expect(session.replaySnapshotComplete).toBe(true);
    expect(session.replayPartial).toBe(false);
    expect(session.replayError).toBeUndefined();
    expect(session.replaySnapshot.compactedReplay).toHaveLength(1);
    expect(session.replaySnapshot.liveJournal).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ cwd: '/work/a' });

    for await (const _event of session.events()) {
      /* empty */
    }
    expect(calls[1]?.headers['last-event-id']).toBe('42');
  });

  it('releases the replay snapshot once consumed', async () => {
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
          lastEventId: 7,
          compactedReplay: [{ id: 1, v: 1, type: 'session_update', data: {} }],
          liveJournal: [{ id: 7, v: 1, type: 'session_update', data: {} }],
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1');
    expect(session.replaySnapshot.compactedReplay).toHaveLength(1);
    expect(session.replaySnapshot.liveJournal).toHaveLength(1);

    const consumed = session.consumeReplaySnapshot();
    expect(consumed.compactedReplay).toHaveLength(1);
    expect(consumed.liveJournal).toHaveLength(1);
    expect(session.replaySnapshot.compactedReplay).toHaveLength(0);
    expect(session.replaySnapshot.liveJournal).toHaveLength(0);
    // Idempotent: a second consume returns the empty snapshot.
    expect(session.consumeReplaySnapshot().compactedReplay).toHaveLength(0);
  });

  it('hydrates replay images but leaves file attachments lazy', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
          clientId: 'client-1',
          compactedReplay: [
            {
              id: 1,
              v: 1,
              type: 'session_update',
              data: {
                update: {
                  sessionUpdate: 'user_message_chunk',
                  content: {
                    type: 'image',
                    attachmentId: 'media-1',
                    mimeType: 'image/png',
                    size: 3,
                  },
                },
              },
            },
            {
              id: 2,
              v: 1,
              type: 'session_update',
              data: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'image',
                  attachmentId: 'media-1',
                  mimeType: 'image/png',
                  size: 3,
                },
              },
            },
            {
              id: 3,
              v: 1,
              type: 'session_update',
              data: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'resource',
                  attachmentId: 'notes.json',
                  mimeType: 'application/json',
                  size: 6,
                },
              },
            },
            {
              id: 4,
              v: 1,
              type: 'session_update',
              data: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'resource',
                  attachmentId: 'report.pdf',
                  mimeType: 'application/pdf',
                  size: 3,
                },
              },
            },
          ],
        });
      }
      if (req.url.endsWith('/session/s-1/attachments/media-1')) {
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      if (req.url.endsWith('/session/s-1/attachments/notes.json')) {
        return new Response(new TextEncoder().encode('你好'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (req.url.endsWith('/session/s-1/attachments/report.pdf')) {
        return new Response(Uint8Array.from([0, 255, 1]), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
      if (req.url.endsWith('/session/s-1/transcript')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          hasMore: false,
          events: [
            {
              v: 1,
              type: 'session_update',
              data: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'image',
                  attachmentId: 'media-1',
                  mimeType: 'image/png',
                  size: 3,
                },
              },
            },
          ],
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1');

    expect(session.replaySnapshot.compactedReplay[0]?.data).toEqual({
      update: {
        sessionUpdate: 'user_message_chunk',
        content: {
          type: 'image',
          data: 'AQID',
          mimeType: 'image/png',
          attachmentId: 'media-1',
        },
      },
    });
    expect(session.replaySnapshot.compactedReplay[1]?.data).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'image',
        data: 'AQID',
        mimeType: 'image/png',
        attachmentId: 'media-1',
      },
    });
    expect(session.replaySnapshot.compactedReplay[2]?.data).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'resource',
        attachmentId: 'notes.json',
        mimeType: 'application/json',
        size: 6,
      },
    });
    expect(session.replaySnapshot.compactedReplay[3]?.data).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'resource',
        attachmentId: 'report.pdf',
        mimeType: 'application/pdf',
        size: 3,
      },
    });
    const page = await session.getTranscriptPage();
    expect(page.events[0]?.data).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'image',
        data: 'AQID',
        mimeType: 'image/png',
        attachmentId: 'media-1',
      },
    });
    expect(
      calls.find((call) => call.url.endsWith('/attachments/media-1'))?.headers[
        'x-qwen-client-id'
      ],
    ).toBe('client-1');
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/media-1')),
    ).toHaveLength(1);

    const reloaded = await DaemonSessionClient.load(client, 's-1');
    expect(reloaded.replaySnapshot.compactedReplay[0]?.data).toMatchObject({
      update: { content: { attachmentId: 'media-1' } },
    });
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/media-1')),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/notes.json')),
    ).toHaveLength(0);
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/report.pdf')),
    ).toHaveLength(0);
  });

  it('keeps a visible placeholder when replay media is unavailable', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
          clientId: 'client-1',
          compactedReplay: [
            {
              id: 1,
              v: 1,
              type: 'session_update',
              data: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'image',
                  attachmentId: 'missing-media',
                  mimeType: 'image/png',
                  size: 3,
                },
              },
            },
          ],
        });
      }
      if (req.url.endsWith('/session/s-1/attachments/missing-media')) {
        return jsonResponse(410, { error: 'gone' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1');

    expect(session.replaySnapshot.compactedReplay[0]?.data).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'text',
        text: '[Attachment is no longer available]',
      },
    });
    const hydrateBlock = (
      session as unknown as {
        hydrateBlock(block: unknown): Promise<unknown>;
      }
    ).hydrateBlock.bind(session);
    await hydrateBlock({
      type: 'image',
      attachmentId: 'missing-media',
      mimeType: 'image/png',
      size: 3,
    });
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/missing-media')),
    ).toHaveLength(2);
  });

  it('keeps replay attachment references retryable after a transient media failure', async () => {
    let mediaRequests = 0;
    const reference = {
      type: 'image',
      attachmentId: 'flaky-media',
      mimeType: 'image/png',
      size: 3,
    };
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
          clientId: 'client-1',
          compactedReplay: [
            {
              id: 1,
              v: 1,
              type: 'session_update',
              data: {
                update: {
                  sessionUpdate: 'user_message_chunk',
                  content: reference,
                },
              },
            },
            {
              id: 2,
              v: 1,
              type: 'mid_turn_message_injected',
              data: {
                sessionId: 's-1',
                messages: [''],
                items: [{ content: [reference] }],
              },
            },
          ],
        });
      }
      if (req.url.endsWith('/session/s-1/attachments/flaky-media')) {
        mediaRequests += 1;
        if (mediaRequests === 1) {
          return jsonResponse(500, { error: 'boom' });
        }
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      if (req.url.endsWith('/session/s-1/transcript')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          hasMore: false,
          events: [
            {
              v: 1,
              type: 'session_update',
              data: {
                sessionUpdate: 'user_message_chunk',
                content: reference,
              },
            },
          ],
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1');

    // A transient failure must keep the reference (and its attachmentId) in the
    // snapshot so a later hydration pass can retry instead of pinning the
    // permanent placeholder for the client's lifetime.
    expect(session.replaySnapshot.compactedReplay[0]?.data).toEqual({
      update: { sessionUpdate: 'user_message_chunk', content: reference },
    });
    expect(session.replaySnapshot.compactedReplay[1]?.data).toMatchObject({
      items: [{ content: [reference] }],
    });
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/flaky-media')),
    ).toHaveLength(1);

    const page = await session.getTranscriptPage();
    expect(page.events[0]?.data).toEqual({
      sessionUpdate: 'user_message_chunk',
      content: {
        type: 'image',
        data: 'AQID',
        mimeType: 'image/png',
        attachmentId: 'flaky-media',
      },
    });
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/flaky-media')),
    ).toHaveLength(2);
  });

  it('evicts least-recently-used media when the cache byte cap is exceeded', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.includes('/session/s-1/attachments/')) {
        return new Response(Uint8Array.from([1]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const session = new DaemonSessionClient({
      client: new DaemonClient({ baseUrl: 'http://daemon', fetch }),
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });
    const hydrateBlock = (
      session as unknown as {
        hydrateBlock(block: unknown): Promise<unknown>;
      }
    ).hydrateBlock.bind(session);

    for (let index = 0; index < 4; index += 1) {
      await hydrateBlock({
        type: 'image',
        attachmentId: `media-${index}`,
        mimeType: 'image/png',
        size: 8 * 1024 * 1024,
      });
    }
    await hydrateBlock({
      type: 'image',
      attachmentId: 'media-0',
      mimeType: 'image/png',
      size: 8 * 1024 * 1024,
    });
    await hydrateBlock({
      type: 'image',
      attachmentId: 'media-4',
      mimeType: 'image/png',
      size: 8 * 1024 * 1024,
    });
    await hydrateBlock({
      type: 'image',
      attachmentId: 'media-1',
      mimeType: 'image/png',
      size: 8 * 1024 * 1024,
    });

    expect(
      calls.filter((call) => call.url.endsWith('/attachments/media-0')),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.url.endsWith('/attachments/media-1')),
    ).toHaveLength(2);
  });

  it('uploads session attachment through the authenticated session route', async () => {
    const reference = {
      type: 'image' as const,
      attachmentId: 'media-1',
      mimeType: 'image/png',
      size: 3,
    };
    const { fetch, calls } = recordingFetch((req) =>
      req.method === 'POST'
        ? jsonResponse(201, reference)
        : jsonResponse(500, { error: `unexpected ${req.url}` }),
    );
    const session = new DaemonSessionClient({
      client: new DaemonClient({ baseUrl: 'http://daemon', fetch }),
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(
      session.uploadAttachment(
        new Blob([Uint8Array.of(1, 2, 3)]),
        'image 你好.png',
        'image/png',
      ),
    ).resolves.toEqual(reference);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'content-type': 'image/png',
        'x-qwen-client-id': 'client-1',
      }),
    });
    expect(calls[0]?.headers).not.toHaveProperty('x-qwen-attachment-name');
    expect(calls[0]?.url).toBe(
      'http://daemon/session/s-1/attachments?name=image%20%E4%BD%A0%E5%A5%BD.png',
    );
  });

  it('removes session attachment through the authenticated session route', async () => {
    const { fetch, calls } = recordingFetch((req) =>
      req.method === 'DELETE'
        ? jsonResponse(200, { removed: true })
        : jsonResponse(500, { error: `unexpected ${req.url}` }),
    );
    const session = new DaemonSessionClient({
      client: new DaemonClient({ baseUrl: 'http://daemon', fetch }),
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(session.removeAttachment('media-1')).resolves.toBe(true);
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      headers: expect.objectContaining({ 'x-qwen-client-id': 'client-1' }),
    });
    expect(calls[0]?.url).toContain('/session/s-1/attachments/media-1');
  });

  it('evicts a hydrated image after its attachment is removed', async () => {
    let removed = false;
    const { fetch, calls } = recordingFetch((req) => {
      if (req.method === 'DELETE') {
        removed = true;
        return jsonResponse(200, { removed: true });
      }
      if (req.method === 'GET' && !removed) {
        return new Response(Uint8Array.of(1, 2, 3), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return jsonResponse(404, { error: 'not found' });
    });
    const session = new DaemonSessionClient({
      client: new DaemonClient({ baseUrl: 'http://daemon', fetch }),
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });
    const hydrateBlock = (
      session as unknown as {
        hydrateBlock(block: unknown): Promise<unknown>;
      }
    ).hydrateBlock.bind(session);
    const reference = {
      type: 'image',
      attachmentId: 'media-1',
      mimeType: 'image/png',
      size: 3,
    };

    await expect(hydrateBlock(reference)).resolves.toMatchObject({
      type: 'image',
      data: 'AQID',
    });
    await expect(session.removeAttachment('media-1')).resolves.toBe(true);
    await expect(hydrateBlock(reference)).resolves.toEqual({
      type: 'text',
      text: '[Attachment is no longer available]',
    });
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('reads session attachments through the authenticated media route', async () => {
    const { fetch, calls } = recordingFetch((req) =>
      req.method === 'GET'
        ? new Response('hello', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          })
        : jsonResponse(500, { error: `unexpected ${req.url}` }),
    );
    const session = new DaemonSessionClient({
      client: new DaemonClient({ baseUrl: 'http://daemon', fetch }),
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(session.readAttachment('attachment-1')).resolves.toEqual({
      data: 'aGVsbG8=',
      mimeType: 'text/plain',
    });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({ 'x-qwen-client-id': 'client-1' }),
    });
    expect(calls[0]?.url).toContain('/session/s-1/attachments/attachment-1');
  });

  it('loads restored prompt activity from hasActivePrompt responses', async () => {
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
          hasActivePrompt: true,
          compactedReplay: [],
          liveJournal: [],
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1', {
      workspaceCwd: '/work/a',
    });

    expect(session.hasActivePrompt).toBe(true);
    // Absent on the response → defaults to a trustworthy snapshot.
    expect(session.replayDegraded).toBe(false);
  });

  it('surfaces replayDegraded from the load response', async () => {
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
          compactedReplay: [],
          liveJournal: [],
          replayDegraded: true,
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1', {
      workspaceCwd: '/work/a',
    });

    expect(session.replayDegraded).toBe(true);
  });

  it('reports incomplete and partial load replay snapshots', async () => {
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
          compactedReplay: [],
          partial: true,
          replayError: 'journal read failed',
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1');

    expect(session.replaySnapshotComplete).toBe(false);
    expect(session.replayPartial).toBe(true);
    expect(session.replayError).toBe('journal read failed');
  });

  it('resumes an existing daemon session using server watermark', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: { modes: null },
          hasActivePrompt: true,
          lastEventId: 99,
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.resume(client, 's-1');

    expect(session.attached).toBe(true);
    expect(session.clientId).toBe('client-1');
    expect(session.hasActivePrompt).toBe(true);
    expect(session.state).toEqual({ modes: null });
    expect(session.replaySnapshot.compactedReplay).toHaveLength(0);
    expect(session.replaySnapshot.liveJournal).toHaveLength(0);
    expect(session.replaySnapshotComplete).toBe(false);
    for await (const _event of session.events()) {
      /* empty */
    }
    expect(calls[1]?.headers['last-event-id']).toBe('99');
  });

  it('replays from id 0 on freshly-created sessions so startup-window guardrail events are observable (codex review fix #1)', async () => {
    // Codex review round 2, finding #1: PR 14b's
    // `mcp_budget_warning` / `mcp_child_refused_batch` events fire
    // during the child's `newSession` handler and are buffered on
    // `BridgeClient.earlyEvents` until `byId.set(sessionId, entry)`
    // runs. The bridge drains them onto the per-session bus before
    // `spawnOrAttach` returns, so they live in the replay ring with
    // ids — but the SDK's old default of `lastEventId: undefined`
    // started subscriptions live, so consumers never observed them.
    //
    // Fix: when `session.attached === false` (newly-created), seed
    // `Last-Event-ID: 0` to replay the startup-window events. The
    // existing `modelServiceId` carve-out still triggers seed for
    // re-attached sessions where attach-time switch events need to
    // replay.
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
      // No `modelServiceId` — the only signal that triggered seed
      // pre-fix. With the fix, `attached: false` alone is enough.
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(session.attached).toBe(false);
    expect(new URL(calls[1]!.url).pathname).toBe('/session/s-1/events');
    expect(calls[1]?.headers['last-event-id']).toBe('0');
  });

  it('starts live when createOrAttach has no model service replay need', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.createOrAttach(client, {
      workspaceCwd: '/work/a',
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(session.lastEventId).toBeUndefined();
    expect(new URL(calls[1]!.url).pathname).toBe('/session/s-1/events');
    expect(calls[1]?.headers['last-event-id']).toBeUndefined();
  });

  it('forwards heartbeat through DaemonClient with the bound clientId', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, {
        sessionId: 's-1',
        clientId: 'client-1',
        lastSeenAt: 1_700_000_000_002,
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });
    const result = await session.heartbeat();
    expect(result).toEqual({
      sessionId: 's-1',
      clientId: 'client-1',
      lastSeenAt: 1_700_000_000_002,
    });
    expect(calls[0]?.url).toBe('http://daemon/session/s-1/heartbeat');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
  });

  it('forwards artifact helpers through DaemonClient with the bound clientId', async () => {
    const listEnvelope = {
      v: 1 as const,
      sessionId: 's-1',
      artifacts: [],
      generatedAt: '2026-07-01T00:00:00.000Z',
      limits: { maxArtifacts: 200 },
    };
    const mutationResult = {
      v: 1 as const,
      sessionId: 's-1',
      changes: [],
    };
    const { fetch, calls } = recordingFetch((req) => {
      if (
        req.method === 'GET' &&
        req.url === 'http://daemon/session/s-1/artifacts'
      ) {
        return jsonResponse(200, listEnvelope);
      }
      if (
        req.method === 'POST' &&
        req.url === 'http://daemon/session/s-1/artifacts'
      ) {
        return jsonResponse(200, mutationResult);
      }
      if (
        req.method === 'DELETE' &&
        req.url === 'http://daemon/session/s-1/artifacts/artifact-1'
      ) {
        return jsonResponse(200, mutationResult);
      }
      return jsonResponse(500, {
        error: `unexpected ${req.method} ${req.url}`,
      });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(session.artifacts()).resolves.toEqual(listEnvelope);
    await expect(
      session.addArtifact({
        title: 'Client report',
        url: 'https://example.com/report',
      }),
    ).resolves.toEqual(mutationResult);
    await expect(session.removeArtifact('artifact-1')).resolves.toEqual(
      mutationResult,
    );

    expect(calls.map((call) => call.headers['x-qwen-client-id'])).toEqual([
      'client-1',
      'client-1',
      'client-1',
    ]);
    expect(calls[1]?.body).toBe(
      JSON.stringify({
        title: 'Client report',
        url: 'https://example.com/report',
      }),
    );
  });

  it('forwards recap through DaemonClient with the bound clientId and signal', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, {
        sessionId: 's-1',
        recap: 'Refactoring the auth flow. Next: run the integration tests.',
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });
    const ctrl = new AbortController();
    const result = await session.recap({ signal: ctrl.signal });
    expect(result).toEqual({
      sessionId: 's-1',
      recap: 'Refactoring the auth flow. Next: run the integration tests.',
    });
    expect(calls[0]?.url).toBe('http://daemon/session/s-1/recap');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    expect(calls[0]?.signal).toBe(ctrl.signal);
  });

  it('forwards generation through DaemonClient with the bound clientId', async () => {
    const { fetch, calls } = recordingFetch(() =>
      sseResponse(
        'event: done\ndata: {"v":1,"type":"done","requestId":"r-1","model":"fast","modelSource":"fast","inputTokens":4,"outputTokens":2}\n\n',
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    const events = [];
    for await (const event of session.generateContent('Translate this')) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://daemon/session/s-1/generate');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
  });

  it('forwards pending prompt list requests with encoded session id and clientId', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, {
        pendingPrompts: [
          {
            promptId: 'prompt-1',
            text: 'hello',
            state: 'queued',
            queuedAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 'session with/slash',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(session.getPendingPrompts()).resolves.toEqual({
      pendingPrompts: [
        {
          promptId: 'prompt-1',
          text: 'hello',
          state: 'queued',
          queuedAt: 1_700_000_000_000,
        },
      ],
    });
    expect(calls[0]?.url).toBe(
      'http://daemon/session/session%20with%2Fslash/pending-prompts',
    );
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
  });

  it('hydrates attachment references in pending and mid-turn snapshots', async () => {
    const reference = {
      type: 'image' as const,
      attachmentId: 'media-1',
      mimeType: 'image/png',
      size: 3,
    };
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/pending-prompts')) {
        return jsonResponse(200, {
          pendingPrompts: [
            {
              promptId: 'prompt-1',
              text: 'look',
              state: 'queued',
              queuedAt: 1,
              content: [reference],
            },
          ],
        });
      }
      if (req.url.endsWith('/mid-turn-messages')) {
        return jsonResponse(200, {
          messages: [
            { messageId: 'mid-1', text: 'look', content: [reference] },
          ],
          settledMessageIds: [],
          promotedMessageIds: [],
        });
      }
      if (requestPathEndsWith(req, '/events')) {
        return sseResponse(
          `id: 1\nevent: mid_turn_message_injected\ndata: ${JSON.stringify({
            id: 1,
            v: 1,
            type: 'mid_turn_message_injected',
            data: {
              sessionId: 's-1',
              messages: ['look'],
              messageIds: ['mid-1'],
              items: [{ content: [reference] }],
            },
          })}\n\n`,
        );
      }
      if (req.url.endsWith('/attachments/media-1')) {
        return new Response(Uint8Array.of(1, 2, 3), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const session = new DaemonSessionClient({
      client: new DaemonClient({ baseUrl: 'http://daemon', fetch }),
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });
    const image = { type: 'image', data: 'AQID', mimeType: 'image/png' };

    await expect(session.getPendingPrompts()).resolves.toMatchObject({
      pendingPrompts: [{ content: [image] }],
    });
    await expect(session.getMidTurnMessages()).resolves.toMatchObject({
      messages: [{ content: [image] }],
    });
    const events = [];
    for await (const event of session.events()) events.push(event);
    expect(events).toMatchObject([
      {
        type: 'mid_turn_message_injected',
        data: { items: [{ content: [image] }] },
      },
    ]);
  });

  it('forwards pending prompt removals with encoded ids and clientId', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, { removed: false }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 'session with/slash',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(
      session.removePendingPrompt('prompt with/slash'),
    ).resolves.toEqual({ removed: false });
    expect(calls[0]?.url).toBe(
      'http://daemon/session/session%20with%2Fslash/pending-prompts/prompt%20with%2Fslash',
    );
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
  });

  it('forwards stable mid-turn ids and the session clientId', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, { accepted: true, messageId: 'stable-1' }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 'session with/slash',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(
      session.enqueueMidTurnMessage('shared message', {
        messageId: 'stable-1',
      }),
    ).resolves.toEqual({ accepted: true, messageId: 'stable-1' });
    expect(calls[0]?.url).toBe(
      'http://daemon/session/session%20with%2Fslash/mid-turn-message',
    );
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      message: 'shared message',
      messageId: 'stable-1',
    });
  });

  it('forwards the mid-turn snapshot query with session and client ids', async () => {
    const snapshot = {
      messages: [{ messageId: 'mid-1', text: 'shared message' }],
      settledMessageIds: ['mid-2'],
      promotedMessageIds: ['mid-3'],
    };
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, snapshot));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 'session with/slash',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(session.getMidTurnMessages()).resolves.toEqual(snapshot);
    expect(calls[0]?.url).toBe(
      'http://daemon/session/session%20with%2Fslash/mid-turn-messages',
    );
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
  });

  it('forwards mid-turn message removals with encoded ids and clientId', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(200, { removed: true }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 'session with/slash',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    await expect(
      session.removeMidTurnMessage('message with/slash'),
    ).resolves.toEqual({ removed: true });
    expect(calls[0]?.url).toBe(
      'http://daemon/session/session%20with%2Fslash/mid-turn-messages/message%20with%2Fslash',
    );
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.headers['x-qwen-client-id']).toBe('client-1');
  });

  it('maps pending prompt HTTP failures through DaemonClient errors', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(404, { error: 'not found' }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    await expect(session.getPendingPrompts()).rejects.toMatchObject({
      status: 404,
    });
    await expect(session.removePendingPrompt('p-1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('forwards session-scoped operations through DaemonClient', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(200, { stopReason: 'end_turn' });
      }
      if (req.url.endsWith('/session/s-1/model')) {
        return jsonResponse(200, { modelId: 'qwen3-coder' });
      }
      if (req.url.endsWith('/session/s-1/config-option')) {
        return jsonResponse(200, { configOptions: [], persisted: true });
      }
      if (req.url.endsWith('/session/s-1/context')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          state: { models: { currentModelId: 'qwen3-coder' } },
        });
      }
      if (req.url.endsWith('/session/s-1/supported-commands')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          availableCommands: [
            {
              name: 'init',
              description: 'Initialize',
              input: null,
            },
          ],
          availableSkills: ['review'],
        });
      }
      if (
        req.url.endsWith('/session/s-1/tasks') ||
        req.url.endsWith('/session/s-1/tasks?includeWorkflows=true')
      ) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          now: 1_700_000_000_000,
          tasks: [],
        });
      }
      if (req.url.endsWith('/session/s-1/lsp')) {
        return jsonResponse(200, {
          v: 1,
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          enabled: false,
          configuredServers: 0,
          readyServers: 0,
          failedServers: 0,
          inProgressServers: 0,
          notStartedServers: 0,
          servers: [],
        });
      }
      if (req.url.endsWith('/session/s-1/cancel')) {
        return new Response(null, { status: 204 });
      }
      if (req.url.endsWith('/permission/req-1')) {
        return jsonResponse(200, {});
      }
      if (req.url.endsWith('/session/s-1/permission/req-2')) {
        return jsonResponse(200, {});
      }
      if (req.method === 'DELETE' && req.url.endsWith('/session/s-1')) {
        return new Response(null, { status: 204 });
      }
      if (req.url.endsWith('/session/s-1/metadata')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          displayName: 'My Session',
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    const controller = new AbortController();
    await expect(
      session.prompt(
        { prompt: [{ type: 'text', text: 'hi' }] },
        controller.signal,
      ),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(session.setModel('qwen3-coder')).resolves.toEqual({
      modelId: 'qwen3-coder',
    });
    await expect(
      session.setConfigOption('reasoning_effort', 'medium', { persist: true }),
    ).resolves.toEqual({ configOptions: [], persisted: true });
    await expect(session.context()).resolves.toEqual({
      v: 1,
      sessionId: 's-1',
      workspaceCwd: '/work/a',
      state: { models: { currentModelId: 'qwen3-coder' } },
    });
    await expect(session.supportedCommands()).resolves.toEqual({
      v: 1,
      sessionId: 's-1',
      availableCommands: [
        {
          name: 'init',
          description: 'Initialize',
          input: null,
        },
      ],
      availableSkills: ['review'],
    });
    await expect(session.tasks()).resolves.toEqual({
      v: 1,
      sessionId: 's-1',
      now: 1_700_000_000_000,
      tasks: [],
    });
    await expect(session.workflowTasks()).resolves.toEqual({
      v: 1,
      sessionId: 's-1',
      now: 1_700_000_000_000,
      tasks: [],
    });
    await expect(session.lspStatus()).resolves.toEqual({
      v: 1,
      sessionId: 's-1',
      workspaceCwd: '/work/a',
      enabled: false,
      configuredServers: 0,
      readyServers: 0,
      failedServers: 0,
      inProgressServers: 0,
      notStartedServers: 0,
      servers: [],
    });
    await expect(session.cancel()).resolves.toBeUndefined();
    await expect(
      session.respondToPermission('req-1', {
        outcome: { outcome: 'selected', optionId: 'allow' },
      }),
    ).resolves.toBe(true);
    await expect(
      session.respondToSessionPermission('req-2', {
        outcome: { outcome: 'cancelled' },
      }),
    ).resolves.toBe(true);
    await expect(
      session.updateMetadata({ displayName: 'My Session' }),
    ).resolves.toEqual({ displayName: 'My Session' });
    await expect(session.close()).resolves.toBeUndefined();

    expect(calls.map((c) => c.url)).toEqual([
      'http://daemon/session/s-1/prompt',
      'http://daemon/session/s-1/model',
      'http://daemon/session/s-1/config-option',
      'http://daemon/session/s-1/context',
      'http://daemon/session/s-1/supported-commands',
      'http://daemon/session/s-1/tasks',
      'http://daemon/session/s-1/tasks?includeWorkflows=true',
      'http://daemon/session/s-1/lsp',
      'http://daemon/session/s-1/cancel',
      'http://daemon/permission/req-1',
      'http://daemon/session/s-1/permission/req-2',
      'http://daemon/session/s-1/metadata',
      'http://daemon/session/s-1',
    ]);
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(JSON.parse(calls[2]!.body!)).toEqual({
      configId: 'reasoning_effort',
      value: 'medium',
      persist: true,
    });
    expect(calls.map((c) => c.headers['x-qwen-client-id'])).toEqual([
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
      'client-1',
    ]);
  });

  it('rejects locally in subscription mode when pending prompts reach the cap', async () => {
    let eventsController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const encoder = new TextEncoder();
    const { fetch, calls } = recordingFetch((req) => {
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return pendingSseResponse(
          () => {},
          (controller) => {
            eventsController = controller;
          },
        );
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(202, { promptId: 'p-1', lastEventId: 0 });
      }
      if (req.url.endsWith('/session/s-1/cancel')) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
      maxPendingPromptsPerSession: 1,
    });
    const eventsAbort = new AbortController();
    const eventPump = (async () => {
      for await (const _event of session.events({
        signal: eventsAbort.signal,
      })) {
        /* keep subscription active */
      }
    })().catch(() => {});

    await vi.waitFor(() => {
      expect(
        calls.filter((c) => requestPathEndsWith(c, '/events')),
      ).toHaveLength(1);
    });
    const first = session
      .prompt({ prompt: [{ type: 'text', text: 'first' }] })
      .catch((err: unknown) => err);
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(1);
    });
    await waitForPendingPrompt(session, 'p-1');

    const secondCtrl = new AbortController();
    const second = session
      .prompt({ prompt: [{ type: 'text', text: 'second' }] }, secondCtrl.signal)
      .catch((err: unknown) => err);
    try {
      const secondResult = await Promise.race<unknown>([
        second,
        new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
      ]);
      expect(secondResult).toBeInstanceOf(DaemonPendingPromptLimitError);
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(1);
    } finally {
      eventsController?.enqueue(encoder.encode(turnCompleteFrame('p-1')));
      eventsController?.close();
      secondCtrl.abort();
      eventsAbort.abort();
      await first;
      await second;
      await eventPump;
    }
  });

  it('coalesces a prompt abort with an explicit session cancel', async () => {
    let eventsController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let resolveCancel!: (response: Response) => void;
    const cancelResponse = new Promise<Response>((resolve) => {
      resolveCancel = resolve;
    });
    const { fetch, calls } = recordingFetch((req) => {
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return pendingSseResponse(
          () => {},
          (controller) => {
            eventsController = controller;
          },
        );
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(202, { promptId: 'p-1', lastEventId: 0 });
      }
      if (req.url.endsWith('/session/s-1/cancel')) {
        return cancelResponse;
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });
    const eventsAbort = new AbortController();
    const eventPump = (async () => {
      for await (const _event of session.events({
        signal: eventsAbort.signal,
      })) {
        /* keep subscription active */
      }
    })().catch(() => {});

    await vi.waitFor(() => {
      expect(
        calls.filter((call) => requestPathEndsWith(call, '/events')),
      ).toHaveLength(1);
    });
    const promptAbort = new AbortController();
    const prompt = session
      .prompt(
        { prompt: [{ type: 'text', text: 'cancel me' }] },
        promptAbort.signal,
      )
      .catch((error: unknown) => error);
    await waitForPendingPrompt(session, 'p-1');

    promptAbort.abort();
    const explicitCancel = session.cancel();
    await vi.waitFor(() => {
      expect(calls.filter((call) => call.url.endsWith('/cancel'))).toHaveLength(
        1,
      );
    });

    resolveCancel(new Response(null, { status: 204 }));
    await explicitCancel;
    await prompt;
    eventsController?.close();
    eventsAbort.abort();
    await eventPump;
  });

  it('releases a subscription prompt slot after a non-202 result', async () => {
    let eventsController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const eventsAbort = new AbortController();
    const { fetch, calls } = recordingFetch((req) => {
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return pendingSseResponse(
          () => {},
          (controller) => {
            eventsController = controller;
          },
        );
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(200, { stopReason: 'end_turn' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
      maxPendingPromptsPerSession: 1,
    });
    const eventPump = (async () => {
      for await (const _event of session.events({
        signal: eventsAbort.signal,
      })) {
        /* keep subscription active */
      }
    })().catch(() => {});

    await vi.waitFor(() => {
      expect(
        calls.filter((c) => requestPathEndsWith(c, '/events')),
      ).toHaveLength(1);
    });
    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'first' }] }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'second' }] }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(2);

    eventsController?.close();
    eventsAbort.abort();
    await eventPump;
  });

  it.each([[null], [0], [Infinity]])(
    'disables the subscription prompt cap for %s',
    async (maxPendingPromptsPerSession) => {
      let eventsController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;
      let nextPromptId = 0;
      const encoder = new TextEncoder();
      const { fetch, calls } = recordingFetch((req) => {
        if (requestPathEndsWith(req, '/session/s-1/events')) {
          return pendingSseResponse(
            () => {},
            (controller) => {
              eventsController = controller;
            },
          );
        }
        if (req.url.endsWith('/session/s-1/prompt')) {
          nextPromptId += 1;
          return jsonResponse(202, {
            promptId: `p-${nextPromptId}`,
            lastEventId: 0,
          });
        }
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      });
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const session = new DaemonSessionClient({
        client,
        session: {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
        },
        maxPendingPromptsPerSession,
      });
      const eventsAbort = new AbortController();
      const eventPump = (async () => {
        for await (const _event of session.events({
          signal: eventsAbort.signal,
        })) {
          /* keep subscription active */
        }
      })().catch(() => {});

      await vi.waitFor(() => {
        expect(
          calls.filter((c) => requestPathEndsWith(c, '/events')),
        ).toHaveLength(1);
      });
      const first = session.prompt({
        prompt: [{ type: 'text', text: 'first' }],
      });
      const second = session.prompt({
        prompt: [{ type: 'text', text: 'second' }],
      });
      await vi.waitFor(() => {
        expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(2);
      });
      await waitForPendingPrompt(session, 'p-1');
      await waitForPendingPrompt(session, 'p-2');
      eventsController!.enqueue(
        encoder.encode(turnCompleteFrame('p-1') + turnCompleteFrame('p-2')),
      );

      try {
        await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
        await expect(second).resolves.toEqual({ stopReason: 'end_turn' });
      } finally {
        eventsController?.close();
        eventsAbort.abort();
        await eventPump;
      }
    },
  );

  it('does not reserve a subscription prompt slot for a pre-aborted signal', async () => {
    let eventsController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const encoder = new TextEncoder();
    const { fetch, calls } = recordingFetch((req) => {
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              eventsController = controller;
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(202, { promptId: 'p-1', lastEventId: 0 });
      }
      if (req.url.endsWith('/session/s-1/cancel')) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
      maxPendingPromptsPerSession: 1,
    });
    const eventsAbort = new AbortController();
    const eventPump = (async () => {
      for await (const _event of session.events({
        signal: eventsAbort.signal,
      })) {
        /* keep subscription active */
      }
    })().catch(() => {});

    await vi.waitFor(() => {
      expect(
        calls.filter((c) => requestPathEndsWith(c, '/events')),
      ).toHaveLength(1);
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      session.prompt(
        { prompt: [{ type: 'text', text: 'pre-aborted' }] },
        aborted.signal,
      ),
    ).rejects.toThrow();
    expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(0);

    const active = session
      .prompt({ prompt: [{ type: 'text', text: 'active' }] })
      .catch((err: unknown) => err);
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(1);
    });
    await waitForPendingPrompt(session, 'p-1');
    eventsController!.enqueue(encoder.encode(turnCompleteFrame('p-1')));

    try {
      await expect(active).resolves.toEqual({ stopReason: 'end_turn' });
    } finally {
      eventsController?.close();
      eventsAbort.abort();
      await eventPump;
    }
  });

  it('rejects an accepted subscription prompt if the event stream has ended', async () => {
    let eventsController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    let resolvePrompt: ((response: Response) => void) | undefined;
    const promptResponse = new Promise<Response>((resolve) => {
      resolvePrompt = resolve;
    });
    const encoder = new TextEncoder();
    const { fetch, calls } = recordingFetch((req) => {
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              eventsController = controller;
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        return promptResponse;
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
      maxPendingPromptsPerSession: 1,
    });
    const eventPump = (async () => {
      for await (const _event of session.events()) {
        /* keep subscription active */
      }
    })().catch(() => {});

    await vi.waitFor(() => {
      expect(
        calls.filter((c) => requestPathEndsWith(c, '/events')),
      ).toHaveLength(1);
    });
    const prompt = session
      .prompt({ prompt: [{ type: 'text', text: 'late accept' }] })
      .catch((err: unknown) => err);
    await vi.waitFor(() => {
      expect(calls.filter((c) => c.url.endsWith('/prompt'))).toHaveLength(1);
    });
    eventsController!.close();
    await eventPump;
    resolvePrompt!(jsonResponse(202, { promptId: 'p-1', lastEventId: 0 }));

    const result = await Promise.race<unknown>([
      prompt,
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('SSE stream ended');
    expect(pendingPromptIds(session)).toEqual([]);
  });

  it('submits prompts without waiting for turn completion', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(202, { promptId: 'p-1', lastEventId: 9 });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    await expect(
      session.submitPrompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toEqual({ promptId: 'p-1', lastEventId: 9 });
    expect(calls.map((call) => call.url)).toEqual([
      'http://daemon/session/s-1/prompt',
    ]);
  });

  it('surfaces permission races and session operation failures', async () => {
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/permission/missing-req')) {
        return jsonResponse(404, { error: 'unknown request' });
      }
      if (req.url.endsWith('/session/s-1/model')) {
        return jsonResponse(404, { error: 'unknown session' });
      }
      if (req.url.endsWith('/session/s-1/cancel')) {
        return jsonResponse(500, { error: 'cancel failed' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    await expect(
      session.respondToPermission('missing-req', {
        outcome: { outcome: 'cancelled' },
      }),
    ).resolves.toBe(false);
    await expect(session.setModel('qwen3-coder')).rejects.toMatchObject({
      status: 404,
    });
    await expect(session.cancel()).rejects.toMatchObject({ status: 500 });
  });

  it('tracks Last-Event-ID across event subscriptions', async () => {
    let eventCallCount = 0;
    const { fetch, calls } = recordingFetch((req) => {
      if (!requestPathEndsWith(req, '/session/s-1/events')) {
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      }
      eventCallCount++;
      if (eventCallCount === 1) {
        return sseResponse(
          'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n' +
            'id: 5\nevent: session_update\ndata: {"id":5,"v":1,"type":"session_update","data":"b"}\n\n',
        );
      }
      return sseResponse('');
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    const stream = session.events();
    const first = await stream.next();
    expect(first.value?.id).toBe(4);
    expect(session.lastEventId).toBeUndefined();

    const second = await stream.next();
    expect(second.value?.id).toBe(5);
    expect(session.lastEventId).toBe(4);

    await expect(stream.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(session.lastEventId).toBe(5);

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(calls[0]?.headers['last-event-id']).toBeUndefined();
    expect(calls[1]?.headers['last-event-id']).toBe('5');
  });

  it('tracks accepted REST stream state separately from adjacent lineage', async () => {
    const firstStreamId = '11111111-1111-4111-8111-111111111111';
    const callerAccepted = vi.fn();
    let eventCallCount = 0;
    const { fetch, calls } = recordingFetch((req) => {
      if (!requestPathEndsWith(req, '/session/s-1/events')) {
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      }
      eventCallCount += 1;
      const response = sseResponse('');
      if (eventCallCount === 1) {
        response.headers.set('x-qwen-sse-stream-id', firstStreamId);
      }
      return response;
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    for await (const _event of session.events({
      clientId: 'spoofed-client',
      previousSseStreamId: '22222222-2222-4222-8222-222222222222',
      onSseStreamAccepted: callerAccepted,
    } as unknown as DaemonSessionSubscribeOptions)) {
      /* empty */
    }
    for await (const _event of session.events()) {
      /* empty */
    }
    for await (const _event of session.events()) {
      /* empty */
    }

    const eventCalls = calls.filter((call) =>
      requestPathEndsWith(call, '/session/s-1/events'),
    );
    const firstUrl = new URL(eventCalls[0]!.url);
    const secondUrl = new URL(eventCalls[1]!.url);
    const thirdUrl = new URL(eventCalls[2]!.url);
    expect(eventCalls.map((call) => call.headers['x-qwen-client-id'])).toEqual([
      'client-1',
      'client-1',
      'client-1',
    ]);
    expect(firstUrl.searchParams.get('connectReason')).toBe('initial');
    expect(firstUrl.searchParams.has('previousStreamId')).toBe(false);
    expect(callerAccepted).not.toHaveBeenCalled();
    expect(secondUrl.searchParams.get('connectReason')).toBe('resume');
    expect(secondUrl.searchParams.get('previousStreamId')).toBe(firstStreamId);
    // The second handshake was accepted by an old daemon (no response id):
    // the next request remains a resume but must not claim stale lineage.
    expect(thirdUrl.searchParams.get('connectReason')).toBe('resume');
    expect(thirdUrl.searchParams.has('previousStreamId')).toBe(false);
  });

  it('forwards an explicit WebUI SSE connection reason', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse(''));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    for await (const _event of session.events({
      sseConnectReason: 'state_resync',
    })) {
      /* empty */
    }

    expect(new URL(calls[0]!.url).searchParams.get('connectReason')).toBe(
      'state_resync',
    );
  });

  it('clears accepted REST state across a switch to an ACP transport', async () => {
    let transportType: DaemonTransportType = 'rest';
    const subscribeCalls: DaemonTransportSubscribeOptions[] = [];
    const transport: DaemonTransport = {
      get type() {
        return transportType;
      },
      supportsReplay: true,
      connected: true,
      async fetch() {
        return jsonResponse(500, { error: 'unexpected fetch' });
      },
      async *subscribeEvents(_sessionId, opts) {
        subscribeCalls.push(opts);
        if (transportType === 'rest') {
          opts.onSseStreamAccepted?.('11111111-1111-4111-8111-111111111111');
        }
        yield* [];
      },
      dispose() {},
    };
    const client = new DaemonClient({ baseUrl: 'http://daemon', transport });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    for await (const _event of session.events()) {
      /* empty */
    }
    transportType = 'acp-http';
    for await (const _event of session.events()) {
      /* empty */
    }
    transportType = 'rest';
    for await (const _event of session.events()) {
      /* empty */
    }

    expect(subscribeCalls[0]?.sseConnectReason).toBe('initial');
    expect(subscribeCalls[1]?.sseConnectReason).toBe('initial');
    expect(subscribeCalls[1]?.previousSseStreamId).toBeUndefined();
    expect(subscribeCalls[1]?.onSseStreamAccepted).toBeTypeOf('function');
    expect(subscribeCalls[2]?.sseConnectReason).toBe('initial');
    expect(subscribeCalls[2]?.previousSseStreamId).toBeUndefined();
  });

  it('captures REST lineage when auto-reconnect falls back from ACP within one subscription', async () => {
    const firstStreamId = '11111111-1111-4111-8111-111111111111';
    const secondStreamId = '22222222-2222-4222-8222-222222222222';
    let restSubscriptions = 0;
    const { fetch, calls } = recordingFetch((req) => {
      if (!requestPathEndsWith(req, '/session/s-1/events')) {
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      }
      restSubscriptions += 1;
      const response = sseResponse('');
      response.headers.set(
        'x-qwen-sse-stream-id',
        restSubscriptions === 1 ? firstStreamId : secondStreamId,
      );
      return response;
    });
    const closedAcpTransport: DaemonTransport = {
      type: 'acp-http',
      supportsReplay: false,
      connected: false,
      async fetch() {
        throw new DaemonTransportClosedError();
      },
      async *subscribeEvents() {
        yield await Promise.reject(new DaemonTransportClosedError());
      },
      dispose() {},
    };
    const transport = new AutoReconnectTransport({
      baseUrl: 'http://daemon',
      fetch,
      preferredType: 'acp-http',
      initial: closedAcpTransport,
      factory: async () => {
        throw new Error('ACP reconnect unavailable');
      },
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', transport });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
    });

    for await (const _event of session.events()) {
      /* empty */
    }
    for await (const _event of session.events()) {
      /* empty */
    }

    expect(transport.type).toBe('rest');
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.headers['x-qwen-client-id'])).toEqual([
      'client-1',
      'client-1',
    ]);
    const firstUrl = new URL(calls[0]!.url);
    const secondUrl = new URL(calls[1]!.url);
    expect(firstUrl.searchParams.get('connectReason')).toBe('initial');
    expect(firstUrl.searchParams.has('previousStreamId')).toBe(false);
    expect(secondUrl.searchParams.get('connectReason')).toBe('resume');
    expect(secondUrl.searchParams.get('previousStreamId')).toBe(firstStreamId);
  });

  it('sends the load-seeded eventEpoch alongside the resume cursor (DAEMON-001)', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/load')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: false,
          clientId: 'client-1',
          state: {},
          lastEventId: 42,
          eventEpoch: 'epoch-load',
          compactedReplay: [],
          liveJournal: [],
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.load(client, 's-1', {
      workspaceCwd: '/work/a',
    });
    for await (const _event of session.events()) {
      /* empty */
    }

    expect(calls[1]?.headers['last-event-id']).toBe('42');
    expect(calls[1]?.headers['x-qwen-event-epoch']).toBe('epoch-load');
  });

  it('sends the resume-seeded eventEpoch alongside the resume cursor (DAEMON-001)', async () => {
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-1',
          state: {},
          lastEventId: 99,
          eventEpoch: 'epoch-resume',
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return sseResponse('');
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const session = await DaemonSessionClient.resume(client, 's-1');
    for await (const _event of session.events()) {
      /* empty */
    }

    expect(calls[1]?.headers['last-event-id']).toBe('99');
    expect(calls[1]?.headers['x-qwen-event-epoch']).toBe('epoch-resume');
  });

  it('learns the bus epoch from the response header and echoes it on reconnect (DAEMON-001)', async () => {
    let eventCallCount = 0;
    const { fetch, calls } = recordingFetch((req) => {
      if (!requestPathEndsWith(req, '/session/s-1/events')) {
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      }
      eventCallCount++;
      if (eventCallCount === 1) {
        // Old daemons never stamp `eventEpoch` on create responses, so the
        // first (live) subscription is the only place to learn the epoch.
        return sseResponseWithEpoch(
          'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n',
          'epoch-live',
        );
      }
      return sseResponse('');
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    for await (const _event of session.events()) {
      /* empty */
    }
    for await (const _event of session.events()) {
      /* empty */
    }

    // First subscription is live: no cursor, so no epoch header either.
    expect(calls[0]?.headers['last-event-id']).toBeUndefined();
    expect(calls[0]?.headers['x-qwen-event-epoch']).toBeUndefined();
    // Reconnect pairs the tracked cursor with the learned epoch.
    expect(calls[1]?.headers['last-event-id']).toBe('4');
    expect(calls[1]?.headers['x-qwen-event-epoch']).toBe('epoch-live');
  });

  it('a header-learned epoch supersedes the seeded one (DAEMON-001)', async () => {
    let eventCallCount = 0;
    const { fetch, calls } = recordingFetch((req) => {
      if (!requestPathEndsWith(req, '/session/s-1/events')) {
        return jsonResponse(500, { error: `unexpected ${req.url}` });
      }
      eventCallCount++;
      if (eventCallCount === 1) {
        return sseResponseWithEpoch(
          'id: 7\nevent: session_update\ndata: {"id":7,"v":1,"type":"session_update","data":"a"}\n\n',
          'epoch-new',
        );
      }
      return sseResponse('');
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
      lastEventId: 1,
      eventEpoch: 'epoch-old',
    });

    for await (const _event of session.events()) {
      /* empty */
    }
    for await (const _event of session.events()) {
      /* empty */
    }

    // First subscription echoes the seeded pair.
    expect(calls[0]?.headers['last-event-id']).toBe('1');
    expect(calls[0]?.headers['x-qwen-event-epoch']).toBe('epoch-old');
    // Reconnect uses the epoch learned from the response header.
    expect(calls[1]?.headers['last-event-id']).toBe('7');
    expect(calls[1]?.headers['x-qwen-event-epoch']).toBe('epoch-new');
  });

  it('does not overwrite replay state for events without SSE ids', async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse(
        'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n' +
          'event: session_update\ndata: {"v":1,"type":"session_update","data":"synthetic"}\n\n',
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    for await (const _event of session.events()) {
      /* empty */
    }

    expect(session.lastEventId).toBe(4);
  });

  it('does not acquire the subscription guard until iteration starts', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse(''));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    const abandoned = session.events();
    await expect(session.events().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(calls).toHaveLength(1);
    await abandoned.return(undefined);
  });

  it('rejects concurrent subscriptions on one session client', async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse(
        'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n',
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    const first = session.events();
    await expect(first.next()).resolves.toMatchObject({
      done: false,
      value: { id: 4 },
    });

    const second = session.events();
    await expect(second.next()).rejects.toThrow('subscription active');

    await first.return(undefined);

    for await (const _event of session.events()) {
      /* guard recovered */
    }
  });

  it('allows callers to seed, override, and disable replay state', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse(''));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
      lastEventId: 7,
    });

    for await (const _event of session.events()) {
      /* empty */
    }
    for await (const _event of session.events({ lastEventId: 11 })) {
      /* empty */
    }
    for await (const _event of session.events({ resume: false })) {
      /* empty */
    }

    expect(calls[0]?.headers['last-event-id']).toBe('7');
    expect(calls[1]?.headers['last-event-id']).toBe('11');
    expect(calls[2]?.headers['last-event-id']).toBeUndefined();
  });

  it('allows callers to set and clear replay state explicitly', async () => {
    const { fetch, calls } = recordingFetch(() => sseResponse(''));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    session.setLastEventId(12);
    expect(session.lastEventId).toBe(12);
    for await (const _event of session.events()) {
      /* empty */
    }

    session.setLastEventId(undefined);
    expect(session.lastEventId).toBeUndefined();
    for await (const _event of session.events()) {
      /* empty */
    }

    expect(calls[0]?.headers['last-event-id']).toBe('12');
    expect(calls[1]?.headers['last-event-id']).toBeUndefined();
    expect(() => session.setLastEventId(-1)).toThrow(TypeError);
    expect(() => session.setLastEventId(1.5)).toThrow(TypeError);
    expect(() => session.setLastEventId(Number.NaN)).toThrow(TypeError);
    expect(
      () =>
        new DaemonSessionClient({
          client,
          session: {
            sessionId: 's-1',
            workspaceCwd: '/work/a',
            attached: true,
          },
          lastEventId: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(TypeError);
    expect(() => session.events({ lastEventId: -1 })).toThrow(TypeError);
  });

  it('honors abort signals and releases the subscription guard', async () => {
    let cancelled = false;
    const { fetch, calls } = recordingFetch(() =>
      pendingSseResponse(() => {
        cancelled = true;
      }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });
    const controller = new AbortController();

    const events = session.events({ signal: controller.signal });
    const next = events.next();
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    controller.abort();

    await expect(next).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(cancelled).toBe(true);

    const retry = session.events();
    await retry.return(undefined);
  });

  it('releases the subscription guard when consumers throw into the iterator', async () => {
    const { fetch } = recordingFetch(() =>
      sseResponse(
        'id: 4\nevent: session_update\ndata: {"id":4,"v":1,"type":"session_update","data":"a"}\n\n',
      ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    const events = session.events();
    await expect(events.next()).resolves.toMatchObject({
      done: false,
      value: { id: 4 },
    });

    await expect(events.throw(new Error('boom'))).rejects.toThrow('boom');

    for await (const _event of session.events()) {
      /* guard recovered */
    }
  });

  it('propagates prompt and subscription errors', async () => {
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/prompt')) {
        return jsonResponse(500, { error: 'boom' });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return jsonResponse(500, { error: 'stream failed' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
      },
    });

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toThrow('POST /session/:id/prompt: boom');

    const events = session.events();
    await expect(events.next()).rejects.toThrow(
      'GET /session/:id/events: stream failed',
    );

    const retry = session.events({ resume: false });
    await expect(retry.next()).rejects.toThrow(
      'GET /session/:id/events: stream failed',
    );
  });
});

describe('DaemonSessionClient clientId self-heal', () => {
  function invalidClientIdResponse(): Response {
    return jsonResponse(400, {
      code: 'invalid_client_id',
      error: 'unknown client',
      sessionId: 's-1',
      clientId: 'client-1',
    });
  }

  function newSession(client: DaemonClient): DaemonSessionClient {
    return new DaemonSessionClient({
      client,
      session: {
        sessionId: 's-1',
        workspaceCwd: '/work/a',
        attached: true,
        clientId: 'client-1',
      },
      maxPendingPromptsPerSession: 10,
    });
  }

  it('re-registers and retries once when the blocking prompt is rejected with invalid_client_id', async () => {
    let promptCalls = 0;
    let resumeCalls = 0;
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        resumeCalls++;
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-2',
          state: {},
        });
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        promptCalls++;
        if (promptCalls === 1) return invalidClientIdResponse();
        return jsonResponse(200, { stopReason: 'end_turn' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = newSession(client);

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toEqual({ stopReason: 'end_turn' });

    expect(resumeCalls).toBe(1);
    expect(promptCalls).toBe(2);
    // The retried prompt carries the freshly registered clientId.
    const promptRequests = calls.filter((c) =>
      c.url.endsWith('/session/s-1/prompt'),
    );
    expect(promptRequests[0]?.headers['x-qwen-client-id']).toBe('client-1');
    expect(promptRequests[1]?.headers['x-qwen-client-id']).toBe('client-2');
    expect(session.clientId).toBe('client-2');
    // resume re-registers without sending the stale clientId.
    const resumeReq = calls.find((c) => c.url.endsWith('/session/s-1/resume'));
    expect(resumeReq?.headers['x-qwen-client-id']).toBeUndefined();
    expect(resumeReq?.body).toBe(JSON.stringify({ cwd: '/work/a' }));
  });

  it('re-registers standalone sessions through the dedicated resume route', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    let promptCalls = 0;
    const { fetch, calls } = recordingFetch((req) => {
      const path = new URL(req.url).pathname;
      if (path === '/capabilities') {
        return jsonResponse(200, { features: ['standalone_sessions_v1'] });
      }
      if (path === `/standalone/sessions/${sessionId}/resume`) {
        return jsonResponse(200, {
          sessionId,
          workspaceCwd: '/conversations',
          attached: true,
          clientId: 'client-2',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          projectlessOutputDirectory: '/conversations/conversation-hash',
          workingDirectory: { state: 'ready' },
          state: {},
        });
      }
      if (path === `/session/${sessionId}/prompt`) {
        promptCalls += 1;
        if (promptCalls === 1) {
          return jsonResponse(400, {
            code: 'invalid_client_id',
            error: 'unknown client',
            sessionId,
            clientId: 'client-1',
          });
        }
        return jsonResponse(200, { stopReason: 'end_turn' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = new DaemonSessionClient({
      client,
      session: {
        sessionId,
        workspaceCwd: '/conversations',
        attached: true,
        clientId: 'client-1',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
      },
    });

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).resolves.toEqual({ stopReason: 'end_turn' });

    const resume = calls.find((call) =>
      new URL(call.url).pathname.endsWith('/resume'),
    );
    expect(resume?.body).toBe('{}');
    expect(resume?.headers['x-qwen-client-id']).toBeUndefined();
    expect(
      calls.some((call) =>
        new URL(call.url).pathname.endsWith(`/session/${sessionId}/resume`),
      ),
    ).toBe(false);
    expect(session.clientId).toBe('client-2');
  });

  it('re-registers and retries attachment upload, removal, and hydration', async () => {
    let resumeCalls = 0;
    const attempts = new Map<string, number>();
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        resumeCalls += 1;
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: `client-${resumeCalls + 1}`,
          state: {},
        });
      }
      const operation = `${req.method} ${new URL(req.url).pathname}`;
      const attempt = (attempts.get(operation) ?? 0) + 1;
      attempts.set(operation, attempt);
      if (attempt === 1) return invalidClientIdResponse();
      if (req.method === 'POST') {
        return jsonResponse(201, {
          type: 'image',
          attachmentId: 'media-uploaded',
          mimeType: 'image/png',
          size: 3,
        });
      }
      if (req.method === 'DELETE') {
        return jsonResponse(200, { removed: true });
      }
      if (req.method === 'GET') {
        return new Response(Uint8Array.of(1, 2, 3), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const session = newSession(
      new DaemonClient({ baseUrl: 'http://daemon', fetch }),
    );

    await expect(
      session.uploadAttachment(
        new Blob([Uint8Array.of(1, 2, 3)]),
        'image.png',
        'image/png',
      ),
    ).resolves.toMatchObject({ attachmentId: 'media-uploaded' });
    await expect(session.removeAttachment('media-uploaded')).resolves.toBe(
      true,
    );
    const hydrateBlock = (
      session as unknown as {
        hydrateBlock(block: unknown): Promise<unknown>;
      }
    ).hydrateBlock.bind(session);
    await expect(
      hydrateBlock({
        type: 'image',
        attachmentId: 'media-read',
        mimeType: 'image/png',
        size: 3,
      }),
    ).resolves.toEqual({
      type: 'image',
      data: 'AQID',
      mimeType: 'image/png',
      attachmentId: 'media-read',
    });

    expect(resumeCalls).toBe(3);
    expect(session.clientId).toBe('client-4');
    expect(
      calls
        .filter((call) => !call.url.endsWith('/resume'))
        .map((call) => call.headers['x-qwen-client-id']),
    ).toEqual([
      'client-1',
      'client-2',
      'client-2',
      'client-3',
      'client-3',
      'client-4',
    ]);
  });

  it('re-registers and retries once on the non-blocking prompt path', async () => {
    let promptCalls = 0;
    let resumeCalls = 0;
    let eventsController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const encoder = new TextEncoder();
    const { fetch, calls } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        resumeCalls++;
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-2',
          state: {},
        });
      }
      if (requestPathEndsWith(req, '/session/s-1/events')) {
        return pendingSseResponse(
          () => {},
          (controller) => {
            eventsController = controller;
          },
        );
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        promptCalls++;
        if (promptCalls === 1) return invalidClientIdResponse();
        return jsonResponse(202, { promptId: 'p-2', lastEventId: 0 });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = newSession(client);
    // Activate the SSE subscription so prompt() takes the non-blocking path.
    const eventsAbort = new AbortController();
    const eventPump = (async () => {
      for await (const _event of session.events({
        signal: eventsAbort.signal,
      })) {
        /* keep subscription active */
      }
    })().catch(() => {});
    await vi.waitFor(() => {
      expect(
        calls.filter((c) => requestPathEndsWith(c, '/events')),
      ).toHaveLength(1);
    });

    const promptPromise = session
      .prompt({ prompt: [{ type: 'text', text: 'hi' }] })
      .catch((err: unknown) => err);
    // The retried prompt registers a pending entry under the new promptId.
    await waitForPendingPrompt(session, 'p-2');
    eventsController?.enqueue(encoder.encode(turnCompleteFrame('p-2')));

    await expect(promptPromise).resolves.toEqual({ stopReason: 'end_turn' });
    expect(resumeCalls).toBe(1);
    expect(promptCalls).toBe(2);
    const promptRequests = calls.filter((c) =>
      c.url.endsWith('/session/s-1/prompt'),
    );
    expect(promptRequests[1]?.headers['x-qwen-client-id']).toBe('client-2');

    eventsController?.close();
    eventsAbort.abort();
    await eventPump;
  });

  it('propagates the error when the retried prompt is also invalid_client_id (no loop)', async () => {
    let promptCalls = 0;
    let resumeCalls = 0;
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        resumeCalls++;
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-2',
          state: {},
        });
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        promptCalls++;
        return invalidClientIdResponse();
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = newSession(client);

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toMatchObject({
      status: 400,
      body: { code: 'invalid_client_id' },
    });
    expect(resumeCalls).toBe(1);
    expect(promptCalls).toBe(2);
  });

  it('does not re-register or retry on a non-invalid_client_id error', async () => {
    let promptCalls = 0;
    let resumeCalls = 0;
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        resumeCalls++;
        return jsonResponse(200, { clientId: 'client-2' });
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        promptCalls++;
        return jsonResponse(500, { error: 'boom' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = newSession(client);

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toThrow('POST /session/:id/prompt: boom');
    expect(promptCalls).toBe(1);
    expect(resumeCalls).toBe(0);
    expect(session.clientId).toBe('client-1');
  });

  it('does not re-register or retry on 400 with a different error code', async () => {
    let promptCalls = 0;
    let resumeCalls = 0;
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        resumeCalls++;
        return jsonResponse(200, { clientId: 'client-2' });
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        promptCalls++;
        return jsonResponse(400, {
          code: 'validation_error',
          error: 'bad request',
        });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = newSession(client);

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toMatchObject({
      status: 400,
      body: { code: 'validation_error' },
    });
    expect(promptCalls).toBe(1);
    expect(resumeCalls).toBe(0);
    expect(session.clientId).toBe('client-1');
  });

  it('propagates a reattach failure and clears the in-flight guard', async () => {
    let promptCalls = 0;
    let resumeCalls = 0;
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        resumeCalls++;
        if (resumeCalls === 1) {
          return jsonResponse(404, { error: 'session gone' });
        }
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-2',
          state: {},
        });
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        promptCalls++;
        if (promptCalls <= 2) return invalidClientIdResponse();
        return jsonResponse(200, { stopReason: 'end_turn' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = newSession(client);

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'hi' }] }),
    ).rejects.toThrow('POST /session/:id/resume: session gone');
    expect(resumeCalls).toBe(1);
    expect(session.clientId).toBe('client-1');

    await expect(
      session.prompt({ prompt: [{ type: 'text', text: 'retry' }] }),
    ).resolves.toEqual({ stopReason: 'end_turn' });
    expect(resumeCalls).toBe(2);
    expect(promptCalls).toBe(3);
    expect(session.clientId).toBe('client-2');
  });

  it('coalesces concurrent reattach into a single re-registration', async () => {
    let promptCalls = 0;
    let resumeCalls = 0;
    const { fetch } = recordingFetch((req) => {
      if (req.url.endsWith('/session/s-1/resume')) {
        resumeCalls++;
        return jsonResponse(200, {
          sessionId: 's-1',
          workspaceCwd: '/work/a',
          attached: true,
          clientId: 'client-2',
          state: {},
        });
      }
      if (req.url.endsWith('/session/s-1/prompt')) {
        promptCalls++;
        // First two concurrent prompts are rejected; retries succeed.
        if (promptCalls <= 2) return invalidClientIdResponse();
        return jsonResponse(200, { stopReason: 'end_turn' });
      }
      return jsonResponse(500, { error: `unexpected ${req.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const session = newSession(client);

    const [a, b] = await Promise.all([
      session.prompt({ prompt: [{ type: 'text', text: 'a' }] }),
      session.prompt({ prompt: [{ type: 'text', text: 'b' }] }),
    ]);
    expect(a).toEqual({ stopReason: 'end_turn' });
    expect(b).toEqual({ stopReason: 'end_turn' });
    expect(resumeCalls).toBe(1);
    expect(session.clientId).toBe('client-2');
  });
});
