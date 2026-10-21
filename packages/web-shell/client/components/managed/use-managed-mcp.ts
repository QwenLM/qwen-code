import { useEffect, useMemo } from 'react';
import type { AtMentionWorkspaceActions } from '../../hooks/useAtMentionSources';
import { useI18n } from '../../i18n';
import type { ManagedAgentProvider } from './managed-agent-provider';
import { managedRequestId } from './managed-session-storage';

export function useManagedMcp(
  provider: ManagedAgentProvider,
  clientId: string,
  sessionId: string | undefined,
) {
  const { t } = useI18n();
  const scope = useMemo(
    () => ({
      key: JSON.stringify([
        provider.storageKey,
        clientId,
        sessionId,
        managedRequestId(),
      ]),
      active: false,
      requests: new Set<AbortController>(),
    }),
    [provider, clientId, sessionId],
  );
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      for (const request of scope.requests) request.abort();
      scope.requests.clear();
    };
  }, [scope]);

  return useMemo<AtMentionWorkspaceActions | undefined>(() => {
    const api = provider.mcp;
    if (!api || !sessionId) return undefined;
    return {
      scopeKey: scope.key,
      async loadMcpStatus() {
        if (!scope.active) throw new Error('MCP Session changed.');
        const abort = new AbortController();
        scope.requests.add(abort);
        try {
          const catalog = await api.list(sessionId, {
            clientId,
            signal: abort.signal,
          });
          abort.signal.throwIfAborted();
          if (catalog.session_id !== sessionId)
            throw new Error('MCP catalog Session identity mismatch.');
          return {
            servers: catalog.servers.map((server) => ({
              kind: 'mcp_server' as const,
              name: server.server_id,
              disabled: false,
              resourceCount: server.resources.length,
              description: t('managed.mcp.catalog', {
                tools: server.tools.length,
                toolsState: t(
                  `managed.mcp.discovery.${server.discovery.tools}`,
                ),
                resources: server.resources.length,
                resourcesState: t(
                  `managed.mcp.discovery.${server.discovery.resources}`,
                ),
                prompts: server.prompts.length,
                promptsState: t(
                  `managed.mcp.discovery.${server.discovery.prompts}`,
                ),
              }),
            })),
          };
        } finally {
          scope.requests.delete(abort);
        }
      },
    };
  }, [provider.mcp, clientId, sessionId, scope, t]);
}
