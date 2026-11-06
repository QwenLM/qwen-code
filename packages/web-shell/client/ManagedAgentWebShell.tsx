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
import type { ManagedArchivedSessionsStatus } from './components/managed/ManagedArchivedSessions';
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
  slotRef,
  children,
}: {
  target: HTMLElement;
  slotRef: (element: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  return createPortal(
    // display:contents keeps the portal-scope/theme wrapper in the DOM (so the
    // scope attributes and synced variables still apply) without generating a
    // box: otherwise this wrapper becomes the host sidebar's flex item and its
    // default min-height:auto blocks the nav's overflow-y-auto from scrolling.
    <div
      ref={slotRef}
      data-web-shell-portal-root
      data-web-shell-shadcn
      style={{ display: 'contents' }}
    >
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
  const stableArchivedCallbackRef = useRef(onArchivedSessionsStatusChange);
  const lastArchivedStatusRef = useRef<
    ManagedArchivedSessionsStatus | undefined
  >(undefined);
  const handleArchivedStatusChange = useRef<
    NonNullable<
      ManagedSessionsNavigationProps['onArchivedSessionsStatusChange']
    >
  >((status) => {
    lastArchivedStatusRef.current = status;
    archivedStatusRef.current?.(status);
  });
  const callbacksRef = useRef({ fetchImpl, getHeaders, saveArtifact });
  useLayoutEffect(() => {
    callbacksRef.current = { fetchImpl, getHeaders, saveArtifact };
    const previous = archivedStatusRef.current;
    const changed = previous !== onArchivedSessionsStatusChange;
    // The child's reporting effect keys on the forwarded identity, which is
    // frozen, so a swapped handler would never see the already-current
    // status. Re-emit it — but only when the replaced callback was stable
    // (the initial one, or one that survived an unchanged commit). Inline
    // closures change identity every render and never qualify, so this
    // cannot rebuild the unbounded render loop the frozen identity prevents.
    if (
      changed &&
      previous !== undefined &&
      previous === stableArchivedCallbackRef.current &&
      onArchivedSessionsStatusChange &&
      lastArchivedStatusRef.current
    ) {
      onArchivedSessionsStatusChange(lastArchivedStatusRef.current);
    }
    if (!changed) stableArchivedCallbackRef.current = previous;
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
  const providerKey = provider?.storageKey;
  let selectedSessionId: string | undefined;
  if (
    // A provider-less render keeps the stored identity, so comparing it to
    // `undefined` here would hold this branch open forever and setState on
    // every render. Only a mounted provider can change the identity.
    (providerKey !== undefined && selection.storageKey !== providerKey) ||
    selection.hostSessionOnly !== hostSessionOnly ||
    selection.externalSessionId !== sessionId
  ) {
    // Adjust during render (React's adjusting-state-when-props-change
    // pattern): an external switch is visible on this commit — an effect
    // would paint one stale frame first. Only an id carried over from the
    // previous identity is dropped, never an explicit new selection. Without a
    // provider there is no previous identity to carry an id over from.
    // Compare against the last real identity, not the stored one: a
    // provider-less render in between must not erase the scope a carried id
    // belongs to, or A -> none -> C would hand A's session to C.
    selectedSessionId =
      providerKey !== undefined &&
      selection.storageKey !== undefined &&
      selection.storageKey !== providerKey &&
      sessionId === selection.externalSessionId
        ? undefined
        : sessionId;
    setSelection({
      // Retain the identity while no provider is mounted. Gating the
      // comparison on providerKey above is what keeps this from making the
      // branch condition permanently true and looping setState per render.
      storageKey: providerKey ?? selection.storageKey,
      hostSessionOnly,
      externalSessionId: sessionId,
      selectedSessionId,
    });
  } else {
    selectedSessionId = selection.selectedSessionId;
  }
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const shellRootRef = useRef<HTMLDivElement | null>(null);
  // Stable, or React detaches the inline callback with null in every commit's
  // mutation phase and `syncSlot` below sees no root.
  const setShellRoot = useCallback((element: HTMLDivElement | null) => {
    shellRootRef.current = element;
    setPortalRoot(element);
  }, []);
  // A wrapper can mount in a commit where none of the sync effect's deps
  // changed (the provider arrives later, hostSessionOnly flips, the provider
  // identity remounts the page), so the ref callback themes the element it
  // just saw instead of relying on the effect to notice the mount.
  const slotTokenNames = useMemo(
    () => new WeakMap<HTMLElement, Set<string>>(),
    [],
  );
  const syncSlot = useCallback(
    (slot: HTMLElement) => {
      const root = shellRootRef.current;
      if (!root) return;
      const computed = getComputedStyle(root);
      slot.classList.toggle('dark', theme === WebShellThemeId.Dark);
      slot.lang = resolvedLanguage;
      const applied = slotTokenNames.get(slot) ?? new Set<string>();
      const current = new Set<string>();
      for (let index = 0; index < computed.length; index += 1) {
        const name = computed[index];
        if (!name.startsWith('--')) continue;
        current.add(name);
        slot.style.setProperty(name, computed.getPropertyValue(name));
      }
      // A token the root no longer defines must not stay pinned here: an
      // inline declaration on our own wrapper outranks the host's cascade,
      // so a withdrawn host token would otherwise outlive its source.
      for (const name of applied)
        if (!current.has(name)) slot.style.removeProperty(name);
      slotTokenNames.set(slot, current);
    },
    [theme, resolvedLanguage, slotTokenNames],
  );
  const registerHostSlot = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) syncSlot(element);
    },
    [syncSlot],
  );
  // Our own wrappers are the only nodes carrying the portal-scope marker, so
  // the host slot's own chrome is never themed and a wrapper that outlives a
  // detach is picked up again instead of being dropped from a registry.
  const syncHostSlots = useCallback(() => {
    for (const target of [navigationTarget, archivedNavigationTarget]) {
      if (!target) continue;
      for (const slot of target.querySelectorAll<HTMLElement>(
        '[data-web-shell-portal-root]',
      ))
        syncSlot(slot);
    }
  }, [syncSlot, navigationTarget, archivedNavigationTarget]);
  useLayoutEffect(syncHostSlots, [syncHostSlots, style, portalRoot]);
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
                      ref={setShellRoot}
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
                                  <HostNavigationSlot
                                    target={navigationTarget}
                                    slotRef={registerHostSlot}
                                  >
                                    {navigation}
                                  </HostNavigationSlot>
                                )
                              : undefined
                          }
                          renderArchivedNavigation={(archived) =>
                            archivedNavigationTarget ? (
                              <HostNavigationSlot
                                target={archivedNavigationTarget}
                                slotRef={registerHostSlot}
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
