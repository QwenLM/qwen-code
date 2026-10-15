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
  it('uses only server model choices and preserves the frozen change key and revision', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          models: [
            { modelId: 'published', label: 'Published', route: 'private' },
          ],
          modelSelection: { revision: 0, provider: 'private' },
          supported: true,
          credentials: 'private',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: 's',
          modelSelection: {
            modelId: 'published',
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
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      sessionId: 's',
      modelId: 'published',
      expectedRevision: 0,
      idempotencyKey: 'original',
    });
    expect(
      createJavaManagedAgentProvider({ baseUrl: 'https://product.example' })
        .modelChange,
    ).toBeUndefined();
  });

  it.each([
    {
      models: [
        { modelId: 'A', label: 'A' },
        { modelId: 'A', label: 'Duplicate' },
      ],
      modelSelection: { revision: 0 },
      supported: true,
    },
    {
      models: [{ modelId: 'A', label: 5 }],
      modelSelection: { revision: 0 },
      supported: true,
    },
    {
      models: [{ modelId: 'A\nroute', label: 'A' }],
      modelSelection: { revision: 0 },
      supported: true,
    },
    { models: [], modelSelection: { revision: -1 }, supported: true },
    { models: [], modelSelection: { revision: 1 }, supported: true },
    { models: [], modelSelection: { revision: 0 }, supported: 'true' },
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
      sessionId: 'other',
      modelSelection: { modelId: 'B', revision: 2 },
      replayed: false,
    },
    {
      sessionId: 's',
      modelSelection: { modelId: 'A', revision: 2 },
      replayed: false,
    },
    {
      sessionId: 's',
      modelSelection: { modelId: 'B', revision: 1 },
      replayed: false,
    },
    {
      sessionId: 's',
      modelSelection: { modelId: 'B', revision: 2.5 },
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
        jsonResponse({
          sessionId: 's',
          agentId: 'agent-a',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
          lastSequence: 0,
          modelContext: value,
        }),
      ),
    });
    return (await provider.getSession('s', { clientId: 'client' }))
      .modelContext;
  }

  it('publishes only observed model-context fields including zero input tokens', async () => {
    expect(
      await readModelContext({
        modelId: 'actual-pinned-model',
        inputTokens: 0,
        contextWindowSize: 1000,
        observedAt: 12,
        rawResource: 'private',
        budget: { totalTokens: 999999 },
        route: 'private',
      }),
    ).toEqual({
      modelId: 'actual-pinned-model',
      inputTokens: 0,
      contextWindowSize: 1000,
      observedAt: 12,
    });
  });

  it.each([
    undefined,
    null,
    {},
    { modelId: 42, observedAt: 1 },
    { modelId: ' ', observedAt: 1 },
    { modelId: 'model', observedAt: -1 },
    { modelId: 'model', observedAt: 1.5 },
    { modelId: 'model', observedAt: Number.MAX_SAFE_INTEGER + 1 },
  ])('omits invalid model observations (%j)', async (value) => {
    expect(await readModelContext(value)).toBeUndefined();
  });

  it.each([
    {
      inputTokens: -1,
      contextWindowSize: 1000,
      expected: { contextWindowSize: 1000 },
    },
    { inputTokens: 10, contextWindowSize: 0, expected: { inputTokens: 10 } },
    {
      inputTokens: 1.5,
      contextWindowSize: Number.MAX_SAFE_INTEGER + 1,
      expected: {},
    },
    { inputTokens: '10', contextWindowSize: '1000', expected: {} },
  ])(
    'does not invent missing or invalid occupancy (%j)',
    async ({ inputTokens, contextWindowSize, expected }) => {
      expect(
        await readModelContext({
          modelId: 'model',
          observedAt: 12,
          inputTokens,
          contextWindowSize,
        }),
      ).toEqual({ modelId: 'model', observedAt: 12, ...expected });
    },
  );

  it('reads tasks without identity scope but only exposes cancellation with a product scope', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: [], hasMore: false }));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    expect(provider.tasks).toBeDefined();
    expect(provider.tasks!.cancel).toBeUndefined();
    expect(
      createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        productScope: '  ',
      }).tasks!.cancel,
    ).toBeUndefined();
    const abort = new AbortController();
    await provider.tasks!.list('s1', {
      clientId: 'client',
      cursor: 'opaque',
      limit: 50,
      signal: abort.signal,
    });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/tasks/query');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      sessionId: 's1',
      cursor: 'opaque',
      limit: 50,
    });
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
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(operation));
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
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual(
      expect.objectContaining({
        sessionId: 's1',
        taskId: 'task1',
        idempotencyKey: 'original',
      }),
    );
    expect(
      await provider.tasks!.cancel!.query('s1', 'task1', 'op1', {
        clientId: 'client',
      }),
    ).toEqual(operation);
    fetchImpl.mockImplementation(async () =>
      jsonResponse({ ...operation, taskId: 'different' }),
    );
    await expect(
      provider.tasks!.cancel!.query('s1', 'task1', 'op1', {
        clientId: 'client',
      }),
    ).rejects.toThrow('identity mismatch');
    fetchImpl.mockImplementation(async () =>
      jsonResponse({ ...operation, type: 'cancel' }),
    );
    await expect(
      provider.tasks!.cancel!.query('s1', 'task1', 'op1', {
        clientId: 'client',
      }),
    ).rejects.toThrow('identity mismatch');
  });
  it('uses the exact cwd request and key and queries its accepted operation', async () => {
    const operation = {
      operationId: 'op-cwd',
      sessionId: 's1',
      type: 'cwd_change',
      status: 'pending',
      expectedContextRevision: 7,
      targetCwdRelative: ' 空格 dir ',
      replayed: false,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(operation));
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: fetchImpl,
    });
    expect(
      await provider.cwdChange!.submit(
        's1',
        { cwdRelative: ' 空格 dir ', expectedContextRevision: 7 },
        { clientId: 'client', idempotencyKey: 'original-key' },
      ),
    ).toEqual(operation);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/sessions/cwd/change',
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual(
      expect.objectContaining({
        sessionId: 's1',
        cwdRelative: ' 空格 dir ',
        expectedContextRevision: 7,
        idempotencyKey: 'original-key',
      }),
    );
    expect(
      await provider.cwdChange!.query('s1', 'op-cwd', { clientId: 'client' }),
    ).toEqual(operation);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('/operations/query');
  });

  it('requires explicit identity scope for cwd recovery and maps its capability independently', async () => {
    const options = {
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          sessionId: 's1',
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
          workspace: {
            workspaceId: 'ws',
            cwdRelative: '.',
            contextRevision: 3,
            state: 'ready',
          },
          capabilities: { cwdChange: true, workspaceTurns: false },
        }),
      ),
    };
    expect(createJavaManagedAgentProvider(options).cwdChange).toBeUndefined();
    expect(
      createJavaManagedAgentProvider({ ...options, productScope: '  ' })
        .cwdChange,
    ).toBeUndefined();
    const provider = createJavaManagedAgentProvider({
      ...options,
      productScope: 'tenant:actor',
    });
    expect(
      (await provider.getSession('s1', { clientId: 'client' })).capabilities
        .cwdChange,
    ).toBe(true);
  });

  it('rejects an unrelated operation returned by the query endpoint', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          sessionId: 'other',
          operationId: 'op',
          type: 'action_response',
          status: 'completed',
        }),
      ),
    });
    await expect(
      provider.cwdChange!.query('s1', 'op', { clientId: 'client' }),
    ).rejects.toThrow();
  });
  it('keeps an empty bound session idle and disables execution', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant-a:actor-a',
      enableWorkspaceBinding: true,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          sessionId: 'empty-1',
          agentId: 'agent-model-a',
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

  it.each([true, false, undefined])(
    'uses only the server Workspace creation capability (%s) and freezes the create command',
    async (workspaceCreation) => {
      const workspace = {
        workspaceId: 'created-a',
        displayName: 'A',
        state: 'active',
        canCreateSession: true,
      };
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
        jsonResponse(
          String(url).endsWith('/workspaces/query')
            ? {
                data: [],
                defaultWorkspace: null,
                hasMore: false,
                capabilities: {
                  workspaceBinding: true,
                  workspaceContext: false,
                  workspaceCreation,
                },
              }
            : workspace,
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
      expect(String(fetchImpl.mock.calls[1][0])).toContain(
        '/workspaces/create',
      );
      expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
        displayName: 'A',
        idempotencyKey: 'saved-key',
      });
      expect(fetchImpl.mock.calls[1][1]?.signal).toBe(abort.signal);
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

  it('discovers policy selection, reads options and sends explicit policies for both bound creation paths', async () => {
    const options = {
      approvalMode: 'default',
      availableApprovalModes: ['default', 'auto-edit'],
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      jsonResponse(
        String(url).endsWith('/workspaces/query')
          ? {
              data: [],
              defaultWorkspace: null,
              hasMore: false,
              capabilities: {
                workspaceBinding: true,
                workspaceContext: false,
                approvalModeSelection: true,
              },
            }
          : String(url).endsWith('/session-options/query')
            ? options
            : { sessionId: 's', turnId: 't' },
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
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      agentId: 'agent-b',
    });
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
        JSON.parse(String(fetchImpl.mock.calls[index][1]?.body)).approvalMode,
      ).toBe('auto-edit');
    await provider.workspaceBinding!.createEmpty(
      { agentId: 'agent-b', workspaceId: 'ws', cwdRelative: '.' },
      command,
    );
    expect(
      JSON.parse(String(fetchImpl.mock.calls[4][1]?.body)),
    ).not.toHaveProperty('approvalMode');
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
          jsonResponse({
            sessionId: 's',
            agentId: 'qwen-code',
            approvalMode,
            status: 'ACTIVE',
            createdAt: 1,
            updatedAt: 1,
            lastSequence: 0,
          }),
        ),
      });
      const summary = await provider.getSession('s', { clientId: 'client' });
      if (['default', 'auto-edit', 'yolo'].includes(String(approvalMode)))
        expect(summary.approvalMode).toBe(approvalMode);
      else expect(summary).not.toHaveProperty('approvalMode');
    },
  );

  it('creates a bound Session and initial Turn in one request with the chosen preset', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ sessionId: 's', turnId: 't' }));
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
        agentId: 'agent-b',
        input: [{ type: 'input_text', text: 'Read README' }],
        workspace: { workspaceId: 'ws-b', cwdRelative: 'src' },
        metadata: { clientId: 'client' },
        idempotencyKey: 'frozen-key',
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects initial-input admission without a Turn identity', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      productScope: 'tenant:actor',
      enableWorkspaceBinding: true,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ sessionId: 's' })),
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
      .mockResolvedValue(jsonResponse({ sessionId: 'empty' }));
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

  it('strips control characters from the derived create title', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'accepted',
        replayed: false,
      }),
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
    expect(String(url)).toBe(
      'https://product.example/api/agent/web-shell/v1/sessions/create',
    );
    expect(JSON.parse(String(init?.body)).title).toBe(
      '[31mERROR [0m the build failed',
    );
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

  it('forwards stream keep-alives to the subscribe caller', async () => {
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            ': keepalive\r\n\r\nid: 9\nevent: turn.completed\ndata: {"sequence":9,"eventId":"evt_9","sessionId":"session-1","turnId":"turn-1","type":"turn.completed","createdAt":9,"data":{},"terminal":true}\n\n: keepalive\n\n',
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
    ).toEqual({
      canSend: true,
      canCancel: false,
      workspaceTurns: true,
      tasks: true,
    });
    expect(
      (await provider.getSession('bound-1', { clientId: 'c' })).capabilities,
    ).toEqual({ canSend: false, canCancel: false, tasks: true });
  });

  it.each([true, false])(
    'offers cancel for a running bound Turn when workspaceTurns is %s',
    async (workspaceTurns) => {
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
            capabilities: { tasks: true, workspaceTurns },
          }),
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
        ...(workspaceTurns ? { workspaceTurns: true } : {}),
      });
    },
  );

  it.each([true, false])(
    'gates fresh Shell sending with foregroundShell=%s while retaining cancellation',
    async (enabled) => {
      const base = {
        sessionId: 'shell-1',
        status: 'ACTIVE',
        createdAt: 1,
        updatedAt: 2,
        lastSequence: 5,
        workspace: { workspaceId: 'ws-a', cwdRelative: '.' },
        capabilities: {
          tasks: true,
          workspaceTurns: true,
          foregroundShell: enabled,
        },
      };
      const provider = createJavaManagedAgentProvider({
        baseUrl: 'https://product.example',
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(jsonResponse(base))
          .mockResolvedValueOnce(
            jsonResponse({
              ...base,
              activeTurn: {
                turnId: 'turn-1',
                sessionId: 'shell-1',
                status: 'RUNNING',
                submittedAt: 2,
              },
            }),
          ),
      });
      expect(
        (await provider.getSession('shell-1', { clientId: 'c' })).capabilities,
      ).toEqual({
        canSend: enabled,
        canCancel: false,
        workspaceTurns: true,
        tasks: true,
      });
      expect(
        (await provider.getSession('shell-1', { clientId: 'c' })).capabilities,
      ).toEqual({
        canSend: false,
        canCancel: true,
        workspaceTurns: true,
        tasks: true,
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
