import './styles/globals.css';
import shellStyles from './App.module.css';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { BrandProvider, type WebShellBrand } from './brandContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ManagedSessionsPage } from './components/managed/ManagedSessionsPage';
import {
  createJavaManagedAgentProvider,
  type JavaManagedAgentProviderOptions,
} from './components/managed/java-managed-agent-provider';
import type { ManagedAgentProvider } from './components/managed/managed-agent-provider';
import { RootErrorFallback } from './components/RootErrorFallback';
import { WebShellCustomizationProvider } from './customization';
import {
  I18nProvider,
  normalizeLanguage,
  useI18n,
  type WebShellLanguage,
} from './i18n';
import { WebShellPortalRootContext } from './portalRoot';
import {
  ThemeProvider,
  WebShellThemeId,
  type WebShellTheme,
} from './themeContext';
import { CompactModeContext, TodoContextsProvider } from './WebShellContexts';

/**
 * 会话列表 portal 到宿主导航槽位所需的 props，直接从 ManagedSessionsPage 的
 * props 推导，避免在入口层维护第二份类型。
 */
type ManagedSessionsNavigationProps = Pick<
  ComponentProps<typeof ManagedSessionsPage>,
  | 'navigationTarget'
  | 'archivedNavigationTarget'
  | 'onArchivedSessionsStatusChange'
  | 'navigationActive'
  | 'navigationSearch'
>;

/**
 * 宿主插槽在 shell 容器之外，编译后的 CSS 只匹配 shell/portal 作用域，
 * 因此每个插槽都套一层带 portal 作用域标记的容器，主题变量由 shell 根同步。
 */
function HostNavigationSlot({
  target,
  children,
}: {
  target: HTMLElement;
  children: ReactNode;
}) {
  return createPortal(
    <div data-web-shell-portal-root data-web-shell-shadcn>
      {children}
    </div>,
    target,
  );
}

/** Change productScope with tenant/actor identity so saved selections and output caches are discarded. */
export interface ManagedAgentWebShellProps
  extends Omit<JavaManagedAgentProviderOptions, 'baseUrl'>,
    ManagedSessionsNavigationProps {
  baseUrl?: string;
  managedAgentProvider?: ManagedAgentProvider;
  /** Only open the existing Session explicitly selected by the host. */
  hostSessionOnly?: boolean;
  sessionId?: string;
  onSessionChange?: (sessionId: string | undefined) => void;
  language?: WebShellLanguage;
  theme?: WebShellTheme;
  brand?: WebShellBrand;
  className?: string;
  style?: CSSProperties;
}

/**
 * Shown when the shell is mounted with neither an injected provider nor a
 * baseUrl to build one from. The mount docs promise a notice in this state;
 * rendering it (rather than an empty wrapper) keeps that promise honest.
 */
function ManagedUnavailableNotice() {
  const { t } = useI18n();
  return (
    <p
      role="status"
      style={{ padding: '2rem', textAlign: 'center', opacity: 0.7 }}
    >
      {t('managed.unavailable')}
    </p>
  );
}

/** Managed-only 产品入口，不创建 daemon workspace/session context。 */
export function ManagedAgentWebShell(props: ManagedAgentWebShellProps) {
  const {
    sessionId,
    managedAgentProvider,
    hostSessionOnly = false,
    onSessionChange,
    language,
    theme = WebShellThemeId.Dark,
    brand = {},
    className,
    style,
    baseUrl,
    credentials,
    fetch: fetchImpl,
    getHeaders,
    agentId,
    productScope,
    enableWorkspaceBinding,
    modelPresets,
    saveArtifact,
    navigationTarget,
    archivedNavigationTarget,
    onArchivedSessionsStatusChange,
    navigationActive,
    navigationSearch,
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
  const archivedStatusRef = useRef(onArchivedSessionsStatusChange);
  const handleArchivedStatusChange = useRef<
    NonNullable<
      ManagedSessionsNavigationProps['onArchivedSessionsStatusChange']
    >
  >((status) => archivedStatusRef.current?.(status));
  const callbacksRef = useRef({ fetchImpl, getHeaders, saveArtifact });
  useLayoutEffect(() => {
    callbacksRef.current = { fetchImpl, getHeaders, saveArtifact };
    archivedStatusRef.current = onArchivedSessionsStatusChange;
  });
  const hasFetch = fetchImpl !== undefined;
  const hasGetHeaders = getHeaders !== undefined;
  const hasSaveArtifact = saveArtifact !== undefined;
  const provider = useMemo(
    () =>
      managedAgentProvider ??
      (baseUrl === undefined
        ? undefined
        : createJavaManagedAgentProvider({
            baseUrl,
            credentials,
            fetch: !hasFetch
              ? undefined
              : (...args) => (callbacksRef.current.fetchImpl ?? fetch)(...args),
            getHeaders: !hasGetHeaders
              ? undefined
              : () => callbacksRef.current.getHeaders?.() ?? {},
            agentId,
            productScope,
            enableWorkspaceBinding,
            modelPresets,
            saveArtifact: !hasSaveArtifact
              ? undefined
              : (artifact, options) =>
                  callbacksRef.current.saveArtifact?.(artifact, options) ??
                  Promise.resolve(),
          })),
    [
      managedAgentProvider,
      baseUrl,
      credentials,
      agentId,
      productScope,
      enableWorkspaceBinding,
      modelPresets,
      hasFetch,
      hasGetHeaders,
      hasSaveArtifact,
    ],
  );
  const [selection, setSelection] = useState(() => ({
    storageKey: provider?.storageKey,
    hostSessionOnly,
    externalSessionId: sessionId,
    selectedSessionId: sessionId,
  }));
  // With both sessionId and onSessionChange the host owns the selection:
  // onSelectSession suppresses the internal write, but the echoed value
  // still passes through the same state machine — otherwise a host can never
  // return to "no selection" and a scope switch forwards the carried-over id.
  const controlled =
    hostSessionOnly ||
    (sessionId !== undefined && onSessionChange !== undefined);
  let selectedSessionId: string | undefined;
  if (
    selection.storageKey !== provider?.storageKey ||
    selection.hostSessionOnly !== hostSessionOnly ||
    selection.externalSessionId !== sessionId
  ) {
    // Adjust during render (React's adjusting-state-when-props-change
    // pattern): an external switch is visible on this commit — an effect
    // would paint one stale frame first. Only an id carried over from the
    // previous identity is dropped, never an explicit new selection.
    selectedSessionId =
      selection.storageKey !== provider?.storageKey &&
      sessionId === selection.externalSessionId
        ? undefined
        : sessionId;
    setSelection({
      storageKey: provider?.storageKey,
      hostSessionOnly,
      externalSessionId: sessionId,
      selectedSessionId,
    });
  } else {
    selectedSessionId = selection.selectedSessionId;
  }
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const shellRootRef = useRef<HTMLDivElement | null>(null);
  const syncHostSlots = useCallback(() => {
    const root = shellRootRef.current;
    if (!root) return;
    const computed = getComputedStyle(root);
    for (const target of [navigationTarget, archivedNavigationTarget]) {
      const slot = target?.firstElementChild;
      if (!(slot instanceof HTMLElement)) continue;
      slot.classList.toggle('dark', theme === WebShellThemeId.Dark);
      slot.lang = resolvedLanguage;
      for (let index = 0; index < computed.length; index += 1) {
        const name = computed[index];
        if (name.startsWith('--'))
          slot.style.setProperty(name, computed.getPropertyValue(name));
      }
    }
  }, [navigationTarget, archivedNavigationTarget, theme, resolvedLanguage]);
  useLayoutEffect(syncHostSlots, [syncHostSlots, portalRoot]);
  const emptyMap = useMemo(() => new Map(), []);

  return (
    <ErrorBoundary
      label="managed-agent-web-shell-root"
      resetKeys={[provider?.storageKey, selectedSessionId]}
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
                      ref={(element) => {
                        shellRootRef.current = element;
                        setPortalRoot(element);
                      }}
                      className={`${shellStyles.app} ${shellStyles.managedHome} ${theme === WebShellThemeId.Dark ? `${shellStyles.themeDark} dark` : shellStyles.themeLight} ${className ?? ''}`}
                      style={style}
                      data-web-shell-root
                      data-web-shell-shadcn
                      lang={resolvedLanguage}
                    >
                      {provider && (
                        <ManagedSessionsPage
                          key={provider.storageKey}
                          renderNavigation={
                            navigationTarget
                              ? (navigation) => (
                                  <HostNavigationSlot target={navigationTarget}>
                                    {navigation}
                                  </HostNavigationSlot>
                                )
                              : undefined
                          }
                          renderArchivedNavigation={(archived) =>
                            archivedNavigationTarget ? (
                              <HostNavigationSlot
                                target={archivedNavigationTarget}
                              >
                                {archived}
                              </HostNavigationSlot>
                            ) : null
                          }
                          sessionId={selectedSessionId}
                          onSelectSession={(next) => {
                            // A host without an echo channel still owns new
                            // selections, but a clear (delete/archive of the
                            // current session) must not evaporate with it.
                            if (
                              !controlled ||
                              (next === undefined &&
                                onSessionChange === undefined)
                            )
                              setSelection((current) => ({
                                ...current,
                                selectedSessionId: next,
                              }));
                            onSessionChange?.(next);
                          }}
                          hostSessionOnly={hostSessionOnly}
                          managedAgentProvider={provider}
                          navigationTarget={navigationTarget}
                          archivedNavigationTarget={archivedNavigationTarget}
                          onArchivedSessionsStatusChange={
                            onArchivedSessionsStatusChange
                              ? handleArchivedStatusChange.current
                              : undefined
                          }
                          navigationActive={navigationActive}
                          navigationSearch={navigationSearch}
                        />
                      )}
                      {!provider && <ManagedUnavailableNotice />}
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
