import { useEffect, useState } from 'react';
import { ManagedAgentWebShell } from './ManagedAgentWebShell';
import { RootErrorFallback } from './components/RootErrorFallback';
import type { WebShellLanguage } from './i18n';
import type { WebShellTheme } from './themeContext';

interface ManagedLocalBoot {
  mode: 'managed';
  productScope: string;
  agentId: string;
  enableWorkspaceBinding: true;
}

export function hasManagedAppMarker(): boolean {
  return (
    document
      .querySelector('meta[name="qwen-managed-app"]')
      ?.getAttribute('content') === 'true'
  );
}

export function ManagedStandaloneApp({
  daemonToken,
  language = 'en',
  theme,
}: {
  daemonToken?: string;
  language?: WebShellLanguage;
  theme?: WebShellTheme;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    boot?: ManagedLocalBoot;
    error?: Error;
  }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    void fetch(`${window.location.origin}/managed/boot`, {
      headers: daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {},
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('Managed application is unavailable.');
        const boot: unknown = await response.json();
        if (
          typeof boot !== 'object' ||
          boot === null ||
          !('mode' in boot) ||
          boot.mode !== 'managed' ||
          !('productScope' in boot) ||
          typeof boot.productScope !== 'string' ||
          !boot.productScope.trim() ||
          !('agentId' in boot) ||
          typeof boot.agentId !== 'string' ||
          !boot.agentId.trim() ||
          !('enableWorkspaceBinding' in boot) ||
          boot.enableWorkspaceBinding !== true
        ) {
          throw new Error('Managed application returned invalid boot options.');
        }
        if (!controller.signal.aborted) {
          setState({
            boot: {
              mode: 'managed',
              productScope: boot.productScope,
              agentId: boot.agentId,
              enableWorkspaceBinding: true,
            },
          });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => controller.abort();
  }, [daemonToken, attempt]);

  if (state.error) {
    return (
      <RootErrorFallback
        error={state.error}
        language={language}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }
  if (!state.boot) {
    return (
      <div role="status" style={{ padding: '2rem' }}>
        {language === 'zh-CN' ? '正在连接…' : 'Connecting…'}
      </div>
    );
  }
  return (
    <ManagedAgentWebShell
      baseUrl={window.location.origin}
      agentId={state.boot.agentId}
      productScope={state.boot.productScope}
      enableWorkspaceBinding={state.boot.enableWorkspaceBinding}
      getHeaders={(): HeadersInit =>
        daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {}
      }
      language={language}
      theme={theme}
    />
  );
}
