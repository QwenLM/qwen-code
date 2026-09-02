/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import { DaemonHttpError } from '../../src/daemon/DaemonHttpError.js';
import {
  DaemonStandaloneCreationOutcomeUnknownError,
  DaemonStandaloneProtocolError,
  isStandaloneCreationOutcomeUnknown,
} from '../../src/daemon/standalone-sessions.js';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const UPPER_SESSION_ID = SESSION_ID.toUpperCase();

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal?: AbortSignal | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function capabilityResponse(
  enabled = true,
  optionsEnabled = enabled,
): Response {
  return jsonResponse(200, {
    v: 1,
    mode: 'serve',
    features: [
      ...(enabled ? ['standalone_sessions_v1'] : []),
      ...(optionsEnabled ? ['standalone_session_options_v1'] : []),
    ],
  });
}

function standaloneOptions() {
  return {
    v: 1,
    initialized: true,
    current: { authType: 'openai', modelId: 'qwen-test' },
    approvalMode: 'default',
    providers: [
      {
        kind: 'model_provider',
        status: 'ok',
        authType: 'openai',
        current: true,
        models: [
          {
            modelId: 'qwen-test',
            baseModelId: 'qwen-test',
            name: 'Qwen Test',
            contextLimit: 131072,
            modalities: { image: true },
            isCurrent: true,
            isRuntime: false,
            configOptions: [],
          },
        ],
      },
    ],
  };
}

function standaloneSummary(sessionId = SESSION_ID) {
  return {
    sessionId,
    workspaceCwd: '/conversations',
    sourceType: 'standalone',
    context: { kind: 'standalone' },
    displayName: 'Standalone',
  };
}

function standaloneSession(sessionId = SESSION_ID) {
  return {
    ...standaloneSummary(sessionId),
    attached: false,
    clientId: 'client-1',
    projectlessOutputDirectory: '/conversations/conversation-hash',
    workingDirectory: { state: 'ready' },
  };
}

function restoredStandaloneSession(sessionId = SESSION_ID) {
  return {
    ...standaloneSession(sessionId),
    attached: true,
    state: {},
    lastEventId: 4,
  };
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
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const request = {
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : null,
        ...(init?.signal ? { signal: init.signal } : {}),
      };
      calls.push(request);
      return reply(request);
    },
  ) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe('DaemonClient standalone sessions', () => {
  it('gates standalone options with their dedicated capability', async () => {
    const { fetch, calls } = recordingFetch(() =>
      capabilityResponse(true, false),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(client.getStandaloneSessionOptions()).rejects.toMatchObject({
      name: 'DaemonCapabilityMissingError',
      capability: 'standalone_session_options_v1',
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/capabilities',
    ]);
  });

  it('reads and validates standalone options', async () => {
    const { fetch, calls } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(200, standaloneOptions()),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(client.getStandaloneSessionOptions()).resolves.toEqual(
      standaloneOptions(),
    );
    expect(calls[1]).toMatchObject({
      url: 'http://daemon/standalone/session-options',
      method: 'GET',
    });
  });

  it.each([
    [
      { ...standaloneOptions(), workspaceCwd: '/conversations' },
      'workspace internals',
    ],
    [{ ...standaloneOptions(), acpChannelLive: true }, 'workspace internals'],
    [{ ...standaloneOptions(), v: 2 }, 'expected v=1'],
    [{ ...standaloneOptions(), providers: null }, 'expected providers[]'],
    [{ ...standaloneOptions(), errors: {} }, 'expected errors[]'],
    [
      {
        ...standaloneOptions(),
        errors: [{ kind: 'a', status: 'degraded' }],
      },
      'invalid status',
    ],
    [
      { ...standaloneOptions(), approvalMode: 'yolo-plus' },
      'invalid approvalMode',
    ],
    [
      {
        ...standaloneOptions(),
        current: { modelId: 'q', visionModelId: 7 },
      },
      'expected visionModelId string',
    ],
    [
      {
        ...standaloneOptions(),
        providers: [
          {
            ...standaloneOptions().providers[0],
            models: [
              {
                ...standaloneOptions().providers[0]!.models[0],
                isCurrent: 'yes',
              },
            ],
          },
        ],
      },
      'expected isCurrent boolean',
    ],
  ])('rejects malformed standalone options: %s', async (body, detail) => {
    const { fetch } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(200, body),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(client.getStandaloneSessionOptions()).rejects.toEqual(
      expect.objectContaining<Partial<DaemonStandaloneProtocolError>>({
        name: 'DaemonStandaloneProtocolError',
        message: expect.stringContaining(detail),
      }),
    );
  });

  it('gates standalone operations before calling their routes', async () => {
    const { fetch, calls } = recordingFetch(() => capabilityResponse(false));
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(client.listStandaloneSessions()).rejects.toMatchObject({
      name: 'DaemonCapabilityMissingError',
      capability: 'standalone_sessions_v1',
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/capabilities',
    ]);
  });

  it.each([
    ['get', (client: DaemonClient) => client.getStandaloneSession(SESSION_ID)],
    [
      'export',
      (client: DaemonClient) => client.exportStandaloneSession(SESSION_ID),
    ],
  ])(
    'gates standalone %s before calling its route',
    async (_name, operation) => {
      const { fetch, calls } = recordingFetch(() => capabilityResponse(false));
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

      await expect(operation(client)).rejects.toMatchObject({
        name: 'DaemonCapabilityMissingError',
        capability: 'standalone_sessions_v1',
      });
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        '/capabilities',
      ]);
    },
  );

  it('omits optional list query parameters when no options are provided', async () => {
    const { fetch, calls } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(200, { sessions: [] }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await client.listStandaloneSessionsPage();

    expect(calls[1]?.url).toBe('http://daemon/standalone/sessions');
  });

  it('generates the UUID before create and sends only standalone fields', async () => {
    const { fetch, calls } = recordingFetch((request) => {
      if (request.url.endsWith('/capabilities')) return capabilityResponse();
      const body = JSON.parse(request.body ?? '{}') as { sessionId: string };
      return jsonResponse(200, standaloneSession(body.sessionId));
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const created = await client.createStandaloneSession({
      modelServiceId: 'qwen-prod',
      approvalMode: 'default',
    });

    const request = calls[1];
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    expect(request).toMatchObject({
      url: 'http://daemon/standalone/sessions',
      method: 'POST',
    });
    expect(body).toEqual({
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      modelServiceId: 'qwen-prod',
      approvalMode: 'default',
    });
    expect(body).not.toHaveProperty('cwd');
    expect(body).not.toHaveProperty('workspaceCwd');
    expect(created.sessionId).toBe(body['sessionId']);
  });

  it('canonicalizes a caller UUID and exercises the complete route family', async () => {
    const { fetch, calls } = recordingFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/capabilities') return capabilityResponse();
      if (
        url.pathname === '/standalone/sessions' &&
        request.method === 'POST'
      ) {
        return jsonResponse(200, standaloneSession());
      }
      if (url.pathname === '/standalone/sessions' && request.method === 'GET') {
        return jsonResponse(200, {
          sessions: [standaloneSummary()],
          nextCursor: 'next',
        });
      }
      if (
        url.pathname === `/standalone/sessions/${SESSION_ID}` &&
        request.method === 'GET'
      ) {
        return jsonResponse(200, standaloneSummary());
      }
      if (url.pathname.endsWith('/load')) {
        return jsonResponse(200, restoredStandaloneSession());
      }
      if (url.pathname.endsWith('/resume')) {
        return jsonResponse(200, restoredStandaloneSession());
      }
      if (url.pathname.endsWith('/repair-directory')) {
        return jsonResponse(200, {
          sessionId: SESSION_ID,
          projectlessOutputDirectory: '/conversations/conversation-hash',
          workingDirectory: {
            state: 'recreated',
            warnings: ['Directory was recreated.'],
          },
        });
      }
      if (url.pathname.endsWith('/metadata')) {
        return jsonResponse(200, {
          sessionId: SESSION_ID,
          displayName: 'Renamed',
        });
      }
      if (url.pathname.endsWith('/export')) {
        return new Response('# transcript', {
          status: 200,
          headers: {
            'content-type': 'text/markdown',
            'content-disposition': 'attachment; filename="session.md"',
          },
        });
      }
      if (url.pathname.endsWith('/archive')) {
        return jsonResponse(200, {
          archived: [SESSION_ID],
          alreadyArchived: [],
          notFound: [],
          errors: [],
        });
      }
      if (url.pathname.endsWith('/unarchive')) {
        return jsonResponse(200, {
          unarchived: [SESSION_ID],
          alreadyActive: [],
          notFound: [],
          errors: [],
        });
      }
      if (url.pathname.endsWith('/delete')) {
        return jsonResponse(200, {
          removed: [SESSION_ID],
          notFound: [],
          errors: [],
          fileCleanupPending: [SESSION_ID],
        });
      }
      return jsonResponse(500, { error: `Unexpected ${request.url}` });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await client.createStandaloneSession({ sessionId: UPPER_SESSION_ID });
    await expect(
      client.listStandaloneSessionsPage({
        pageSize: 25,
        cursor: 'cursor',
        archiveState: 'archived',
      }),
    ).resolves.toMatchObject({ nextCursor: 'next' });
    await expect(
      client.getStandaloneSession(UPPER_SESSION_ID),
    ).resolves.toMatchObject({ context: { kind: 'standalone' } });
    await client.loadStandaloneSession(
      UPPER_SESSION_ID,
      {
        historyPageSize: 40,
        liveReplayMode: 'summary',
        hideInheritedHistory: true,
        approvalMode: 'default',
        timeoutMs: 5_000,
      },
      'client-load',
    );
    await client.resumeStandaloneSession(
      UPPER_SESSION_ID,
      { approvalMode: 'default' },
      'client-resume',
    );
    await client.repairStandaloneSessionDirectory(UPPER_SESSION_ID);
    await client.renameStandaloneSession(
      UPPER_SESSION_ID,
      'Renamed',
      'client-meta',
    );
    await expect(
      client.exportStandaloneSession(UPPER_SESSION_ID, { format: 'md' }),
    ).resolves.toEqual({
      content: '# transcript',
      filename: 'session.md',
      mimeType: 'text/markdown',
      format: 'md',
    });
    await client.archiveStandaloneSessions([UPPER_SESSION_ID]);
    await client.unarchiveStandaloneSessions([UPPER_SESSION_ID]);
    await client.deleteStandaloneSessions([UPPER_SESSION_ID]);

    const routeCalls = calls.filter(
      (call) => new URL(call.url).pathname !== '/capabilities',
    );
    expect(
      routeCalls.map((call) => ({
        method: call.method,
        path: new URL(call.url).pathname,
        query: new URL(call.url).search,
      })),
    ).toEqual([
      { method: 'POST', path: '/standalone/sessions', query: '' },
      {
        method: 'GET',
        path: '/standalone/sessions',
        query: '?cursor=cursor&size=25&archiveState=archived',
      },
      { method: 'GET', path: `/standalone/sessions/${SESSION_ID}`, query: '' },
      {
        method: 'POST',
        path: `/standalone/sessions/${SESSION_ID}/load`,
        query: '',
      },
      {
        method: 'POST',
        path: `/standalone/sessions/${SESSION_ID}/resume`,
        query: '',
      },
      {
        method: 'POST',
        path: `/standalone/sessions/${SESSION_ID}/repair-directory`,
        query: '',
      },
      {
        method: 'PATCH',
        path: `/standalone/sessions/${SESSION_ID}/metadata`,
        query: '',
      },
      {
        method: 'GET',
        path: `/standalone/sessions/${SESSION_ID}/export`,
        query: '?format=md',
      },
      { method: 'POST', path: '/standalone/sessions/archive', query: '' },
      { method: 'POST', path: '/standalone/sessions/unarchive', query: '' },
      { method: 'POST', path: '/standalone/sessions/delete', query: '' },
    ]);
    expect(JSON.parse(routeCalls[0]?.body ?? '{}')).toEqual({
      sessionId: SESSION_ID,
    });
    expect(JSON.parse(routeCalls[3]?.body ?? '{}')).toEqual({
      historyPageSize: 40,
      liveReplayMode: 'summary',
      hideInheritedHistory: true,
      approvalMode: 'default',
    });
    expect(routeCalls[3]?.headers['x-qwen-client-id']).toBe('client-load');
    expect(JSON.parse(routeCalls[4]?.body ?? '{}')).toEqual({
      approvalMode: 'default',
    });
    expect(routeCalls[4]?.headers['x-qwen-client-id']).toBe('client-resume');
    expect(JSON.parse(routeCalls[5]?.body ?? '{}')).toEqual({});
    expect(JSON.parse(routeCalls[6]?.body ?? '{}')).toEqual({
      displayName: 'Renamed',
    });
    expect(routeCalls[6]?.headers['x-qwen-client-id']).toBe('client-meta');
    expect(JSON.parse(routeCalls[8]?.body ?? '{}')).toEqual({
      sessionIds: [SESSION_ID],
    });
  });

  it('preserves exact lookup 202 creating responses', async () => {
    const { fetch } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(202, { sessionId: SESSION_ID, state: 'creating' }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(client.getStandaloneSession(SESSION_ID)).resolves.toEqual({
      sessionId: SESSION_ID,
      state: 'creating',
    });
  });

  it('rejects an exact lookup response for a different session id', async () => {
    const { fetch } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(
            200,
            standaloneSummary('550e8400-e29b-41d4-a716-446655440001'),
          ),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(
      client.getStandaloneSession(SESSION_ID),
    ).rejects.toBeInstanceOf(DaemonStandaloneProtocolError);
  });

  it('honors a standalone restore timeout override', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const { fetch } = recordingFetch((request) => {
        if (request.url.endsWith('/capabilities')) return capabilityResponse();
        signal = request.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason), {
            once: true,
          });
        });
      });
      const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
      const outcome = client
        .loadStandaloneSession(SESSION_ID, { timeoutMs: 25 })
        .catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(24);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ name: 'TimeoutError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('performs one exact lookup after a transport-level unknown outcome', async () => {
    let createAttempts = 0;
    const { fetch, calls } = recordingFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/capabilities') return capabilityResponse();
      if (url.pathname === '/standalone/sessions') {
        createAttempts += 1;
        throw new TypeError('connection reset');
      }
      return jsonResponse(200, standaloneSummary());
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const error = await client
      .createStandaloneSession({ sessionId: SESSION_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DaemonStandaloneCreationOutcomeUnknownError);
    expect(isStandaloneCreationOutcomeUnknown(error)).toBe(true);
    expect(error).toMatchObject({
      sessionId: SESSION_ID,
      recovery: {
        state: 'existing',
        session: { sessionId: SESSION_ID },
      },
    });
    expect(createAttempts).toBe(1);
    expect(
      calls.filter(
        (call) =>
          new URL(call.url).pathname === `/standalone/sessions/${SESSION_ID}`,
      ),
    ).toHaveLength(1);
  });

  it('reports unknown recovery when the exact lookup also fails', async () => {
    const { fetch } = recordingFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/capabilities') return capabilityResponse();
      if (url.pathname === '/standalone/sessions') {
        throw new TypeError('connection reset');
      }
      return jsonResponse(500, {
        code: 'lookup_failed',
        error: 'Unavailable.',
      });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const error = await client
      .createStandaloneSession({ sessionId: SESSION_ID })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: 'DaemonStandaloneCreationOutcomeUnknownError',
      sessionId: SESSION_ID,
      recovery: {
        state: 'unknown',
        sessionId: SESSION_ID,
        error: { name: 'DaemonHttpError', status: 500 },
      },
    });
  });

  it('recovers the generated UUID after a create transport timeout', async () => {
    let createAttempts = 0;
    let generatedSessionId: string | undefined;
    const { fetch } = recordingFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/capabilities') return capabilityResponse();
      if (url.pathname === '/standalone/sessions') {
        createAttempts += 1;
        generatedSessionId = (
          JSON.parse(request.body ?? '{}') as { sessionId: string }
        ).sessionId;
        return new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            reject(request.signal?.reason);
          });
        });
      }
      return jsonResponse(200, standaloneSummary(generatedSessionId));
    });
    const client = new DaemonClient({
      baseUrl: 'http://daemon',
      fetch,
      fetchTimeoutMs: 10,
    });

    const error = await client
      .createStandaloneSession()
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: 'DaemonStandaloneCreationOutcomeUnknownError',
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
      recovery: {
        state: 'existing',
        session: { sessionId: expect.any(String) },
      },
    });
    expect(error).toHaveProperty('sessionId', generatedSessionId);
    expect(error).toHaveProperty(
      'recovery.session.sessionId',
      generatedSessionId,
    );
    expect(createAttempts).toBe(1);
  });

  it('maps structured unknown outcome to an exact creating recovery', async () => {
    const { fetch } = recordingFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/capabilities') return capabilityResponse();
      if (url.pathname === '/standalone/sessions') {
        return jsonResponse(500, {
          code: 'standalone_creation_outcome_unknown',
          sessionId: SESSION_ID,
          error: 'Creation outcome is unknown.',
        });
      }
      return jsonResponse(202, { sessionId: SESSION_ID, state: 'creating' });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(
      client.createStandaloneSession({ sessionId: SESSION_ID }),
    ).rejects.toMatchObject({
      name: 'DaemonStandaloneCreationOutcomeUnknownError',
      sessionId: SESSION_ID,
      recovery: { state: 'creating', sessionId: SESSION_ID },
      originalError: { status: 500 },
    });
  });

  it('treats a malformed successful create as unknown and records 404 recovery', async () => {
    const { fetch } = recordingFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/capabilities') return capabilityResponse();
      if (url.pathname === '/standalone/sessions') {
        return jsonResponse(200, {
          ...standaloneSession(),
          context: { kind: 'workspace' },
        });
      }
      return jsonResponse(404, {
        code: 'standalone_session_not_found',
        sessionId: SESSION_ID,
        error: 'Not found.',
      });
    });
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const error = await client
      .createStandaloneSession({ sessionId: SESSION_ID })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: 'DaemonStandaloneCreationOutcomeUnknownError',
      sessionId: SESSION_ID,
      recovery: { state: 'absent', sessionId: SESSION_ID },
      originalError: { name: 'DaemonStandaloneProtocolError' },
    });
  });

  it('does not recover or wrap a definite create rejection', async () => {
    const { fetch, calls } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(409, {
            code: 'standalone_session_conflict',
            sessionId: SESSION_ID,
            error: 'Conflict.',
          }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    const error = await client
      .createStandaloneSession({ sessionId: SESSION_ID })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(DaemonHttpError);
    expect(error).not.toBeInstanceOf(
      DaemonStandaloneCreationOutcomeUnknownError,
    );
    expect(calls).toHaveLength(2);
  });

  it('rejects malformed list responses at runtime', async () => {
    const { fetch } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(200, {
            sessions: [
              {
                ...standaloneSummary(),
                sourceType: 'workspace',
              },
            ],
          }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(client.listStandaloneSessions()).rejects.toBeInstanceOf(
      DaemonStandaloneProtocolError,
    );
  });

  it('rejects malformed restore and directory responses at runtime', async () => {
    let response: unknown = {
      ...restoredStandaloneSession(),
      state: 'invalid',
    };
    const { fetch } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(200, response),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(
      client.loadStandaloneSession(SESSION_ID),
    ).rejects.toBeInstanceOf(DaemonStandaloneProtocolError);

    response = {
      sessionId: SESSION_ID,
      projectlessOutputDirectory: '/conversations/conversation-hash',
      workingDirectory: { state: 'missing' },
    };
    await expect(
      client.repairStandaloneSessionDirectory(SESSION_ID),
    ).rejects.toBeInstanceOf(DaemonStandaloneProtocolError);
  });

  it('rejects malformed metadata and batch responses at runtime', async () => {
    let response: unknown = { sessionId: SESSION_ID, displayName: 42 };
    const { fetch } = recordingFetch((request) =>
      request.url.endsWith('/capabilities')
        ? capabilityResponse()
        : jsonResponse(200, response),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });

    await expect(
      client.renameStandaloneSession(SESSION_ID, 'Renamed'),
    ).rejects.toBeInstanceOf(DaemonStandaloneProtocolError);

    response = {
      archived: [SESSION_ID],
      alreadyArchived: [],
      notFound: [],
      errors: [{ sessionId: SESSION_ID, code: 42, message: 'bad' }],
    };
    await expect(
      client.archiveStandaloneSessions([SESSION_ID]),
    ).rejects.toBeInstanceOf(DaemonStandaloneProtocolError);

    response = {
      unarchived: [SESSION_ID],
      alreadyActive: [],
      notFound: [],
    };
    await expect(
      client.unarchiveStandaloneSessions([SESSION_ID]),
    ).rejects.toBeInstanceOf(DaemonStandaloneProtocolError);

    response = {
      removed: [SESSION_ID],
      notFound: [],
      errors: [],
    };
    await expect(
      client.deleteStandaloneSessions([SESSION_ID]),
    ).rejects.toBeInstanceOf(DaemonStandaloneProtocolError);
  });
});
