import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifact } from './managed-tool-result.test-fixtures';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';
import { pendingQuestion } from './managed-question.test-fixtures';
import {
  sideQuery,
  sideQueryContext,
} from './managed-side-query.test-fixtures';
import type {
  ManagedSideQuery,
  ManagedSideQueryContext,
} from './managed-side-query-types';
import {
  diagnosticContext,
  diagnosticResources,
  diagnosticStats,
  diagnosticTrace,
} from './managed-diagnostics.test-fixtures';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// The Public wire reports Session, Turn, Event and Item timestamps in epoch
// SECONDS; realistic epochs keep the adapter's ×1000 observable. Every other
// family (actions, side queries, model context) stays epoch millis on both
// wires.
const CREATED_AT = 1790777114;
const UPDATED_AT = 1790777115;
const ACTION_CREATED_AT = 1790777114231;
const ACTION_EXPIRES_AT = 1790777714231;

function publicCapabilities(overrides: Record<string, unknown> = {}) {
  return {
    items: false,
    snapshots: false,
    artifacts: false,
    resync: false,
    actions: false,
    tasks: false,
    workspace_turns: false,
    ...overrides,
  };
}

function publicSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    object: 'agent.session',
    agent_id: 'qwen-code',
    agent_revision: '1',
    status: 'active',
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    last_event_id: 0,
    capabilities: publicCapabilities(),
    ...overrides,
  };
}

function publicTurn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'turn-1',
    object: 'agent.turn',
    session_id: 'session-1',
    status: 'running',
    created_at: CREATED_AT,
    ...overrides,
  };
}

function publicEvent(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    projection_version: 1,
    sequence: 1,
    event_id: 'evt_1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    type: 'turn.completed',
    created_at: CREATED_AT,
    data: {},
    terminal: true,
    ...overrides,
  };
}

function sideQueryWire(query: ManagedSideQuery) {
  return {
    query_id: query.queryId,
    session_id: query.sessionId,
    kind: query.kind,
    trigger: query.trigger,
    question: query.question,
    status: query.status,
    outcome: query.outcome,
    source: {
      journal_revision: query.source.journalRevision,
      committed_sequence: query.source.committedSequence,
      last_commit_digest: query.source.lastCommitDigest,
      completed_turn_sequence: query.source.completedTurnSequence,
      content_version: query.source.contentVersion,
      completed_user_turn_count: query.source.completedUserTurnCount,
      main_input_boundary: query.source.mainInputBoundary,
    },
    result_revision: query.resultRevision,
    text: query.text,
    usage: query.usage,
    error_code: query.errorCode,
    created_at: query.createdAt,
    updated_at: query.updatedAt,
    deadline_at: query.deadlineAt,
  };
}

function sideQueryContextWire(context: ManagedSideQueryContext) {
  return {
    actor_scope_key: context.actorScopeKey,
    content_version: context.contentVersion,
    completed_user_turn_count: context.completedUserTurnCount,
    main_input_boundary: context.mainInputBoundary,
    automatic_eligible: context.automaticEligible,
    generation_available: context.generationAvailable,
    unavailable_reason: context.unavailableReason,
    latest_recap_content_version: context.latestRecapContentVersion,
    latest_recap_user_turn_count: context.latestRecapUserTurnCount,
  };
}

describe('createJavaManagedAgentProvider', () => {
  it('uses the Public side-query routes and resumes full snapshots by revision', async () => {
    // Side-query timestamps are epoch millis on both wires: realistic values
    // make a stray ×1000 in the adapter visible to the full-snapshot asserts.
    const settled = {
      ...sideQuery,
      createdAt: 1790777114231,
      updatedAt: 1790777124231,
      deadlineAt: 1790777414231,
    };
    const running = {
      ...settled,
      status: 'running',
      resultRevision: 1,
      text: 'partial',
    };
    const frames = [running, running, settled]
      .map(
        (query) =>
          `event: snapshot\ndata: ${JSON.stringify(sideQueryWire(query))}\n\n`,
      )
      .join('');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(sideQueryContextWire(sideQueryContext)),
      )
      .mockResolvedValueOnce(jsonResponse(sideQueryWire(running)))
      .mockResolvedValueOnce(
        jsonResponse({ items: [sideQueryWire(running)], next_cursor: 'older' }),
      )
      .mockResolvedValueOnce(jsonResponse(sideQueryWire(running)))
      .mockResolvedValueOnce(
        new Response(frames, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(sideQueryWire({ ...settled, status: 'cancelled' })),
      );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    const signal = new AbortController().signal;
    const options = { clientId: 'c', signal };
    const api = provider.sideQueries!;
    expect(await api.context('s1', options)).toEqual(sideQueryContext);
    await api.create(
      's1',
      { kind: 'btw', question: 'question' },
      { ...options, idempotencyKey: 'original-key' },
    );
    await api.list('s1', { ...options, cursor: 'cursor', limit: 20 });
    await api.get('s1', 'q1', options);
    const snapshots = [];
    for await (const snapshot of api.stream('s1', 'q1', {
      ...options,
      afterRevision: 1,
    }))
      snapshots.push(snapshot);
    expect(snapshots).toEqual([settled]);
    await api.cancel('s1', 'q1', options);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://product.example/v1/agents/sessions/s1/side-queries/context',
      'https://product.example/v1/agents/sessions/s1/side-queries',
      'https://product.example/v1/agents/sessions/s1/side-queries?cursor=cursor&limit=20',
      'https://product.example/v1/agents/sessions/s1/side-queries/q1',
      'https://product.example/v1/agents/sessions/s1/side-queries/q1/events',
      'https://product.example/v1/agents/sessions/s1/side-queries/q1/cancel',
    ]);
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      kind: 'btw',
      question: 'question',
    });
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
    ).toBe('original-key');
    // afterRevision is local stream dedup, never a wire parameter.
    expect(fetchImpl.mock.calls[4][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[4][1]?.body).toBeUndefined();
    expect(
      fetchImpl.mock.calls.every(([, request]) => request?.signal === signal),
    ).toBe(true);
  });

  it('reads diagnostics through passive product routes and rejects foreign snapshots', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(diagnosticContext))
      .mockResolvedValueOnce(jsonResponse(diagnosticStats))
      .mockResolvedValueOnce(jsonResponse(diagnosticResources))
      .mockResolvedValueOnce(jsonResponse(diagnosticTrace));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    const signal = new AbortController().signal;
    const request = { clientId: 'c', signal };
    await expect(
      provider.diagnostics!.getContextUsage('s1', request),
    ).resolves.toEqual(diagnosticContext);
    await expect(
      provider.diagnostics!.getStatistics('s1', request),
    ).resolves.toEqual(diagnosticStats);
    await expect(
      provider.diagnostics!.getResources('s1', request),
    ).resolves.toEqual(diagnosticResources);
    await expect(
      provider.diagnostics!.listAgentTrace('s1', {
        ...request,
        cursor: 'older',
        limit: 20,
      }),
    ).resolves.toEqual(diagnosticTrace);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://product.example/v1/agents/sessions/s1/context-usage',
      'https://product.example/v1/agents/sessions/s1/stats',
      'https://product.example/v1/agents/sessions/s1/resources',
      'https://product.example/v1/agents/sessions/s1/agent-trace?cursor=older&limit=20',
    ]);
    expect(fetchImpl.mock.calls[3][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[3][1]?.body).toBeUndefined();
    expect(
      fetchImpl.mock.calls.every(([, options]) => options?.signal === signal),
    ).toBe(true);
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ ...diagnosticStats, sessionId: 'foreign' }),
    );
    await expect(
      provider.diagnostics!.getStatistics('s1', request),
    ).rejects.toThrow('identity mismatch');
    fetchImpl.mockResolvedValueOnce(
      jsonResponse(
        // The Public contract keeps only tasks; diagnostics is derived from it.
        publicSession({
          id: 's1',
          status: 'closed',
          capabilities: publicCapabilities({
            tasks: true,
            workspace_turns: false,
          }),
        }),
      ),
    );
    const summary = await provider.getSession('s1', request);
    expect(summary.capabilities.diagnostics).toBe(true);
    expect(summary.capabilities.canSend).toBe(false);
  });

  it('projects the client files capability only when the server advertises it', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    for (const advertised of [true, false]) {
      fetchImpl.mockResolvedValueOnce(
        jsonResponse(
          publicSession({
            id: 's1',
            status: 'closed',
            capabilities: publicCapabilities({ client_files: advertised }),
          }),
        ),
      );
      const summary = await provider.getSession('s1', { clientId: 'c' });
      expect(summary.capabilities.clientFiles === true).toBe(advertised);
    }
  });

  it('submits and reads a compression operation through the Public routes', async () => {
    const operation = {
      operationId: 'compression-1',
      sessionId: 's1',
      type: 'context_compression',
      status: 'running',
      expectedCompactionRevision: 0,
      replayed: false,
    };
    const wireOperation = {
      id: 'compression-1',
      session_id: 's1',
      type: 'context_compression',
      status: 'running',
      expected_compaction_revision: 0,
      replayed: false,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(wireOperation));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    const signal = new AbortController().signal;
    await expect(
      provider.contextCompression!.submit(
        's1',
        { expectedCompactionRevision: 0 },
        {
          clientId: 'c',
          idempotencyKey: 'original',
          signal,
        },
      ),
    ).resolves.toEqual(operation);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://product.example/v1/agents/sessions/s1/compress');
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({
      expected_compaction_revision: 0,
    });
    expect(new Headers(request?.headers).get('idempotency-key')).toBe(
      'original',
    );
    await expect(
      provider.contextCompression!.query('s1', 'compression-1', {
        clientId: 'c',
        signal,
      }),
    ).resolves.toEqual(operation);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://product.example/v1/agents/sessions/s1/operations/compression-1',
    );
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[1][1]?.body).toBeUndefined();
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ ...wireOperation, id: 'other' }),
    );
    await expect(
      provider.contextCompression!.query('s1', 'compression-1', {
        clientId: 'c',
      }),
    ).rejects.toThrow('identity mismatch');
    fetchImpl.mockResolvedValueOnce(
      jsonResponse({ ...wireOperation, session_id: 'other' }),
    );
    await expect(
      provider.contextCompression!.submit(
        's1',
        { expectedCompactionRevision: 0 },
        {
          clientId: 'c',
          idempotencyKey: 'original',
        },
      ),
    ).rejects.toThrow('identity mismatch');
  });

  it('projects compression revision and remote operation without allowing a Turn to race it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        publicSession({
          id: 's1',
          title: 'Session',
          workspace: { workspace_id: 'ws', cwd_relative: '.' },
          compaction_revision: 15,
          context_compression_operation_id: 'op',
          capabilities: publicCapabilities({
            workspace_turns: true,
            context_compression: true,
          }),
        }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    const session = await provider.getSession('s1', { clientId: 'c' });
    expect(session.compactionRevision).toBe(15);
    expect(session.contextCompressionOperationId).toBe('op');
    expect(session.capabilities.contextCompression).toBe(true);
    expect(session.capabilities.canSend).toBe(false);
    fetchImpl.mockResolvedValue(jsonResponse(publicSession({ id: 's1' })));
    expect(
      (await provider.getSession('s1', { clientId: 'c' })).compactionRevision,
    ).toBe(0);
    expect(
      createJavaManagedAgentProvider({ baseUrl: 'https://product.example' })
        .contextCompression,
    ).toBeDefined();
  });

  it.each([undefined, true, false])(
    'keeps a recovery-blocked Turn parked with server cancel permission %s',
    async (cancel) => {
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(
            publicSession({
              id: 's1',
              title: 'Blocked',
              // SessionRecovery is camelCase on both wires.
              ...(cancel === undefined
                ? {}
                : {
                    recovery: {
                      state: 'awaiting_evidence',
                      reasonCode: 'recovery_evidence_unavailable',
                      turnId: 't1',
                      nextTurnAllowed: false,
                      actions: {
                        recheck: false,
                        cancel,
                        continueInNewSession: true,
                      },
                    },
                  }),
              latest_turn: publicTurn({
                id: 't1',
                status: 'recovery_blocked',
                error_code: 'hosted_harness_recovery_blocked',
              }),
            }),
          ),
        ),
      });
      const summary = await provider.getSession('s1', { clientId: 'client' });
      expect(summary.phase).toBe('failed');
      expect(summary.capabilities.canSend).toBe(false);
      expect(summary.capabilities.canCancel).toBe(cancel !== false);
      expect(summary.failure?.code).toBe('hosted_harness_recovery_blocked');
    },
  );

  it.each([true, false, undefined])(
    'uses the advertised rename capability %s independently of a running Turn',
    async (rename) => {
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(
            publicSession({
              id: 's1',
              title: 'Running',
              latest_turn: publicTurn({ id: 't1' }),
              capabilities: publicCapabilities({ rename }),
            }),
          ),
        ),
      });
      const summary = await provider.getSession('s1', { clientId: 'client' });
      expect(summary.capabilities.canSend).toBe(false);
      expect(summary.capabilities.canRename === true).toBe(rename === true);
    },
  );

  it('returns the confirmed rename and rejects a different Session or missing/empty title', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        // The replay flag rides the response header on the Public surface.
        new Response(
          JSON.stringify(publicSession({ id: 's1', title: 'Stored name' })),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-qwen-idempotent-replay': 'true',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(publicSession({ id: 's2', title: 'Other' })),
      )
      // A confirmed rename must carry the stored title: an absent wire
      // title yields '' (not the requested one), and an empty stored title
      // stays empty — both are refused by the provider's trim guard, as
      // the WebShell-era required-title contract refused a missing title.
      .mockResolvedValueOnce(
        jsonResponse({ ...publicSession({ id: 's1' }), title: undefined }),
      )
      .mockResolvedValueOnce(
        jsonResponse(publicSession({ id: 's1', title: '' })),
      );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    const command = { clientId: 'c', idempotencyKey: 'original' };
    expect(
      await provider.renameSession!('s1', 'Requested name', command),
    ).toEqual({ displayName: 'Stored name' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://product.example/v1/agents/sessions/s1',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('PATCH');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      title: 'Requested name',
    });
    expect(
      new Headers(fetchImpl.mock.calls[0][1]?.headers).get('idempotency-key'),
    ).toBe('original');
    await expect(
      provider.renameSession!('s1', 'Requested name', command),
    ).rejects.toThrow('rename response is invalid');
    await expect(
      provider.renameSession!('s1', 'Requested name', command),
    ).rejects.toThrow('rename response is invalid');
    await expect(
      provider.renameSession!('s1', 'Requested name', command),
    ).rejects.toThrow('rename response is invalid');
  });

  it('reads tool details through the authenticated Public route and preserves empty output', async () => {
    const details = {
      input: { command: 'true' },
      output: '',
      truncated: false,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(details));
    const abort = new AbortController();
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      getHeaders: () => ({
        'X-Qwen-Tenant-Id': 'tenant',
        'X-Qwen-Actor-Id': 'actor',
      }),
      fetch: fetchImpl,
    });
    expect(
      await provider.toolDetails!.get('session-1', 'item-1', {
        clientId: 'client',
        signal: abort.signal,
      }),
    ).toEqual(details);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://product.example/v1/agents/sessions/session-1/items/item-1/tool-details',
    );
    expect(request?.method).toBe('GET');
    expect(request?.body).toBeUndefined();
    expect(request?.signal).toBe(abort.signal);
    expect(new Headers(request?.headers).get('X-Qwen-Tenant-Id')).toBe(
      'tenant',
    );
    expect(new Headers(request?.headers).get('X-Qwen-Actor-Id')).toBe('actor');
  });

  it('reads the selected Session Skill catalog with authenticated cancellable requests', async () => {
    const catalog = {
      skills: [{ name: 'review', description: 'Published review.' }],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(catalog));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      getHeaders: () => ({ authorization: 'Bearer scoped' }),
    });
    const abort = new AbortController();
    expect(
      await provider.skills!.list('session-a', {
        clientId: 'client',
        signal: abort.signal,
      }),
    ).toEqual(catalog);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://product.example/v1/agents/sessions/session-a/skills',
    );
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBe(abort.signal);
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer scoped',
    );
    expect(init?.body).toBeUndefined();
  });
  it('reads the selected Session MCP catalog with authenticated cancellable requests', async () => {
    const catalog = {
      object: 'agent.mcp_catalog',
      session_id: 'session-a',
      servers: [],
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(catalog));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      getHeaders: () => ({ authorization: 'Bearer scoped' }),
    });
    const abort = new AbortController();
    expect(
      await provider.mcp!.list('session-a', {
        clientId: 'client',
        signal: abort.signal,
      }),
    ).toEqual(catalog);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://product.example/v1/agents/sessions/session-a/mcp-catalog',
    );
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBe(abort.signal);
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer scoped',
    );
    expect(init?.body).toBeUndefined();
  });

  it('preserves Workspace registration keys and validates directory and operation identities', async () => {
    const operation = {
      operationId: 'registration-a',
      type: 'workspace_create',
      status: 'running',
      replayed: false,
    };
    const wireOperation = {
      operation_id: 'registration-a',
      type: 'workspace_create',
      status: 'running',
      replayed: false,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(wireOperation));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      enableWorkspaceBinding: true,
      fetch: fetchImpl,
    });
    const registration = provider.workspaceBinding!.registration!;
    expect(
      await registration.create(
        { nodeId: 'mac', path: '/project', displayName: 'Project' },
        { clientId: 'client', idempotencyKey: 'original' },
      ),
    ).toEqual(operation);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://product.example/v1/agents/workspaces/registrations',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      node_id: 'mac',
      path: '/project',
      display_name: 'Project',
    });
    expect(
      new Headers(fetchImpl.mock.calls[0][1]?.headers).get('idempotency-key'),
    ).toBe('original');
    expect(
      await registration.query('registration-a', { clientId: 'client' }),
    ).toEqual(operation);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://product.example/v1/agents/workspaces/registrations/registration-a',
    );
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('GET');
    fetchImpl.mockImplementation(async () =>
      jsonResponse({ ...wireOperation, operation_id: 'wrong' }),
    );
    await expect(
      registration.query('registration-a', { clientId: 'client' }),
    ).rejects.toThrow('identity mismatch');
    fetchImpl.mockImplementation(async () =>
      jsonResponse({ ...wireOperation, type: 'cwd_change' }),
    );
    await expect(
      registration.create(
        { nodeId: 'mac', path: '/project', displayName: 'Project' },
        { clientId: 'client', idempotencyKey: 'original' },
      ),
    ).rejects.toThrow('identity mismatch');
    fetchImpl.mockImplementation(async () =>
      jsonResponse({
        node_id: 'different',
        canonical_path: '/project',
        platform: 'darwin',
      }),
    );
    await expect(
      registration.checkDirectory(
        { nodeId: 'mac', path: '/project' },
        { clientId: 'client' },
      ),
    ).rejects.toThrow('identity mismatch');
    expect(
      createJavaManagedAgentProvider({ baseUrl: 'https://product.example' })
        .workspaceBinding,
    ).toBeUndefined();
  });

  it('uses the Public approval contract and preserves the exact idempotency key', async () => {
    const selection = {
      approvalMode: 'default',
      approvalRevision: 0,
      availableApprovalModes: ['default', 'auto-edit', 'yolo'],
      supported: true,
      liveSupported: true,
    };
    const receipt = {
      sessionId: 's',
      approvalMode: 'yolo',
      approvalRevision: 1,
      replayed: true,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          approval_mode: 'default',
          approval_revision: 0,
          available_approval_modes: ['default', 'auto-edit', 'yolo'],
          supported: true,
          live_supported: true,
          privateRoute: 'private',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 's',
          approval_mode: 'yolo',
          approval_revision: 1,
          replayed: true,
          privateRoute: 'private',
        }),
      );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    expect(
      await provider.approvalChange!.queryOptions('s', { clientId: 'client' }),
    ).toEqual(selection);
    expect(
      await provider.approvalChange!.submit(
        's',
        { approvalMode: 'yolo', expectedRevision: 0 },
        {
          clientId: 'client',
          idempotencyKey: 'original-key',
          requestId: 'original-request',
        },
      ),
    ).toEqual(receipt);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://product.example/v1/agents/sessions/s/approval',
      'https://product.example/v1/agents/sessions/s/approval',
    ]);
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('POST');
    const body = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(body).toEqual({
      approval_mode: 'yolo',
      expected_revision: 0,
    });
    // The key rides the header; the caller's requestId no longer rides the
    // wire (the server assigns its own X-Request-Id).
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
    ).toBe('original-key');
    expect(body).not.toHaveProperty('requestId');
    expect(
      createJavaManagedAgentProvider({ baseUrl: 'https://product.example' })
        .approvalChange,
    ).toBeDefined();
  });

  it('preserves stored-agent effective and initial approval policy from Session summaries', async () => {
    const agentId = `agent_${'a'.repeat(32)}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        publicSession({
          id: 's',
          agent_id: agentId,
          approval_mode: 'auto-edit',
          initial_approval_mode: 'yolo',
          approval_revision: 2,
          workspace: { workspace_id: 'workspace', cwd_relative: '.' },
          capabilities: publicCapabilities({
            workspace_turns: true,
            approval_mode_change: true,
            actions: true,
          }),
        }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    expect(
      await provider.getSession('s', { clientId: 'client' }),
    ).toMatchObject({
      agentId,
      approvalMode: 'auto-edit',
      initialApprovalMode: 'yolo',
      approvalRevision: 2,
      capabilities: { canSend: true, approvalModeChange: true, actions: true },
    });
  });

  it.each([
    {
      approval_mode: ['yolo'],
      approval_revision: 0,
      available_approval_modes: ['yolo'],
      supported: true,
    },
    {
      approval_mode: 'yolo',
      approval_revision: -1,
      available_approval_modes: ['yolo'],
      supported: true,
    },
    {
      approval_mode: 'yolo',
      approval_revision: 0,
      available_approval_modes: ['default'],
      supported: true,
    },
    {
      approval_mode: 'yolo',
      approval_revision: 0,
      available_approval_modes: ['yolo', 'unknown'],
      supported: true,
    },
  ])('refuses invalid approval options (%j)', async (selection) => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(selection)),
    });
    await expect(
      provider.approvalChange!.queryOptions('s', { clientId: 'client' }),
    ).rejects.toThrow('Invalid Session approval options');
  });

  it('round-trips Auto and Session rules through the existing approval contract', async () => {
    const permissionRules = {
      allow: ['Read'],
      ask: ['Bash(git push*)'],
      deny: ['Bash(rm *)'],
    };
    const selection = {
      approvalMode: 'auto',
      approvalRevision: 2,
      availableApprovalModes: ['auto', 'default'],
      supported: true,
      permissionRulesSupported: true,
      permissionRules,
    };
    const receipt = {
      sessionId: 's',
      approvalMode: 'auto',
      approvalRevision: 3,
      replayed: false,
      permissionRules,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          approval_mode: 'auto',
          approval_revision: 2,
          available_approval_modes: ['auto', 'default'],
          supported: true,
          permission_rules_supported: true,
          permission_rules: permissionRules,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 's',
          approval_mode: 'auto',
          approval_revision: 3,
          replayed: false,
          permission_rules: permissionRules,
        }),
      );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    expect(
      await provider.approvalChange!.queryOptions('s', { clientId: 'c' }),
    ).toEqual(selection);
    expect(
      await provider.approvalChange!.submit(
        's',
        { approvalMode: 'auto', expectedRevision: 2, permissionRules },
        { clientId: 'c', requestId: 'request', idempotencyKey: 'key' },
      ),
    ).toEqual(receipt);
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      permission_rules: permissionRules,
    });
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
    ).toBe('key');
  });

  it('uses only server model choices and preserves the frozen change key and revision', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            { model_id: 'published', label: 'Published', route: 'private' },
          ],
          model_selection: { revision: 0, provider: 'private' },
          supported: true,
          credentials: 'private',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 's',
          model_selection: {
            model_id: 'published',
            revision: 1,
            route: 'private',
          },
          replayed: true,
        }),
      );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    expect(
      await provider.modelChange!.queryOptions('s', { clientId: 'client' }),
    ).toEqual({
      models: [{ modelId: 'published', label: 'Published' }],
      modelSelection: { revision: 0 },
      supported: true,
    });
    expect(
      await provider.modelChange!.submit(
        's',
        { modelId: 'published', expectedRevision: 0 },
        { clientId: 'client', idempotencyKey: 'original' },
      ),
    ).toEqual({
      sessionId: 's',
      modelSelection: { modelId: 'published', revision: 1 },
      replayed: true,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://product.example/v1/agents/sessions/s/models',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://product.example/v1/agents/sessions/s/models',
    );
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      model_id: 'published',
      expected_revision: 0,
    });
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
    ).toBe('original');
    expect(
      createJavaManagedAgentProvider({ baseUrl: 'https://product.example' })
        .modelChange,
    ).toBeDefined();
  });

  it.each([
    {
      models: [
        { model_id: 'A', label: 'A' },
        { model_id: 'A', label: 'Duplicate' },
      ],
      model_selection: { revision: 0 },
      supported: true,
    },
    {
      models: [{ model_id: 'A', label: 5 }],
      model_selection: { revision: 0 },
      supported: true,
    },
    {
      models: [{ model_id: 'A\nroute', label: 'A' }],
      model_selection: { revision: 0 },
      supported: true,
    },
    { models: [], model_selection: { revision: -1 }, supported: true },
    { models: [], model_selection: { revision: 1 }, supported: true },
    { models: [], model_selection: { revision: 0 }, supported: 'true' },
  ])('rejects malformed server model options (%j)', async (response) => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response)),
    });
    await expect(
      provider.modelChange!.queryOptions('s', { clientId: 'client' }),
    ).rejects.toThrow('Invalid Session model options');
  });

  it.each([
    {
      session_id: 'other',
      model_selection: { model_id: 'B', revision: 2 },
      replayed: false,
    },
    {
      session_id: 's',
      model_selection: { model_id: 'A', revision: 2 },
      replayed: false,
    },
    {
      session_id: 's',
      model_selection: { model_id: 'B', revision: 1 },
      replayed: false,
    },
    {
      session_id: 's',
      model_selection: { model_id: 'B', revision: 2.5 },
      replayed: false,
    },
  ])(
    'rejects a change response that cannot confirm the original identity (%j)',
    async (response) => {
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        productScope: 'tenant:actor',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response)),
      });
      await expect(
        provider.modelChange!.submit(
          's',
          { modelId: 'B', expectedRevision: 1 },
          { clientId: 'c', idempotencyKey: 'key' },
        ),
      ).rejects.toThrow('Model change identity mismatch');
    },
  );
  async function readModelContext(value: unknown) {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          publicSession({
            id: 's',
            agent_id: 'agent-a',
            // observed_at is epoch millis on both wires.
            model_context: value,
          }),
        ),
      ),
    });
    return (await provider.getSession('s', { clientId: 'client' }))
      .modelContext;
  }

  it('publishes only observed model-context fields including zero input tokens', async () => {
    expect(
      await readModelContext({
        model_id: 'actual-pinned-model',
        input_tokens: 0,
        context_window_size: 1000,
        observed_at: 1790777114231,
        rawResource: 'private',
        budget: { totalTokens: 999999 },
        route: 'private',
      }),
    ).toEqual({
      modelId: 'actual-pinned-model',
      inputTokens: 0,
      contextWindowSize: 1000,
      observedAt: 1790777114231,
    });
  });

  it.each([
    undefined,
    null,
    {},
    { model_id: 42, observed_at: 1790777114231 },
    { model_id: ' ', observed_at: 1790777114231 },
    { model_id: 'model', observed_at: -1 },
    { model_id: 'model', observed_at: 1.5 },
    { model_id: 'model', observed_at: Number.MAX_SAFE_INTEGER + 1 },
  ])('omits invalid model observations (%j)', async (value) => {
    expect(await readModelContext(value)).toBeUndefined();
  });

  it.each([
    {
      input_tokens: -1,
      context_window_size: 1000,
      expected: { contextWindowSize: 1000 },
    },
    {
      input_tokens: 10,
      context_window_size: 0,
      expected: { inputTokens: 10 },
    },
    {
      input_tokens: 1.5,
      context_window_size: Number.MAX_SAFE_INTEGER + 1,
      expected: {},
    },
    { input_tokens: '10', context_window_size: '1000', expected: {} },
  ])(
    'does not invent missing or invalid occupancy (%j)',
    async ({ input_tokens, context_window_size, expected }) => {
      expect(
        await readModelContext({
          model_id: 'model',
          observed_at: 1790777114231,
          input_tokens,
          context_window_size,
        }),
      ).toEqual({ modelId: 'model', observedAt: 1790777114231, ...expected });
    },
  );

  it('reads tasks without identity scope and exposes cancellation regardless of product scope', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ object: 'list', data: [], has_more: false }),
      );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    expect(provider.tasks).toBeDefined();
    expect(provider.tasks!.cancel).toBeDefined();
    const abort = new AbortController();
    await provider.tasks!.list('s1', {
      clientId: 'client',
      cursor: 'opaque',
      limit: 50,
      signal: abort.signal,
    });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://product.example/v1/agents/sessions/s1/tasks?cursor=opaque&limit=50',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(abort.signal);
  });

  it('preserves the task cancel key and validates operation identity and type', async () => {
    const operation = {
      operationId: 'op1',
      sessionId: 's1',
      taskId: 'task1',
      type: 'task_cancel',
      status: 'pending',
      replayed: false,
    };
    const wireOperation = {
      id: 'op1',
      session_id: 's1',
      task_id: 'task1',
      type: 'task_cancel',
      status: 'pending',
      replayed: false,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(wireOperation));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    expect(
      await provider.tasks!.cancel!.submit('s1', 'task1', {
        clientId: 'client',
        idempotencyKey: 'original',
      }),
    ).toEqual(operation);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://product.example/v1/agents/sessions/s1/tasks/task1/cancel',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    expect(
      new Headers(fetchImpl.mock.calls[0][1]?.headers).get('idempotency-key'),
    ).toBe('original');
    expect(
      await provider.tasks!.cancel!.query('s1', 'task1', 'op1', {
        clientId: 'client',
      }),
    ).toEqual(operation);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://product.example/v1/agents/sessions/s1/operations/op1',
    );
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('GET');
    fetchImpl.mockImplementation(async () =>
      jsonResponse({ ...wireOperation, task_id: 'different' }),
    );
    await expect(
      provider.tasks!.cancel!.query('s1', 'task1', 'op1', {
        clientId: 'client',
      }),
    ).rejects.toThrow('identity mismatch');
    fetchImpl.mockImplementation(async () =>
      jsonResponse({ ...wireOperation, type: 'cancel' }),
    );
    await expect(
      provider.tasks!.cancel!.query('s1', 'task1', 'op1', {
        clientId: 'client',
      }),
    ).rejects.toThrow('identity mismatch');
  });
  it('keeps an empty bound session idle and disables execution', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant-a:actor-a',
      enableWorkspaceBinding: true,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          publicSession({
            id: 'empty-1',
            agent_id: 'agent-model-a',
            workspace: { workspace_id: 'ws-a', cwd_relative: 'services/api' },
          }),
        ),
      ),
    });
    expect(
      await provider.getSession('empty-1', { clientId: 'client' }),
    ).toEqual(
      expect.objectContaining({
        phase: 'created',
        agentId: 'agent-model-a',
        workspace: { workspaceId: 'ws-a', cwdRelative: 'services/api' },
        capabilities: { canSend: false, canCancel: false },
      }),
    );
  });

  it.each([false, true])(
    'allows the first message in an unbound empty session (opt-in: %s)',
    async (enableWorkspaceBinding) => {
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        productScope: 'tenant-a:actor-a',
        enableWorkspaceBinding,
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse(publicSession({ id: 'empty-1' }))),
      });
      expect(
        await provider.getSession('empty-1', { clientId: 'client' }),
      ).toEqual(
        expect.objectContaining({
          phase: 'created',
          capabilities: { canSend: true, canCancel: false },
        }),
      );
    },
  );

  it.each([true, false, undefined])(
    'uses only the server Workspace creation capability (%s) and freezes the create command',
    async (workspaceCreation) => {
      const workspace = {
        workspaceId: 'created-a',
        displayName: 'A',
        state: 'active',
        canCreateSession: true,
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async (_url, init) =>
          jsonResponse(
            // List and create share the /workspaces path; the verb separates
            // them on the Public surface.
            init?.method === 'GET'
              ? {
                  object: 'list',
                  data: [],
                  default_workspace: null,
                  has_more: false,
                  capabilities: {
                    workspace_binding: true,
                    workspace_context: false,
                    workspace_creation: workspaceCreation,
                  },
                }
              : {
                  workspace_id: 'created-a',
                  display_name: 'A',
                  state: 'active',
                  can_create_session: true,
                },
          ),
        );
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        productScope: 'tenant-a:actor-a',
        enableWorkspaceBinding: true,
        fetch: fetchImpl,
      });
      expect(
        (await provider.workspaceBinding!.list({ clientId: 'client' }))
          .canCreateWorkspace,
      ).toBe(workspaceCreation === true);
      const abort = new AbortController();
      expect(
        await provider.workspaceBinding!.createWorkspace!(
          { displayName: 'A' },
          {
            clientId: 'client',
            idempotencyKey: 'saved-key',
            signal: abort.signal,
          },
        ),
      ).toEqual(workspace);
      expect(String(fetchImpl.mock.calls[1][0])).toBe(
        'https://product.example/v1/agents/workspaces',
      );
      expect(fetchImpl.mock.calls[1][1]?.method).toBe('POST');
      expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
        display_name: 'A',
      });
      expect(
        new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
      ).toBe('saved-key');
      expect(fetchImpl.mock.calls[1][1]?.signal).toBe(abort.signal);
    },
  );

  it('creates a bound empty session without requiring turnId', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      jsonResponse(
        String(input).endsWith('/workspaces')
          ? {
              object: 'list',
              data: [
                {
                  id: 'ws-a',
                  object: 'agent.workspace',
                  display_name: 'A',
                  state: 'active',
                  can_create_session: true,
                },
              ],
              default_workspace: null,
              has_more: false,
              next_cursor: null,
              capabilities: {
                workspace_binding: true,
                workspace_context: false,
              },
            }
          : // An empty create carries no input, so the Session has no Turn yet.
            publicSession({ id: 'empty-1' }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant-a:actor-a',
      agentId: 'agent-a',
      enableWorkspaceBinding: true,
      fetch: fetchImpl,
    });
    const listed = await provider.workspaceBinding!.list({
      clientId: 'client',
    });
    expect(listed.supported).toBe(true);
    expect(listed.canCreateWorkspace).toBe(false);
    expect(listed.supportsApprovalModeSelection).toBe(false);
    expect(listed.nextCursor).toBeUndefined();
    expect(
      await provider.workspaceBinding!.createEmpty(
        {
          agentId: 'agent-a',
          workspaceId: 'ws-a',
          cwdRelative: './docs',
        },
        { clientId: 'client', idempotencyKey: 'key-a' },
      ),
    ).toEqual({ sessionId: 'empty-1' });
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://product.example/v1/agents/sessions',
    );
    const createBody = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(createBody).toEqual(
      expect.objectContaining({
        agent_id: 'agent-a',
        input: [],
        workspace: { workspace_id: 'ws-a', cwd_relative: './docs' },
      }),
    );
    // requestId no longer rides the wire; the key rides the header.
    expect(createBody).not.toHaveProperty('requestId');
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
    ).toBe('key-a');
    expect(provider.storageKey).toContain('agent-a');
    expect(() =>
      createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        enableWorkspaceBinding: true,
      }),
    ).toThrow('productScope');
  });

  it('preserves explicit memory, model, worktree and extension pins on both creation paths', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse(
        publicSession({
          id: 's',
          latest_turn: publicTurn({ id: 't', session_id: 's' }),
        }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      enableWorkspaceBinding: true,
      fetch: fetchImpl,
    });
    const request = {
      agentId: 'qwen-code',
      modelId: 'model-b',
      memoryStoreId: 'memstore_personal',
      workspaceId: 'ws',
      cwdRelative: '.',
      approvalMode: 'yolo' as const,
      worktree: { baseRef: 'main' },
      extensionPins: [
        {
          extensionId: 'ext_00000000-0000-0000-0000-000000000001',
          packageRevision: 1,
          packageDigest: 'a'.repeat(64),
        },
      ],
    };
    const command = { clientId: 'client', idempotencyKey: 'frozen-key' };
    await provider.workspaceBinding!.createEmpty(request, command);
    await provider.workspaceBinding!.createSession!(
      { ...request, text: 'First' },
      command,
    );
    for (const [, init] of fetchImpl.mock.calls) {
      expect(JSON.parse(String(init?.body))).toEqual(
        expect.objectContaining({
          agent_id: 'qwen-code',
          model_id: 'model-b',
          memory_store_id: 'memstore_personal',
          approval_mode: 'yolo',
          worktree: { base_ref: 'main' },
          // extensionPins is the one camelCase field the Public create keeps.
          extensionPins: request.extensionPins,
        }),
      );
      expect(new Headers(init?.headers).get('idempotency-key')).toBe(
        'frozen-key',
      );
    }
  });

  it('discovers policy selection, reads options and sends explicit policies for both bound creation paths', async () => {
    const options = {
      approvalMode: 'default',
      availableApprovalModes: ['default', 'auto-edit'],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      jsonResponse(
        String(url).endsWith('/workspaces')
          ? {
              object: 'list',
              data: [],
              default_workspace: null,
              has_more: false,
              capabilities: {
                workspace_binding: true,
                workspace_context: false,
                approval_mode_selection: true,
              },
            }
          : String(url).includes('/session-options')
            ? {
                approval_mode: 'default',
                available_approval_modes: ['default', 'auto-edit'],
              }
            : publicSession({
                id: 's',
                latest_turn: publicTurn({ id: 't', session_id: 's' }),
              }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      enableWorkspaceBinding: true,
      fetch: fetchImpl,
    });
    expect(
      (await provider.workspaceBinding!.list({ clientId: 'client' }))
        .supportsApprovalModeSelection,
    ).toBe(true);
    expect(
      await provider.workspaceBinding!.getSessionOptions!('agent-b', {
        clientId: 'client',
      }),
    ).toEqual(options);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://product.example/v1/agents/session-options?agent_id=agent-b',
    );
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[1][1]?.body).toBeUndefined();
    const command = { clientId: 'client', idempotencyKey: 'saved-key' };
    const request = {
      agentId: 'agent-b',
      workspaceId: 'ws',
      cwdRelative: '.',
      approvalMode: 'auto-edit' as const,
    };
    await provider.workspaceBinding!.createEmpty(request, command);
    await provider.workspaceBinding!.createSession!(
      { ...request, text: 'Write' },
      command,
    );
    for (const index of [2, 3])
      expect(
        JSON.parse(String(fetchImpl.mock.calls[index][1]?.body)).approval_mode,
      ).toBe('auto-edit');
    await provider.workspaceBinding!.createEmpty(
      { agentId: 'agent-b', workspaceId: 'ws', cwdRelative: '.' },
      command,
    );
    expect(
      JSON.parse(String(fetchImpl.mock.calls[4][1]?.body)),
    ).not.toHaveProperty('approval_mode');
  });

  it.each([
    'default',
    'auto-edit',
    'yolo',
    'auto',
    'plan',
    undefined,
    { name: 'default' },
  ])(
    'only publishes supported read-back policy metadata (%j)',
    async (approvalMode) => {
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        productScope: 'tenant:actor',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(
            publicSession({
              id: 's',
              agent_id: 'qwen-code',
              approval_mode: approvalMode,
            }),
          ),
        ),
      });
      const summary = await provider.getSession('s', { clientId: 'client' });
      if (
        ['default', 'auto-edit', 'auto', 'yolo'].includes(String(approvalMode))
      )
        expect(summary.approvalMode).toBe(approvalMode);
      else expect(summary).not.toHaveProperty('approvalMode');
    },
  );

  it('creates a bound Session and initial Turn in one request with the chosen preset', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        publicSession({
          id: 's',
          latest_turn: publicTurn({ id: 't', session_id: 's' }),
        }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      enableWorkspaceBinding: true,
      fetch: fetchImpl,
    });
    const command = { clientId: 'client', idempotencyKey: 'frozen-key' };
    await expect(
      provider.workspaceBinding!.createSession!(
        {
          agentId: 'agent-b',
          workspaceId: 'ws-b',
          cwdRelative: 'src',
          text: 'Read README',
        },
        command,
      ),
    ).resolves.toEqual({ sessionId: 's' });
    const request = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(request).toEqual(
      expect.objectContaining({
        agent_id: 'agent-b',
        input: [{ type: 'input_text', text: 'Read README' }],
        workspace: { workspace_id: 'ws-b', cwd_relative: 'src' },
        metadata: { clientId: 'client' },
      }),
    );
    expect(
      new Headers(fetchImpl.mock.calls[0][1]!.headers).get('idempotency-key'),
    ).toBe('frozen-key');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects initial-input admission without a Turn identity', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      enableWorkspaceBinding: true,
      // No latest_turn: the synthesized admission has no turnId.
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(publicSession({ id: 's' }))),
    });
    await expect(
      provider.workspaceBinding!.createSession!(
        { agentId: 'a', workspaceId: 'w', cwdRelative: '.', text: 'Read' },
        { clientId: 'c', idempotencyKey: 'k' },
      ),
    ).rejects.toThrow('admission identity');
  });

  it('keeps createEmpty empty when a host reuses a wider request object', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(publicSession({ id: 'empty' })));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      enableWorkspaceBinding: true,
      fetch: fetchImpl,
    });
    const request = {
      agentId: 'a',
      workspaceId: 'w',
      cwdRelative: '.',
      text: 'Extra host field',
    };
    await expect(
      provider.workspaceBinding!.createEmpty(request, {
        clientId: 'c',
        idempotencyKey: 'k',
      }),
    ).resolves.toEqual({ sessionId: 'empty' });
    expect(
      JSON.parse(fetchImpl.mock.calls[0][1]!.body as string).input,
    ).toEqual([]);
  });
  it('maps Java session, environment, and active turn state', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        publicSession({
          id: 'session-1',
          title: 'Managed task',
          // The WebShell activeTurn projection is the Public latest_turn.
          latest_turn: publicTurn({ id: 'turn-1', session_id: 'session-1' }),
          // The environment map's inner keys are identical on both wires.
          environment: {
            environmentId: 'python',
            state: 'starting',
          },
          last_event_id: 3,
        }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example?token=not-stored',
      fetch: fetchImpl,
    });

    const summary = await provider.getSession('session-1', {
      clientId: 'client-1',
    });

    expect(summary).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        activeTurnId: 'turn-1',
        phase: 'agent_running',
        runtimeState: 'starting',
        runtimeReady: false,
        capabilities: { canSend: false, canCancel: true },
      }),
    );
    expect(provider.storageKey).not.toContain('token');
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://product.example/v1/agents/sessions/session-1',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
  });

  it.each([
    ['active', 'running', 'agent_running', false, true],
    ['active', 'cancelling', 'cancelling', false, false],
    ['archived', 'completed', 'completed', false, false],
    ['deleting', 'failed', 'failed', false, false],
    // A terminal turn on an ACTIVE session enables the composer again; the
    // only canSend: true row, the state a hardcoded false would delete.
    ['active', 'completed', 'completed', true, false],
  ] as const)(
    'maps %s/%s to usable controls',
    async (status, turnStatus, phase, canSend, canCancel) => {
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(
            publicSession({
              id: 'session-1',
              status,
              latest_turn: publicTurn({
                id: 'turn-1',
                session_id: 'session-1',
                status: turnStatus,
              }),
            }),
          ),
        ),
      });
      expect(
        await provider.getSession('session-1', { clientId: 'client-1' }),
      ).toEqual(
        expect.objectContaining({
          phase,
          capabilities: { canSend, canCancel },
        }),
      );
    },
  );

  it('maps the session list page, sends cursor and limit, and passes through nextCursor', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        object: 'list',
        data: [publicSession({ id: 'list-1', last_event_id: 3 })],
        has_more: true,
        next_cursor: 'cursor-2',
      }),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const page = await provider.listSessions({
      clientId: 'client-1',
      cursor: 'cursor-1',
      limit: 25,
    });

    expect(page.nextCursor).toBe('cursor-2');
    expect(page.sessions).toHaveLength(1);
    expect(page.sessions[0]).toEqual(
      expect.objectContaining({
        sessionId: 'list-1',
        capabilities: expect.objectContaining({ canSend: true }),
      }),
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://product.example/v1/agents/sessions?cursor=cursor-1&limit=25',
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('sends the paging cursor verbatim on transcript queries', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        events: [],
        items: [],
        last_sequence: 7,
        covered_sequence: 5,
        has_more: true,
        older_cursor: 'older-1',
      }),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const transcript = await provider.getTranscript('session-1', {
      clientId: 'client-1',
      before: 'before-1',
      limit: 25,
    });

    expect(transcript.olderCursor).toBe('older-1');
    expect(transcript.lastEventId).toBe(5);
    expect(transcript.history).toBe('items');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://product.example/v1/agents/sessions/session-1/transcript?cursor=before-1&limit=25',
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['negative', -1],
    ['fractional', 1.5],
  ])(
    'rejects %s message coverage instead of resuming at the head',
    async (_label, coverage) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          events: [],
          items: [],
          last_sequence: 400,
          covered_sequence: coverage,
          has_more: false,
        }),
      );
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: fetchImpl,
      });
      await expect(
        provider.getTranscript('session-1', {
          clientId: 'client-1',
          limit: 100,
        }),
      ).rejects.toThrow('Invalid message transcript coverage.');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('forwards personal memory only when explicitly selected', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse(
        publicSession({
          id: 's',
          latest_turn: publicTurn({ id: 't', session_id: 's' }),
        }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    await provider.createSession(
      { text: 'hello', memoryStoreId: 'memstore_personal' },
      { clientId: 'client', idempotencyKey: 'with-memory' },
    );
    await provider.createSession(
      { text: 'hello' },
      { clientId: 'client', idempotencyKey: 'without-memory' },
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toMatchObject(
      {
        memory_store_id: 'memstore_personal',
      },
    );
    expect(
      JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)),
    ).not.toHaveProperty('memory_store_id');
  });

  it('sends idempotent create, submit, and cancel commands only to Java', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const url = String(input);
        // Create answers the Session (the admission is synthesized from its
        // latest_turn); submit and cancel share the events route and answer a
        // TurnCommandAdmission.
        return jsonResponse(
          url.endsWith('/sessions')
            ? publicSession({
                id: 'session-1',
                latest_turn: publicTurn({
                  id: 'turn-1',
                  session_id: 'session-1',
                }),
              })
            : {
                session_id: 'session-1',
                turn_id: 'turn-2',
                status: 'accepted',
                replayed: false,
                operation_id: 'op-1',
                admission_stage: 'java_durable',
                delivery_state: 'pending',
              },
        );
      });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    const options = { clientId: 'client-1', idempotencyKey: 'key-1' };

    await provider.createSession({ text: 'hello' }, options);
    await expect(
      provider.submitPrompt('session-1', { text: 'next' }, options),
    ).resolves.toEqual({
      sessionId: 'session-1',
      turnId: 'turn-2',
      operationId: 'op-1',
    });
    await expect(
      provider.cancel('session-1', 'turn-2', options),
    ).resolves.toEqual({
      sessionId: 'session-1',
      turnId: 'turn-2',
      operationId: 'op-1',
    });

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://product.example/v1/agents/sessions',
      'https://product.example/v1/agents/sessions/session-1/events',
      'https://product.example/v1/agents/sessions/session-1/events',
    ]);
    const createBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(createBody).toEqual(
      expect.objectContaining({
        agent_id: 'qwen-code',
        input: [{ type: 'input_text', text: 'hello' }],
      }),
    );
    expect(createBody).not.toHaveProperty('environmentId');
    expect(createBody).not.toHaveProperty('requestId');
    // The Public input event carries only type + input; the WebShell metadata
    // echo has no Public counterpart and is dropped.
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      type: 'agent.session.input.message',
      input: [{ type: 'input_text', text: 'next' }],
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({
      type: 'agent.session.cancel',
      turn_id: 'turn-2',
    });
    for (const [, init] of fetchImpl.mock.calls) {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty(
        'admissionProfile',
      );
      expect(JSON.parse(String(init?.body))).not.toHaveProperty(
        'idempotencyKey',
      );
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('key-1');
    }
  });

  it.each(['submit', 'cancel'] as const)(
    'rejects a %s response without its durable operation',
    async (command) => {
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse({
            session_id: 'session-1',
            turn_id: 'turn-1',
            status: 'accepted',
            replayed: false,
          }),
        ),
      });
      const options = { clientId: 'client-1', idempotencyKey: 'original-key' };
      const result =
        command === 'submit'
          ? provider.submitPrompt('session-1', { text: 'Continue' }, options)
          : provider.cancel('session-1', 'turn-1', options);
      await expect(result).rejects.toThrow(/identity/);
    },
  );

  it('strips control characters from the derived create title', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse(
        publicSession({
          id: 'session-1',
          latest_turn: publicTurn({ id: 'turn-1', session_id: 'session-1' }),
        }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    // Pasted terminal output carries ANSI escapes, NUL, BEL or DEL; the
    // server refuses C0 control characters in a title with 400
    // invalid_title, so the derivation strips them before posting.
    await provider.createSession(
      { text: '\u001b[31mERROR\u001b[0m the build failed\u0007' },
      { clientId: 'client-1', idempotencyKey: 'key-1' },
    );

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://product.example/v1/agents/sessions');
    expect(JSON.parse(String(init?.body)).title).toBe(
      '[31mERROR [0m the build failed',
    );
  });

  it('preserves creation Skills and the prompt-derived title for a Workspace-bound create', async () => {
    const skills = [
      {
        name: 'review',
        description: 'Review the current change.',
        body: 'Check the current change for regressions.',
        user_invocable: true,
        model_invocable: true,
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse(
        publicSession({
          id: 'session-1',
          latest_turn: publicTurn({ id: 'turn-1', session_id: 'session-1' }),
        }),
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      productScope: 'tenant:actor',
      enableWorkspaceBinding: true,
    });

    // The bound create omitted the title, so the list and header showed a
    // Session-ID prefix while the standard shell shows a prompt-derived title.
    await provider.workspaceBinding!.createSession!(
      {
        agentId: 'qwen-code',
        workspaceId: 'ws-default',
        cwdRelative: 'services/api',
        text: '\u001b[31mERROR\u001b[0m the build failed',
        skills,
      },
      { clientId: 'client-1', idempotencyKey: 'key-1' },
    );

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.title).toBe('[31mERROR [0m the build failed');
    expect(body.skills).toEqual(skills);
    expect(
      new Headers(fetchImpl.mock.calls[0]![1]?.headers).get('idempotency-key'),
    ).toBe('key-1');
    expect(body.workspace).toEqual({
      workspace_id: 'ws-default',
      cwd_relative: 'services/api',
    });

    // The cap must slice by code point: a code-unit cut at 77 splits an astral
    // character, sending a title that ends in a lone high surrogate, which no
    // store column keeps, so the server would persist the tail as '?'.
    await provider.workspaceBinding!.createSession!(
      {
        agentId: 'qwen-code',
        workspaceId: 'ws-default',
        cwdRelative: 'services/api',
        text: `${'a'.repeat(76)}\u{1f600}${'b'.repeat(10)}`,
      },
      { clientId: 'client-1', idempotencyKey: 'key-2' },
    );
    const capped = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body)).title;
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(capped)).toBe(false);
  });

  it('scopes the storageKey by product identity', () => {
    const a = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor-a',
    });
    const b = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor-b',
    });
    expect(a.storageKey).not.toBe(b.storageKey);
    expect(a.storageKey).toContain('tenant:actor-a');
  });

  it('uses lastEventId only as the Java public sequence cursor', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        `id: 9\nevent: turn.completed\ndata: ${JSON.stringify(
          publicEvent({
            sequence: 9,
            event_id: 'evt_9',
            type: 'turn.completed',
          }),
        )}\n\n`,
        { status: 200 },
      ),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const events = [];
    for await (const event of provider.subscribeEvents('session-1', {
      clientId: 'client-1',
      lastEventId: 8,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ id: 9, type: 'completed' }),
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://product.example/v1/agents/sessions/session-1/events?stream=true&after=8',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
  });

  it('forwards stream establishment to the subscribe caller', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          `id: 9\nevent: turn.completed\ndata: ${JSON.stringify(
            publicEvent({
              sequence: 9,
              event_id: 'evt_9',
              type: 'turn.completed',
            }),
          )}\n\n`,
          { status: 200 },
        ),
      ),
    });
    const onEstablished = vi.fn();
    const events = [];
    for await (const event of provider.subscribeEvents('session-1', {
      clientId: 'client-1',
      lastEventId: 8,
      onEstablished,
    })) {
      events.push(event);
    }
    expect(onEstablished).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({ id: 9, type: 'completed' }),
    ]);
  });

  it('forwards stream keep-alives to the subscribe caller', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          `: keepalive\r\n\r\nid: 9\nevent: turn.completed\ndata: ${JSON.stringify(
            publicEvent({
              sequence: 9,
              event_id: 'evt_9',
              type: 'turn.completed',
            }),
          )}\n\n: keepalive\n\n`,
          { status: 200 },
        ),
      ),
    });
    const onAlive = vi.fn();
    const events = [];
    for await (const event of provider.subscribeEvents('session-1', {
      clientId: 'client-1',
      lastEventId: 8,
      onAlive,
    })) {
      events.push(event);
    }
    expect(onAlive).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      expect.objectContaining({ id: 9, type: 'completed' }),
    ]);
  });

  it('turns a resync frame into a stream gap and stops', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          `event:agent.session.resync_required\ndata:${JSON.stringify({
            type: 'agent.session.resync_required',
            session_id: 'session-1',
            replay_floor_sequence: 40,
            snapshot_through_sequence: 42,
            action: 'reload_snapshot',
          })}\n\nid: 43\nevent: turn.completed\ndata: ${JSON.stringify(
            publicEvent({
              sequence: 43,
              event_id: 'evt_43',
              type: 'turn.completed',
            }),
          )}\n\n`,
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of provider.subscribeEvents('session-1', {
      clientId: 'client-1',
      lastEventId: 3,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        id: 3,
        type: 'stream_gap',
        sessionId: 'session-1',
        data: expect.objectContaining({ replayFloorSequence: 40 }),
      }),
    ]);
  });

  it('projects a bounded transcript snapshot from canonical Java events', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        items: [],
        events: [
          publicEvent({
            sequence: 1,
            event_id: 'evt_1',
            type: 'turn.accepted',
            // Event data payloads are shared record bodies, never re-keyed.
            data: { input: [{ type: 'text', text: 'hello' }] },
            terminal: false,
          }),
          publicEvent({
            sequence: 2,
            event_id: 'evt_2',
            type: 'item.output_text.delta',
            data: { text: 'world' },
            terminal: false,
          }),
        ],
        older_cursor: 'older-1',
        has_more: true,
        last_sequence: 4,
        covered_sequence: 4,
      }),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const transcript = await provider.getTranscript('session-1', {
      clientId: 'client-1',
      limit: 100,
    });

    expect(transcript.events).toEqual([
      expect.objectContaining({ id: 1, type: 'accepted' }),
      expect.objectContaining({ id: 2, type: 'assistant_delta' }),
    ]);
    expect(transcript.olderCursor).toBe('older-1');
    expect(transcript.lastEventId).toBe(4);
  });

  it('hydrates history from durable items plus control events', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'input-1',
            object: 'agent.item',
            session_id: 'session-1',
            turn_id: 'turn-1',
            type: 'message',
            role: 'user',
            revision: 1,
            status: 'completed',
            content: [
              {
                part_id: 'input-part-1',
                type: 'input_text',
                text: 'hello',
                first_sequence: 1,
                last_sequence: 1,
              },
            ],
            attributes: {},
            first_sequence: 1,
            last_sequence: 1,
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
          },
          {
            id: 'output-1',
            object: 'agent.item',
            session_id: 'session-1',
            turn_id: 'turn-1',
            type: 'message',
            role: 'assistant',
            revision: 2,
            status: 'completed',
            content: [
              {
                part_id: 'output-part-1',
                type: 'output_text',
                text: 'world',
                first_sequence: 2,
                last_sequence: 3,
              },
            ],
            attributes: {},
            first_sequence: 2,
            last_sequence: 4,
            created_at: CREATED_AT,
            updated_at: CREATED_AT + 2,
          },
        ],
        events: [
          publicEvent({
            sequence: 4,
            event_id: 'evt_4',
            type: 'turn.completed',
          }),
        ],
        covered_sequence: 4,
        has_more: false,
        last_sequence: 4,
      }),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const transcript = await provider.getTranscript('session-1', {
      clientId: 'client-1',
    });

    expect(transcript.events).toEqual([
      expect.objectContaining({
        id: 1,
        type: 'accepted',
        assembledFromItem: true,
      }),
      expect.objectContaining({
        id: 2,
        type: 'assistant_delta',
        data: { itemId: 'output-1', text: 'world' },
        assembledFromItem: true,
      }),
      expect.objectContaining({ id: 4, type: 'completed' }),
    ]);
    expect(transcript.olderCursor).toBeUndefined();
    expect(transcript.lastEventId).toBe(4);
  });

  it.each([
    undefined,
    { text: '{"input":', truncated: true, byteLength: 9000 },
  ])(
    'lists pending Actions with optional preview %j, sends revisions, and rejects a failed replay',
    async (inputPreview) => {
      const permission = {
        id: 'tool_approval_1',
        session_id: 'session-1',
        kind: 'permission',
        source: { type: 'tool_call' },
        state: 'requested',
        input_revision: 1,
        policy_revision: 'hosted-tool-approval/1',
        // Action timestamps are epoch millis on both wires.
        created_at: ACTION_CREATED_AT,
        expires_at: ACTION_EXPIRES_AT,
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
        turn_id: 'turn-1',
        function_call_id: 'call-1',
        tool_name: 'write_file',
        ...(inputPreview
          ? {
              input_preview: {
                text: inputPreview.text,
                truncated: inputPreview.truncated,
                byte_length: inputPreview.byteLength,
              },
            }
          : {}),
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            data: [
              permission,
              { ...permission, id: 'tool_approval_2', state: 'decided' },
              {
                ...permission,
                id: 'question_1',
                kind: 'question',
                state: 'decided',
                questions: [],
              },
            ],
            has_more: false,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: 'op-1',
            session_id: 'session-1',
            type: 'action_response',
            status: 'running',
            admission_stage: 'java_durable',
            delivery_state: 'leased',
            replayed: false,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: 'op-1',
            session_id: 'session-1',
            type: 'action_response',
            status: 'completed',
            admission_stage: 'harness_confirmed',
            delivery_state: 'confirmed',
            replayed: false,
          }),
        );
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: fetchImpl,
      });

      const pending = await provider.actions!.listPending('session-1', {
        clientId: 'client-1',
      });
      expect(pending).toEqual([
        {
          actionId: 'tool_approval_1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          functionCallId: 'call-1',
          toolName: 'write_file',
          inputRevision: 1,
          policyRevision: 'hosted-tool-approval/1',
          createdAt: ACTION_CREATED_AT,
          expiresAt: ACTION_EXPIRES_AT,
          ...(inputPreview ? { inputPreview } : {}),
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' },
          ],
        },
      ]);
      expect(String(fetchImpl.mock.calls[0][0])).toBe(
        'https://product.example/v1/agents/sessions/session-1/actions?limit=20',
      );
      expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');

      await provider.actions!.respond(pending[0], 'deny', {
        clientId: 'client-1',
        idempotencyKey: 'tool_approval_1:deny',
      });
      expect(String(fetchImpl.mock.calls[1][0])).toBe(
        'https://product.example/v1/agents/sessions/session-1/actions/tool_approval_1/responses',
      );
      expect(fetchImpl.mock.calls[1][1]?.method).toBe('POST');
      expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
        kind: 'permission',
        input_revision: 1,
        policy_revision: 'hosted-tool-approval/1',
        option_id: 'deny',
      });
      expect(
        new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
      ).toBe('tool_approval_1:deny');
      // The accepted answer is followed on its own operation, not re-sent.
      expect(String(fetchImpl.mock.calls[2][0])).toBe(
        'https://product.example/v1/agents/sessions/session-1/operations/op-1',
      );
      expect(fetchImpl.mock.calls[2][1]?.method).toBe('GET');
      expect(fetchImpl.mock.calls[2][1]?.body).toBeUndefined();

      fetchImpl.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'op-1',
            session_id: 'session-1',
            type: 'action_response',
            status: 'failed',
            admission_stage: 'java_durable',
            delivery_state: 'blocked',
            failure_code: 'action_delivery_failed',
            replayed: true,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
      );
      await expect(
        provider.actions!.respond(pending[0], 'deny', {
          clientId: 'client-1',
          idempotencyKey: 'tool_approval_1:deny',
        }),
      ).rejects.toThrow('action_delivery_failed');

      // The failure code rides the error so the hook can classify it (an ended
      // Action vs a delivery failure worth retrying).
      fetchImpl.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'op-2',
            session_id: 'session-1',
            type: 'action_response',
            status: 'failed',
            admission_stage: 'java_durable',
            delivery_state: 'confirmed',
            failure_code: 'action_response_delivery_failed',
            replayed: true,
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
      );
      await expect(
        provider.actions!.respond(pending[0], 'deny', {
          clientId: 'client-1',
          idempotencyKey: 'tool_approval_1:deny',
        }),
      ).rejects.toMatchObject({ code: 'action_response_delivery_failed' });

      for (const status of ['cancelled', 'recovery_blocked'] as const) {
        fetchImpl.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: `op-${status}`,
              session_id: 'session-1',
              type: 'action_response',
              status,
              admission_stage: 'java_durable',
              delivery_state: 'blocked',
              replayed: true,
            }),
            { status: 202, headers: { 'content-type': 'application/json' } },
          ),
        );
        await expect(
          provider.actions!.respond(pending[0], 'deny', {
            clientId: 'client-1',
            idempotencyKey: 'tool_approval_1:deny',
          }),
        ).rejects.toThrow(`approval answer ${status}`);
      }
    },
  );

  it('lists a durable question and submits its structured answer through the existing operation', async () => {
    const question = pendingQuestion();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: question.actionId,
              session_id: question.sessionId,
              kind: 'question',
              source: { kind: 'tool_call', id: question.functionCallId },
              state: 'requested',
              input_revision: question.inputRevision,
              policy_revision: question.policyRevision,
              created_at: ACTION_CREATED_AT,
              expires_at: question.expiresAt,
              turn_id: question.turnId,
              function_call_id: question.functionCallId,
              tool_name: question.toolName,
              questions: question.questions.map((entry) => ({
                id: entry.id,
                prompt: entry.prompt,
                required: entry.required,
                multiple: entry.multiple,
                allow_text: entry.allowText,
                options: entry.options,
              })),
            },
          ],
          has_more: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'question-response',
          session_id: question.sessionId,
          type: 'action_response',
          status: 'completed',
          admission_stage: 'harness_confirmed',
          delivery_state: 'confirmed',
          replayed: false,
        }),
      );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    const pending = await provider.actions!.listPending(question.sessionId, {
      clientId: 'client',
    });
    expect(pending).toEqual([{ ...question, createdAt: ACTION_CREATED_AT }]);
    const response = {
      kind: 'question' as const,
      answers: [
        { questionId: 'q1', optionIds: ['q1o2'] },
        { questionId: 'q2', optionIds: ['q2o1', 'q2o2'], text: 'custom' },
      ],
    };
    await provider.actions!.respond(question, response, {
      clientId: 'client',
      idempotencyKey: 'question:stable-digest',
    });
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      `https://product.example/v1/agents/sessions/${question.sessionId}/actions/${question.actionId}/responses`,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      kind: 'question',
      input_revision: question.inputRevision,
      policy_revision: question.policyRevision,
      answers: [
        { question_id: 'q1', option_ids: ['q1o2'] },
        { question_id: 'q2', option_ids: ['q2o1', 'q2o2'], text: 'custom' },
      ],
    });
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
    ).toBe('question:stable-digest');
    await expect(
      provider.actions!.respond(question, 'allow', {
        clientId: 'client',
        idempotencyKey: 'invalid',
      }),
    ).rejects.toThrow('kind does not match');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  describe('an accepted approval answer', () => {
    const action = {
      actionId: 'tool_approval_1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      functionCallId: 'call-1',
      toolName: 'write_file',
      inputRevision: 1,
      policyRevision: 'hosted-tool-approval/1',
      expiresAt: 600_001,
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
    };
    const operation = (status: string, failureCode?: string) =>
      jsonResponse({
        id: 'op-1',
        session_id: 'session-1',
        type: 'action_response',
        status,
        admission_stage: 'java_durable',
        delivery_state: status === 'running' ? 'leased' : 'confirmed',
        ...(failureCode ? { failure_code: failureCode } : {}),
        replayed: false,
      });
    const urls = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
      fetchImpl.mock.calls.map(([url]) =>
        String(url).replace('https://product.example/v1/agents', ''),
      );

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects when the operation it was accepted on later fails', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(operation('pending'))
        .mockResolvedValueOnce(operation('running'))
        .mockResolvedValueOnce(operation('failed', 'workspace_unavailable'));
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: fetchImpl,
      });

      // eslint-disable-next-line vitest/valid-expect -- awaited via `answer` below, after the fake timers advance (handler attached early so the rejection is not unhandled)
      const answer = expect(
        provider.actions!.respond(action, 'allow', {
          clientId: 'client-1',
          idempotencyKey: 'tool_approval_1:allow',
        }),
      ).rejects.toThrow('approval answer failed (workspace_unavailable)');
      await vi.advanceTimersByTimeAsync(30_000);
      await answer;
      expect(urls(fetchImpl)).toEqual([
        '/sessions/session-1/actions/tool_approval_1/responses',
        '/sessions/session-1/operations/op-1',
        '/sessions/session-1/operations/op-1',
      ]);
    });

    it('reports an answer still unsettled after the polling budget as unconfirmed', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => operation('running'));
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: fetchImpl,
      });

      // eslint-disable-next-line vitest/valid-expect -- awaited via `answer` below, after the fake timers advance (handler attached early so the rejection is not unhandled)
      const answer = expect(
        provider.actions!.respond(action, 'allow', {
          clientId: 'client-1',
          idempotencyKey: 'tool_approval_1:allow',
        }),
      ).rejects.toThrow('not confirmed yet (operation op-1 is running)');
      await vi.advanceTimersByTimeAsync(60_000);
      await answer;
      const calls = urls(fetchImpl);
      // One answer, then reads of that same operation only.
      expect(calls[0]).toBe(
        '/sessions/session-1/actions/tool_approval_1/responses',
      );
      expect(
        calls
          .slice(1)
          .every((url) => url === '/sessions/session-1/operations/op-1'),
      ).toBe(true);
      expect(calls.length).toBeGreaterThan(2);
    });
  });

  it('reports the actions capability only when the Session has it', async () => {
    const session = publicSession({ id: 'session-1' });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(
            publicSession({
              id: 'session-1',
              capabilities: publicCapabilities({ actions: true, tasks: false }),
            }),
          ),
        )
        .mockResolvedValueOnce(jsonResponse(session)),
    });
    expect(
      (await provider.getSession('session-1', { clientId: 'c' })).capabilities,
    ).toEqual({ canSend: true, canCancel: false, actions: true });
    expect(
      (await provider.getSession('session-1', { clientId: 'c' })).capabilities,
    ).toEqual({ canSend: true, canCancel: false });
  });

  it('reports the terminal capability from the Session summary', async () => {
    const session = {
      sessionId: 'session-1',
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1,
      lastSequence: 0,
    };
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            ...session,
            capabilities: { terminal: true },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            ...session,
            capabilities: { terminal: null },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ ...session, capabilities: {} })),
    });
    const load = () => provider.getSession('session-1', { clientId: 'c' });
    expect((await load()).capabilities).toEqual({
      canSend: true,
      canCancel: false,
      terminal: true,
    });
    expect((await load()).capabilities).toEqual({
      canSend: true,
      canCancel: false,
      terminal: null,
    });
    expect((await load()).capabilities).toEqual({
      canSend: true,
      canCancel: false,
    });
  });

  it('lets a bound Session send only when the service allows its caller', async () => {
    const bound = {
      id: 'bound-1',
      last_event_id: 3,
      workspace: { workspace_id: 'ws-a', cwd_relative: '.' },
    };
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(
            publicSession({
              ...bound,
              capabilities: publicCapabilities({
                tasks: true,
                workspace_turns: true,
              }),
            }),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            publicSession({
              ...bound,
              capabilities: publicCapabilities({
                tasks: true,
                workspace_turns: false,
              }),
            }),
          ),
        ),
    });

    // The Public contract derives diagnostics from tasks.
    expect(
      (await provider.getSession('bound-1', { clientId: 'c' })).capabilities,
    ).toEqual({
      canSend: true,
      canCancel: false,
      workspaceTurns: true,
      tasks: true,
      diagnostics: true,
    });
    expect(
      (await provider.getSession('bound-1', { clientId: 'c' })).capabilities,
    ).toEqual({
      canSend: false,
      canCancel: false,
      tasks: true,
      diagnostics: true,
    });
  });

  it.each([true, false])(
    'offers cancel for a running bound Turn when workspaceTurns is %s',
    async (workspaceTurns) => {
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(
            publicSession({
              id: 'bound-1',
              last_event_id: 5,
              workspace: { workspace_id: 'ws-a', cwd_relative: '.' },
              latest_turn: publicTurn({
                id: 'turn-2',
                session_id: 'bound-1',
                status: 'running',
              }),
              capabilities: publicCapabilities({
                tasks: true,
                workspace_turns: workspaceTurns,
              }),
            }),
          ),
        ),
      });
      // The creator may still cancel after the Workspace stops admitting
      // new work, so cancel does not follow workspaceTurns; the server
      // refuses anyone else.
      expect(
        (await provider.getSession('bound-1', { clientId: 'c' })).capabilities,
      ).toEqual({
        canSend: false,
        canCancel: true,
        tasks: true,
        diagnostics: true,
        ...(workspaceTurns ? { workspaceTurns: true } : {}),
      });
    },
  );

  it.each([true, false])(
    'gates fresh Shell sending with foregroundShell=%s while retaining cancellation',
    async (enabled) => {
      const base = {
        id: 'shell-1',
        last_event_id: 5,
        workspace: { workspace_id: 'ws-a', cwd_relative: '.' },
        capabilities: publicCapabilities({
          tasks: true,
          workspace_turns: true,
          foreground_shell: enabled,
        }),
      };
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(jsonResponse(publicSession(base)))
          .mockResolvedValueOnce(
            jsonResponse(
              publicSession({
                ...base,
                latest_turn: publicTurn({
                  id: 'turn-1',
                  session_id: 'shell-1',
                  status: 'running',
                }),
              }),
            ),
          ),
      });
      expect(
        (await provider.getSession('shell-1', { clientId: 'c' })).capabilities,
      ).toEqual({
        canSend: enabled,
        canCancel: false,
        workspaceTurns: true,
        tasks: true,
        diagnostics: true,
      });
      expect(
        (await provider.getSession('shell-1', { clientId: 'c' })).capabilities,
      ).toEqual({
        canSend: false,
        canCancel: true,
        workspaceTurns: true,
        tasks: true,
        diagnostics: true,
      });
    },
  );

  it('passes download cancellation through the host sink to the content fetch', async () => {
    const abort = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        expect(init?.signal).toBe(abort.signal);
        return new Response('hello', {
          status: 200,
          headers: { etag: `"${artifact.sha256}"`, 'content-length': '5' },
        });
      });
    const saveArtifact = vi.fn(async (_artifact, options) => {
      expect(options.signal).toBe(abort.signal);
      const stream = await options.openStream();
      expect(await stream.getReader().read()).toMatchObject({ done: false });
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      saveArtifact,
    });
    await provider.toolResults!.downloadArtifact(artifact, {
      clientId: 'client',
      signal: abort.signal,
    });
    expect(saveArtifact).toHaveBeenCalledWith(
      artifact,
      expect.objectContaining({
        signal: abort.signal,
        openStream: expect.any(Function),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
