import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import type { WebShellAtItem, WebShellAtProvider } from '../customization';
import { useI18n } from '../i18n';

export interface AtMentionProviderView {
  id: string;
  label: string;
  description?: string;
}

export interface AtMentionItem extends WebShellAtItem {
  kind?: 'insert' | 'directory' | 'mcp-server';
  targetPath?: string;
  serverName?: string;
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
}

type GlobWorkspaceFn = (
  pattern: string,
  opts?: { maxResults?: number },
) => Promise<{ matches: string[] }>;

interface ExtensionEntry {
  name: string;
  displayName?: string;
  description?: string;
  isActive: boolean;
}

type LoadExtensionsStatusFn = () => Promise<{
  extensions: ExtensionEntry[];
}>;

interface DirectoryEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  ignored: boolean;
}

type ListDirectoryFn = (
  dirPath: string,
  options?: { signal?: AbortSignal },
) => Promise<{
  kind: 'list';
  path: string;
  entries: DirectoryEntry[];
  truncated: boolean;
}>;

interface McpServerEntry {
  kind: 'mcp_server';
  name: string;
  disabled: boolean;
  mcpStatus?: string;
  resourceCount?: number;
  description?: string;
}

type LoadMcpStatusFn = () => Promise<{
  servers: McpServerEntry[];
}>;

type LoadMcpResourcesFn = (
  serverName: string,
  options?: { signal?: AbortSignal },
) => Promise<{
  resources: Array<{
    uri: string;
    name?: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
  }>;
}>;

export interface AtMentionWorkspaceActions {
  globWorkspace?: GlobWorkspaceFn;
  loadExtensionsStatus?: LoadExtensionsStatusFn;
  listDirectory?: ListDirectoryFn;
  loadMcpStatus?: LoadMcpStatusFn;
  loadMcpResources?: LoadMcpResourcesFn;
}

export interface UseAtMentionMenuOptions {
  viewRef: RefObject<EditorView | null>;
  disabledRef: RefObject<boolean>;
  shellModeRef: RefObject<boolean>;
  workspaceActionsRef: RefObject<AtMentionWorkspaceActions | undefined>;
  providers?: readonly WebShellAtProvider[];
}

interface RefreshAtMentionMenuOptions {
  userEdited?: boolean;
}

const AT_PATTERN = /@([\w./:-]*)$/;
const EMPTY_PROVIDERS: readonly WebShellAtProvider[] = [];
const SEARCH_DEBOUNCE_MS = 150;
export const FILE_PROVIDER_ID = 'files';
const EXTENSIONS_PROVIDER_ID = 'extensions';
export const MCP_RESOURCES_PROVIDER_ID = 'mcp-resources';
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}(?:[@-Z\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'g');
const BIDI_CONTROL_RE = /[\u200E\u200F\u061C\u2066-\u2069\u202A-\u202E]/g;

function joinWorkspacePath(dirPath: string, name: string): string {
  if (dirPath === '.' || dirPath === '') return name;
  return `${dirPath.replace(/\/+$/, '')}/${name}`;
}

function normalizeDirectoryPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : '.';
}

function escapeGlobQuery(query: string): string {
  return query.replace(/[\\*?[{\]}]/g, '\\$&');
}

function matchesQuery(query: string, ...values: Array<string | undefined>) {
  const lowerQuery = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(lowerQuery));
}

function directoryInsertText(path: string): string {
  const normalized = normalizeDirectoryPath(path);
  return normalized === '.' ? '@./ ' : `@${normalized}/ `;
}

function buildMcpResourceRef(serverName: string, uri: string): string {
  return `${serverName}:${uri}`;
}

function splitInsertedReferenceQuery(
  query: string,
  lastSelectedProviderId: string | null,
): {
  providerId: string;
  serverName?: string;
} | null {
  if (query.startsWith('ext:')) {
    return { providerId: EXTENSIONS_PROVIDER_ID };
  }
  const separatorIndex = query.indexOf(':');
  if (
    lastSelectedProviderId === MCP_RESOURCES_PROVIDER_ID &&
    separatorIndex > 0
  ) {
    return {
      providerId: MCP_RESOURCES_PROVIDER_ID,
      serverName: query.slice(0, separatorIndex),
    };
  }
  return null;
}

function parentDirectoryPath(path: string): string {
  const normalized = normalizeDirectoryPath(path);
  if (normalized === '.') return '.';
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex < 0 ? '.' : normalized.slice(0, slashIndex);
}

function splitFileQuery(query: string, fallbackDir: string) {
  const normalizedQuery = query.replace(/^\.\/+/, '').replace(/\/+/g, '/');
  const slashIndex = normalizedQuery.lastIndexOf('/');
  if (slashIndex < 0) {
    return {
      dirPath: normalizeDirectoryPath(fallbackDir),
      entryQuery: normalizedQuery,
    };
  }
  return {
    dirPath: normalizeDirectoryPath(normalizedQuery.slice(0, slashIndex)),
    entryQuery: normalizedQuery.slice(slashIndex + 1),
  };
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
  if (
    from > line.from &&
    !/\s/.test(view.state.doc.sliceString(from - 1, from))
  ) {
    return null;
  }
  return {
    from,
    to: selection.head,
    query: match[1] ?? '',
  };
}

export function sanitizeDisplayText(raw: string): string | undefined {
  const stripped = raw
    .replace(ANSI_RE, '')
    .replace(BIDI_CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

function sanitizeAtMentionItem(item: AtMentionItem): AtMentionItem {
  return {
    ...item,
    label: sanitizeDisplayText(item.label) ?? item.id,
    description:
      item.description === undefined
        ? undefined
        : sanitizeDisplayText(item.description),
    detail:
      item.detail === undefined ? undefined : sanitizeDisplayText(item.detail),
  };
}

function createFileProvider(
  getActions: () => AtMentionWorkspaceActions | undefined,
  getCurrentDir: () => string,
  label: string,
  description: string,
): WebShellAtProvider {
  return {
    id: 'files',
    label,
    description,
    order: 1,
    async search({ query, signal }) {
      const actions = getActions();
      const currentDir = normalizeDirectoryPath(getCurrentDir());
      const listDirectory = actions?.listDirectory;
      if (listDirectory) {
        try {
          const { dirPath, entryQuery } = splitFileQuery(query, currentDir);
          const lowerQuery = entryQuery.toLowerCase();
          const listing = await listDirectory(dirPath, { signal });
          if (signal.aborted) return [];
          const entries = listing.entries
            .filter((entry) => !entry.ignored)
            .filter((entry) => entry.name.toLowerCase().includes(lowerQuery))
            .sort((a, b) => {
              if (a.kind === 'directory' && b.kind !== 'directory') return -1;
              if (a.kind !== 'directory' && b.kind === 'directory') return 1;
              return a.name.localeCompare(b.name);
            });
          const currentDirectoryItem: AtMentionItem = {
            id: `current:${dirPath}`,
            label: directoryInsertText(dirPath).trim(),
            description: dirPath,
            insertText: directoryInsertText(dirPath),
            kind: 'insert',
          };
          return [
            currentDirectoryItem,
            ...entries.map((entry): AtMentionItem => {
              const path = joinWorkspacePath(dirPath, entry.name);
              const safeName = sanitizeDisplayText(entry.name) ?? entry.name;
              const safePath = sanitizeDisplayText(path);
              if (entry.kind === 'directory') {
                return {
                  id: `dir:${path}`,
                  label: `${safeName}/`,
                  description: safePath,
                  kind: 'directory',
                  targetPath: path,
                };
              }
              return {
                id: `file:${path}`,
                label: safeName,
                description: safePath,
                insertText: `@${path} `,
                kind: 'insert',
              };
            }),
          ].slice(0, 51);
        } catch (error) {
          if (!signal.aborted) {
            console.warn('Failed to load @ file suggestions', error);
          }
          return [];
        }
      }
      const globWorkspace = actions?.globWorkspace;
      if (!globWorkspace) {
        console.warn(
          '[@mention] file provider unavailable: workspace actions are not configured',
        );
        return [];
      }
      try {
        const pattern = query ? `${escapeGlobQuery(query)}*` : '**/*';
        const result = await globWorkspace(pattern, { maxResults: 50 });
        if (signal.aborted) return [];
        return result.matches
          .filter((file) => file !== '.')
          .map((file) => ({
            id: file,
            label: sanitizeDisplayText(file) ?? file,
            insertText: `@${file} `,
            kind: 'insert',
          }));
      } catch (error) {
        if (!signal.aborted) {
          console.warn('Failed to load @ file suggestions', error);
        }
        return [];
      }
    },
  };
}

function createExtensionProvider(
  getActions: () => AtMentionWorkspaceActions | undefined,
  label: string,
  description: string,
): WebShellAtProvider {
  return {
    id: EXTENSIONS_PROVIDER_ID,
    label,
    description,
    order: 2,
    async search({ query, signal }) {
      const loadExtensionsStatus = getActions()?.loadExtensionsStatus;
      if (!loadExtensionsStatus) return [];
      try {
        const status = await loadExtensionsStatus();
        if (signal.aborted) return [];
        const lowerQuery = query.toLowerCase();
        return status.extensions
          .filter((ext) => ext.isActive)
          .map((ext) => {
            const displayName = sanitizeDisplayText(ext.displayName ?? '');
            const description = sanitizeDisplayText(ext.description ?? '');
            return {
              id: ext.name,
              label: ext.name,
              description:
                displayName && displayName !== ext.name
                  ? displayName
                  : description,
              detail:
                displayName && description
                  ? `${displayName} - ${description}`
                  : (displayName ?? description),
              insertText: `@ext:${ext.name} `,
            };
          })
          .filter((ext) => {
            return matchesQuery(lowerQuery, ext.label, ext.description);
          })
          .sort((a, b) => {
            const aLabel = (a.description || a.label).toLowerCase();
            const bLabel = (b.description || b.label).toLowerCase();
            const aPrefix = aLabel.startsWith(lowerQuery) ? 0 : 1;
            const bPrefix = bLabel.startsWith(lowerQuery) ? 0 : 1;
            if (aPrefix !== bPrefix) return aPrefix - bPrefix;
            return aLabel.localeCompare(bLabel);
          })
          .slice(0, 50);
      } catch (error) {
        if (!signal.aborted) {
          console.warn('Failed to load @ extension suggestions', error);
        }
        return [];
      }
    },
  };
}

function createMcpResourcesProvider(
  getActions: () => AtMentionWorkspaceActions | undefined,
  label: string,
  description: string,
): WebShellAtProvider {
  return {
    id: MCP_RESOURCES_PROVIDER_ID,
    label,
    description,
    order: 3,
    async search({ query, signal }) {
      const loadMcpStatus = getActions()?.loadMcpStatus;
      if (!loadMcpStatus) return [];
      try {
        const status = await loadMcpStatus();
        if (signal.aborted) return [];
        const lowerQuery = query.toLowerCase();
        return status.servers
          .filter((server) => !server.disabled)
          .filter(
            (server) =>
              server.resourceCount === undefined || server.resourceCount > 0,
          )
          .map((server): AtMentionItem => {
            const count =
              server.resourceCount === undefined
                ? undefined
                : `${server.resourceCount}`;
            return {
              id: `mcp-server:${server.name}`,
              label: sanitizeDisplayText(server.name) ?? server.name,
              description:
                count === undefined
                  ? sanitizeDisplayText(server.description ?? '')
                  : `${count} resources`,
              detail: sanitizeDisplayText(server.description ?? ''),
              kind: 'mcp-server',
              serverName: server.name,
            };
          })
          .filter((server) => {
            return matchesQuery(lowerQuery, server.label, server.description);
          })
          .sort((a, b) => a.label.localeCompare(b.label))
          .slice(0, 50);
      } catch (error) {
        if (!signal.aborted) {
          console.warn('Failed to load @ MCP resource suggestions', error);
        }
        return [];
      }
    },
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
  providers = EMPTY_PROVIDERS,
}: UseAtMentionMenuOptions) {
  const { t } = useI18n();
  const [state, setState] = useState<AtMentionMenuState | null>(null);
  const stateRef = useRef<AtMentionMenuState | null>(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileDirectoryRef = useRef('.');
  const lastSelectedProviderIdRef = useRef<string | null>(null);

  const allProviders = useMemo(() => {
    const builtinProviders = [
      createFileProvider(
        () => workspaceActionsRef.current,
        () => fileDirectoryRef.current,
        t('at.category.files'),
        t('at.category.files.description'),
      ),
      createExtensionProvider(
        () => workspaceActionsRef.current,
        t('at.category.extensions'),
        t('at.category.extensions.description'),
      ),
      createMcpResourcesProvider(
        () => workspaceActionsRef.current,
        t('at.category.mcpResources'),
        t('at.category.mcpResources.description'),
      ),
    ];
    const builtinProviderIds = new Set(
      builtinProviders.map((provider) => provider.id),
    );
    return [
      ...builtinProviders,
      ...providers.filter((provider) => !builtinProviderIds.has(provider.id)),
    ].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [providers, t, workspaceActionsRef]);
  const allProvidersRef = useRef(allProviders);
  allProvidersRef.current = allProviders;

  const providerViews = useMemo(
    () =>
      allProviders.map((provider) => ({
        id: provider.id,
        label: provider.label,
        description: provider.description,
      })),
    [allProviders],
  );
  const providerViewsRef = useRef(providerViews);
  providerViewsRef.current = providerViews;

  const setMenu = useCallback((next: AtMentionMenuState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const clearPendingLoad = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clearPendingLoad();
    setMenu(null);
  }, [clearPendingLoad, setMenu]);

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
        query: current.query,
        items: [],
        loading: false,
      });
      return true;
    }
    close();
    return true;
  }, [clearPendingLoad, close, setMenu]);

  useEffect(
    () => () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      abortRef.current?.abort();
      abortRef.current = null;
      fileDirectoryRef.current = '.';
    },
    [],
  );

  const getPreviousProviderItems = useCallback(
    (providerId: string, query: string) => {
      const current = stateRef.current;
      if (
        current?.level !== 'items' ||
        current.selectedProviderId !== providerId
      ) {
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

  const loadItems = useCallback(
    (
      providerId: string,
      query: string,
      baseState: Omit<AtMentionMenuState, 'items' | 'loading'>,
    ) => {
      const provider = allProvidersRef.current.find(
        (item) => item.id === providerId,
      );
      if (!provider) {
        setMenu(null);
        return;
      }
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const previousItems = getPreviousProviderItems(providerId, query);
      setMenu({ ...baseState, items: previousItems, loading: true });
      provider
        .search({ query, signal: abort.signal })
        .then((items) => {
          if (abort.signal.aborted || requestIdRef.current !== requestId) {
            return;
          }
          setMenu({
            ...baseState,
            items: items.map(sanitizeAtMentionItem).slice(0, 50),
            selectedIndex: 0,
            loading: false,
          });
        })
        .catch((error) => {
          if (abort.signal.aborted || requestIdRef.current !== requestId) {
            return;
          }
          console.warn(
            `[@mention] provider="${providerId}" query="${query}" failed`,
            error,
          );
          setMenu({
            ...baseState,
            items: [],
            selectedIndex: 0,
            loading: false,
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
      const previousItems = getPreviousProviderItems(providerId, query);
      setMenu({ ...baseState, items: previousItems, loading: true });
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        loadItems(providerId, query, baseState);
      }, SEARCH_DEBOUNCE_MS);
    },
    [getPreviousProviderItems, loadItems, setMenu],
  );

  const loadMcpResourceItems = useCallback(
    (
      serverName: string,
      query: string,
      baseState: Omit<AtMentionMenuState, 'items' | 'loading'>,
    ) => {
      const loadMcpResources = workspaceActionsRef.current?.loadMcpResources;
      if (!loadMcpResources) {
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
      setMenu({ ...baseState, items: previousItems, loading: true });
      loadMcpResources(serverName, { signal: abort.signal })
        .then((status) => {
          if (abort.signal.aborted || requestIdRef.current !== requestId) {
            return;
          }
          const items = status.resources
            .map((resource): AtMentionItem => {
              const label =
                sanitizeDisplayText(resource.title ?? '') ??
                sanitizeDisplayText(resource.name ?? '') ??
                sanitizeDisplayText(resource.uri) ??
                resource.uri;
              return {
                id: `mcp-resource:${serverName}:${resource.uri}`,
                label,
                description:
                  sanitizeDisplayText(resource.description ?? '') ??
                  resource.mimeType,
                detail: sanitizeDisplayText(resource.uri) ?? resource.uri,
                insertText: `@${buildMcpResourceRef(serverName, resource.uri)} `,
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
            .slice(0, 50);
          setMenu({
            ...baseState,
            items,
            selectedIndex: 0,
            loading: false,
          });
        })
        .catch((error) => {
          if (abort.signal.aborted || requestIdRef.current !== requestId) {
            return;
          }
          console.warn('Failed to load @ MCP resources', error);
          setMenu({
            ...baseState,
            items: [],
            selectedIndex: 0,
            loading: false,
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
    ) => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
      abortRef.current?.abort();
      abortRef.current = null;
      const previousItems =
        stateRef.current?.level === 'items' &&
        stateRef.current.itemMode === 'mcpResources' &&
        stateRef.current.mcpServerName === serverName
          ? stateRef.current.items
          : [];
      setMenu({ ...baseState, items: previousItems, loading: true });
      searchTimerRef.current = setTimeout(() => {
        searchTimerRef.current = null;
        loadMcpResourceItems(serverName, query, baseState);
      }, SEARCH_DEBOUNCE_MS);
    },
    [loadMcpResourceItems, setMenu],
  );

  const refreshForView = useCallback(
    (view: EditorView | null, options: RefreshAtMentionMenuOptions = {}) => {
      if (disabledRef.current || shellModeRef.current) {
        close();
        return;
      }
      const parsed = parseAtMention(view);
      if (!parsed) {
        close();
        return;
      }
      const current = stateRef.current;
      const keepItemsLevel =
        current?.level === 'items' &&
        current.from === parsed.from &&
        current.selectedProviderId !== undefined;
      if (keepItemsLevel) {
        const providerId = current.selectedProviderId!;
        if (
          providerId === FILE_PROVIDER_ID &&
          (parsed.query !== current.query ||
            (options.userEdited && parsed.query === ''))
        ) {
          const { dirPath } = splitFileQuery(
            parsed.query,
            fileDirectoryRef.current,
          );
          fileDirectoryRef.current = dirPath;
          scheduleLoadItems(providerId, parsed.query, {
            ...current,
            from: parsed.from,
            to: parsed.to,
            query: parsed.query,
            selectedIndex: 0,
            providers: providerViewsRef.current,
          });
          return;
        }
        if (parsed.query !== current.query) {
          const baseState = {
            ...current,
            from: parsed.from,
            to: parsed.to,
            query: parsed.query,
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
              parsed.query,
              baseState,
            );
          } else {
            scheduleLoadItems(providerId, parsed.query, baseState);
          }
          return;
        }
        setMenu({
          ...current,
          from: parsed.from,
          to: parsed.to,
          providers: providerViewsRef.current,
        });
        return;
      }
      const filteredProviders = providerViewsRef.current.filter((provider) => {
        return matchesQuery(parsed.query, provider.label, provider.description);
      });
      if (filteredProviders.length === 0 && parsed.query) {
        const insertedReference = splitInsertedReferenceQuery(
          parsed.query,
          lastSelectedProviderIdRef.current,
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
            scheduleLoadMcpResourceItems(insertedReference.serverName, '', {
              from: parsed.from,
              to: parsed.to,
              query: '',
              level: 'items',
              selectedProviderId: MCP_RESOURCES_PROVIDER_ID,
              selectedIndex: 0,
              providers: providerViewsRef.current,
              itemMode: 'mcpResources',
              mcpServerName: insertedReference.serverName,
            });
            return;
          }
          scheduleLoadItems(insertedReference.providerId, '', {
            from: parsed.from,
            to: parsed.to,
            query: '',
            level: 'items',
            selectedProviderId: insertedReference.providerId,
            selectedIndex: 0,
            providers: providerViewsRef.current,
            itemMode:
              insertedReference.providerId === MCP_RESOURCES_PROVIDER_ID
                ? 'mcpServers'
                : 'default',
            mcpServerName: undefined,
          });
          return;
        }
        const providerId = lastSelectedProviderIdRef.current;
        if (
          providerId &&
          providerViewsRef.current.some(
            (provider) => provider.id === providerId,
          )
        ) {
          scheduleLoadItems(providerId, '', {
            from: parsed.from,
            to: parsed.to,
            query: '',
            level: 'items',
            selectedProviderId: providerId,
            selectedIndex: 0,
            providers: providerViewsRef.current,
            itemMode:
              providerId === MCP_RESOURCES_PROVIDER_ID
                ? 'mcpServers'
                : 'default',
            mcpServerName: undefined,
          });
          return;
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
      });
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
      scheduleLoadItems(provider.id, current.query, {
        ...current,
        level: 'items',
        selectedProviderId: provider.id,
        selectedIndex: 0,
        itemMode:
          provider.id === MCP_RESOURCES_PROVIDER_ID ? 'mcpServers' : 'default',
        mcpServerName: undefined,
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
      const baseState = {
        ...current,
        query,
        selectedIndex: 0,
      };
      if (
        current.selectedProviderId === MCP_RESOURCES_PROVIDER_ID &&
        current.itemMode === 'mcpResources' &&
        current.mcpServerName
      ) {
        scheduleLoadMcpResourceItems(current.mcpServerName, query, baseState);
        return true;
      }
      scheduleLoadItems(current.selectedProviderId, query, baseState);
      return true;
    },
    [scheduleLoadItems, scheduleLoadMcpResourceItems],
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
      });
      return 'items';
    }
    if (current.selectedProviderId === FILE_PROVIDER_ID) {
      const currentDir = normalizeDirectoryPath(fileDirectoryRef.current);
      if (currentDir !== '.') {
        fileDirectoryRef.current = parentDirectoryPath(currentDir);
        scheduleLoadItems(FILE_PROVIDER_ID, '', {
          ...current,
          query: '',
          selectedIndex: 0,
        });
        return 'items';
      }
    }
    setMenu({
      ...current,
      level: 'categories',
      selectedProviderId: undefined,
      selectedIndex: 0,
      items: [],
      loading: false,
      itemMode: undefined,
      mcpServerName: undefined,
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
      const item = current.items[index ?? current.selectedIndex];
      if (!item) return false;
      if (current.selectedProviderId) {
        lastSelectedProviderIdRef.current = current.selectedProviderId;
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
        });
        return true;
      }
      if (
        current.selectedProviderId === MCP_RESOURCES_PROVIDER_ID &&
        item.kind === 'mcp-server' &&
        item.serverName
      ) {
        scheduleLoadMcpResourceItems(item.serverName, '', {
          ...current,
          query: '',
          selectedIndex: 0,
          itemMode: 'mcpResources',
          mcpServerName: item.serverName,
        });
        return true;
      }
      const insert = item.insertText ?? `@${item.label} `;
      const docLength = view.state.doc.length;
      if (
        current.from < 0 ||
        current.to < current.from ||
        current.to > docLength
      ) {
        close();
        return false;
      }
      view.dispatch({
        changes: { from: current.from, to: current.to, insert },
        selection: { anchor: current.from + insert.length },
        scrollIntoView: true,
      });
      view.focus();
      close();
      return true;
    },
    [
      close,
      enterCategory,
      scheduleLoadItems,
      scheduleLoadMcpResourceItems,
      viewRef,
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
    backToCategories,
    updateSearch,
  };
}
