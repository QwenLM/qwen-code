import {
  RPC_CHANNELS,
  type LlmConnectionSetup,
  type QwenProviderCatalog,
  type QwenProviderConnectParams,
  type QwenProviderConnectResult,
} from '@craft-agent/shared/protocol';
import {
  QWEN_CODE_CONNECTION_SLUG,
  addLlmConnection,
  deleteLlmConnection,
  getDefaultLlmConnection,
  getLlmConnection,
  getLlmConnections,
  setDefaultLlmConnection,
  touchLlmConnection,
  updateLlmConnection,
  type LlmConnection,
  type LlmConnectionWithStatus,
} from '@craft-agent/shared/config';
import { BRAND } from '@craft-agent/shared/branding';
import { getCredentialManager } from '@craft-agent/shared/credentials';
import { setSetupDeferred } from '@craft-agent/shared/config/storage';
import {
  testBackendConnection,
  validateStoredBackendConnection,
} from '@craft-agent/shared/agent/backend';
import {
  connectQwenProviderViaAcp,
  listQwenProvidersViaAcp,
} from '@craft-agent/shared/agent';
import { getModelRefreshService } from '@craft-agent/server-core/model-fetchers';
import {
  createBuiltInConnection,
  parseTestConnectionError,
} from '@craft-agent/server-core/domain';
import {
  getWorkspaceOrThrow,
  buildBackendHostRuntimeContext,
} from '@craft-agent/server-core/handlers';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';

function attachRuntimeModelState<T extends LlmConnection>(connection: T): T {
  let runtimeState:
    | { models: NonNullable<LlmConnection['models']>; serverDefault?: string }
    | undefined;
  try {
    runtimeState = getModelRefreshService().getRuntimeModelState(
      connection.slug,
    );
  } catch {
    runtimeState = undefined;
  }
  if (
    !runtimeState ||
    (runtimeState.models.length === 0 && !runtimeState.serverDefault)
  ) {
    return connection;
  }
  return {
    ...connection,
    models: runtimeState.models,
    defaultModel: runtimeState.serverDefault,
  };
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.settings.LIST_QWEN_PROVIDERS,
  RPC_CHANNELS.settings.CONNECT_QWEN_PROVIDER,
] as const;

function ensureQwenConnection(slug = QWEN_CODE_CONNECTION_SLUG): LlmConnection {
  return (
    getLlmConnection(slug) ?? createBuiltInConnection(QWEN_CODE_CONNECTION_SLUG)
  );
}

export function registerLlmConnectionsHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  const { sessionManager } = deps;

  server.handle(
    RPC_CHANNELS.settings.LIST_QWEN_PROVIDERS,
    async (_ctx, sessionId?: string): Promise<QwenProviderCatalog> => {
      if (sessionId) {
        try {
          return await sessionManager.listSessionQwenProviders(sessionId);
        } catch (error) {
          deps.platform.logger?.warn(
            `Qwen provider list via active session failed: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      return listQwenProvidersViaAcp({
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
      });
    },
  );

  server.handle(
    RPC_CHANNELS.settings.CONNECT_QWEN_PROVIDER,
    async (
      _ctx,
      params: QwenProviderConnectParams,
      sessionId?: string,
    ): Promise<QwenProviderConnectResult> => {
      try {
        const scopedParams: QwenProviderConnectParams = {
          ...params,
          scope: 'user',
        };
        let result: QwenProviderConnectResult;
        if (sessionId) {
          try {
            result = await sessionManager.connectSessionQwenProvider(
              sessionId,
              scopedParams,
            );
          } catch (error) {
            deps.platform.logger?.warn(
              `Qwen provider connect via active session failed: ${error instanceof Error ? error.message : error}`,
            );
            result = await connectQwenProviderViaAcp(
              { hostRuntime: buildBackendHostRuntimeContext(deps.platform) },
              scopedParams,
            );
          }
        } else {
          result = await connectQwenProviderViaAcp(
            { hostRuntime: buildBackendHostRuntimeContext(deps.platform) },
            scopedParams,
          );
        }
        if (!result.success) return result;

        const existing = ensureQwenConnection();
        const qwenConnection: LlmConnection = {
          ...existing,
          slug: QWEN_CODE_CONNECTION_SLUG,
          name: BRAND.selfReferName,
          providerType: 'qwen',
          authType: 'none',
          defaultModel: result.modelId || existing.defaultModel,
        };
        if (getLlmConnection(qwenConnection.slug)) {
          updateLlmConnection(qwenConnection.slug, qwenConnection);
        } else {
          addLlmConnection(qwenConnection);
        }
        setDefaultLlmConnection(qwenConnection.slug);

        try {
          await getModelRefreshService().refreshNow(qwenConnection.slug);
        } catch (err) {
          deps.platform.logger?.warn(
            `Qwen model refresh after provider connect failed: ${err instanceof Error ? err.message : err}`,
          );
        }

        await sessionManager.reinitializeAuth(qwenConnection.slug);
        setSetupDeferred(false);
        return result;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        deps.platform.logger?.error(
          'Failed to connect Qwen provider:',
          message,
        );
        return { success: false, error: message };
      }
    },
  );

  server.handle(
    RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
    async (
      _ctx,
      setup: LlmConnectionSetup,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const connection = ensureQwenConnection(setup.slug);
        const qwenConnection: LlmConnection = {
          ...connection,
          slug: QWEN_CODE_CONNECTION_SLUG,
          name: BRAND.selfReferName,
          providerType: 'qwen',
          authType: 'none',
        };

        if (getLlmConnection(qwenConnection.slug)) {
          updateLlmConnection(qwenConnection.slug, qwenConnection);
        } else {
          addLlmConnection(qwenConnection);
        }
        setDefaultLlmConnection(qwenConnection.slug);

        try {
          await getModelRefreshService().refreshNow(qwenConnection.slug);
        } catch (err) {
          deps.platform.logger?.warn(
            `Qwen model refresh after setup failed: ${err instanceof Error ? err.message : err}`,
          );
        }

        await sessionManager.reinitializeAuth(qwenConnection.slug);
        setSetupDeferred(false);
        return { success: true };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        deps.platform.logger?.error(
          'Failed to setup Qwen connection:',
          message,
        );
        return { success: false, error: message };
      }
    },
  );

  server.handle(
    RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
    async (
      _ctx,
      params: import('@craft-agent/shared/protocol').TestLlmConnectionParams,
    ): Promise<
      import('@craft-agent/shared/protocol').TestLlmConnectionResult
    > => {
      const startedAt = Date.now();
      try {
        const result = await testBackendConnection({
          provider: 'qwen',
          apiKey: '',
          model: params.model || 'qwen3-coder',
          timeoutMs: 45000,
          hostRuntime: buildBackendHostRuntimeContext(deps.platform),
          connection: { providerType: 'qwen' },
        });
        const elapsed = Date.now() - startedAt;
        deps.platform.logger?.info(
          `[testQwenConnectionSetup] Elapsed: ${elapsed}ms, success=${result.success}`,
        );
        return result.success
          ? { success: true }
          : {
              success: false,
              error: parseTestConnectionError(result.error || 'Unknown error'),
            };
      } catch (error) {
        const elapsed = Date.now() - startedAt;
        const msg = error instanceof Error ? error.message : String(error);
        deps.platform.logger?.info(
          `[testQwenConnectionSetup] Elapsed: ${elapsed}ms, threw: ${msg.slice(0, 1000)}`,
        );
        return { success: false, error: parseTestConnectionError(msg) };
      }
    },
  );

  server.handle(
    RPC_CHANNELS.llmConnections.LIST,
    async (): Promise<LlmConnection[]> =>
      getLlmConnections().map(attachRuntimeModelState),
  );

  server.handle(
    RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
    async (): Promise<LlmConnectionWithStatus[]> => {
      const defaultSlug = getDefaultLlmConnection();
      return getLlmConnections().map(
        (conn): LlmConnectionWithStatus =>
          attachRuntimeModelState({
            ...conn,
            isAuthenticated: true,
            isDefault: conn.slug === defaultSlug,
          }),
      );
    },
  );

  server.handle(
    RPC_CHANNELS.llmConnections.GET,
    async (_ctx, slug: string): Promise<LlmConnection | null> => {
      const connection = getLlmConnection(slug);
      return connection ? attachRuntimeModelState(connection) : null;
    },
  );

  server.handle(
    RPC_CHANNELS.llmConnections.GET_API_KEY,
    async (): Promise<string | null> => null,
  );

  server.handle(
    RPC_CHANNELS.llmConnections.SAVE,
    async (
      _ctx,
      connection: LlmConnection,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const qwenConnection: LlmConnection = {
          ...connection,
          slug: connection.slug || QWEN_CODE_CONNECTION_SLUG,
          name: connection.name || BRAND.selfReferName,
          providerType: 'qwen',
          authType: 'none',
        };
        const existing = getLlmConnection(qwenConnection.slug);
        const success = existing
          ? updateLlmConnection(qwenConnection.slug, qwenConnection)
          : addLlmConnection(qwenConnection);
        if (!success)
          return { success: false, error: 'Failed to save connection' };
        if (!getDefaultLlmConnection())
          setDefaultLlmConnection(qwenConnection.slug);
        await sessionManager.reinitializeAuth(qwenConnection.slug);
        return { success: true };
      } catch (error) {
        deps.platform.logger?.error('Failed to save Qwen connection:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  server.handle(
    RPC_CHANNELS.llmConnections.DELETE,
    async (
      _ctx,
      slug: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const success = deleteLlmConnection(slug);
        if (success) {
          getModelRefreshService().stopConnection(slug);
          await getCredentialManager().deleteLlmCredentials(slug);
        }
        return { success };
      } catch (error) {
        deps.platform.logger?.error('Failed to delete Qwen connection:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  server.handle(
    RPC_CHANNELS.llmConnections.TEST,
    async (
      _ctx,
      slug: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const connection = getLlmConnection(slug);
        if (!connection)
          return { success: false, error: 'Connection not found' };
        const result = await validateStoredBackendConnection({
          slug,
          connection,
          hostRuntime: buildBackendHostRuntimeContext(deps.platform),
        });
        if (!result.success) return { success: false, error: result.error };
        touchLlmConnection(slug);
        if (result.shouldRefreshModels) {
          getModelRefreshService()
            .refreshNow(slug)
            .catch((err) => {
              deps.platform.logger?.warn(
                `Qwen model refresh failed during validation: ${err instanceof Error ? err.message : err}`,
              );
            });
        }
        return { success: true };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: parseTestConnectionError(msg) };
      }
    },
  );

  server.handle(
    RPC_CHANNELS.llmConnections.SET_DEFAULT,
    async (
      _ctx,
      slug: string,
    ): Promise<{ success: boolean; error?: string }> => {
      const success = setDefaultLlmConnection(slug);
      if (success) await sessionManager.reinitializeAuth(slug);
      return { success, error: success ? undefined : 'Connection not found' };
    },
  );

  server.handle(
    RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
    async (
      _ctx,
      workspaceId: string,
      slug: string | null,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        const workspace = getWorkspaceOrThrow(workspaceId);
        if (slug && !getLlmConnection(slug))
          return { success: false, error: 'Connection not found' };
        const { loadWorkspaceConfig, saveWorkspaceConfig } = await import(
          '@craft-agent/shared/workspaces'
        );
        const config = loadWorkspaceConfig(workspace.rootPath);
        if (!config)
          return { success: false, error: 'Failed to load workspace config' };
        config.defaults = config.defaults || {};
        if (slug) config.defaults.defaultLlmConnection = slug;
        else delete config.defaults.defaultLlmConnection;
        saveWorkspaceConfig(workspace.rootPath, config);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  server.handle(
    RPC_CHANNELS.llmConnections.REFRESH_MODELS,
    async (
      _ctx,
      slug: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!getLlmConnection(slug))
          return { success: false, error: 'Connection not found' };
        await getModelRefreshService().refreshNow(slug);
        return { success: true };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        deps.platform.logger?.error(
          `Failed to refresh Qwen models for ${slug}: ${msg}`,
        );
        return { success: false, error: msg };
      }
    },
  );
}
