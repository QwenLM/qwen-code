/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonWorkspaceProvider,
  useDaemonWorkspace,
  useOptionalDaemonWorkspace,
  type DaemonWorkspaceActions,
  type DaemonWorkspaceContextValue,
} from './DaemonWorkspaceProvider.js';

const sdkMocks = vi.hoisted(() => {
  const capabilities = vi.fn();
  const workspaceMcp = vi.fn();
  const workspaceMcpTools = vi.fn();
  const restartMcpServer = vi.fn();
  const workspaceSkills = vi.fn();
  const workspaceTools = vi.fn();
  const setWorkspaceToolEnabled = vi.fn();
  const workspaceMemory = vi.fn();
  const readWorkspaceFile = vi.fn();
  const writeWorkspaceMemory = vi.fn();
  const listWorkspaceAgents = vi.fn();
  const getWorkspaceAgent = vi.fn();
  const createWorkspaceAgent = vi.fn();
  const deleteWorkspaceAgent = vi.fn();
  const workspaceProviders = vi.fn();
  const listWorkspaceSessions = vi.fn();
  const deleteSessionsData = vi.fn();

  class MockDaemonClient {
    constructor(_opts: unknown) {}

    capabilities = capabilities;
    workspaceMcp = workspaceMcp;
    workspaceMcpTools = workspaceMcpTools;
    restartMcpServer = restartMcpServer;
    workspaceSkills = workspaceSkills;
    workspaceTools = workspaceTools;
    setWorkspaceToolEnabled = setWorkspaceToolEnabled;
    workspaceMemory = workspaceMemory;
    readWorkspaceFile = readWorkspaceFile;
    writeWorkspaceMemory = writeWorkspaceMemory;
    listWorkspaceAgents = listWorkspaceAgents;
    getWorkspaceAgent = getWorkspaceAgent;
    createWorkspaceAgent = createWorkspaceAgent;
    deleteWorkspaceAgent = deleteWorkspaceAgent;
    workspaceProviders = workspaceProviders;
    listWorkspaceSessions = listWorkspaceSessions;
    deleteSessionsData = deleteSessionsData;
    dispose = vi.fn();
  }

  return {
    MockDaemonClient,
    capabilities,
    workspaceMcp,
    workspaceMcpTools,
    restartMcpServer,
    workspaceSkills,
    workspaceTools,
    setWorkspaceToolEnabled,
    workspaceMemory,
    readWorkspaceFile,
    writeWorkspaceMemory,
    listWorkspaceAgents,
    getWorkspaceAgent,
    createWorkspaceAgent,
    deleteWorkspaceAgent,
    workspaceProviders,
    listWorkspaceSessions,
    deleteSessionsData,
    reset() {
      capabilities.mockReset();
      capabilities.mockResolvedValue({
        workspaceCwd: '/mock-workspace',
        features: [],
      });
      workspaceMcp.mockReset();
      workspaceMcp.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        servers: [],
      });
      workspaceMcpTools.mockReset();
      workspaceMcpTools.mockResolvedValue({
        v: 1,
        serverName: 'mock',
        tools: [],
      });
      restartMcpServer.mockReset();
      restartMcpServer.mockResolvedValue({ restarted: true });
      workspaceSkills.mockReset();
      workspaceSkills.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        skills: [],
      });
      workspaceTools.mockReset();
      workspaceTools.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        acpChannelLive: true,
        tools: [],
      });
      setWorkspaceToolEnabled.mockReset();
      setWorkspaceToolEnabled.mockResolvedValue({ ok: true });
      workspaceMemory.mockReset();
      workspaceMemory.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        files: [],
      });
      readWorkspaceFile.mockReset();
      readWorkspaceFile.mockResolvedValue({ path: 'QWEN.md', text: '' });
      writeWorkspaceMemory.mockReset();
      writeWorkspaceMemory.mockResolvedValue({ ok: true });
      listWorkspaceAgents.mockReset();
      listWorkspaceAgents.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        agents: [],
      });
      getWorkspaceAgent.mockReset();
      getWorkspaceAgent.mockResolvedValue({ agent: undefined });
      createWorkspaceAgent.mockReset();
      createWorkspaceAgent.mockResolvedValue({ ok: true });
      deleteWorkspaceAgent.mockReset();
      deleteWorkspaceAgent.mockResolvedValue(undefined);
      workspaceProviders.mockReset();
      workspaceProviders.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        providers: [],
      });
      listWorkspaceSessions.mockReset();
      listWorkspaceSessions.mockResolvedValue({ sessions: [] });
      deleteSessionsData.mockReset();
      deleteSessionsData.mockResolvedValue({
        removed: [],
        notFound: [],
        errors: [],
      });
    },
  };
});

vi.mock('@qwen-code/sdk/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/sdk/daemon')>();
  return {
    ...actual,
    DaemonClient: sdkMocks.MockDaemonClient,
  };
});

describe('DaemonWorkspaceProvider', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    sdkMocks.reset();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.unstubAllGlobals();
  });

  function renderWithProvider(children: ReactNode) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    return new Promise<void>((resolve) => {
      act(() => {
        root?.render(
          <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170">
            {children}
          </DaemonWorkspaceProvider>,
        );
      });
      resolve();
    });
  }

  it('exposes workspace context with autoConnect', async () => {
    let context: DaemonWorkspaceContextValue | undefined;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(context).toBeDefined();
    expect(context?.baseUrl).toBe('http://127.0.0.1:4170');
    expect(context?.workspaceCwd).toBe('/mock-workspace');
  });

  it('throws when useDaemonWorkspace is used without provider', async () => {
    let error: Error | undefined;

    function Harness() {
      try {
        useDaemonWorkspace();
      } catch (e) {
        error = e as Error;
      }
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
    });

    expect(error?.message).toContain(
      'useDaemonWorkspace must be used within DaemonWorkspaceProvider',
    );
  });

  it('exposes workspace actions', async () => {
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(actions).toBeDefined();
    expect(typeof actions?.loadMcpStatus).toBe('function');
    expect(typeof actions?.loadSkillsStatus).toBe('function');
    expect(typeof actions?.listAgents).toBe('function');
    expect(typeof actions?.globWorkspace).toBe('function');
  });

  it('useOptionalDaemonWorkspace returns undefined without provider', async () => {
    let context: DaemonWorkspaceContextValue | undefined = {
      client: {} as never,
    } as never;

    function Harness() {
      context = useOptionalDaemonWorkspace();
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
    });

    expect(context).toBeUndefined();
  });

  it('returns MCP tools fallback for older daemons', async () => {
    sdkMocks.workspaceMcpTools.mockRejectedValueOnce(
      new Error('missing route'),
    );
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    const workspaceActions = actions;

    await act(async () => {
      await expect(workspaceActions.loadMcpTools('server-a')).resolves.toEqual({
        v: 1,
        workspaceCwd: '',
        serverName: 'server-a',
        initialized: false,
        acpChannelLive: false,
        tools: [],
        errors: [
          {
            kind: 'mcp_tools',
            status: 'error',
            error: 'The connected daemon does not expose MCP tool details.',
          },
        ],
      });
    });
  });

  it('loads workspace glob matches', async () => {
    const fetchMock = vi.fn(
      async (
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response(
          JSON.stringify({ matches: ['src/App.tsx', 42, 'src/index.ts'] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    const workspaceActions = actions;

    let result: { matches: string[] } | undefined;
    await act(async () => {
      result = await workspaceActions.globWorkspace('src/*', {
        maxResults: 10,
        includeIgnored: true,
        cwd: 'packages/web-shell',
      });
    });

    expect(result).toEqual({ matches: ['src/App.tsx', 'src/index.ts'] });
  });

  it('actions.deleteSession calls client.deleteSessionsData with single-element array', async () => {
    sdkMocks.deleteSessionsData.mockResolvedValueOnce({
      removed: ['session-123'],
      notFound: [],
      errors: [],
    });
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    let result: boolean | undefined;
    await act(async () => {
      result = await actions!.deleteSession('session-123');
    });

    expect(result).toBe(true);
    expect(sdkMocks.deleteSessionsData).toHaveBeenCalledWith(['session-123']);
  });

  it('actions.deleteSession throws when result has errors', async () => {
    sdkMocks.deleteSessionsData.mockResolvedValueOnce({
      removed: [],
      notFound: [],
      errors: [{ sessionId: 'session-456', error: 'invalid client id' }],
    });
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    await act(async () => {
      await expect(actions!.deleteSession('session-456')).rejects.toThrow(
        'invalid client id',
      );
    });
  });

  it('actions.deleteSessions calls client.deleteSessionsData', async () => {
    const batchResult = {
      removed: ['s-1', 's-2'],
      notFound: ['s-3'],
      errors: [] as Array<{ sessionId: string; error: string }>,
    };
    sdkMocks.deleteSessionsData.mockResolvedValueOnce(batchResult);
    let actions: DaemonWorkspaceActions | undefined;

    function Harness() {
      const workspace = useOptionalDaemonWorkspace();
      actions = workspace?.actions;
      return null;
    }

    await renderWithProvider(<Harness />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    if (!actions) throw new Error('actions not defined');

    let result: typeof batchResult | undefined;
    await act(async () => {
      result = await actions!.deleteSessions(['s-1', 's-2', 's-3']);
    });

    expect(result).toEqual(batchResult);
    expect(sdkMocks.deleteSessionsData).toHaveBeenCalledWith([
      's-1',
      's-2',
      's-3',
    ]);
  });
});
