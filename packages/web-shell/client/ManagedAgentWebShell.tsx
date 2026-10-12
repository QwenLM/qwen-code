import './styles/globals.css';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
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

/** Change productScope with tenant/actor identity so saved selections and output caches are discarded. */
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
    saveArtifact,
  } = props;
  const resolvedLanguage = normalizeLanguage(language);
  // Function props may be inline closures: route them through a ref so the
  // provider (and its caches, fetches and SSE) is rebuilt only when a real
  // connection input changes, not on every parent render. Assigned in a
  // layout effect: a render React discards (a suspended or interrupted
  // transition) must not repoint the committed tree's callbacks, and a
  // passive effect would come too late — the layout phase of a commit
  // finishes before any passive effect, so a child effect of that same
  // commit still reads the fresh callbacks.
  const callbacksRef = useRef({ fetchImpl, getHeaders, saveArtifact });
  useLayoutEffect(() => {
    callbacksRef.current = { fetchImpl, getHeaders, saveArtifact };
  });
  const hasFetch = fetchImpl !== undefined;
  const hasGetHeaders = getHeaders !== undefined;
  const hasSaveArtifact = saveArtifact !== undefined;
  const provider = useMemo(
    () =>
      createJavaManagedAgentProvider({
        baseUrl,
        credentials,
        environmentId,
        fetch: !hasFetch
          ? undefined
          : (...args) => (callbacksRef.current.fetchImpl ?? fetch)(...args),
        getHeaders: !hasGetHeaders
          ? undefined
          : () => callbacksRef.current.getHeaders?.() ?? {},
        agentId,
        productScope,
        enableWorkspaceBinding,
        saveArtifact: !hasSaveArtifact
          ? undefined
          : (artifact, options) =>
              callbacksRef.current.saveArtifact?.(artifact, options) ??
              Promise.resolve(),
      }),
    [
      baseUrl,
      credentials,
      environmentId,
      agentId,
      productScope,
      enableWorkspaceBinding,
      hasFetch,
      hasGetHeaders,
      hasSaveArtifact,
    ],
  );
  const [selection, setSelection] = useState(() => ({
    storageKey: provider.storageKey,
    externalSessionId: sessionId,
    selectedSessionId: sessionId,
  }));
  // With both sessionId and onSessionChange the host owns the selection:
  // onSelectSession suppresses the internal write, but the echoed value
  // still passes through the same state machine — otherwise a host can never
  // return to "no selection" and a scope switch forwards the carried-over id.
  const controlled = sessionId !== undefined && onSessionChange !== undefined;
  let selectedSessionId: string | undefined;
  if (
    selection.storageKey !== provider.storageKey ||
    selection.externalSessionId !== sessionId
  ) {
    // Adjust during render (React's adjusting-state-when-props-change
    // pattern): an external switch is visible on this commit — an effect
    // would paint one stale frame first. Only an id carried over from the
    // previous identity is dropped, never an explicit new selection.
    selectedSessionId =
      selection.storageKey !== provider.storageKey &&
      sessionId === selection.externalSessionId
        ? undefined
        : sessionId;
    setSelection({
      storageKey: provider.storageKey,
      externalSessionId: sessionId,
      selectedSessionId,
    });
  } else {
    selectedSessionId = selection.selectedSessionId;
  }
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const emptyMap = useMemo(() => new Map(), []);

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
                          if (!controlled)
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
