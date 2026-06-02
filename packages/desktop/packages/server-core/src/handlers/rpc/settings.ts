import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'path';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import {
  getPreferencesPath,
  getSessionDraft,
  setSessionDraft,
  deleteSessionDraft,
  getAllSessionDrafts,
  getWorkspaceByNameOrId,
  getDefaultThinkingLevel,
  setDefaultThinkingLevel,
  isProtectedWorkspace,
} from '@craft-agent/shared/config';
import type {
  QwenMemoryPathTarget,
  QwenMemorySettings,
} from '@craft-agent/shared/config';
import { parsePermissionMode } from '@craft-agent/shared/agent/modes';
import type { PermissionMode } from '@craft-agent/shared/agent/modes';
import {
  isValidThinkingLevel,
  normalizeThinkingLevel,
  THINKING_LEVEL_IDS,
} from '@craft-agent/shared/agent/thinking-levels';
import {
  getQwenCoreSettingsViaAcp,
  getQwenMemorySettingsViaAcp,
  getQwenPermissionSettingsViaAcp,
  removeQwenHookViaAcp,
  removeQwenMcpServerViaAcp,
  setQwenMemorySettingsViaAcp,
  setQwenCoreSettingViaAcp,
  setQwenExtensionSettingViaAcp,
  setQwenHookViaAcp,
  setQwenMcpServerViaAcp,
  setQwenPermissionRulesViaAcp,
  getQwenSettingsPathViaAcp,
  getQwenMemoryPathsViaAcp,
} from '@craft-agent/shared/agent';
import type {
  PermissionRuleType,
  PermissionSettingsScope,
  QwenCoreSettingKey,
  QwenCoreSettingsSnapshot,
  QwenHookDefinition,
  QwenHookEvent,
  QwenMcpServerConfig,
  QwenSettingValue,
  QwenSettingsScope,
} from '@craft-agent/shared/protocol';

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(
  (id) => `'${id}'`,
).join(', ');
import {
  getWorkspaceOrThrow,
  buildBackendHostRuntimeContext,
} from '@craft-agent/server-core/handlers';
import type {
  RequestContext,
  RpcServer,
} from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import {
  requestClientOpenFileDialog,
  requestClientOpenPath,
} from '@craft-agent/server-core/transport';
import { isValidWorkingDirectory } from '../../utils/path-validation';

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
  RPC_CHANNELS.preferences.READ,
  RPC_CHANNELS.preferences.WRITE,
  RPC_CHANNELS.drafts.GET,
  RPC_CHANNELS.drafts.SET,
  RPC_CHANNELS.drafts.DELETE,
  RPC_CHANNELS.drafts.GET_ALL,
  RPC_CHANNELS.input.GET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
  RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
  RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT,
  RPC_CHANNELS.memory.GET_SETTINGS,
  RPC_CHANNELS.memory.SET_SETTINGS,
  RPC_CHANNELS.memory.GET_SETTINGS_PATH,
  RPC_CHANNELS.memory.GET_PATHS,
  RPC_CHANNELS.memory.OPEN_PATH,
  RPC_CHANNELS.sessions.GET_MODEL,
  RPC_CHANNELS.sessions.SET_MODEL,
  RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
  RPC_CHANNELS.settings.GET_QWEN_CORE_SETTINGS,
  RPC_CHANNELS.settings.SET_QWEN_CORE_SETTING,
  RPC_CHANNELS.settings.SET_QWEN_MCP_SERVER,
  RPC_CHANNELS.settings.REMOVE_QWEN_MCP_SERVER,
  RPC_CHANNELS.settings.SET_QWEN_HOOK,
  RPC_CHANNELS.settings.REMOVE_QWEN_HOOK,
  RPC_CHANNELS.settings.SET_QWEN_EXTENSION_SETTING,
  RPC_CHANNELS.settings.GET_QWEN_PERMISSION_SETTINGS,
  RPC_CHANNELS.settings.SET_QWEN_PERMISSION_RULES,
  RPC_CHANNELS.settings.GET_GLOBAL_PERMISSION_MODE,
  RPC_CHANNELS.settings.SET_GLOBAL_PERMISSION_MODE,
  RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.dialog.OPEN_FOLDER,
] as const;

async function getQwenWorkspaceAcpOptions(
  deps: HandlerDeps,
  ctx: RequestContext,
  workspaceId?: string,
) {
  const resolvedWorkspaceId =
    workspaceId ??
    ctx.workspaceId ??
    (ctx.webContentsId
      ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
      : undefined);
  const workspace = resolvedWorkspaceId
    ? getWorkspaceByNameOrId(resolvedWorkspaceId)
    : null;
  const { loadWorkspaceConfig } = await import(
    '@craft-agent/shared/workspaces'
  );
  const workspaceConfig = workspace
    ? loadWorkspaceConfig(workspace.rootPath)
    : null;
  const workspaceRoot = workspace?.rootPath;
  const cwd = workspaceConfig?.defaults?.workingDirectory || workspaceRoot;

  return {
    hostRuntime: buildBackendHostRuntimeContext(deps.platform),
    ...(cwd ? { cwd } : {}),
    ...(workspaceRoot ? { processCwd: workspaceRoot } : {}),
    ...(cwd ? { projectRoot: cwd } : {}),
  };
}

function mapPermissionModeToQwenApprovalMode(mode: PermissionMode): string {
  switch (mode) {
    case 'allow-all':
      return 'yolo';
    case 'safe':
      return 'plan';
    case 'auto-edit':
      return 'auto-edit';
    case 'ask':
    default:
      return 'default';
  }
}

function permissionModeFromQwenCoreSettings(
  snapshot: QwenCoreSettingsSnapshot,
): PermissionMode {
  const approvalMode =
    snapshot.merged.values['tools.approvalMode'] ??
    snapshot.user.values['tools.approvalMode'];
  if (typeof approvalMode === 'string') {
    return parsePermissionMode(approvalMode) ?? 'ask';
  }
  return 'ask';
}

export function registerSettingsHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  // ============================================================
  // Settings - Global Permission Mode (App-Level)
  // ============================================================

  server.handle(
    RPC_CHANNELS.settings.GET_GLOBAL_PERMISSION_MODE,
    async (ctx) => {
      const snapshot = await getQwenCoreSettingsViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
      );
      const mode = permissionModeFromQwenCoreSettings(snapshot);
      await deps.sessionManager.applyGlobalPermissionMode(mode, {
        changedBy: 'restore',
      });
      return mode;
    },
  );

  server.handle(
    RPC_CHANNELS.settings.SET_GLOBAL_PERMISSION_MODE,
    async (ctx, mode: string) => {
      const parsed = parsePermissionMode(mode);
      if (!parsed) {
        throw new Error(`Invalid permission mode: ${mode}`);
      }
      const snapshot = await setQwenCoreSettingViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
        'user',
        'tools.approvalMode',
        mapPermissionModeToQwenApprovalMode(parsed),
      );
      await deps.sessionManager.applyGlobalPermissionMode(
        permissionModeFromQwenCoreSettings(snapshot),
      );
      return { success: true };
    },
  );

  // ============================================================
  // Settings - Default Thinking Level (App-Level)
  // ============================================================

  server.handle(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL, async () =>
    getDefaultThinkingLevel(),
  );

  server.handle(
    RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL,
    async (_ctx, level: string) => {
      if (!isValidThinkingLevel(level)) {
        throw new Error(
          `Invalid thinking level: ${level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`,
        );
      }
      const success = setDefaultThinkingLevel(level);
      if (!success) {
        throw new Error('Failed to persist default thinking level');
      }
      return { success: true };
    },
  );

  server.handle(RPC_CHANNELS.settings.GET_QWEN_CORE_SETTINGS, async (ctx) =>
    getQwenCoreSettingsViaAcp(await getQwenWorkspaceAcpOptions(deps, ctx)),
  );

  server.handle(
    RPC_CHANNELS.settings.SET_QWEN_CORE_SETTING,
    async (
      ctx,
      scope: QwenSettingsScope,
      key: QwenCoreSettingKey,
      value: QwenSettingValue,
    ) => {
      const snapshot = await setQwenCoreSettingViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
        scope,
        key,
        value,
      );
      if (key === 'tools.approvalMode') {
        await deps.sessionManager.applyGlobalPermissionMode(
          permissionModeFromQwenCoreSettings(snapshot),
        );
      }
      return snapshot;
    },
  );

  server.handle(
    RPC_CHANNELS.settings.SET_QWEN_MCP_SERVER,
    async (
      ctx,
      scope: QwenSettingsScope,
      name: string,
      mcpServer: QwenMcpServerConfig,
    ) =>
      setQwenMcpServerViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
        scope,
        name,
        mcpServer,
      ),
  );

  server.handle(
    RPC_CHANNELS.settings.REMOVE_QWEN_MCP_SERVER,
    async (ctx, scope: QwenSettingsScope, name: string) =>
      removeQwenMcpServerViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
        scope,
        name,
      ),
  );

  server.handle(
    RPC_CHANNELS.settings.SET_QWEN_HOOK,
    async (
      ctx,
      scope: QwenSettingsScope,
      event: QwenHookEvent,
      index: number | undefined,
      hook: QwenHookDefinition,
    ) =>
      setQwenHookViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
        scope,
        event,
        index,
        hook,
      ),
  );

  server.handle(
    RPC_CHANNELS.settings.REMOVE_QWEN_HOOK,
    async (
      ctx,
      scope: QwenSettingsScope,
      event: QwenHookEvent,
      index: number,
    ) =>
      removeQwenHookViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
        scope,
        event,
        index,
      ),
  );

  server.handle(
    RPC_CHANNELS.settings.SET_QWEN_EXTENSION_SETTING,
    async (
      ctx,
      extensionId: string,
      settingKey: string,
      scope: QwenSettingsScope,
      value: QwenSettingValue,
    ) =>
      setQwenExtensionSettingViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
        extensionId,
        settingKey,
        scope,
        value,
      ),
  );

  server.handle(
    RPC_CHANNELS.settings.GET_QWEN_PERMISSION_SETTINGS,
    async (ctx) =>
      getQwenPermissionSettingsViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
      ),
  );

  server.handle(
    RPC_CHANNELS.settings.SET_QWEN_PERMISSION_RULES,
    async (
      ctx,
      scope: PermissionSettingsScope,
      ruleType: PermissionRuleType,
      rules: string[],
    ) =>
      setQwenPermissionRulesViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx),
        scope,
        ruleType,
        rules,
      ),
  );

  // ============================================================
  // Settings - Model (Session-Specific)
  // ============================================================

  // Get session-specific model
  server.handle(
    RPC_CHANNELS.sessions.GET_MODEL,
    async (
      _ctx,
      sessionId: string,
      _workspaceId: string,
    ): Promise<string | null> => {
      const session = await deps.sessionManager.getSession(sessionId);
      return session?.model ?? null;
    },
  );

  // Set session-specific model (and optionally connection)
  server.handle(
    RPC_CHANNELS.sessions.SET_MODEL,
    async (
      _ctx,
      sessionId: string,
      workspaceId: string,
      model: string | null,
      connection?: string,
    ) => {
      await deps.sessionManager.updateSessionModel(
        sessionId,
        workspaceId,
        model,
        connection,
      );
      deps.platform.logger.info(
        `Session ${sessionId} model updated to: ${model}${connection ? ` (connection: ${connection})` : ''}`,
      );
    },
  );

  // Open native folder dialog for selecting working directory (routed to client)
  server.handle(RPC_CHANNELS.dialog.OPEN_FOLDER, async (ctx) => {
    const result = await requestClientOpenFileDialog(server, ctx.clientId, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Working Directory',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ============================================================
  // Workspace Settings (per-workspace configuration)
  // ============================================================

  // Get workspace settings (model, permission mode, working directory, credential strategy)
  server.handle(
    RPC_CHANNELS.workspace.SETTINGS_GET,
    async (_ctx, workspaceId: string) => {
      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) {
        deps.platform.logger.error(`Workspace not found: ${workspaceId}`);
        return null;
      }

      // Load workspace config
      const { loadWorkspaceConfig } = await import(
        '@craft-agent/shared/workspaces'
      );
      const config = loadWorkspaceConfig(workspace.rootPath);

      return {
        name: config?.name,
        kind: config?.kind ?? workspace.kind,
        isProtected: config?.isProtected ?? workspace.isProtected,
        pinned: config?.pinned ?? false,
        model: config?.defaults?.model,
        permissionMode: config?.defaults?.permissionMode,
        cyclablePermissionModes: config?.defaults?.cyclablePermissionModes,
        thinkingLevel: normalizeThinkingLevel(config?.defaults?.thinkingLevel),
        workingDirectory: config?.defaults?.workingDirectory,
        localMcpEnabled: config?.localMcpServers?.enabled ?? true,
        defaultLlmConnection: config?.defaults?.defaultLlmConnection,
        enabledSourceSlugs: config?.defaults?.enabledSourceSlugs ?? [],
      };
    },
  );

  // Update a workspace setting
  server.handle(
    RPC_CHANNELS.workspace.SETTINGS_UPDATE,
    async (_ctx, workspaceId: string, key: string, value: unknown) => {
      const workspace = getWorkspaceOrThrow(workspaceId);
      const normalizedValue =
        key === 'workingDirectory' && typeof value === 'string'
          ? value.trim()
          : value;

      // Validate key is a known workspace setting
      const validKeys = [
        'name',
        'pinned',
        'model',
        'enabledSourceSlugs',
        'permissionMode',
        'cyclablePermissionModes',
        'thinkingLevel',
        'workingDirectory',
        'localMcpEnabled',
        'defaultLlmConnection',
      ];
      if (!validKeys.includes(key)) {
        throw new Error(
          `Invalid workspace setting key: ${key}. Valid keys: ${validKeys.join(', ')}`,
        );
      }

      if (
        isProtectedWorkspace(workspace) &&
        ['name', 'pinned', 'workingDirectory'].includes(key)
      ) {
        throw new Error(
          'This conversation workspace is managed by Qwen and cannot be renamed, pinned, or moved.',
        );
      }

      // Validate defaultLlmConnection exists before saving
      if (
        key === 'defaultLlmConnection' &&
        normalizedValue !== undefined &&
        normalizedValue !== null
      ) {
        const { getLlmConnection } = await import(
          '@craft-agent/shared/config/storage'
        );
        if (!getLlmConnection(normalizedValue as string)) {
          throw new Error(`LLM connection "${normalizedValue}" not found`);
        }
      }

      if (
        key === 'workingDirectory' &&
        normalizedValue !== undefined &&
        normalizedValue !== null
      ) {
        const validation = isValidWorkingDirectory(String(normalizedValue));
        if (!validation.valid) {
          throw new Error(validation.reason!);
        }
      }

      const { loadWorkspaceConfig, saveWorkspaceConfig } = await import(
        '@craft-agent/shared/workspaces'
      );
      const config = loadWorkspaceConfig(workspace.rootPath);
      if (!config) {
        throw new Error(`Failed to load workspace config: ${workspaceId}`);
      }

      // Handle 'name' specially - it's a top-level config property, not in defaults
      if (key === 'name') {
        config.name = String(normalizedValue).trim();
      } else if (key === 'pinned') {
        config.pinned = Boolean(normalizedValue);
      } else if (key === 'localMcpEnabled') {
        // Store in localMcpServers.enabled (top-level, not in defaults)
        config.localMcpServers = config.localMcpServers || { enabled: true };
        config.localMcpServers.enabled = Boolean(normalizedValue);
      } else {
        // Update the setting in defaults
        config.defaults = config.defaults || {};
        (config.defaults as Record<string, unknown>)[key] = normalizedValue;
      }

      // Save the config
      saveWorkspaceConfig(workspace.rootPath, config);
      deps.platform.logger.info(
        `Workspace setting updated: ${key} = ${JSON.stringify(normalizedValue)}`,
      );
    },
  );

  // ============================================================
  // User Preferences
  // ============================================================

  // Read user preferences file
  server.handle(RPC_CHANNELS.preferences.READ, async () => {
    const path = getPreferencesPath();
    if (!existsSync(path)) {
      return { content: '{}', exists: false, path };
    }
    return { content: readFileSync(path, 'utf-8'), exists: true, path };
  });

  // Write user preferences file (validates JSON before saving)
  server.handle(RPC_CHANNELS.preferences.WRITE, async (_, content: string) => {
    try {
      JSON.parse(content); // Validate JSON
      const path = getPreferencesPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf-8');
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // ============================================================
  // Session Drafts (persisted input text)
  // ============================================================

  // Get draft for a session (text + attachment refs)
  server.handle(RPC_CHANNELS.drafts.GET, async (_ctx, sessionId: string) =>
    getSessionDraft(sessionId),
  );

  // Set draft for a session (empty drafts are cleared)
  server.handle(
    RPC_CHANNELS.drafts.SET,
    async (
      _ctx,
      sessionId: string,
      draft: import('@craft-agent/shared/config').SessionDraft,
    ) => {
      setSessionDraft(sessionId, draft);
    },
  );

  // Delete draft for a session
  server.handle(RPC_CHANNELS.drafts.DELETE, async (_ctx, sessionId: string) => {
    deleteSessionDraft(sessionId);
  });

  // Get all drafts (for loading on app start)
  server.handle(RPC_CHANNELS.drafts.GET_ALL, async () => getAllSessionDrafts());

  // ============================================================
  // Input Settings
  // ============================================================

  // Get auto-capitalisation setting
  server.handle(RPC_CHANNELS.input.GET_AUTO_CAPITALISATION, async () => {
    const { getAutoCapitalisation } = await import(
      '@craft-agent/shared/config/storage'
    );
    return getAutoCapitalisation();
  });

  // Set auto-capitalisation setting
  server.handle(
    RPC_CHANNELS.input.SET_AUTO_CAPITALISATION,
    async (_ctx, enabled: boolean) => {
      const { setAutoCapitalisation } = await import(
        '@craft-agent/shared/config/storage'
      );
      setAutoCapitalisation(enabled);
    },
  );

  // Get send message key setting
  server.handle(RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY, async () => {
    const { getSendMessageKey } = await import(
      '@craft-agent/shared/config/storage'
    );
    return getSendMessageKey();
  });

  // Set send message key setting
  server.handle(
    RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
    async (_ctx, key: 'enter' | 'cmd-enter') => {
      const { setSendMessageKey } = await import(
        '@craft-agent/shared/config/storage'
      );
      setSendMessageKey(key);
    },
  );

  // Get spell check setting
  server.handle(RPC_CHANNELS.input.GET_SPELL_CHECK, async () => {
    const { getSpellCheck } = await import(
      '@craft-agent/shared/config/storage'
    );
    return getSpellCheck();
  });

  // Set spell check setting
  server.handle(
    RPC_CHANNELS.input.SET_SPELL_CHECK,
    async (_ctx, enabled: boolean) => {
      const { setSpellCheck } = await import(
        '@craft-agent/shared/config/storage'
      );
      setSpellCheck(enabled);
    },
  );

  // ============================================================
  // Power Settings
  // ============================================================

  // Get keep awake while running setting
  server.handle(RPC_CHANNELS.power.GET_KEEP_AWAKE, async () => {
    const { getKeepAwakeWhileRunning } = await import(
      '@craft-agent/shared/config/storage'
    );
    return getKeepAwakeWhileRunning();
  });

  // ============================================================
  // Appearance Settings
  // ============================================================

  // Get rich tool descriptions setting
  server.handle(
    RPC_CHANNELS.appearance.GET_RICH_TOOL_DESCRIPTIONS,
    async () => {
      const { getRichToolDescriptions } = await import(
        '@craft-agent/shared/config/storage'
      );
      return getRichToolDescriptions();
    },
  );

  // Set rich tool descriptions setting
  server.handle(
    RPC_CHANNELS.appearance.SET_RICH_TOOL_DESCRIPTIONS,
    async (_ctx, enabled: boolean) => {
      const { setRichToolDescriptions } = await import(
        '@craft-agent/shared/config/storage'
      );
      setRichToolDescriptions(enabled);
    },
  );

  // ============================================================
  // Prompt Caching Settings
  // ============================================================

  // Get extended prompt cache (1h TTL) setting
  server.handle(RPC_CHANNELS.caching.GET_EXTENDED_PROMPT_CACHE, async () => {
    const { getExtendedPromptCache } = await import(
      '@craft-agent/shared/config/storage'
    );
    return getExtendedPromptCache();
  });

  // Set extended prompt cache (1h TTL) setting
  server.handle(
    RPC_CHANNELS.caching.SET_EXTENDED_PROMPT_CACHE,
    async (_ctx, enabled: boolean) => {
      const { setExtendedPromptCache } = await import(
        '@craft-agent/shared/config/storage'
      );
      setExtendedPromptCache(enabled);
    },
  );

  // Get 1M context window setting
  server.handle(RPC_CHANNELS.caching.GET_ENABLE_1M_CONTEXT, async () => {
    const { getEnable1MContext } = await import(
      '@craft-agent/shared/config/storage'
    );
    return getEnable1MContext();
  });

  // Set 1M context window setting
  server.handle(
    RPC_CHANNELS.caching.SET_ENABLE_1M_CONTEXT,
    async (_ctx, enabled: boolean) => {
      const { setEnable1MContext } = await import(
        '@craft-agent/shared/config/storage'
      );
      setEnable1MContext(enabled);
    },
  );

  // ============================================================
  // Memory Settings
  // ============================================================

  server.handle(RPC_CHANNELS.memory.GET_SETTINGS, async () =>
    getQwenMemorySettingsViaAcp({
      hostRuntime: buildBackendHostRuntimeContext(deps.platform),
    }),
  );

  server.handle(
    RPC_CHANNELS.memory.SET_SETTINGS,
    async (_ctx, updates: Partial<QwenMemorySettings>) =>
      setQwenMemorySettingsViaAcp(
        {
          hostRuntime: buildBackendHostRuntimeContext(deps.platform),
        },
        updates,
      ),
  );

  server.handle(RPC_CHANNELS.memory.GET_SETTINGS_PATH, async () =>
    getQwenSettingsPathViaAcp({
      hostRuntime: buildBackendHostRuntimeContext(deps.platform),
    }),
  );

  server.handle(
    RPC_CHANNELS.memory.GET_PATHS,
    async (ctx, workspaceId?: string) =>
      getQwenMemoryPathsViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx, workspaceId),
      ),
  );

  server.handle(
    RPC_CHANNELS.memory.OPEN_PATH,
    async (ctx, target: QwenMemoryPathTarget, workspaceId?: string) => {
      const validTargets: readonly QwenMemoryPathTarget[] = [
        'user',
        'project',
        'auto',
      ];
      if (!validTargets.includes(target)) {
        throw new Error(`Invalid memory path target: ${String(target)}`);
      }

      const paths = await getQwenMemoryPathsViaAcp(
        await getQwenWorkspaceAcpOptions(deps, ctx, workspaceId),
      );
      const targetPath =
        target === 'user'
          ? paths.userMemoryFile
          : target === 'project'
            ? paths.projectMemoryFile
            : paths.autoMemoryDir;
      const result = await requestClientOpenPath(
        server,
        ctx.clientId,
        targetPath,
      );
      if (result.error) {
        throw new Error(result.error);
      }
    },
  );

  // ============================================================
  // Tools Settings
  // ============================================================

  server.handle(RPC_CHANNELS.tools.GET_BROWSER_TOOL_ENABLED, async () => {
    const { getBrowserToolEnabled } = await import(
      '@craft-agent/shared/config/storage'
    );
    return getBrowserToolEnabled();
  });

  server.handle(
    RPC_CHANNELS.tools.SET_BROWSER_TOOL_ENABLED,
    async (_ctx, enabled: boolean) => {
      const { setBrowserToolEnabled } = await import(
        '@craft-agent/shared/config/storage'
      );
      setBrowserToolEnabled(enabled);
    },
  );

  // ============================================================
  // Network Proxy Settings
  // ============================================================

  // Get network proxy settings
  server.handle(RPC_CHANNELS.settings.GET_NETWORK_PROXY, async () => {
    const { getNetworkProxySettings } = await import(
      '@craft-agent/shared/config/storage'
    );
    return getNetworkProxySettings();
  });
}
