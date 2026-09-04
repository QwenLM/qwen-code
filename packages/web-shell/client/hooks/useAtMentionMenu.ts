import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import type { RefObject, ReactNode } from 'react';
import type { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type {
  WebShellAtProvider,
  WebShellAtProviderTab,
  WebShellBuiltinAtProviderId,
  WebShellBuiltinAtProvidersConfig,
  WebShellComposerTag,
} from '../customization';
import { useI18n } from '../i18n';
import {
  BUILTIN_PROVIDER_IDS,
  EXTENSIONS_PROVIDER_ID,
  FILE_PROVIDER_ID,
  FILE_ROOT_ITEM_LIMIT,
  ITEM_LIMIT,
  MCP_RESOURCES_PROVIDER_ID,
  SAFE_DISPLAY_FALLBACK,
  createBuiltinProviderCache,
  createComposerTagForItem,
  createExtensionProvider,
  createFileProvider,
  createMcpResourcesProvider,
  escapeAtReferenceText,
  fileSearchGlobPattern,
  getCached,
  matchesQuery,
  normalizeDirectoryPath,
  safeDisplayText,
  sanitizeAtMentionItem,
  sanitizeDisplayText,
  sanitizeInsertText,
  splitFileQuery,
  unescapeAtReferenceText,
} from './useAtMentionSources';
import type {
  AtMentionItem,
  AtMentionWorkspaceActions,
  BuiltinProviderCache,
  McpStatus,
} from './useAtMentionSources';

export {
  FILE_PROVIDER_ID,
  MCP_RESOURCES_PROVIDER_ID,
  fileReferenceInsertText,
  sanitizeDisplayText,
} from './useAtMentionSources';
export type {
  AtMentionItem,
  AtMentionWorkspaceActions,
} from './useAtMentionSources';

export interface AtMentionProviderView {
  id: string;
  provider: WebShellAtProvider;
  label: ReactNode;
  textValue: string;
  description?: string;
  tabs?: readonly WebShellAtProviderTab[];
  selectedTabId?: string;
  renderItem?: WebShellAtProvider['renderItem'];
}

export interface AtMentionMenuState {
  from: number;
  to: number;
  query: string;
  level: 'categories' | 'items';
  selectedProviderId?: string;
  selectedIndex: number;
  providers: AtMentionProviderView[];
  items: AtMentionItem[];
  loading: boolean;
  itemMode?: 'default' | 'mcpServers' | 'mcpResources';
  mcpServerName?: string;
  fileDirectory?: string;
  // search mode owns the panel input; context mode mirrors text typed in the editor.
  inputMode?: 'search' | 'context';
  validateMcpServer?: boolean;
  tabs?: readonly WebShellAtProviderTab[];
  selectedTabId?: string;
}

interface LoadMcpResourceOptions {
  validateServer?: boolean;
}

export interface UseAtMentionMenuOptions {
  viewRef: RefObject<EditorView | null>;
  disabledRef: RefObject<boolean>;
  shellModeRef: RefObject<boolean>;
  workspaceActionsRef: RefObject<AtMentionWorkspaceActions | undefined>;
  workspaceKey?: string;
  builtinProviders?: WebShellBuiltinAtProvidersConfig;
  providers?: readonly WebShellAtProvider[];
  createInlineTagEffect?: (range: {
    from: number;
    to: number;
    tag: WebShellComposerTag;
  }) => StateEffect<unknown>;
  /**
   * Invoked when the user selects the synthetic "Upload file" item in the
   * file provider. Receives the directory currently being browsed and a
   * callback that re-inserts the mention query removed before the picker
   * opened — call it when the picker closes without an upload so the typed
   * text is not lost. When absent (upload unsupported), the item is hidden.
   */
  onUploadRequest?: (targetDir: string, restoreQuery?: () => void) => void;
}

const AT_PATTERN = /@((?:[\p{L}\p{N}_./:-]|\\.)*)$/u;
const EMPTY_PROVIDERS: readonly WebShellAtProvider[] = [];
const SEARCH_DEBOUNCE_MS = 150;

function shallowEqualMenuState(
  current: AtMentionMenuState | null,
  next: AtMentionMenuState | null,
): boolean {
  if (current === next) return true;
  if (!current || !next) return false;
  const keys = Object.keys(current) as Array<keyof AtMentionMenuState>;
  return (
    keys.length === Object.keys(next).length &&
    keys.every((key) => {
      const currentValue = current[key];
      const nextValue = next[key];
      if (Object.is(currentValue, nextValue)) return true;
      return (
        Array.isArray(currentValue) &&
        Array.isArray(nextValue) &&
        currentValue.length === nextValue.length &&
        currentValue.every((value, index) => Object.is(value, nextValue[index]))
      );
    })
  );
}

function equalProviderViews(
  current: readonly AtMentionProviderView[],
  next: readonly AtMentionProviderView[],
): boolean {
  return (
    current.length === next.length &&
    current.every((provider, index) => {
      const nextProvider = next[index];
      return (
        nextProvider !== undefined &&
        provider.id === nextProvider.id &&
        provider.textValue === nextProvider.textValue &&
        Object.is(provider.label, nextProvider.label) &&
        provider.description === nextProvider.description &&
        provider.tabs === nextProvider.tabs &&
        provider.selectedTabId === nextProvider.selectedTabId &&
        provider.renderItem === nextProvider.renderItem
      );
    })
  );
}

function isBuiltinProviderId(providerId: string): boolean {
  return BUILTIN_PROVIDER_IDS.includes(
    providerId as WebShellBuiltinAtProviderId,
  );
}

function isBuiltinProviderEnabled(
  providerId: WebShellBuiltinAtProviderId,
  config: WebShellBuiltinAtProvidersConfig | undefined,
): boolean {
  if (config === undefined || config === true) return true;
  if (config === false) return false;
  if (Array.isArray(config)) {
    return (config as readonly WebShellBuiltinAtProviderId[]).includes(
      providerId,
    );
  }
  const options = config as Exclude<
    WebShellBuiltinAtProvidersConfig,
    boolean | readonly WebShellBuiltinAtProviderId[]
  >;
  if (options.enabled === false) return false;
  if (options.include && !options.include.includes(providerId)) return false;
  if (options.exclude?.includes(providerId)) return false;
  return true;
}

function getRegisteredCustomProviders(
  customProviders: readonly WebShellAtProvider[],
): WebShellAtProvider[] {
  const registeredIds = new Set<string>(BUILTIN_PROVIDER_IDS);
  const accepted: WebShellAtProvider[] = [];
  for (const provider of customProviders) {
    if (registeredIds.has(provider.id)) {
      console.error(
        `[@mention] duplicate provider id="${provider.id}" ignored`,
      );
      continue;
    }
    registeredIds.add(provider.id);
    accepted.push(provider);
  }
  return accepted;
}

function getProviderTextValue(provider: WebShellAtProvider): string {
  return (
    (provider.textValue === undefined
      ? undefined
      : sanitizeDisplayText(provider.textValue)) ??
    (typeof provider.label === 'string'
      ? (sanitizeDisplayText(provider.label) ?? undefined)
      : undefined) ??
    safeDisplayText(provider.id) ??
    SAFE_DISPLAY_FALLBACK
  );
}

function buildMcpResourceRef(serverName: string, uri: string): string {
  return `${serverName}:${uri}`;
}

function mcpResourceInsertText(serverName: string, uri: string): string {
  return `@${escapeAtReferenceText(
    buildMcpResourceRef(
      sanitizeInsertText(serverName),
      sanitizeInsertText(uri),
    ),
  )} `;
}

function splitInsertedReferenceQuery(
  query: string,
  lastSelectedProviderId: string | null,
  lastSelectedMcpServerName: string | null,
): {
  providerId: string;
  serverName?: string;
  itemQuery: string;
  validateServer?: boolean;
} | null {
  const unescapedQuery = unescapeAtReferenceText(query);
  if (
    lastSelectedProviderId === MCP_RESOURCES_PROVIDER_ID &&
    lastSelectedMcpServerName &&
    unescapedQuery.startsWith(`${lastSelectedMcpServerName}:`)
  ) {
    return {
      providerId: MCP_RESOURCES_PROVIDER_ID,
      serverName: lastSelectedMcpServerName,
      itemQuery: unescapedQuery.slice(lastSelectedMcpServerName.length + 1),
      validateServer: true,
    };
  }
  if (query.startsWith('ext:')) {
    return {
      providerId: EXTENSIONS_PROVIDER_ID,
      itemQuery: query.slice('ext:'.length),
    };
  }
  if (query.startsWith('mcp:')) {
    return {
      providerId: MCP_RESOURCES_PROVIDER_ID,
      itemQuery: query.slice('mcp:'.length),
    };
  }
  return null;
}

function getProviderQueryFromMention(
  providerId: string,
  parsedQuery: string,
  mcpServerName?: string,
): string {
  if (providerId === EXTENSIONS_PROVIDER_ID && parsedQuery.startsWith('ext:')) {
    return parsedQuery.slice('ext:'.length);
  }
  if (
    providerId === MCP_RESOURCES_PROVIDER_ID &&
    parsedQuery.startsWith('mcp:')
  ) {
    return parsedQuery.slice('mcp:'.length);
  }
  const unescapedQuery = unescapeAtReferenceText(parsedQuery);
  if (
    providerId === MCP_RESOURCES_PROVIDER_ID &&
    mcpServerName &&
    unescapedQuery.startsWith(`${mcpServerName}:`)
  ) {
    return unescapedQuery.slice(mcpServerName.length + 1);
  }
  if (
    !isBuiltinProviderId(providerId) &&
    parsedQuery.startsWith(`${providerId}:`)
  ) {
    return parsedQuery.slice(providerId.length + 1);
  }
  return parsedQuery;
}

async function isEnabledMcpServer(
  actions: AtMentionWorkspaceActions | undefined,
  serverName: string,
  signal?: AbortSignal,
  loadStatus?: () => Promise<McpStatus>,
) {
  if (signal?.aborted) return false;
  const loadMcpStatus = loadStatus ?? actions?.loadMcpStatus;
  if (!loadMcpStatus) return false;
  try {
    const status = await loadMcpStatus();
    if (signal?.aborted) return false;
    return status.servers.some(
      (server) => server.name === serverName && !server.disabled,
    );
  } catch (error) {
    console.warn(`Failed to verify @ MCP server "${serverName}" status`, error);
    return false;
  }
}

function parentDirectoryPath(path: string): string {
  const normalized = normalizeDirectoryPath(path);
  if (normalized === '.') return '.';
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex < 0 ? '.' : normalized.slice(0, slashIndex);
}

function parseAtMention(view: EditorView | null) {
  if (!view) return null;
  const selection = view.state.selection.main;
  if (!selection.empty) return null;
  const line = view.state.doc.lineAt(selection.head);
  const textBefore = line.text.slice(0, selection.head - line.from);
  const match = textBefore.match(AT_PATTERN);
  if (!match) return null;
  const from = selection.head - match[0].length;
  if (from > line.from) {
    const previous = view.state.doc.sliceString(from - 1, from);
    if (!/[\s([{'"]/.test(previous)) {
      return null;
    }
  }
  return {
    from,
    to: selection.head,
    query: match[1] ?? '',
  };
}

function nextSelectionIndex(
  current: number,
  total: number,
  direction: 'up' | 'down',
) {
  if (total <= 0) return null;
  if (direction === 'up') return current <= 0 ? null : current - 1;
  return current >= total - 1 ? null : current + 1;
}

export function useAtMentionMenu({
  viewRef,
  disabledRef,
  shellModeRef,
  workspaceActionsRef,
  workspaceKey,
  builtinProviders,
  providers = EMPTY_PROVIDERS,
  createInlineTagEffect,
  onUploadRequest,
}: UseAtMentionMenuOptions) {
  const { t } = useI18n();
  const [state, setState] = useState<AtMentionMenuState | null>(null);
  const stateRef = useRef<AtMentionMenuState | null>(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileDirectoryRef = useRef('.');
  const builtinCacheRef = useRef<BuiltinProviderCache>(
    createBuiltinProviderCache(),
  );
  const lastSelectedProviderIdRef = useRef<string | null>(null);
  const lastSelectedMcpServerNameRef = useRef<string | null>(null);
  const preserveProviderSelectionRef = useRef(false);

  const allProviders = useMemo(() => {
    const builtinAtProviders = [
      createFileProvider(
        () => workspaceActionsRef.current,
        () => fileDirectoryRef.current,
        () => builtinCacheRef.current,
        t('at.category.files'),
        t('at.category.files.description'),
        () =>
          onUploadRequest
            ? {
                id: 'upload-file',
                label: t('at.files.upload'),
                description: t('at.files.upload.description'),
                kind: 'upload',
                insertText: '',
              }
            : null,
      ),
      createExtensionProvider(
        () => workspaceActionsRef.current,
        () => builtinCacheRef.current,
        t('at.category.extensions'),
        t('at.category.extensions.description'),
      ),
      createMcpResourcesProvider(
        () => workspaceActionsRef.current,
        () => builtinCacheRef.current,
        t('at.category.mcpResources'),
        t('at.category.mcpResources.description'),
        (count) => t('mcp.resourceCount', { count }),
      ),
    ].filter((provider) =>
      isBuiltinProviderEnabled(
        provider.id as WebShellBuiltinAtProviderId,
        builtinProviders,
      ),
    );
    return [
      ...builtinAtProviders,
      ...getRegisteredCustomProviders(providers),
    ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [builtinProviders, providers, t, workspaceActionsRef, onUploadRequest]);
  const allProvidersRef = useRef(allProviders);
  allProvidersRef.current = allProviders;

  const providerViews = useMemo(
    () =>
      allProviders.map((provider) => ({
        id: provider.id,
        provider,
        textValue: getProviderTextValue(provider),
        label:
          typeof provider.label === 'string'
            ? getProviderTextValue(provider)
            : provider.label,
        description:
          provider.description === undefined
            ? undefined
            : sanitizeDisplayText(provider.description),
        tabs: provider.tabs,
        renderItem: provider.renderItem,
      })),
    [allProviders],
  );
  const providerViewsRef = useRef(providerViews);
  providerViewsRef.current = providerViews;

  const setMenu = useCallback(
    (next: SetStateAction<AtMentionMenuState | null>) => {
      const resolved =
        typeof next === 'function' ? next(stateRef.current) : next;
      if (shallowEqualMenuState(stateRef.current, resolved)) return;
      stateRef.current = resolved;
      setState(resolved);
    },
    [],
  );

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    fileDirectoryRef.current = '.';
    builtinCacheRef.current = createBuiltinProviderCache();
    stateRef.current = null;
    setState(null);
  }, [workspaceKey]);

  const clearPendingLoad = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  }, []);

  const close = useCallback(
    (options: { preserveProviderSelection?: boolean } = {}) => {
      if (
        stateRef.current === null &&
        abortRef.current === null &&
        searchTimerRef.current === null &&
        lastSelectedProviderIdRef.current === null &&
        lastSelectedMcpServerNameRef.current === null &&
        !preserveProviderSelectionRef.current
      ) {
        return;
      }
      clearPendingLoad();
      builtinCacheRef.current = createBuiltinProviderCache();
      const preserveSelection =
        options.preserveProviderSelection ||
        preserveProviderSelectionRef.current;
      preserveProviderSelectionRef.current = false;
      if (!preserveSelection) {
        lastSelectedProviderIdRef.current = null;
        lastSelectedMcpServerNameRef.current = null;
      }
      setMenu(null);
    },
    [clearPendingLoad, setMenu],
  );

  const closeIfOpen = useCallback(() => {
    const current = stateRef.current;
    if (!current) return false;
    if (current.level === 'items') {
      clearPendingLoad();
      setMenu({
        ...current,
        level: 'categories',
        selectedProviderId: undefined,
        selectedIndex: 0,
        query: '',
        items: [],
        loading: false,
        itemMode: undefined,
        mcpServerName: undefined,
        fileDirectory: undefined,
        inputMode: undefined,
        tabs: undefined,
        selectedTabId: undefined,
      });
      return 'categories';
    }
    close();
    return 'closed';
  }, [clearPendingLoad, close, setMenu]);

  useEffect(
    () => () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      abortRef.current?.abort();
      abortRef.current = null;
      fileDirectoryRef.current = '.';
      builtinCacheRef.current = createBuiltinProviderCache();
    },
    [],
  );

  const getPreviousProviderItems = useCallback(
    (
      providerId: string,
      query: string,
      baseState: Omit<AtMentionMenuState, 'items' | 'loading'>,
    ) => {
      const current = stateRef.current;
      if (
        current?.level !== 'items' ||
        current.selectedProviderId !== providerId ||
        current.selectedTabId !== baseState.selectedTabId ||
        current.itemMode !== baseState.itemMode ||
        current.mcpServerName !== baseState.mcpServerName ||
        current.fileDirectory !== baseState.fileDirectory
      ) {
        return [];
      }
      if (current.query !== query && !isBuiltinProviderId(providerId)) {
        return [];
      }
      if (
        providerId === FILE_PROVIDER_ID &&
        query === '' &&
        fileDirectoryRef.current === '.'
      ) {
        return [];
      }
      return current.items;
    },
    [],
  );

  const hasCachedProviderData = useCallback(
    (providerId: string, query: string) => {
      const actions = workspaceActionsRef.current;
      const cache = builtinCacheRef.current;
      if (providerId === FILE_PROVIDER_ID) {
        if (query && actions?.globWorkspace) {
          return cache.globResults.has(fileSearchGlobPattern(query));
        }
        if (actions?.listDirectory) {
          const { dirPath } = splitFileQuery(
            query,
            normalizeDirectoryPath(fileDirectoryRef.current),
          );
          return cache.directories.has(dirPath);
        }
        const pattern = fileSearchGlobPattern(query);
        return (
          Boolean(actions?.globWorkspace) && cache.globResults.has(pattern)
        );
      }
      if (providerId === EXTENSIONS_PROVIDER_ID) {
        return cache.extensionsStatus !== undefined;
      }
      if (providerId === MCP_RESOURCES_PROVIDER_ID) {
        return cache.mcpStatus !== undefined;
      }
      return false;
    },
    [workspaceActionsRef],
  );

  const loadItems = useCallback(
    (
      providerId: string,
      query: string,
      baseState: Omit<AtMentionMenuState, 'items' | 'loading'>,
      options: { loadingAlreadySet?: boolean } = {},
    ) => {
      const provider = allProvidersRef.current.find(
        (item) => item.id === providerId,
      );
      if (!provider) {
        console.warn(
          `[@mention] provider="${providerId}" not found (may have been removed)`,
        );
        setMenu(null);
        return;
      }
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const previousItems = getPreviousProviderItems(
        providerId,
        query,
        baseState,
      );
      if (!options.loadingAlreadySet) {
        setMenu({ ...baseState, items: previousItems, loading: true });
      }
      Promise.resolve()
        .then(() =>
          provider.search({
            query,
            signal: abort.signal,
            tabId: baseState.selectedTabId,
          }),
        )
        .then((items) => {
          if (abort.signal.aborted || requestIdRef.current !== requestId) {
            return;
          }
          setMenu((prev) => {
            if (!prev || prev.level !== 'items') return prev;
            // The file provider prepends prefix items whenever its entry
            // query is empty (e.g. `@src/`), not only for `query === ''`;
            // filtered queries are already capped inside the provider.
            const maxItems =
              providerId === FILE_PROVIDER_ID
                ? FILE_ROOT_ITEM_LIMIT
                : ITEM_LIMIT;
            return {
              ...prev,
              items: items.slice(0, maxItems).map((item) =>
                sanitizeAtMentionItem(item, {
                  customProvider: !isBuiltinProviderId(providerId),
                }),
              ),
              selectedIndex: 0,
              loading: false,
            };
          });
        })
        .catch((error) => {
          if (abort.signal.aborted || requestIdRef.current !== requestId) {
            return;
          }
          console.warn(
            `[@mention] provider="${providerId}" query=<redacted> failed`,
            error,
          );
          setMenu((prev) => {
            if (!prev || prev.level !== 'items') return prev;
            return {
              ...prev,
              items: [],
              selectedIndex: 0,
              loading: false,
            };
          });
        });
    },
    [getPreviousProviderItems, setMenu],
  );

  const scheduleLoadItems = useCallback(
    (
      providerId: string,
      query: string,
      baseState: Omit<AtMentionMenuState, 'items' | 'loading'>,
    ) => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      abortRef.current?.abort();
      abortRef.current = null;
      const previousItems = getPreviousProviderItems(
        providerId,
        query,
        baseState,
      );
      setMenu({ ...baseState, items: previousItems, loading: true });
      if (hasCachedProviderData(providerId, query)) {
        loadItems(providerId, query, baseState, { loadingAlreadySet: true });
        return;
      }
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        loadItems(providerId, query, baseState, { loadingAlreadySet: true });
      }, SEARCH_DEBOUNCE_MS);
    },
    [getPreviousProviderItems, hasCachedProviderData, loadItems, setMenu],
  );

  const loadMcpResourceItems = useCallback(
    (
      serverName: string,
      query: string,
      baseState: Omit<AtMentionMenuState, 'items' | 'loading'>,
      options: LoadMcpResourceOptions & { loadingAlreadySet?: boolean } = {},
    ) => {
      const actions = workspaceActionsRef.current;
      const loadMcpResources = actions?.loadMcpResources;
      if (!loadMcpResources) {
        console.warn(
          `[@mention] loadMcpResources not available for server="${serverName}"`,
        );
        setMenu({ ...baseState, items: [], loading: false });
        return;
      }
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const previousItems =
        stateRef.current?.level === 'items' &&
        stateRef.current.itemMode === 'mcpResources' &&
        stateRef.current.mcpServerName === serverName
          ? stateRef.current.items
          : [];
      if (!options.loadingAlreadySet) {
        setMenu({ ...baseState, items: previousItems, loading: true });
      }
      const loadMcpStatus = actions?.loadMcpStatus;
      const enabledPromise = options.validateServer
        ? isEnabledMcpServer(
            actions,
            serverName,
            abort.signal,
            loadMcpStatus
              ? () => {
                  const cache = builtinCacheRef.current;
                  cache.mcpStatus ??= loadMcpStatus().catch((error) => {
                    cache.mcpStatus = undefined;
                    throw error;
                  });
                  return cache.mcpStatus;
                }
              : undefined,
          )
        : Promise.resolve(true);
      enabledPromise
        .then((enabled) => {
          if (abort.signal.aborted) {
            return { resources: [] };
          }
          if (!enabled) {
            console.warn('[@mention] MCP server disabled or not found', {
              serverName,
            });
            return { resources: [] };
          }
          return getCached(
            builtinCacheRef.current.mcpResources,
            serverName,
            () => loadMcpResources(serverName, { signal: abort.signal }),
          );
        })
        .then((status) => {
          if (abort.signal.aborted || requestIdRef.current !== requestId) {
            return;
          }
          const items = status.resources
            .map((resource): AtMentionItem => {
              const label =
                sanitizeDisplayText(resource.title ?? '') ??
                sanitizeDisplayText(resource.name ?? '') ??
                safeDisplayText(resource.uri);
              return {
                id: `mcp-resource:${serverName}:${resource.uri}`,
                label,
                description:
                  sanitizeDisplayText(resource.description ?? '') ??
                  sanitizeDisplayText(resource.mimeType ?? ''),
                detail: safeDisplayText(resource.uri),
                insertText: mcpResourceInsertText(serverName, resource.uri),
                kind: 'insert',
              };
            })
            .filter((resource) => {
              return matchesQuery(
                query,
                resource.label,
                resource.description,
                resource.detail,
              );
            })
            .sort((a, b) => a.label.localeCompare(b.label))
            .slice(0, ITEM_LIMIT);
          setMenu((prev) => {
            if (!prev || prev.level !== 'items') return prev;
            return {
              ...prev,
              items,
              selectedIndex: 0,
              loading: false,
            };
          });
        })
        .catch((error) => {
          if (abort.signal.aborted || requestIdRef.current !== requestId) {
            return;
          }
          console.warn('Failed to load @ MCP resources', error);
          setMenu((prev) => {
            if (!prev || prev.level !== 'items') return prev;
            return {
              ...prev,
              items: [],
              selectedIndex: 0,
              loading: false,
            };
          });
        });
    },
    [setMenu, workspaceActionsRef],
  );

  const scheduleLoadMcpResourceItems = useCallback(
    (
      serverName: string,
      query: string,
      baseState: Omit<AtMentionMenuState, 'items' | 'loading'>,
      options: LoadMcpResourceOptions = {},
    ) => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      abortRef.current?.abort();
      abortRef.current = null;
      const previousItems =
        stateRef.current?.level === 'items' &&
        stateRef.current.itemMode === 'mcpResources' &&
        stateRef.current.mcpServerName === serverName &&
        baseState.itemMode === 'mcpResources'
          ? stateRef.current.items
          : [];
      setMenu({ ...baseState, items: previousItems, loading: true });
      if (builtinCacheRef.current.mcpResources.has(serverName)) {
        loadMcpResourceItems(serverName, query, baseState, {
          ...options,
          loadingAlreadySet: true,
        });
        return;
      }
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        loadMcpResourceItems(serverName, query, baseState, {
          ...options,
          loadingAlreadySet: true,
        });
      }, SEARCH_DEBOUNCE_MS);
    },
    [loadMcpResourceItems, setMenu],
  );

  const refreshForView = useCallback(
    (view: EditorView | null) => {
      if (disabledRef.current || shellModeRef.current) {
        close();
        return false;
      }
      const parsed = parseAtMention(view);
      if (!parsed) {
        close();
        return false;
      }
      const current = stateRef.current;
      const keepItemsLevel =
        current?.level === 'items' &&
        current.from === parsed.from &&
        (current.to === parsed.to ||
          (current.inputMode === 'search' && parsed.to >= current.to) ||
          (current.inputMode === 'context' && parsed.to >= current.to)) &&
        current.selectedProviderId !== undefined &&
        providerViewsRef.current.some(
          (provider) => provider.id === current.selectedProviderId,
        );
      if (keepItemsLevel) {
        if (!current.selectedProviderId) return true;
        const providerId: string = current.selectedProviderId;
        const query =
          current.inputMode === 'context'
            ? getProviderQueryFromMention(
                providerId,
                parsed.query,
                current.mcpServerName,
              )
            : current.query;
        if (query !== current.query) {
          const nextState: Omit<AtMentionMenuState, 'items' | 'loading'> = {
            ...current,
            from: parsed.from,
            to: parsed.to,
            query,
            selectedIndex: 0,
            providers: providerViewsRef.current,
          };
          if (
            providerId === MCP_RESOURCES_PROVIDER_ID &&
            current.itemMode === 'mcpResources' &&
            current.mcpServerName
          ) {
            scheduleLoadMcpResourceItems(
              current.mcpServerName,
              query,
              nextState,
              { validateServer: current.validateMcpServer },
            );
            return true;
          }
          scheduleLoadItems(providerId, query, nextState);
          return true;
        }
        setMenu({
          ...current,
          from: parsed.from,
          to: parsed.to,
          query,
          providers: providerViewsRef.current,
        });
        return true;
      }
      const filteredProviders = providerViewsRef.current
        .filter((provider) => {
          return matchesQuery(
            parsed.query,
            provider.textValue,
            provider.description,
          );
        })
        .slice(0, ITEM_LIMIT);
      if (
        current?.level === 'categories' &&
        current.from === parsed.from &&
        current.to === parsed.to &&
        current.query === parsed.query &&
        equalProviderViews(current.providers, filteredProviders)
      ) {
        return true;
      }
      if (filteredProviders.length === 0 && parsed.query) {
        const insertedReference = splitInsertedReferenceQuery(
          parsed.query,
          lastSelectedProviderIdRef.current,
          lastSelectedMcpServerNameRef.current,
        );
        if (
          insertedReference &&
          providerViewsRef.current.some(
            (provider) => provider.id === insertedReference.providerId,
          )
        ) {
          if (
            insertedReference.providerId === MCP_RESOURCES_PROVIDER_ID &&
            insertedReference.serverName
          ) {
            lastSelectedMcpServerNameRef.current = insertedReference.serverName;
            scheduleLoadMcpResourceItems(
              insertedReference.serverName,
              insertedReference.itemQuery,
              {
                from: parsed.from,
                to: parsed.to,
                query: insertedReference.itemQuery,
                level: 'items',
                selectedProviderId: MCP_RESOURCES_PROVIDER_ID,
                selectedIndex: 0,
                providers: providerViewsRef.current,
                itemMode: 'mcpResources',
                mcpServerName: insertedReference.serverName,
                fileDirectory: undefined,
                inputMode: 'context',
                validateMcpServer: insertedReference.validateServer,
              },
              { validateServer: insertedReference.validateServer },
            );
            return true;
          }
          scheduleLoadItems(
            insertedReference.providerId,
            insertedReference.itemQuery,
            {
              from: parsed.from,
              to: parsed.to,
              query: insertedReference.itemQuery,
              level: 'items',
              selectedProviderId: insertedReference.providerId,
              selectedIndex: 0,
              providers: providerViewsRef.current,
              itemMode: 'default',
              mcpServerName: undefined,
              fileDirectory:
                insertedReference.providerId === FILE_PROVIDER_ID
                  ? fileDirectoryRef.current
                  : undefined,
              inputMode: 'context',
            },
          );
          return true;
        }
        const prefixedProvider = providerViewsRef.current.find(
          (provider) =>
            !isBuiltinProviderId(provider.id) &&
            parsed.query.startsWith(`${provider.id}:`),
        );
        if (prefixedProvider) {
          const itemQuery = parsed.query.slice(prefixedProvider.id.length + 1);
          scheduleLoadItems(prefixedProvider.id, itemQuery, {
            from: parsed.from,
            to: parsed.to,
            query: itemQuery,
            level: 'items',
            selectedProviderId: prefixedProvider.id,
            selectedIndex: 0,
            providers: providerViewsRef.current,
            itemMode: 'default',
            mcpServerName: undefined,
            fileDirectory: undefined,
            inputMode: 'context',
          });
          return true;
        }
        if (
          providerViewsRef.current.some(
            (provider) => provider.id === FILE_PROVIDER_ID,
          )
        ) {
          fileDirectoryRef.current = '.';
          scheduleLoadItems(FILE_PROVIDER_ID, parsed.query, {
            from: parsed.from,
            to: parsed.to,
            query: parsed.query,
            level: 'items',
            selectedProviderId: FILE_PROVIDER_ID,
            selectedIndex: 0,
            providers: providerViewsRef.current,
            itemMode: 'default',
            mcpServerName: undefined,
            fileDirectory: fileDirectoryRef.current,
            inputMode: 'context',
          });
          return true;
        }
      }
      setMenu({
        from: parsed.from,
        to: parsed.to,
        query: parsed.query,
        level: 'categories',
        selectedIndex: 0,
        providers: filteredProviders,
        items: [],
        loading: false,
        inputMode: undefined,
      });
      return true;
    },
    [
      close,
      disabledRef,
      scheduleLoadItems,
      scheduleLoadMcpResourceItems,
      setMenu,
      shellModeRef,
    ],
  );

  const moveSelection = useCallback(
    (direction: 'up' | 'down') => {
      const current = stateRef.current;
      if (!current) return false;
      const total =
        current.level === 'categories'
          ? current.providers.length
          : current.items.length;
      if (total <= 0) return true;
      const nextIndex = nextSelectionIndex(
        current.selectedIndex,
        total,
        direction,
      );
      // Keep arrow keys owned by the @ panel while it is open. Returning false
      // at the boundary would fall through to the editor history navigation.
      if (nextIndex === null) return true;
      setMenu({ ...current, selectedIndex: nextIndex });
      return true;
    },
    [setMenu],
  );

  const select = useCallback(
    (index: number) => {
      const current = stateRef.current;
      if (!current) return false;
      const total =
        current.level === 'categories'
          ? current.providers.length
          : current.items.length;
      if (index < 0 || index >= total) return false;
      setMenu({ ...current, selectedIndex: index });
      return true;
    },
    [setMenu],
  );

  const enterCategory = useCallback(
    (index?: number) => {
      const current = stateRef.current;
      if (!current || current.level !== 'categories') return false;
      const provider = current.providers[index ?? current.selectedIndex];
      if (!provider) return false;
      lastSelectedProviderIdRef.current = provider.id;
      if (provider.id === FILE_PROVIDER_ID) {
        fileDirectoryRef.current = '.';
      }
      const selectedTabId = provider.tabs?.find((tab) => !tab.disabled)?.id;
      scheduleLoadItems(provider.id, current.query, {
        ...current,
        level: 'items',
        selectedProviderId: provider.id,
        selectedIndex: 0,
        tabs: provider.tabs,
        selectedTabId,
        itemMode:
          provider.id === MCP_RESOURCES_PROVIDER_ID ? 'mcpServers' : 'default',
        mcpServerName: undefined,
        fileDirectory:
          provider.id === FILE_PROVIDER_ID
            ? fileDirectoryRef.current
            : undefined,
        inputMode: 'search',
      });
      return true;
    },
    [scheduleLoadItems],
  );

  const updateSearch = useCallback(
    (query: string) => {
      const current = stateRef.current;
      if (
        !current ||
        current.level !== 'items' ||
        !current.selectedProviderId
      ) {
        return false;
      }
      const baseState: Omit<AtMentionMenuState, 'items' | 'loading'> = {
        ...current,
        query,
        selectedIndex: 0,
        inputMode: 'search',
      };
      if (
        current.selectedProviderId === MCP_RESOURCES_PROVIDER_ID &&
        current.itemMode === 'mcpResources' &&
        current.mcpServerName
      ) {
        scheduleLoadMcpResourceItems(current.mcpServerName, query, baseState, {
          validateServer: current.validateMcpServer,
        });
        return true;
      }
      scheduleLoadItems(current.selectedProviderId, query, baseState);
      return true;
    },
    [scheduleLoadItems, scheduleLoadMcpResourceItems],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      const current = stateRef.current;
      if (
        !current ||
        current.level !== 'items' ||
        !current.selectedProviderId ||
        !current.tabs?.some((tab) => tab.id === tabId && !tab.disabled)
      ) {
        return false;
      }
      if (current.selectedTabId === tabId) return true;
      const baseState: Omit<AtMentionMenuState, 'items' | 'loading'> = {
        ...current,
        selectedTabId: tabId,
        selectedIndex: 0,
        inputMode: 'search',
      };
      scheduleLoadItems(current.selectedProviderId, current.query, baseState);
      return true;
    },
    [scheduleLoadItems],
  );

  const backToCategories = useCallback((): false | 'items' | 'categories' => {
    const current = stateRef.current;
    if (!current || current.level !== 'items') return false;
    if (
      current.selectedProviderId === MCP_RESOURCES_PROVIDER_ID &&
      current.itemMode === 'mcpResources'
    ) {
      scheduleLoadItems(MCP_RESOURCES_PROVIDER_ID, '', {
        ...current,
        query: '',
        selectedIndex: 0,
        itemMode: 'mcpServers',
        mcpServerName: undefined,
        fileDirectory: undefined,
        inputMode: 'search',
        validateMcpServer: undefined,
      });
      return 'items';
    }
    if (current.selectedProviderId === FILE_PROVIDER_ID) {
      const currentDir = normalizeDirectoryPath(
        current.fileDirectory ?? fileDirectoryRef.current,
      );
      if (currentDir !== '.') {
        fileDirectoryRef.current = parentDirectoryPath(currentDir);
        scheduleLoadItems(FILE_PROVIDER_ID, '', {
          ...current,
          query: '',
          selectedIndex: 0,
          fileDirectory: fileDirectoryRef.current,
          inputMode: 'search',
        });
        return 'items';
      }
    }
    setMenu({
      ...current,
      level: 'categories',
      selectedProviderId: undefined,
      selectedIndex: 0,
      query: '',
      items: [],
      loading: false,
      itemMode: undefined,
      mcpServerName: undefined,
      fileDirectory: undefined,
      inputMode: undefined,
      tabs: undefined,
      selectedTabId: undefined,
    });
    clearPendingLoad();
    return 'categories';
  }, [clearPendingLoad, scheduleLoadItems, setMenu]);

  const accept = useCallback(
    (index?: number) => {
      const current = stateRef.current;
      if (!current) return false;
      if (current.level === 'categories') {
        return enterCategory(index);
      }
      const view = viewRef.current;
      if (!view) return false;
      if (current.loading) return true;
      const item = current.items[index ?? current.selectedIndex];
      if (!item) return false;
      if (current.selectedProviderId) {
        lastSelectedProviderIdRef.current = current.selectedProviderId;
      }
      if (item.kind === 'upload') {
        // Menu items are not recomputed when upload availability changes,
        // so a stale item can be accepted after the handler disappears;
        // dropping the typed query in that case would silently eat it.
        if (disabledRef.current || !onUploadRequest) {
          close();
          return true;
        }
        const removedText = view.state.sliceDoc(current.from, current.to);
        view.dispatch({
          changes: { from: current.from, to: current.to, insert: '' },
          selection: { anchor: current.from },
        });
        const docAfterRemoval = view.state.doc;
        // Typed queries (`@src/`) browse a directory derived from the query
        // text without syncing fileDirectoryRef, so re-derive the same
        // directory the panel is displaying.
        const { dirPath } = splitFileQuery(
          current.query,
          fileDirectoryRef.current,
        );
        onUploadRequest(dirPath, () => {
          const doc = view.state.doc;
          // Tolerate a pure end-append — the upload flow's own completed
          // `@file` tags land there while the picker is open and never move
          // the insertion point. Whole-doc session swaps flush this callback
          // before the swap, so a foreign doc never reaches here.
          if (
            current.from > doc.length ||
            doc.length < docAfterRemoval.length ||
            doc.sliceString(0, docAfterRemoval.length) !==
              docAfterRemoval.toString()
          ) {
            return;
          }
          view.dispatch({
            changes: { from: current.from, insert: removedText },
            selection: { anchor: current.from + removedText.length },
          });
        });
        close();
        return true;
      }
      if (
        current.selectedProviderId === FILE_PROVIDER_ID &&
        item.kind === 'directory' &&
        item.targetPath
      ) {
        fileDirectoryRef.current = normalizeDirectoryPath(item.targetPath);
        scheduleLoadItems(FILE_PROVIDER_ID, '', {
          ...current,
          query: '',
          selectedIndex: 0,
          fileDirectory: fileDirectoryRef.current,
          inputMode: 'search',
        });
        return true;
      }
      if (
        current.selectedProviderId === MCP_RESOURCES_PROVIDER_ID &&
        item.kind === 'mcp-server' &&
        item.serverName
      ) {
        lastSelectedMcpServerNameRef.current = item.serverName;
        scheduleLoadMcpResourceItems(item.serverName, '', {
          ...current,
          query: '',
          selectedIndex: 0,
          itemMode: 'mcpResources',
          mcpServerName: item.serverName,
          fileDirectory: undefined,
          inputMode: 'search',
          validateMcpServer: undefined,
        });
        return true;
      }
      const rawInsert =
        item.insertText ??
        `@${escapeAtReferenceText(sanitizeInsertText(item.label))} `;
      const insert =
        item.composerTag && !/\s$/.test(rawInsert)
          ? `${rawInsert} `
          : rawInsert;
      const docLength = view.state.doc.length;
      if (
        current.from < 0 ||
        current.to < current.from ||
        current.to > docLength
      ) {
        console.warn('[@mention] stale insertion range', {
          from: current.from,
          to: current.to,
          docLength,
        });
        close();
        return true;
      }
      const currentMention = view.state.doc.sliceString(
        current.from,
        current.to,
      );
      if (!currentMention.startsWith('@')) {
        console.warn('[@mention] stale insertion text', {
          from: current.from,
          to: current.to,
        });
        close();
        return true;
      }
      preserveProviderSelectionRef.current = true;
      const tag = createComposerTagForItem(
        current.selectedProviderId,
        item,
        insert,
      );
      const tagText = insert.trimEnd();
      const effects =
        tag && createInlineTagEffect
          ? [
              createInlineTagEffect({
                from: current.from,
                to: current.from + tagText.length,
                tag,
              }),
            ]
          : undefined;
      view.dispatch({
        changes: { from: current.from, to: current.to, insert },
        ...(effects ? { effects } : {}),
        selection: { anchor: current.from + insert.length },
        scrollIntoView: true,
      });
      view.focus();
      close({ preserveProviderSelection: true });
      return true;
    },
    [
      close,
      enterCategory,
      createInlineTagEffect,
      scheduleLoadItems,
      scheduleLoadMcpResourceItems,
      disabledRef,
      viewRef,
      onUploadRequest,
    ],
  );

  return {
    state,
    close,
    closeIfOpen,
    refreshForView,
    moveSelection,
    select,
    accept,
    enterCategory,
    selectTab,
    backToCategories,
    updateSearch,
  };
}
