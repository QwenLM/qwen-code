import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifact } from './managed-tool-result.test-fixtures';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createJavaManagedAgentProvider', () => {
  it('keeps an empty bound session idle and disables execution', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant-a:actor-a',
      enableWorkspaceBinding: true,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          sessionId: 'empty-1',
          status: 'ACTIVE',
          createdAt: 1,
          updatedAt: 1,
          lastSequence: 0,
          workspace: { workspaceId: 'ws-a', cwdRelative: 'services/api' },
        }),
      ),
    });
    expect(
      await provider.getSession('empty-1', { clientId: 'client' }),
    ).toEqual(
      expect.objectContaining({
        phase: 'created',
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
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse({
            sessionId: 'empty-1',
            status: 'ACTIVE',
            createdAt: 1,
            updatedAt: 1,
            lastSequence: 0,
          }),
        ),
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

  it('creates a bound empty session without requiring turnId', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      jsonResponse(
        String(input).includes('/workspaces/query')
          ? {
              data: [
                {
                  workspaceId: 'ws-a',
                  displayName: 'A',
                  state: 'active',
                  canCreateSession: true,
                },
              ],
              defaultWorkspace: null,
              hasMore: false,
              nextCursor: null,
              capabilities: {
                workspaceBinding: true,
                workspaceContext: false,
              },
            }
          : { sessionId: 'empty-1', status: 'accepted', replayed: false },
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
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual(
      expect.objectContaining({
        requestId: expect.stringMatching(/^managed_/),
        agentId: 'agent-a',
        input: [],
        idempotencyKey: 'key-a',
        workspace: { workspaceId: 'ws-a', cwdRelative: './docs' },
      }),
    );
    expect(provider.storageKey).toContain('agent-a');
    expect(() =>
      createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        enableWorkspaceBinding: true,
      }),
    ).toThrow('productScope');
  });
  it('maps Java session, environment, and active turn state', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        sessionId: 'session-1',
        title: 'Managed task',
        status: 'ACTIVE',
        createdAt: 10,
        updatedAt: 20,
        activeTurn: {
          turnId: 'turn-1',
          sessionId: 'session-1',
          status: 'IN_PROGRESS',
          submittedAt: 11,
        },
        environment: {
          environmentId: 'python',
          state: 'starting',
        },
        lastSequence: 3,
      }),
    );
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example?token=not-stored',
      environmentId: 'python',
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
      'https://product.example/api/agent/web-shell/v1/sessions/get',
    );
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
          jsonResponse({
            sessionId: 'session-1',
            status,
            createdAt: 1,
            updatedAt: 2,
            activeTurn: {
              turnId: 'turn-1',
              status: turnStatus,
              submittedAt: 1,
            },
          }),
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
        data: [
          {
            sessionId: 'list-1',
            status: 'ACTIVE',
            createdAt: 1,
            updatedAt: 2,
            lastSequence: 3,
          },
        ],
        hasMore: true,
        nextCursor: 'cursor-2',
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
      'https://product.example/api/agent/web-shell/v1/sessions/query',
    );
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({ cursor: 'cursor-1', limit: 25 }),
    );
  });

  it('sends the paging cursor verbatim on transcript queries', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        events: [],
        items: [],
        lastSequence: 7,
        hasMore: true,
        olderCursor: 'older-1',
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
    expect(transcript.lastEventId).toBe(7);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://product.example/api/agent/web-shell/v1/transcript/query',
    );
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        sessionId: 'session-1',
        cursor: 'before-1',
        limit: 25,
      }),
    );
  });

  it('sends idempotent create, submit, and cancel commands only to Java', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => {
        const url = String(input);
        return jsonResponse({
          sessionId: 'session-1',
          turnId: url.includes('/sessions/create') ? 'turn-1' : 'turn-2',
          status: 'accepted',
          replayed: false,
        });
      });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      environmentId: 'python',
      fetch: fetchImpl,
    });
    const options = { clientId: 'client-1', idempotencyKey: 'key-1' };

    await provider.createSession({ text: 'hello' }, options);
    await provider.submitPrompt('session-1', { text: 'next' }, options);
    await provider.cancel('session-1', 'turn-2', options);

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://product.example/api/agent/web-shell/v1/sessions/create',
      'https://product.example/api/agent/web-shell/v1/turns/submit',
      'https://product.example/api/agent/web-shell/v1/turns/cancel',
    ]);
    const createBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(createBody).toEqual(
      expect.objectContaining({
        requestId: expect.stringMatching(/^managed_/),
        idempotencyKey: 'key-1',
        agentId: 'qwen-code',
        input: [{ type: 'input_text', text: 'hello' }],
      }),
    );
    // The standalone Java contract 400s any non-blank environmentId; the
    // option stays a storageKey scope input only.
    expect(createBody).not.toHaveProperty('environmentId');
  });

  it('scopes the storageKey by environmentId when no productScope is given', () => {
    const a = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      environmentId: 'env-a',
    });
    const b = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      environmentId: 'env-b',
    });
    expect(a.storageKey).not.toBe(b.storageKey);
    expect(a.storageKey).toContain('env-a');
  });

  it('uses lastEventId only as the Java public sequence cursor', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          'id: 9\nevent: turn.completed\ndata: {"sequence":9,"eventId":"evt_9","sessionId":"session-1","turnId":"turn-1","type":"turn.completed","createdAt":9,"data":{},"terminal":true}\n\n',
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
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      sessionId: 'session-1',
      afterSequence: 8,
    });
  });

  it('forwards stream establishment to the subscribe caller', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            'id: 9\nevent: turn.completed\ndata: {"sequence":9,"eventId":"evt_9","sessionId":"session-1","turnId":"turn-1","type":"turn.completed","createdAt":9,"data":{},"terminal":true}\n\n',
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

  it('turns a resync frame into a stream gap and stops', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            'event:agent.session.resync_required\ndata:{"type":"agent.session.resync_required","sessionId":"session-1","replayFloorSequence":40,"snapshotThroughSequence":42,"action":"reload_snapshot"}\n\nid: 43\nevent: turn.completed\ndata: {"sequence":43,"eventId":"evt_43","sessionId":"session-1","turnId":"turn-1","type":"turn.completed","createdAt":43,"data":{},"terminal":true}\n\n',
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
        events: [
          {
            sequence: 1,
            eventId: 'evt_1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            type: 'turn.accepted',
            createdAt: 1,
            data: { input: [{ type: 'text', text: 'hello' }] },
            terminal: false,
          },
          {
            sequence: 2,
            eventId: 'evt_2',
            sessionId: 'session-1',
            turnId: 'turn-1',
            type: 'item.output_text.delta',
            createdAt: 2,
            data: { text: 'world' },
            terminal: false,
          },
        ],
        olderCursor: 'older-1',
        hasMore: true,
        lastSequence: 4,
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
            itemId: 'input-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            type: 'message',
            role: 'user',
            status: 'completed',
            content: [
              {
                partId: 'input-part-1',
                type: 'input_text',
                text: 'hello',
                firstSequence: 1,
                lastSequence: 1,
              },
            ],
            attributes: {},
            firstSequence: 1,
            lastSequence: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            itemId: 'output-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                partId: 'output-part-1',
                type: 'output_text',
                text: 'world',
                firstSequence: 2,
                lastSequence: 3,
              },
            ],
            attributes: {},
            firstSequence: 2,
            lastSequence: 4,
            createdAt: 2,
            updatedAt: 4,
          },
        ],
        events: [
          {
            sequence: 4,
            eventId: 'evt_4',
            sessionId: 'session-1',
            turnId: 'turn-1',
            type: 'turn.completed',
            createdAt: 4,
            data: {},
            terminal: true,
          },
        ],
        coveredSequence: 4,
        hasMore: false,
        lastSequence: 4,
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
        actionId: 'tool_approval_1',
        sessionId: 'session-1',
        kind: 'permission',
        source: { type: 'tool_call' },
        state: 'requested',
        inputRevision: 1,
        policyRevision: 'hosted-tool-approval/1',
        createdAt: 1,
        expiresAt: 600_001,
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
        turnId: 'turn-1',
        functionCallId: 'call-1',
        toolName: 'write_file',
        ...(inputPreview ? { inputPreview } : {}),
      };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            data: [
              permission,
              { ...permission, actionId: 'tool_approval_2', state: 'decided' },
              {
                ...permission,
                actionId: 'question_1',
                kind: 'question',
                questions: [],
              },
            ],
            hasMore: false,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({ operationId: 'op-1', status: 'running' }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            operationId: 'op-1',
            type: 'action_response',
            status: 'completed',
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
          expiresAt: 600_001,
          ...(inputPreview ? { inputPreview } : {}),
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' },
          ],
        },
      ]);
      expect(String(fetchImpl.mock.calls[0][0])).toBe(
        'https://product.example/api/agent/web-shell/v1/actions/query',
      );

      await provider.actions!.respond(pending[0], 'deny', {
        clientId: 'client-1',
        idempotencyKey: 'tool_approval_1:deny',
      });
      expect(String(fetchImpl.mock.calls[1][0])).toBe(
        'https://product.example/api/agent/web-shell/v1/actions/respond',
      );
      expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
        requestId: expect.any(String),
        idempotencyKey: 'tool_approval_1:deny',
        sessionId: 'session-1',
        actionId: 'tool_approval_1',
        response: {
          kind: 'permission',
          inputRevision: 1,
          policyRevision: 'hosted-tool-approval/1',
          optionId: 'deny',
        },
      });
      // The accepted answer is followed on its own operation, not re-sent.
      expect(String(fetchImpl.mock.calls[2][0])).toBe(
        'https://product.example/api/agent/web-shell/v1/operations/query',
      );
      expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({
        sessionId: 'session-1',
        operationId: 'op-1',
      });

      fetchImpl.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            operationId: 'op-1',
            sessionId: 'session-1',
            type: 'action_response',
            status: 'failed',
            admissionStage: 'java_durable',
            deliveryState: 'blocked',
            failureCode: 'action_delivery_failed',
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

      for (const status of ['cancelled', 'recovery_blocked'] as const) {
        fetchImpl.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              operationId: `op-${status}`,
              sessionId: 'session-1',
              type: 'action_response',
              status,
              admissionStage: 'java_durable',
              deliveryState: 'blocked',
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
        operationId: 'op-1',
        sessionId: 'session-1',
        type: 'action_response',
        status,
        admissionStage: 'java_durable',
        deliveryState: status === 'running' ? 'leased' : 'confirmed',
        ...(failureCode ? { failureCode } : {}),
        replayed: false,
      });
    const urls = (fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) =>
      fetchImpl.mock.calls.map(([url]) =>
        String(url).replace(
          'https://product.example/api/agent/web-shell/v1',
          '',
        ),
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
        '/actions/respond',
        '/operations/query',
        '/operations/query',
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
      expect(calls[0]).toBe('/actions/respond');
      expect(calls.slice(1).every((url) => url === '/operations/query')).toBe(
        true,
      );
      expect(calls.length).toBeGreaterThan(2);
    });
  });

  it('reports the actions capability only when the Session has it', async () => {
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
            capabilities: { actions: true, tasks: false },
          }),
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

  it('lets a bound Session send only when the service allows its caller', async () => {
    const bound = {
      sessionId: 'bound-1',
      status: 'ACTIVE',
      createdAt: 1,
      updatedAt: 1,
      lastSequence: 3,
      workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
    };
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            ...bound,
            capabilities: { tasks: true, workspaceTurns: true },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            ...bound,
            capabilities: { tasks: true, workspaceTurns: false },
          }),
        ),
    });

    expect(
      (await provider.getSession('bound-1', { clientId: 'c' })).capabilities,
    ).toEqual({ canSend: true, canCancel: false, workspaceTurns: true });
    expect(
      (await provider.getSession('bound-1', { clientId: 'c' })).capabilities,
    ).toEqual({ canSend: false, canCancel: false });
  });

  it('lets the allowed caller cancel a running Turn of a bound Session', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          sessionId: 'bound-1',
          status: 'ACTIVE',
          createdAt: 1,
          updatedAt: 2,
          lastSequence: 5,
          workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
          activeTurn: {
            turnId: 'turn-2',
            sessionId: 'bound-1',
            status: 'RUNNING',
            submittedAt: 2,
          },
          capabilities: { tasks: true, workspaceTurns: true },
        }),
      ),
    });
    expect(
      (await provider.getSession('bound-1', { clientId: 'c' })).capabilities,
    ).toEqual({ canSend: false, canCancel: true, workspaceTurns: true });
  });

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
