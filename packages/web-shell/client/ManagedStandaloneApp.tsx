import { useEffect, useState, type ReactNode } from 'react';
import type {
  ManagedAgentProvider,
  ManagedModelPreset,
} from './components/managed/managed-agent-provider';
import {
  createJavaManagedAgentProvider,
  type JavaManagedAgentProviderOptions,
} from './components/managed/java-managed-agent-provider';
import { ManagedAgentWebShell } from './ManagedAgentWebShell';
import { RootErrorFallback } from './components/RootErrorFallback';
import type { WebShellLanguage } from './i18n';
import { buildSessionPathname, parseSessionId } from './utils/sessionPath';

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
  children,
}: {
  daemonToken?: string;
  language?: WebShellLanguage;
  children: (provider: ManagedAgentProvider) => ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    provider?: ManagedAgentProvider;
    gatewayOptions?: JavaManagedAgentProviderOptions;
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
          boot.enableWorkspaceBinding !== true ||
          ('managedOnly' in boot && typeof boot.managedOnly !== 'boolean')
        ) {
          throw new Error('Managed application returned invalid boot options.');
        }
        const rawPresets = 'modelPresets' in boot ? boot.modelPresets : [];
        if (
          !Array.isArray(rawPresets) ||
          rawPresets.some(
            (item: unknown) =>
              typeof item !== 'object' ||
              item === null ||
              !('agentId' in item) ||
              typeof item.agentId !== 'string' ||
              !item.agentId.trim() ||
              ('modelId' in item &&
                (typeof item.modelId !== 'string' || !item.modelId.trim())) ||
              !('label' in item) ||
              typeof item.label !== 'string' ||
              !item.label.trim(),
          ) ||
          new Set(
            (rawPresets as ManagedModelPreset[]).map(
              (item) => item.modelId ?? item.agentId,
            ),
          ).size !== rawPresets.length
        ) {
          throw new Error(
            'Managed application returned invalid model presets.',
          );
        }
        const modelPresets = rawPresets as ManagedModelPreset[];
        if (!controller.signal.aborted) {
          const options: JavaManagedAgentProviderOptions = {
            baseUrl: window.location.origin,
            productScope: boot.productScope,
            agentId: boot.agentId,
            enableWorkspaceBinding: true,
            modelPresets,
            getHeaders: (): HeadersInit =>
              daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {},
          };
          const url = new URL(window.location.href);
          if (url.searchParams.get('managed') === '1') {
            // Managed restoration must not restore a stale Local route or history target.
            if (parseSessionId(url.pathname) !== undefined) {
              url.pathname = buildSessionPathname(url.pathname, undefined);
            }
            url.searchParams.delete('workspace');
            url.searchParams.delete('context');
            window.history.replaceState(null, '', url);
          }
          setState(
            'managedOnly' in boot && boot.managedOnly
              ? { gatewayOptions: options }
              : { provider: createJavaManagedAgentProvider(options) },
          );
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
  if (state.gatewayOptions) {
    return (
      <ManagedGatewaySurface
        options={state.gatewayOptions}
        language={language}
      />
    );
  }
  if (!state.provider) {
    return (
      <div role="status" style={{ padding: '2rem' }}>
        {language === 'zh-CN' ? '正在连接…' : 'Connecting…'}
      </div>
    );
  }
  return children(state.provider);
}

function selectedGatewaySession(): string | undefined {
  return (
    new URL(window.location.href).searchParams.get('managedSession') ??
    undefined
  );
}

function ManagedGatewaySurface({
  options,
  language,
}: {
  options: JavaManagedAgentProviderOptions;
  language: WebShellLanguage;
}) {
  const [sessionId, setSessionId] = useState(selectedGatewaySession);
  useEffect(() => {
    const restore = () => setSessionId(selectedGatewaySession());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  return (
    <ManagedAgentWebShell
      {...options}
      language={language}
      sessionId={sessionId}
      onSessionChange={(next) => {
        setSessionId(next);
        const url = new URL(window.location.href);
        url.searchParams.set('managed', '1');
        if (next) url.searchParams.set('managedSession', next);
        else url.searchParams.delete('managedSession');
        if (url.href !== window.location.href) {
          window.history.pushState(null, '', url);
        }
      }}
      style={{ height: '100dvh' }}
    />
  );
}
