import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { RPC_CHANNELS } from '../../../shared/types';
import type { HandlerFn, RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

const requestContext = {
  clientId: 'client-1',
  workspaceId: null,
  webContentsId: null,
};

const getDefaultThinkingLevelMock = mock(() => 'think');
const setDefaultThinkingLevelMock = mock((_level: string) => true);
let mockedWorkspace: Record<string, unknown> | null = null;
let mockedWorkspaceConfig: Record<string, unknown> | null = null;
const getWorkspaceByNameOrIdMock = mock(
  (_workspaceId: string) => mockedWorkspace,
);
const loadWorkspaceConfigMock = mock(
  (_rootPath: string) => mockedWorkspaceConfig,
);
const getQwenCoreSettingsViaAcpMock = mock(async () => ({
  user: {
    path: '',
    values: { 'tools.approvalMode': 'yolo' },
    mcpServers: [],
    hooks: [],
  },
  workspace: { path: '', values: {}, mcpServers: [], hooks: [] },
  merged: {
    values: {},
    mcpServers: [],
    hooks: [],
    extensions: [],
  },
  workspaceTrusted: true,
}));
const setQwenCoreSettingViaAcpMock = mock(async () => ({
  user: { path: '', values: {}, mcpServers: [], hooks: [] },
  workspace: { path: '', values: {}, mcpServers: [], hooks: [] },
  merged: {
    values: { 'tools.approvalMode': 'yolo' },
    mcpServers: [],
    hooks: [],
    extensions: [],
  },
  workspaceTrusted: true,
}));
const applyGlobalPermissionModeMock = mock(async (_mode: string) => {});
const getQwenMemoryPathsViaAcpMock = mock(async () => ({
  userMemoryFile: '/tmp/QWEN.md',
  projectMemoryFile: '/tmp/project/AGENTS.md',
  autoMemoryDir: '/tmp/project/memory',
}));
const getQwenMemorySettingsViaAcpMock = mock(async () => ({}));
const setQwenMemorySettingsViaAcpMock = mock(async () => ({}));

mock.module('@craft-agent/shared/config', () => ({
  getPreferencesPath: () => '/tmp/preferences.json',
  getSessionDraft: () => null,
  setSessionDraft: () => {},
  deleteSessionDraft: () => {},
  getAllSessionDrafts: () => ({}),
  getWorkspaceByNameOrId: getWorkspaceByNameOrIdMock,
  getDefaultThinkingLevel: getDefaultThinkingLevelMock,
  setDefaultThinkingLevel: setDefaultThinkingLevelMock,
  isProtectedWorkspace: () => false,
}));

mock.module('@craft-agent/shared/workspaces', () => ({
  loadWorkspaceConfig: loadWorkspaceConfigMock,
}));

mock.module('@craft-agent/shared/agent', () => ({
  getQwenCoreSettingsViaAcp: getQwenCoreSettingsViaAcpMock,
  setQwenCoreSettingViaAcp: setQwenCoreSettingViaAcpMock,
  setQwenMcpServerViaAcp: mock(async () => ({})),
  removeQwenMcpServerViaAcp: mock(async () => ({})),
  setQwenHookViaAcp: mock(async () => ({})),
  removeQwenHookViaAcp: mock(async () => ({})),
  setQwenExtensionSettingViaAcp: mock(async () => ({})),
  getQwenPermissionSettingsViaAcp: mock(async () => ({})),
  setQwenPermissionRulesViaAcp: mock(async () => ({})),
  getQwenMemorySettingsViaAcp: getQwenMemorySettingsViaAcpMock,
  setQwenMemorySettingsViaAcp: setQwenMemorySettingsViaAcpMock,
  getQwenSettingsPathViaAcp: mock(async () => ''),
  getQwenMemoryPathsViaAcp: getQwenMemoryPathsViaAcpMock,
}));

describe('settings default thinking RPC handlers', () => {
  const handlers = new Map<string, HandlerFn>();

  beforeEach(async () => {
    handlers.clear();
    getDefaultThinkingLevelMock.mockClear();
    setDefaultThinkingLevelMock.mockClear();
    mockedWorkspace = null;
    mockedWorkspaceConfig = null;
    getWorkspaceByNameOrIdMock.mockClear();
    loadWorkspaceConfigMock.mockClear();
    getQwenCoreSettingsViaAcpMock.mockClear();
    setQwenCoreSettingViaAcpMock.mockClear();
    applyGlobalPermissionModeMock.mockClear();
    getQwenMemorySettingsViaAcpMock.mockClear();
    setQwenMemorySettingsViaAcpMock.mockClear();
    getQwenMemoryPathsViaAcpMock.mockClear();

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn);
      },
      push() {},
      async invokeClient() {
        return null;
      },
    };

    const deps: HandlerDeps = {
      sessionManager: {
        applyGlobalPermissionMode: applyGlobalPermissionModeMock,
      } as unknown as HandlerDeps['sessionManager'],
      platform: {
        appRootPath: '',
        resourcesPath: '',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        imageProcessor: {
          getMetadata: async () => null,
          process: async () => Buffer.from(''),
        },
      },
      oauthFlowStore: {
        store: () => {},
        getByState: () => null,
        remove: () => {},
        cleanup: () => {},
        dispose: () => {},
        get size() {
          return 0;
        },
      } as unknown as HandlerDeps['oauthFlowStore'],
    };

    const { registerSettingsHandlers } = await import(
      '@craft-agent/server-core/handlers/rpc/settings'
    );
    registerSettingsHandlers(server, deps);
  });

  it('returns persisted default thinking level', async () => {
    const getHandler = handlers.get(
      RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
    );
    expect(getHandler).toBeTruthy();

    const result = await getHandler!(requestContext);
    expect(result).toBe('think');
    expect(getDefaultThinkingLevelMock).toHaveBeenCalledTimes(1);
  });

  it('persists valid thinking level values', async () => {
    const setHandler = handlers.get(
      RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
    );
    expect(setHandler).toBeTruthy();

    const result = await setHandler!(requestContext, 'max');
    expect(result).toEqual({ success: true });
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledWith('max');
    expect(setDefaultThinkingLevelMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid thinking level values before persistence', async () => {
    const setHandler = handlers.get(
      RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
    );
    expect(setHandler).toBeTruthy();

    await expect(setHandler!(requestContext, 'ultra')).rejects.toThrow(
      'Invalid thinking level',
    );
    expect(setDefaultThinkingLevelMock).not.toHaveBeenCalled();
  });

  it('returns global permission mode through Qwen ACP', async () => {
    const getHandler = handlers.get(
      RPC_CHANNELS.settings.GET_GLOBAL_PERMISSION_MODE,
    );
    expect(getHandler).toBeTruthy();

    const result = await getHandler!(requestContext);
    expect(result).toBe('allow-all');
    expect(getQwenCoreSettingsViaAcpMock).toHaveBeenCalledTimes(1);
    expect(applyGlobalPermissionModeMock).toHaveBeenCalledWith('allow-all', {
      changedBy: 'restore',
    });
  });

  it('persists global permission mode through Qwen ACP', async () => {
    const setHandler = handlers.get(
      RPC_CHANNELS.settings.SET_GLOBAL_PERMISSION_MODE,
    );
    expect(setHandler).toBeTruthy();

    const result = await setHandler!(requestContext, 'yolo');
    expect(result).toEqual({ success: true });
    const call = setQwenCoreSettingViaAcpMock.mock.calls[0] as unknown[];
    expect(call.slice(1)).toEqual(['user', 'tools.approvalMode', 'yolo']);
    expect(applyGlobalPermissionModeMock).toHaveBeenCalledWith('allow-all');
  });

  it('syncs global permission mode when approval mode is saved as a Qwen core setting', async () => {
    const setHandler = handlers.get(
      RPC_CHANNELS.settings.SET_QWEN_CORE_SETTING,
    );
    expect(setHandler).toBeTruthy();

    await setHandler!(requestContext, 'user', 'tools.approvalMode', 'yolo');

    expect(applyGlobalPermissionModeMock).toHaveBeenCalledWith('allow-all');
  });

  it('uses the workspace working directory as the Qwen memory project root', async () => {
    mockedWorkspace = {
      id: 'ws-1',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: '/Users/dragon/.craft-agent/workspaces/qwen-code',
    };
    mockedWorkspaceConfig = {
      defaults: {
        workingDirectory: '/Users/dragon/Documents/qwen-code',
      },
    };

    const getHandler = handlers.get(RPC_CHANNELS.memory.GET_PATHS);
    expect(getHandler).toBeTruthy();

    await getHandler!(requestContext, 'ws-1');

    expect(getQwenMemoryPathsViaAcpMock).toHaveBeenCalledTimes(1);
    expect(getQwenMemoryPathsViaAcpMock.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/Users/dragon/Documents/qwen-code',
      processCwd: '/Users/dragon/.craft-agent/workspaces/qwen-code',
      projectRoot: '/Users/dragon/Documents/qwen-code',
    });
  });

  it('loads memory settings through the workspace Qwen ACP process', async () => {
    mockedWorkspace = {
      id: 'ws-1',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: '/Users/dragon/.craft-agent/workspaces/qwen-code',
    };
    mockedWorkspaceConfig = {
      defaults: {
        workingDirectory: '/Users/dragon/Documents/qwen-code',
      },
    };

    const getHandler = handlers.get(RPC_CHANNELS.memory.GET_SETTINGS);
    expect(getHandler).toBeTruthy();

    await getHandler!(requestContext, 'ws-1');

    expect(getQwenMemorySettingsViaAcpMock).toHaveBeenCalledTimes(1);
    expect(getQwenMemorySettingsViaAcpMock.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/Users/dragon/Documents/qwen-code',
      processCwd: '/Users/dragon/.craft-agent/workspaces/qwen-code',
      projectRoot: '/Users/dragon/Documents/qwen-code',
    });
  });

  it('saves memory settings through the workspace Qwen ACP process', async () => {
    mockedWorkspace = {
      id: 'ws-1',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: '/Users/dragon/.craft-agent/workspaces/qwen-code',
    };
    mockedWorkspaceConfig = {
      defaults: {
        workingDirectory: '/Users/dragon/Documents/qwen-code',
      },
    };

    const setHandler = handlers.get(RPC_CHANNELS.memory.SET_SETTINGS);
    expect(setHandler).toBeTruthy();

    const updates = { enableManagedAutoDream: true };
    await setHandler!(requestContext, updates, 'ws-1');

    expect(setQwenMemorySettingsViaAcpMock).toHaveBeenCalledTimes(1);
    expect(setQwenMemorySettingsViaAcpMock.mock.calls[0]?.[0]).toMatchObject({
      cwd: '/Users/dragon/Documents/qwen-code',
      processCwd: '/Users/dragon/.craft-agent/workspaces/qwen-code',
      projectRoot: '/Users/dragon/Documents/qwen-code',
    });
    expect(setQwenMemorySettingsViaAcpMock.mock.calls[0]?.[1]).toBe(updates);
  });
});
