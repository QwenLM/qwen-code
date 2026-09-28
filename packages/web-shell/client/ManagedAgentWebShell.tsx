import './styles/globals.css';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BrandProvider, type WebShellBrand } from './brandContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ManagedSessionsPage } from './components/managed/ManagedSessionsPage';
import {
  createJavaManagedAgentProvider,
  type JavaManagedAgentProviderOptions,
} from './components/managed/java-managed-agent-provider';
import { RootErrorFallback } from './components/RootErrorFallback';
import { WebShellCustomizationProvider } from './customization';
import { I18nProvider, normalizeLanguage, type WebShellLanguage } from './i18n';
import { WebShellPortalRootContext } from './portalRoot';
import {
  ThemeProvider,
  WebShellThemeId,
  type WebShellTheme,
} from './themeContext';
import { CompactModeContext, TodoContextsProvider } from './WebShellContexts';

export interface ManagedAgentWebShellProps
  extends JavaManagedAgentProviderOptions {
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  language?: WebShellLanguage;
  theme?: WebShellTheme;
  brand?: WebShellBrand;
  className?: string;
  style?: CSSProperties;
}

/** Managed-only 产品入口，不创建 daemon workspace/session context。 */
export function ManagedAgentWebShell(props: ManagedAgentWebShellProps) {
  const {
    sessionId,
    onSessionChange,
    language,
    theme = WebShellThemeId.Dark,
    brand = {},
    className,
    style,
    baseUrl,
    credentials,
    environmentId,
    fetch: fetchImpl,
    getHeaders,
    agentId,
    productScope,
    enableWorkspaceBinding,
  } = props;
  const resolvedLanguage = normalizeLanguage(language);
  const provider = useMemo(
    () =>
      createJavaManagedAgentProvider({
        baseUrl,
        credentials,
        environmentId,
        fetch: fetchImpl,
        getHeaders,
        agentId,
        productScope,
        enableWorkspaceBinding,
      }),
    [
      baseUrl,
      credentials,
      environmentId,
      fetchImpl,
      getHeaders,
      agentId,
      productScope,
      enableWorkspaceBinding,
    ],
  );
  const [selection, setSelection] = useState(() => ({
    storageKey: provider.storageKey,
    externalSessionId: sessionId,
    selectedSessionId: sessionId,
  }));
  const selectedSessionId =
    selection.storageKey === provider.storageKey
      ? selection.selectedSessionId
      : sessionId === selection.externalSessionId
        ? undefined
        : sessionId;
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const emptyMap = useMemo(() => new Map(), []);
  useEffect(() => {
    setSelection((current) => ({
      storageKey: provider.storageKey,
      externalSessionId: sessionId,
      selectedSessionId:
        current.storageKey !== provider.storageKey &&
        sessionId === current.externalSessionId
          ? undefined
          : sessionId,
    }));
  }, [sessionId, provider.storageKey]);

  return (
    <ErrorBoundary
      label="managed-agent-web-shell-root"
      resetKeys={[provider.storageKey, selectedSessionId]}
      fallback={(error, reset) => (
        <RootErrorFallback
          error={error}
          onRetry={reset}
          language={resolvedLanguage}
        />
      )}
    >
      <ThemeProvider value={theme}>
        <BrandProvider value={brand}>
          <I18nProvider language={resolvedLanguage}>
            <WebShellPortalRootContext.Provider value={portalRoot}>
              <WebShellCustomizationProvider value={{}}>
                <TodoContextsProvider timeline={emptyMap} details={emptyMap}>
                  <CompactModeContext.Provider value={false}>
                    <div
                      ref={setPortalRoot}
                      className={`${theme === WebShellThemeId.Dark ? 'dark ' : ''}${className ?? ''}`}
                      style={style}
                      data-web-shell-root
                      data-web-shell-shadcn
                      lang={resolvedLanguage}
                    >
                      <ManagedSessionsPage
                        key={provider.storageKey}
                        sessionId={selectedSessionId}
                        onSelectSession={(next) => {
                          setSelection((current) => ({
                            ...current,
                            selectedSessionId: next,
                          }));
                          onSessionChange?.(next);
                        }}
                        managedAgentProvider={provider}
                      />
                    </div>
                  </CompactModeContext.Provider>
                </TodoContextsProvider>
              </WebShellCustomizationProvider>
            </WebShellPortalRootContext.Provider>
          </I18nProvider>
        </BrandProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
