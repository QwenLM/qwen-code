import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isJavaAgentResyncRequired,
  JavaManagedAgentClient,
  SKIP_ON_CORRUPT,
} from './java-managed-agent-client';
import type { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { projectJavaAgentEvent } from './java-managed-agent-event-projector';
import {
  corruptFrame as corrupt,
  validEventFrame as valid,
} from './managed-agent-sse.test-fixtures';

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// The Public wire carries epoch SECONDS for Session/Turn/Event/Item and
// MILLIS for every other family. Realistic epochs prove the unit: a fixture
// of 0 or 1 would pass under either.
const SECONDS = 1_790_777_114;
const MILLIS = 1_790_777_114_231;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JavaManagedAgentClient', () => {
  it('sends Session file locators without a caller-selected Workspace or cwd', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          scope_revision: 'scope',
          directory: '.',
          entries: [],
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          scope_revision: 'scope',
          path: 'file.txt',
          name: 'file.txt',
          mime_type: 'text/plain',
          text: 'text',
          byte_length: 4,
          sha256: 'a'.repeat(64),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          scope_revision: 'scope',
          upload_id: 'upload-id',
          path: 'file.txt',
          size_bytes: 4,
          sha256: 'a'.repeat(64),
        }),
      );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    await client.queryWorkspaceFiles({
      sessionId: 'session-a',
      directory: '.',
    });
    await client.readWorkspaceFile({
      sessionId: 'session-a',
      path: 'file.txt',
      expectedScopeRevision: 'scope',
    });
    await client.uploadWorkspaceFile(
      {
        sessionId: 'session-a',
        path: 'file.txt',
        expectedScopeRevision: 'scope',
        uploadId: 'upload-id',
      },
      new Blob(['text']),
    );
    const queryCall = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(queryCall.pathname).toBe('/v1/agents/workspace-files');
    expect(Object.fromEntries(queryCall.searchParams)).toEqual({
      session_id: 'session-a',
      directory: '.',
    });
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    const readCall = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(readCall.pathname).toBe('/v1/agents/workspace-files/content');
    expect(Object.fromEntries(readCall.searchParams)).toEqual({
      session_id: 'session-a',
      path: 'file.txt',
      expected_scope_revision: 'scope',
    });
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[1][1]?.body).toBeUndefined();
    const uploadCall = new URL(String(fetchImpl.mock.calls[2][0]));
    expect(uploadCall.pathname).toBe('/v1/agents/workspace-files/uploads');
    expect(Object.fromEntries(uploadCall.searchParams)).toEqual({
      session_id: 'session-a',
      path: 'file.txt',
      expected_scope_revision: 'scope',
      upload_id: 'upload-id',
    });
    expect(fetchImpl.mock.calls[2][1]?.method).toBe('POST');
  });

  it('mints a terminal ticket through the authenticated WebShell POST', async () => {
    const result = { ticket: 'eyJ_abc-123', expiresInSeconds: 30 };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(result));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/gateway',
      getHeaders: () => ({ authorization: 'Bearer scoped' }),
      fetch: fetchImpl,
    });
    const signal = new AbortController().signal;
    expect(await client.terminalTicket('s1', 't1', signal)).toEqual(result);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://product.example/gateway/api/agent/web-shell/v1/sessions/terminal-ticket',
    );
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBe(signal);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer scoped',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      sessionId: 's1',
      terminalId: 't1',
    });
  });

  it('builds terminal WebSocket URLs with the Session path, terminal ID and replay', () => {
    const secure = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/gateway',
    });
    expect(secure.terminalWebSocketUrl('s-1', 't-1')).toBe(
      'wss://product.example/gateway/api/agent/web-shell/v1/sessions/s-1/terminal?terminalId=t-1&replay=1',
    );
    const insecure = new JavaManagedAgentClient({
      baseUrl: 'http://localhost:8080',
    });
    expect(insecure.terminalWebSocketUrl('s-1', 't-1')).toBe(
      'ws://localhost:8080/api/agent/web-shell/v1/sessions/s-1/terminal?terminalId=t-1&replay=1',
    );
  });

  it('uploads raw bytes to the authenticated Workspace route and queries the same upload ID', async () => {
    const wireResult = {
      scope_revision: 'scope',
      upload_id: 'upload-id',
      path: 'folder/你好.pdf',
      size_bytes: 4,
      sha256: 'a'.repeat(64),
    };
    const result = {
      scopeRevision: 'scope',
      uploadId: 'upload-id',
      path: 'folder/你好.pdf',
      sizeBytes: 4,
      sha256: 'a'.repeat(64),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(wireResult))
      .mockResolvedValueOnce(
        jsonResponse({ ...wireResult, state: 'completed', code: null }),
      );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/gateway',
      getHeaders: () => ({
        authorization: 'Bearer scoped',
        'content-type': 'application/json',
      }),
      fetch: fetchImpl,
    });
    const request = {
      workspaceId: 'workspace',
      cwdRelative: 'src',
      path: result.path,
      expectedScopeRevision: 'scope',
      uploadId: result.uploadId,
    };
    const data = new Blob([new Uint8Array([0, 255, 128, 1])]);
    const signal = new AbortController().signal;
    expect(await client.uploadWorkspaceFile(request, data, signal)).toEqual(
      result,
    );
    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/gateway/v1/agents/workspace-files/uploads');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      workspace_id: 'workspace',
      cwd_relative: 'src',
      path: result.path,
      expected_scope_revision: 'scope',
      upload_id: result.uploadId,
    });
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(data);
    expect(init?.signal).toBe(signal);
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer scoped',
    );
    expect(
      await client.queryWorkspaceFileUpload(result.uploadId, signal),
    ).toEqual({ ...result, state: 'completed', code: undefined });
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://product.example/gateway/v1/agents/workspace-files/uploads/upload-id',
    );
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[1][1]?.body).toBeUndefined();
    expect(fetchImpl.mock.calls[1][1]?.signal).toBe(signal);
  });

  it('renames through the authenticated Public PATCH using the original key and signal', async () => {
    const sessionBody = {
      id: 's1',
      object: 'agent.session',
      agent_id: 'dataworks_data_agent',
      agent_revision: '1',
      status: 'active',
      title: 'Confirmed',
      created_at: SECONDS,
      updated_at: SECONDS + 5,
      last_event_id: 9,
      capabilities: {
        items: true,
        snapshots: true,
        artifacts: false,
        resync: true,
        actions: false,
        tasks: true,
        workspace_turns: false,
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      // A replay returns the settled Session body; the replay flag rides
      // the response header. A title-less confirmation yields an empty
      // title, which the provider's trim guard refuses.
      .mockResolvedValueOnce(
        jsonResponse({ ...sessionBody, title: null }, 200, {
          'x-qwen-idempotent-replay': 'true',
        }),
      );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/gateway',
      getHeaders: () => ({ authorization: 'Bearer scoped' }),
      fetch: fetchImpl,
    });
    const abort = new AbortController();
    const request = {
      sessionId: 's1',
      title: 'Confirmed',
      idempotencyKey: 'original',
    };
    expect(await client.renameSession(request, abort.signal)).toEqual({
      sessionId: 's1',
      title: 'Confirmed',
      replayed: false,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://product.example/gateway/v1/agents/sessions/s1');
    expect(init?.method).toBe('PATCH');
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBe(abort.signal);
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer scoped',
    );
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('original');
    // The body carries only the new title: no sessionId, no body key.
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Confirmed' });
    expect(await client.renameSession(request, abort.signal)).toEqual({
      sessionId: 's1',
      title: '',
      replayed: true,
    });
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
    ).toBe('original');
  });

  it('does not treat an accepted or refused rename as confirmed', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ id: 's1', title: 'Unconfirmed' }, 202),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'session_operation_forbidden',
              message: 'Forbidden',
            },
          },
          403,
        ),
      );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    const request = {
      sessionId: 's1',
      title: 'Name',
      idempotencyKey: 'original',
    };
    await expect(client.renameSession(request)).rejects.toMatchObject({
      status: 202,
      code: 'session_rename_unconfirmed',
    });
    await expect(client.renameSession(request)).rejects.toMatchObject({
      status: 403,
      code: 'session_operation_forbidden',
    });
  });

  it('uses authorized Workspace registration routes without putting credentials in request bodies', async () => {
    const registration = {
      operation_id: 'operation-a',
      type: 'workspace_create',
      status: 'completed',
      workspace_id: 'workspace-a',
      failure_code: null,
      replayed: false,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ supported: true, data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          node_id: 'mac',
          canonical_path: '/project',
          platform: 'darwin',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(registration, 202))
      .mockResolvedValueOnce(jsonResponse(registration));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/gateway',
      getHeaders: () => ({ authorization: 'Bearer short-lived' }),
      credentials: 'include',
      fetch: fetchImpl,
    });
    const abort = new AbortController();
    await client.listRuntimeNodes(abort.signal);
    await client.checkWorkspaceDirectory(
      { nodeId: 'mac', path: '/project' },
      abort.signal,
    );
    await client.registerWorkspace(
      {
        nodeId: 'mac',
        path: '/project',
        displayName: 'Project',
        idempotencyKey: 'original',
      },
      abort.signal,
    );
    await client.getWorkspaceOperation('operation-a', abort.signal);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://product.example/gateway/v1/agents/runtime-nodes',
      'https://product.example/gateway/v1/agents/runtime-nodes/mac/check-directory',
      'https://product.example/gateway/v1/agents/workspaces/registrations',
      'https://product.example/gateway/v1/agents/workspaces/registrations/operation-a',
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'POST',
      'POST',
      'GET',
    ]);
    // Reads carry no body; the mutations carry only their Public fields.
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      path: '/project',
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))).toEqual({
      node_id: 'mac',
      path: '/project',
      display_name: 'Project',
    });
    expect(fetchImpl.mock.calls[3][1]?.body).toBeUndefined();
    // The key travels as a header on the registration mutation only.
    expect(
      new Headers(fetchImpl.mock.calls[2][1]?.headers).get('idempotency-key'),
    ).toBe('original');
    expect(
      new Headers(fetchImpl.mock.calls[0][1]?.headers).get('idempotency-key'),
    ).toBeNull();
    for (const [, request] of fetchImpl.mock.calls) {
      expect(request?.credentials).toBe('include');
      expect(request?.signal).toBe(abort.signal);
      expect(new Headers(request?.headers).get('authorization')).toBe(
        'Bearer short-lived',
      );
    }
  });

  it('queries and changes Session models using authenticated cancellable requests', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          models: [{ model_id: 'published', label: 'Published' }],
          model_selection: { model_id: 'published', revision: 2 },
          supported: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 'session-a',
          model_selection: { model_id: 'published', revision: 3 },
          replayed: false,
        }),
      );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      getHeaders: () => ({ 'x-tenant': 'tenant-a' }),
    });
    const abort = new AbortController();
    expect(await client.getSessionModels('session-a', abort.signal)).toEqual({
      models: [{ modelId: 'published', label: 'Published' }],
      modelSelection: { modelId: 'published', revision: 2 },
      supported: true,
    });
    const request = {
      sessionId: 'session-a',
      modelId: 'published',
      expectedRevision: 2,
      idempotencyKey: 'frozen',
    };
    expect(await client.changeModel(request, abort.signal)).toEqual({
      sessionId: 'session-a',
      modelSelection: { modelId: 'published', revision: 3 },
      replayed: false,
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://product.example/v1/agents/sessions/session-a/models',
      'https://product.example/v1/agents/sessions/session-a/models',
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'POST',
    ]);
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      model_id: 'published',
      expected_revision: 2,
    });
    expect(
      new Headers(fetchImpl.mock.calls[1][1]?.headers).get('idempotency-key'),
    ).toBe('frozen');
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.credentials).toBe('include');
      expect(init?.signal).toBe(abort.signal);
      expect(new Headers(init?.headers).get('x-tenant')).toBe('tenant-a');
    }
  });
  it('queries effective Session options for the selected Agent with authenticated headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        approval_mode: 'default',
        available_approval_modes: ['default', 'auto-edit'],
        plan_mode_supported: false,
        input_attachments: false,
        skills_supported: false,
        model_selection_supported: false,
      }),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      getHeaders: () => ({ 'x-tenant': 'tenant-a' }),
    });
    const abort = new AbortController();
    expect(
      await client.getSessionOptions('model-specific-agent', abort.signal),
    ).toEqual({
      approvalMode: 'default',
      availableApprovalModes: ['default', 'auto-edit'],
      planModeSupported: false,
      inputAttachments: false,
      skillsSupported: false,
      modelSelectionSupported: false,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://product.example/v1/agents/session-options?agent_id=model-specific-agent',
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBe(abort.signal);
    expect(new Headers(init?.headers).get('x-tenant')).toBe('tenant-a');
  });
  it('creates a Workspace with the frozen name and key through the authenticated POST route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        workspace_id: 'created-a',
        display_name: 'A',
        state: 'active',
        can_create_session: true,
        default_cwd_relative: null,
        can_select_directory: false,
      }),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      getHeaders: () => ({ 'x-tenant': 'tenant-a' }),
    });
    const abort = new AbortController();
    const request = { displayName: 'A', idempotencyKey: 'saved-key' };
    expect(await client.createWorkspace(request, abort.signal)).toEqual({
      workspaceId: 'created-a',
      displayName: 'A',
      state: 'active',
      canCreateSession: true,
      canSelectDirectory: false,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://product.example/v1/agents/workspaces');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBe(abort.signal);
    expect(new Headers(init?.headers).get('x-tenant')).toBe('tenant-a');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('saved-key');
    expect(JSON.parse(String(init?.body))).toEqual({ display_name: 'A' });
  });
  it('uses the task read and cancel routes with headers, credentials and cancellation', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          object: 'list',
          data: [],
          has_more: false,
          next_cursor: 'floor',
          active_child_count: 0,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'task1',
          object: 'agent.task',
          session_id: 's1',
          kind: 'child_agent',
          state: 'running',
          // Tasks carry MILLIS on the Public wire: never scaled.
          created_at: MILLIS,
          artifact_refs: [],
          action_capabilities: ['cancel', 'read_output'],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          object: 'list',
          data: [],
          has_more: false,
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'cancel-op',
          session_id: 's1',
          type: 'task_cancel',
          task_id: 'task1',
          status: 'completed',
          admission_stage: 'harness_confirmed',
          delivery_state: 'confirmed',
          receipt_id: 'receipt-1',
          replayed: false,
        }),
      );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      getHeaders: () => ({ 'x-tenant': 'tenant' }),
    });
    const abort = new AbortController();
    await client.listTasks(
      { sessionId: 's1', cursor: 'page', limit: 50 },
      abort.signal,
    );
    expect(
      await client.getTask({ sessionId: 's1', taskId: 'task1' }, abort.signal),
    ).toMatchObject({ taskId: 'task1', createdAt: MILLIS });
    await client.listTaskEvents(
      { sessionId: 's1', taskId: 'task1', after: 'checkpoint', limit: 50 },
      abort.signal,
    );
    expect(
      await client.cancelTask(
        {
          sessionId: 's1',
          taskId: 'task1',
          idempotencyKey: 'saved',
          requestId: 'trace',
        },
        abort.signal,
      ),
    ).toEqual({
      operationId: 'cancel-op',
      sessionId: 's1',
      type: 'task_cancel',
      taskId: 'task1',
      status: 'completed',
      admissionStage: 'harness_confirmed',
      deliveryState: 'confirmed',
      receiptId: 'receipt-1',
      replayed: false,
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://product.example/v1/agents/sessions/s1/tasks?cursor=page&limit=50',
      'https://product.example/v1/agents/sessions/s1/tasks/task1',
      'https://product.example/v1/agents/sessions/s1/tasks/task1/events?after=checkpoint&limit=50',
      'https://product.example/v1/agents/sessions/s1/tasks/task1/cancel',
    ]);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual([
      'GET',
      'GET',
      'GET',
      'POST',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.credentials).toBe('include');
      expect(init?.signal).toBe(abort.signal);
      expect(new Headers(init?.headers).get('x-tenant')).toBe('tenant');
    }
    // Reads carry their locators in the query, never a body; the cancel
    // carries the key as a header and drops the trace-only requestId.
    for (const index of [0, 1, 2]) {
      expect(fetchImpl.mock.calls[index][1]?.body).toBeUndefined();
    }
    expect(fetchImpl.mock.calls[3][1]?.body).toBeUndefined();
    expect(
      new Headers(fetchImpl.mock.calls[3][1]?.headers).get('idempotency-key'),
    ).toBe('saved');
    expect(String(fetchImpl.mock.calls[3][0])).not.toContain('trace');
  });
  it('binds the default browser fetch to the global object', async () => {
    const fetchImpl = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(
        jsonResponse({ object: 'list', data: [], has_more: false }),
      );
    });
    vi.stubGlobal('fetch', fetchImpl);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
    });

    await client.listSessions({ limit: 20 });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uses the private gateway with product credentials and headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        object: 'list',
        data: [
          {
            id: 'session-a',
            object: 'agent.session',
            agent_id: 'dataworks_data_agent',
            agent_revision: '1',
            status: 'active',
            title: 'Session',
            created_at: SECONDS,
            updated_at: SECONDS + 5,
            last_event_id: 42,
            // The WebShell activeTurn projection is the latest Turn
            // regardless of status: active_turn stays null here.
            active_turn: null,
            latest_turn: {
              id: 'turn-1',
              object: 'agent.turn',
              session_id: 'session-a',
              status: 'completed',
              created_at: SECONDS + 1,
              completed_at: SECONDS + 4,
              error_code: null,
            },
            capabilities: {
              items: true,
              snapshots: true,
              artifacts: false,
              resync: true,
              actions: false,
              tasks: true,
              workspace_turns: false,
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example/',
      fetch: fetchImpl,
      getHeaders: () => ({ authorization: 'Bearer short-lived' }),
    });

    const page = await client.listSessions({ limit: 20 });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://product.example/v1/agents/sessions?limit=20');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer short-lived',
    );
    expect(page).toEqual({
      data: [
        {
          sessionId: 'session-a',
          title: 'Session',
          agentId: 'dataworks_data_agent',
          status: 'active',
          createdAt: SECONDS * 1000,
          updatedAt: (SECONDS + 5) * 1000,
          activeTurn: {
            turnId: 'turn-1',
            sessionId: 'session-a',
            status: 'completed',
            submittedAt: (SECONDS + 1) * 1000,
            completedAt: (SECONDS + 4) * 1000,
            errorCode: null,
          },
          lastSequence: 42,
          capabilities: {
            tasks: true,
            artifacts: false,
            actions: false,
            workspaceTurns: false,
            // The Public contract keeps only tasks; the adapter restores
            // the derived diagnostics flag.
            diagnostics: true,
          },
        },
      ],
      nextCursor: null,
      hasMore: false,
    });
  });

  it('parses chunked CRLF SSE frames and ignores heartbeats', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ': keepalive\r\n\r\nid: 7\r\nevent: item.output_text.delta\r\ndata: {"schema_version":1,"projection_version":1,"sequence":7,"event_id":"evt_7",',
      `"session_id":"session-1","turn_id":"turn-1","type":"item.output_text.delta","created_at":${SECONDS + 7},"data":{"text":"hi"},"terminal":false}\r\n\r\n`,
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 6,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        sequence: 7,
        // The wire carries seconds; the frozen contract is millis.
        createdAt: (SECONDS + 7) * 1000,
        data: { text: 'hi' },
      }),
    ]);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://product.example/v1/agents/sessions/session-1/events?stream=true&after=6',
    );
    expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined();
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('accept')).toBe(
      'text/event-stream',
    );
  });

  it('reports the stream as open once the response arrives, and not when it fails', async () => {
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
        }),
      ),
    });
    const onOpen = vi.fn();
    const iterator = client.streamEvents(
      { sessionId: 'session-1', afterSequence: 6 },
      undefined,
      onOpen,
    );
    // The stream idles without a single frame, yet the open signal fires:
    // establishment is what a silent-but-healthy connection reports. The
    // generator stays parked on the idle stream when the test is done.
    void iterator.next();
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());

    const failing = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new TypeError('Failed to fetch')),
    });
    const onOpenFailure = vi.fn();
    await expect(
      failing
        .streamEvents({ sessionId: 'session-1' }, undefined, onOpenFailure)
        .next(),
    ).rejects.toThrow('Failed to fetch');
    expect(onOpenFailure).not.toHaveBeenCalled();
  });

  it('reports each complete heartbeat to onAlive, and not a trailing fragment', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const encoder = new TextEncoder();
    const chunks = [
      ': keepalive\r\n\r\n',
      `id: 7\r\nevent: item.output_text.delta\r\ndata: {"schema_version":1,"projection_version":1,"sequence":7,"event_id":"evt_7","session_id":"session-1","turn_id":"turn-1","type":"item.output_text.delta","created_at":${SECONDS + 7},"data":{"text":"hi"},"terminal":false}\r\n\r\n`,
      ': keepalive\r\n\r\n',
      // A leftover partial frame at end of stream is a mid-frame
      // disconnect, never a complete heartbeat: it is not reported.
      ': keepal',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    const onAlive = vi.fn();

    const events = [];
    for await (const event of client.streamEvents(
      { sessionId: 'session-1', afterSequence: 6 },
      undefined,
      undefined,
      onAlive,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        sequence: 7,
        createdAt: (SECONDS + 7) * 1000,
        data: { text: 'hi' },
      }),
    ]);
    expect(onAlive).toHaveBeenCalledTimes(2);
  });

  it('decodes the resync frame that ends an expired stream', async () => {
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // The server's only frame without an id: line, snake_case.
        new Response(
          'event:agent.session.resync_required\ndata:{"type":"agent.session.resync_required","session_id":"session-1","replay_floor_sequence":40,"snapshot_through_sequence":42,"action":"reload_snapshot"}\n\n',
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 3,
    })) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        type: 'agent.session.resync_required',
        sessionId: 'session-1',
        replayFloorSequence: 40,
        snapshotThroughSequence: 42,
        action: 'reload_snapshot',
      },
    ]);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
  });

  it('skips one corrupt frame and delivers the frames behind it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // The persisted frame at sequence 2 has a truncated JSON payload.
          'id: 2\r\nevent: item.output_text.delta\r\ndata: {"sequence":2,"event_id":"evt_2"\r\n\r\n' +
            `id: 3\r\nevent: item.output_text.delta\r\ndata: {"schema_version":1,"projection_version":1,"sequence":3,"event_id":"evt_3","session_id":"session-1","turn_id":"turn-1","type":"item.output_text.delta","created_at":${SECONDS + 3},"data":{"text":"after"},"terminal":false}\r\n\r\n`,
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        sequence: 3,
        createdAt: (SECONDS + 3) * 1000,
        data: { text: 'after' },
      }),
    ]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('resyncs past a run of only corrupt frames instead of aborting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // The valid frame behind the corrupt run disables the end-of-stream
        // fallback, so only the budget trip can produce the first frame.
        new Response(
          corrupt(2) + corrupt(3) + corrupt(4) + corrupt(5) + valid(6),
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 6 }));
    // Rate-limited skip warning for the first frame, plus the resync warning.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('resyncs when a connection delivers nothing but skipped corrupt frames', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // Two corrupt frames stay under the resync budget, but nothing valid
        // was delivered before the stream ended: retrying the same cursor
        // would replay them identically, so the stream ends with a resync.
        new Response(corrupt(2) + corrupt(3), { status: 200 }),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
  });

  it('resyncs when a connection delivers nothing but a single skipped frame', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // One skip is already one too many: nothing valid was delivered, so
        // retrying the same cursor replays this frame identically. The stream
        // ends normally here, so without the resync the hook reconnects every
        // 3s forever with a frozen transcript and no visible error.
        new Response(corrupt(2), { status: 200 }),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    // The skip warning plus the end-of-stream resync warning: a resync from
    // the fail-closed name check would log once instead, so this pins which
    // guard produced the frame.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('resyncs on a corrupt action update frame instead of skipping it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // A skipped action update leaves a pending approval unreachable.
          // The valid frame behind it disables the end-of-stream fallback,
          // so only the name-based resync can produce the first frame.
          'id: 2\r\nevent: action.updated\r\ndata: {"sequence":2,"event_id":"evt_2"\r\n\r\n' +
            valid(3),
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 3 }));
  });

  it.each([
    'stream.reconciled',
    'turn.accepted',
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
    'item.tool_call.updated',
    'item.tool_result.updated',
  ])('resyncs on a corrupt %s frame instead of skipping it', async (name) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(corrupt(2, name) + valid(3), { status: 200 }),
        ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 3 }));
  });

  it.each([...SKIP_ON_CORRUPT])(
    'skips a corrupt %s frame and delivers what is behind it',
    async (name) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const client = new JavaManagedAgentClient({
        baseUrl: 'https://product.example',
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(corrupt(2, name) + valid(3), { status: 200 }),
          ),
      });

      const frames = [];
      for await (const frame of client.streamEvents({
        sessionId: 'session-1',
        afterSequence: 1,
      })) {
        frames.push(frame);
      }

      expect(frames).toEqual([expect.objectContaining({ sequence: 3 })]);
    },
  );

  it('resyncs on a corrupt frame with an unknown event name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(corrupt(2, 'item.brand.new') + valid(3), {
          status: 200,
        }),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 3 }));
  });

  it('resyncs on a corrupt frame with no event name at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            'id: 2\r\ndata: {"sequence":2,"event_id":"evt_2"\r\n\r\n' +
              valid(3),
            { status: 200 },
          ),
        ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 3 }));
  });

  it('only allows skipping names that project to a UI event', () => {
    for (const name of SKIP_ON_CORRUPT) {
      expect(
        projectJavaAgentEvent({
          sequence: 2,
          eventId: 'evt_2',
          sessionId: 'session-1',
          turnId: 'turn-1',
          type: name,
          createdAt: 2,
          data: {},
          terminal: false,
        }),
      ).toBeDefined();
    }
  });

  it('accumulates the corrupt budget across read chunks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const encoder = new TextEncoder();
    const chunks = [
      corrupt(2) + corrupt(3),
      corrupt(4) + corrupt(5) + valid(6),
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    });
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 200 })),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    // The corrupt run straddles two reads: the fourth corrupt frame still
    // trips the budget.
    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 6 }));
  });

  it('tolerates three consecutive corrupt frames when a valid frame resets the count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // A run of exactly three consecutive corrupt frames (4-6) stays under
        // the budget, and the valid frame at 3 resets an earlier count.
        new Response(
          corrupt(2) +
            valid(3) +
            corrupt(4) +
            corrupt(5) +
            corrupt(6) +
            valid(7),
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ sequence: 3 }),
      expect.objectContaining({ sequence: 7 }),
    ]);
    // Skip warnings are rate-limited: only the first skip logs.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rate-limits skip warnings when corruption alternates with valid frames', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let stream = '';
    for (let index = 2; index <= 41; index += 1) {
      stream += index % 2 === 0 ? corrupt(index) : valid(index);
    }
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(stream, { status: 200 })),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(20);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs a mid-frame close distinctly and spares the budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          `id: 2\r\nevent: item.output_text.delta\r\ndata: {"schema_version":1,"projection_version":1,"sequence":2,"event_id":"evt_2","session_id":"session-1","turn_id":"turn-1","type":"item.output_text.delta","created_at":${SECONDS + 2},"data":{},"terminal":true}\r\n\r\n` +
            // Truncated final frame without the terminating blank line.
            'id: 3\r\nevent: item.output_text.delta\r\ndata: {"sequence":3,"ev',
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({ sequence: 2 })]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('closed mid-frame'),
    );
  });

  it('warns when the stream closes before the trailing frame even reaches its data line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          valid(2) +
            // The tear lands before the data: line: no payload at all.
            'id: 3\r\nevent: item.output_text.delta\r\n',
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({ sequence: 2 })]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('closed mid-frame'),
    );
  });

  it('charges the budget for corrupt frames but not for a mid-frame close', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // Three corrupt frames stay under the budget; the torn tail must
          // not take the fourth slot. With nothing delivered at all, the end
          // of the stream still surfaces the loss.
          corrupt(2) +
            corrupt(3) +
            corrupt(4) +
            'id: 5\r\nevent: item.output_text.delta\r\ndata: {"sequence":5,"ev',
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(1);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('closed mid-frame'),
    );
  });

  it('counts a mid-stream frame without a data line as corrupt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // A complete frame with id/event lines but no data line is
          // malformed server output, not a heartbeat.
          'id: 2\r\nevent: item.output_text.delta\r\n\r\n' + valid(3),
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({ sequence: 3 })]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('charges the budget for mid-stream frames without a data line', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noData = (sequence: number) =>
      `id: ${sequence}\r\nevent: item.output_text.delta\r\n\r\n`;
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        // Four no-data frames trip the budget; the valid frame behind them
        // disables the end-of-stream fallback.
        new Response(noData(2) + noData(3) + noData(4) + noData(5) + valid(6), {
          status: 200,
        }),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 6 }));
  });

  it('does not count heartbeats toward the corrupt-frame budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            ': keepalive\r\n\r\n'.repeat(5) +
              `id: 2\r\nevent: item.output_text.delta\r\ndata: {"schema_version":1,"projection_version":1,"sequence":2,"event_id":"evt_2","session_id":"session-1","turn_id":"turn-1","type":"item.output_text.delta","created_at":${SECONDS + 2},"data":{},"terminal":false}\r\n\r\n`,
            { status: 200 },
          ),
        ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([expect.objectContaining({ sequence: 2 })]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not let heartbeats dilute the corrupt-frame budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const heartbeat = ': keepalive\r\n\r\n';
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // The valid frame behind the corrupt run disables the
          // end-of-stream fallback, so only the budget trip can produce the
          // first frame.
          corrupt(2) +
            heartbeat +
            corrupt(3) +
            heartbeat +
            corrupt(4) +
            heartbeat +
            corrupt(5) +
            valid(6),
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 6 }));
  });

  it('counts data frames without a string event type as corrupt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          // Valid JSON, but none of these is an event object (the schema
          // requires a string `type`): as corrupt as broken JSON.
          'id: 2\r\nevent: item.output_text.delta\r\ndata: null\r\n\r\n' +
            valid(3) +
            'id: 4\r\nevent: item.output_text.delta\r\ndata: []\r\n\r\n' +
            valid(5) +
            'id: 6\r\nevent: item.output_text.delta\r\ndata: {}\r\n\r\n' +
            valid(7),
          { status: 200 },
        ),
      ),
    });

    const events = [];
    for await (const event of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 1,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({ sequence: 3 }),
      expect.objectContaining({ sequence: 5 }),
      expect.objectContaining({ sequence: 7 }),
    ]);
    // Rate-limited: only the first skip logs.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats a corrupt id-less resync frame as a resync request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          'event:agent.session.resync_required\r\ndata:{"type":"agent.session.resync_required","session_id":"sess\r\n\r\n' +
            // The valid frame behind it disables the end-of-stream fallback,
            // so only the fail-closed resync rule can produce the first
            // frame.
            valid(4),
          { status: 200 },
        ),
      ),
    });

    const frames = [];
    for await (const frame of client.streamEvents({
      sessionId: 'session-1',
      afterSequence: 3,
    })) {
      frames.push(frame);
    }

    expect(frames).toHaveLength(2);
    expect(isJavaAgentResyncRequired(frames[0]!)).toBe(true);
    expect(frames[1]).toEqual(expect.objectContaining({ sequence: 4 }));
  });

  it('creates a Session and synthesizes the admission from the Public Session body', async () => {
    const sessionBody = {
      id: 'session-new',
      object: 'agent.session',
      agent_id: 'dataworks_data_agent',
      agent_revision: '1',
      status: 'active',
      title: 'A title',
      created_at: SECONDS,
      updated_at: SECONDS,
      last_event_id: 1,
      latest_turn: {
        id: 'turn-initial',
        object: 'agent.turn',
        session_id: 'session-new',
        status: 'accepted',
        created_at: SECONDS,
        completed_at: null,
        error_code: null,
      },
      capabilities: {
        items: true,
        snapshots: true,
        artifacts: false,
        resync: true,
        actions: false,
        tasks: true,
        workspace_turns: false,
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(sessionBody))
      // A replay returns the same Session body; the replay flag rides the
      // response header, not a body field.
      .mockResolvedValueOnce(
        jsonResponse(sessionBody, 200, {
          'x-qwen-idempotent-replay': 'true',
        }),
      );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    const request = {
      requestId: 'rid-create',
      idempotencyKey: 'key-create',
      agentId: 'dataworks_data_agent',
      title: 'A title',
      input: [{ type: 'input_text' as const, text: 'hello' }],
      metadata: { clientId: 'client-1' },
      workspace: { workspaceId: 'workspace-1', cwdRelative: 'src' },
      worktree: { baseRef: 'main' },
      memoryStoreId: 'store-1',
      approvalMode: 'auto-edit' as const,
      planMode: true,
      modelId: 'model-a',
      extensionPins: [
        { extensionId: 'ext-1', packageRevision: 2, packageDigest: 'digest' },
      ],
    };
    expect(await client.createSession(request)).toEqual({
      sessionId: 'session-new',
      turnId: 'turn-initial',
      status: 'accepted',
      replayed: false,
    });
    expect(await client.createSession(request)).toEqual({
      sessionId: 'session-new',
      turnId: 'turn-initial',
      status: 'accepted',
      replayed: true,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://product.example/v1/agents/sessions');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(
      'key-create',
    );
    // The create body is snake_case except extensionPins; requestId and the
    // body idempotencyKey never travel.
    expect(JSON.parse(String(init?.body))).toEqual({
      agent_id: 'dataworks_data_agent',
      input: [{ type: 'input_text', text: 'hello' }],
      metadata: { clientId: 'client-1' },
      workspace: { workspace_id: 'workspace-1', cwd_relative: 'src' },
      worktree: { base_ref: 'main' },
      extensionPins: [
        { extensionId: 'ext-1', packageRevision: 2, packageDigest: 'digest' },
      ],
      memory_store_id: 'store-1',
      title: 'A title',
      approval_mode: 'auto-edit',
      plan_mode: true,
      model_id: 'model-a',
    });
  });

  it('maps the stable Java error envelope', async () => {
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'agent_api_idempotency_conflict',
              message: 'conflict',
              request_id: 'request-409',
            },
          },
          409,
        ),
      ),
    });

    await expect(
      client.createSession({
        requestId: 'r1',
        idempotencyKey: 'key-1',
        agentId: 'dataworks_data_agent',
        input: [{ type: 'input_text', text: 'hello' }],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<JavaManagedAgentHttpError>>({
        status: 409,
        code: 'agent_api_idempotency_conflict',
        message: 'conflict',
        requestId: 'request-409',
      }),
    );
  });

  it('sends the cancel-critical fields verbatim', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        session_id: 's1',
        turn_id: 'p1',
        status: 'accepted',
        replayed: false,
        operation_id: 'cancel-1',
        admission_stage: 'java_durable',
        delivery_state: 'pending',
      }),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    expect(
      await client.cancelTurn({
        requestId: 'rid-1',
        idempotencyKey: 'key-cancel',
        sessionId: 's1',
        turnId: 'p1',
      }),
    ).toEqual({
      sessionId: 's1',
      turnId: 'p1',
      status: 'accepted',
      replayed: false,
      operationId: 'cancel-1',
      admissionStage: 'java_durable',
      deliveryState: 'pending',
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://product.example/v1/agents/sessions/s1/events',
    );
    expect(init?.method).toBe('POST');
    // A dropped turn_id or Idempotency-Key cancels nothing and dedupe-breaks;
    // the trace-only requestId never travels.
    expect(JSON.parse(String(init?.body))).toEqual({
      type: 'agent.session.cancel',
      turn_id: 'p1',
    });
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(
      'key-cancel',
    );
  });

  it('loads one recent Item page and passes its opaque older cursor verbatim', async () => {
    const wirePage = {
      object: 'list',
      data: [
        {
          id: 'recent-item',
          object: 'agent.item',
          session_id: 's1',
          turn_id: 'turn-1',
          type: 'message',
          role: 'assistant',
          revision: 1,
          status: 'completed',
          first_sequence: 118,
          last_sequence: 120,
          content: [],
          attributes: {},
          created_at: SECONDS,
          updated_at: SECONDS + 2,
        },
      ],
      next_cursor: 'signed-backward.cursor',
      has_more: true,
      snapshot_through_sequence: 120,
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(wirePage));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    const signal = new AbortController().signal;
    expect(
      await client.getRecentTranscriptItems(
        { sessionId: 's1', cursor: 'signed-backward.cursor', limit: 2 },
        signal,
      ),
    ).toEqual({
      items: [
        {
          itemId: 'recent-item',
          sessionId: 's1',
          turnId: 'turn-1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [],
          attributes: {},
          firstSequence: 118,
          lastSequence: 120,
          // Item timestamps are seconds on the wire, millis in the contract.
          createdAt: SECONDS * 1000,
          updatedAt: (SECONDS + 2) * 1000,
        },
      ],
      nextCursor: 'signed-backward.cursor',
      hasMore: true,
      snapshotThroughSequence: 120,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://product.example/v1/agents/sessions/s1/transcript/items?cursor=signed-backward.cursor&limit=2',
    );
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBe(signal);
  });

  it('surfaces an expired recent Item cursor without draining or replaying history', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'cursor_expired', message: 'Expired' },
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    await expect(
      client.getRecentTranscriptItems({
        sessionId: 's1',
        cursor: 'expired',
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: 'cursor_expired', status: 409 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends getSession, transcript and submit surfaces verbatim', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 's1',
          object: 'agent.session',
          agent_id: 'dataworks_data_agent',
          agent_revision: '1',
          status: 'active',
          created_at: SECONDS,
          updated_at: SECONDS,
          last_event_id: 9,
          capabilities: {
            items: true,
            snapshots: true,
            artifacts: false,
            resync: true,
            actions: false,
            tasks: true,
            workspace_turns: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [],
          events: [],
          covered_sequence: 50,
          has_more: false,
          last_sequence: 50,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          session_id: 's1',
          turn_id: 'turn-9',
          status: 'accepted',
          replayed: false,
          operation_id: 'op-9',
          admission_stage: 'java_durable',
          delivery_state: 'pending',
        }),
      );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    expect(await client.getSession('s1')).toMatchObject({
      sessionId: 's1',
      createdAt: SECONDS * 1000,
      lastSequence: 9,
    });
    await client.getTranscript({
      sessionId: 's1',
      cursor: 'before-1',
      limit: 50,
    });
    await client.submitTurn({
      requestId: 'rid-2',
      idempotencyKey: 'key-submit',
      sessionId: 's1',
      input: [{ type: 'input_text', text: 'go' }],
      metadata: { clientId: 'client-1' },
    });

    const getCall = fetchImpl.mock.calls[0]!;
    const txCall = fetchImpl.mock.calls[1]!;
    const submitCall = fetchImpl.mock.calls[2]!;
    expect(String(getCall[0])).toBe(
      'https://product.example/v1/agents/sessions/s1',
    );
    expect(getCall[1]?.method).toBe('GET');
    expect(getCall[1]?.body).toBeUndefined();
    expect(String(txCall[0])).toBe(
      'https://product.example/v1/agents/sessions/s1/transcript?cursor=before-1&limit=50',
    );
    expect(txCall[1]?.method).toBe('GET');
    expect(txCall[1]?.body).toBeUndefined();
    expect(String(submitCall[0])).toBe(
      'https://product.example/v1/agents/sessions/s1/events',
    );
    expect(submitCall[1]?.method).toBe('POST');
    // The Public input event carries only type + input: the WebShell
    // metadata echo, requestId and body key are all dropped.
    expect(JSON.parse(String(submitCall[1]?.body))).toEqual({
      type: 'agent.session.input.message',
      input: [{ type: 'input_text', text: 'go' }],
    });
    expect(new Headers(submitCall[1]?.headers).get('idempotency-key')).toBe(
      'key-submit',
    );
  });

  it('falls back to the stable http error code for a non-JSON gateway error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: {
          'content-type': 'text/html',
          'x-request-id': 'gateway-request-502',
        },
      }),
    );
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    // A gateway's HTML 502 must not escape as a raw SyntaxError.
    await expect(client.getSession('s1')).rejects.toEqual(
      expect.objectContaining<Partial<JavaManagedAgentHttpError>>({
        status: 502,
        code: 'http_502',
        requestId: 'gateway-request-502',
      }),
    );
  });

  it('rejects a null event-stream body as unavailable', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const client = new JavaManagedAgentClient({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });

    await expect(
      client.streamEvents({ sessionId: 's1' }).next(),
    ).rejects.toEqual(
      expect.objectContaining<Partial<JavaManagedAgentHttpError>>({
        code: 'agent_api_stream_unavailable',
      }),
    );
  });
});
