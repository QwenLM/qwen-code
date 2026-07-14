import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import type { RefObject, ReactNode } from 'react';
import type { StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type {
  WebShellAtItem,
  WebShellAtProvider,
  WebShellAtProviderTab,
  WebShellBuiltinAtProviderId,
  WebShellBuiltinAtProvidersConfig,
  WebShellComposerTag,
} from '../customization';
import { useI18n } from '../i18n';

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
  fileDirectory?: string;
  // search mode owns the panel input; context mode mirrors text typed in the editor.
  inputMode?: 'search' | 'context';
  validateMcpServer?: boolean;
  tabs?: readonly WebShellAtProviderTab[];
  selectedTabId?: string;
}

type GlobWorkspaceFn = (
  pattern: string,
  opts?: { maxResults?: number; signal?: AbortSignal },
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

type DirectoryListing = Awaited<ReturnType<ListDirectoryFn>>;
type GlobWorkspaceResult = Awaited<ReturnType<GlobWorkspaceFn>>;
type ExtensionsStatus = Awaited<ReturnType<LoadExtensionsStatusFn>>;
type McpStatus = Awaited<ReturnType<LoadMcpStatusFn>>;
type McpResources = Awaited<ReturnType<LoadMcpResourcesFn>>;

interface BuiltinProviderCache {
  directories: Map<string, Promise<DirectoryListing>>;
  globResults: Map<string, Promise<GlobWorkspaceResult>>;
  extensionsStatus?: Promise<ExtensionsStatus>;
  mcpStatus?: Promise<McpStatus>;
  mcpResources: Map<string, Promise<McpResources>>;
}

function createBuiltinProviderCache(): BuiltinProviderCache {
  return {
    directories: new Map(),
    globResults: new Map(),
    mcpResources: new Map(),
  };
}

function getCached<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  load: () => Promise<V>,
) {
  let promise = cache.get(key);
  if (!promise) {
    promise = load().catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, promise);
  }
  return promise;
}

interface LoadMcpResourceOptions {
  validateServer?: boolean;
}

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
  workspaceKey?: string;
  builtinProviders?: WebShellBuiltinAtProvidersConfig;
  providers?: readonly WebShellAtProvider[];
  createInlineTagEffect?: (range: {
    from: number;
    to: number;
    tag: WebShellComposerTag;
  }) => StateEffect<unknown>;
}

const AT_PATTERN = /@((?:[\p{L}\p{N}_./:-]|\\.)*)$/u;
const EMPTY_PROVIDERS: readonly WebShellAtProvider[] = [];
const SEARCH_DEBOUNCE_MS = 150;
const ITEM_LIMIT = 50;
const FILE_ROOT_ITEM_LIMIT = ITEM_LIMIT + 1;
export const FILE_PROVIDER_ID = 'files';
const EXTENSIONS_PROVIDER_ID = 'extensions';
export const MCP_RESOURCES_PROVIDER_ID = 'mcp-resources';
const BUILTIN_PROVIDER_IDS: readonly WebShellBuiltinAtProviderId[] = [
  FILE_PROVIDER_ID,
  EXTENSIONS_PROVIDER_ID,
  MCP_RESOURCES_PROVIDER_ID,
];
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'g');
// Strip zero-width and BiDi controls so provider text cannot spoof paths/URIs.
const BIDI_CONTROL_RE = /[\u200B\u200E\u200F\u061C\u2066-\u2069\u202A-\u202E]/g;
const SAFE_DISPLAY_FALLBACK = '[invalid]';
const AT_REFERENCE_UNSAFE_CHARS = /[^\p{L}\p{N}_./-]/gu;
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

function fileSearchGlobPattern(query: string): string {
  return query ? `**/*${escapeGlobQuery(query)}*` : '**/*';
}

function matchesQuery(query: string, ...values: Array<string | undefined>) {
  const lowerQuery = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(lowerQuery));
}

function directoryInsertText(path: string): string {
  const normalized = normalizeDirectoryPath(path);
  const safePath = sanitizeInsertText(normalized);
  return normalized === '.' ? '@./ ' : `@${escapeAtReferenceText(safePath)}/ `;
}

function buildMcpResourceRef(serverName: string, uri: string): string {
  return `${serverName}:${uri}`;
}

function escapeAtReferenceText(ref: string): string {
  return ref.replace(AT_REFERENCE_UNSAFE_CHARS, '\\$&');
}

function unescapeAtReferenceText(ref: string): string {
  return ref.replace(/\\(.)/g, '$1');
}

function isSafeTextChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code > 0x1f && code !== 0x7f && (code < 0x80 || code > 0x9f);
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

function splitFileQuery(query: string, fallbackDir: string) {
  const normalizedQuery = unescapeAtReferenceText(query)
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/');
  const slashIndex = normalizedQuery.lastIndexOf('/');
  if (slashIndex < 0) {
    return {
      dirPath: normalizeDirectoryPath(fallbackDir),
      entryQuery: normalizedQuery,
    };
  }
  const dirQuery = normalizedQuery.slice(0, slashIndex);
  const fallback = normalizeDirectoryPath(fallbackDir);
  const dirPath =
    fallback === '.' ? dirQuery : joinWorkspacePath(fallback, dirQuery);
  return {
    dirPath: normalizeDirectoryPath(dirPath),
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

export function sanitizeDisplayText(raw: string): string | undefined {
  const stripped = raw
    .replace(ANSI_RE, '')
    .replace(BIDI_CONTROL_RE, '')
    .split('')
    .filter(isSafeTextChar)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

function sanitizeInsertText(raw: string): string {
  const stripped = raw
    .replace(ANSI_RE, '')
    .replace(BIDI_CONTROL_RE, '')
    .split('')
    .filter(isSafeTextChar)
    .join('');
  return stripped.length > 0 ? stripped : SAFE_DISPLAY_FALLBACK;
}

function safeDisplayText(raw: string | undefined): string {
  if (raw === undefined) return SAFE_DISPLAY_FALLBACK;
  return sanitizeDisplayText(raw) ?? SAFE_DISPLAY_FALLBACK;
}

function sanitizeOptionalInsertText(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  return sanitizeInsertText(raw).trim();
}

function sanitizeComposerTag(
  tag: WebShellComposerTag | undefined,
): WebShellComposerTag | undefined {
  if (!tag) return undefined;
  const kind =
    tag.kind === undefined ? undefined : sanitizeDisplayText(tag.kind);
  return {
    id: sanitizeDisplayText(tag.id) ?? SAFE_DISPLAY_FALLBACK,
    label: tag.label === undefined ? undefined : sanitizeDisplayText(tag.label),
    value: tag.value === undefined ? undefined : sanitizeDisplayText(tag.value),
    removable: tag.removable,
    kind,
    icon: tag.icon,
    metadata: tag.metadata,
    serialized: sanitizeOptionalInsertText(tag.serialized),
  };
}

function sanitizeAtMentionItem(
  item: AtMentionItem,
  options?: { customProvider?: boolean },
): AtMentionItem {
  const sanitized = {
    ...item,
    label: sanitizeDisplayText(item.label) ?? safeDisplayText(item.id),
    description:
      item.description === undefined
        ? undefined
        : sanitizeDisplayText(item.description),
    subtitle:
      item.subtitle === undefined
        ? undefined
        : sanitizeDisplayText(item.subtitle),
    detail:
      item.detail === undefined ? undefined : sanitizeDisplayText(item.detail),
    icon: item.icon,
    iconTooltip:
      item.iconTooltip === undefined
        ? undefined
        : sanitizeDisplayText(item.iconTooltip),
    insertText:
      item.insertText === undefined
        ? undefined
        : sanitizeInsertText(item.insertText),
    composerTag: sanitizeComposerTag(item.composerTag),
  };
  if (!options?.customProvider) {
    return sanitized;
  }
  const safe = { ...sanitized };
  delete safe.targetPath;
  delete safe.serverName;
  return {
    ...safe,
    kind: 'insert',
  };
}

function createComposerTagForItem(
  providerId: string | undefined,
  item: AtMentionItem,
  insert: string,
): WebShellComposerTag | null {
  const serialized = insert.trim();
  if (!serialized) return null;
  if (item.composerTag) {
    return {
      ...item.composerTag,
      serialized: item.composerTag.serialized?.trim() || serialized,
    };
  }
  if (providerId === EXTENSIONS_PROVIDER_ID) {
    return {
      id: `extension:${serialized}`,
      kind: 'extension',
      value: item.label,
      serialized,
    };
  }
  if (providerId === MCP_RESOURCES_PROVIDER_ID) {
    return {
      id: `mcp:${serialized}`,
      kind: 'mcp',
      value: item.label,
      serialized,
    };
  }
  if (providerId === FILE_PROVIDER_ID) {
    return {
      id: `file:${serialized}`,
      kind: 'file',
      value: item.description ?? item.label,
      serialized,
    };
  }
  return null;
}

function createFileProvider(
  getActions: () => AtMentionWorkspaceActions | undefined,
  getCurrentDir: () => string,
  getCache: () => BuiltinProviderCache,
  label: string,
  description: string,
): WebShellAtProvider {
  return {
    id: FILE_PROVIDER_ID,
    label,
    description,
    order: 1,
    async search({ query, signal }) {
      const actions = getActions();
      const currentDir = normalizeDirectoryPath(getCurrentDir());
      const listDirectory = actions?.listDirectory;
      if (listDirectory && (!query || !actions?.globWorkspace)) {
        try {
          const { dirPath, entryQuery } = splitFileQuery(query, currentDir);
          const lowerQuery = entryQuery.toLowerCase();
          const listing = await getCached(getCache().directories, dirPath, () =>
            listDirectory(dirPath, { signal }),
          );
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
            description: sanitizeDisplayText(dirPath),
            insertText: directoryInsertText(dirPath),
            kind: 'insert',
          };
          return [
            ...(entryQuery ? [] : [currentDirectoryItem]),
            ...entries.map((entry): AtMentionItem => {
              const path = joinWorkspacePath(dirPath, entry.name);
              const safeName = safeDisplayText(entry.name);
              const safePath = sanitizeDisplayText(path);
              const safeInsertPath = sanitizeInsertText(path);
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
                insertText: `@${escapeAtReferenceText(safeInsertPath)} `,
                kind: 'insert',
              };
            }),
          ].slice(0, entryQuery ? ITEM_LIMIT : FILE_ROOT_ITEM_LIMIT);
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
        const pattern = fileSearchGlobPattern(query);
        const result = await getCached(getCache().globResults, pattern, () =>
          globWorkspace(pattern, { maxResults: ITEM_LIMIT, signal }),
        );
        if (signal.aborted) return [];
        return result.matches
          .filter((file) => file !== '.')
          .map((file) => ({
            id: file,
            label: safeDisplayText(file),
            insertText: `@${escapeAtReferenceText(sanitizeInsertText(file))} `,
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
  getCache: () => BuiltinProviderCache,
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
        const cache = getCache();
        cache.extensionsStatus ??= loadExtensionsStatus().catch((error) => {
          cache.extensionsStatus = undefined;
          throw error;
        });
        const status = await cache.extensionsStatus;
        if (signal.aborted) return [];
        const lowerQuery = query.toLowerCase();
        return status.extensions
          .filter((ext) => ext.isActive)
          .map((ext) => {
            const label = safeDisplayText(ext.name);
            const insertName = escapeAtReferenceText(
              sanitizeInsertText(ext.name),
            );
            const displayName = sanitizeDisplayText(ext.displayName ?? '');
            const description = sanitizeDisplayText(ext.description ?? '');
            return {
              id: ext.name,
              label,
              description:
                displayName && displayName !== label
                  ? displayName
                  : description,
              detail:
                displayName && description
                  ? `${displayName} - ${description}`
                  : (displayName ?? description),
              insertText: `@ext:${insertName} `,
            };
          })
          .filter((ext) => {
            return matchesQuery(lowerQuery, ext.label, ext.description);
          })
          .sort((a, b) => {
            const aLabel = a.label.toLowerCase();
            const bLabel = b.label.toLowerCase();
            const aPrefix = aLabel.startsWith(lowerQuery) ? 0 : 1;
            const bPrefix = bLabel.startsWith(lowerQuery) ? 0 : 1;
            if (aPrefix !== bPrefix) return aPrefix - bPrefix;
            return aLabel.localeCompare(bLabel);
          })
          .slice(0, ITEM_LIMIT);
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
  getCache: () => BuiltinProviderCache,
  label: string,
  description: string,
  formatResourceCount: (count: number) => string,
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
        const cache = getCache();
        cache.mcpStatus ??= loadMcpStatus().catch((error) => {
          cache.mcpStatus = undefined;
          throw error;
        });
        const status = await cache.mcpStatus;
        if (signal.aborted) return [];
        const lowerQuery = query.toLowerCase();
        return status.servers
          .filter((server) => !server.disabled)
          .map((server): AtMentionItem => {
            const safeName = sanitizeInsertText(server.name);
            const count =
              server.resourceCount === undefined
                ? undefined
                : formatResourceCount(server.resourceCount);
            if (server.resourceCount === 0) {
              return {
                id: `mcp-server-ref:${server.name}`,
                label: safeDisplayText(server.name),
                description: sanitizeDisplayText(server.description ?? ''),
                detail: sanitizeDisplayText(server.description ?? ''),
                insertText: `@mcp:${escapeAtReferenceText(safeName)} `,
                kind: 'insert',
              };
            }
            return {
              id: `mcp-server:${server.name}`,
              label: safeDisplayText(server.name),
              description:
                count === undefined
                  ? sanitizeDisplayText(server.description ?? '')
                  : count,
              detail: sanitizeDisplayText(server.description ?? ''),
              kind: 'mcp-server',
              serverName: server.name,
            };
          })
          .filter((server) => {
            return matchesQuery(lowerQuery, server.label, server.description);
          })
          .sort((a, b) => a.label.localeCompare(b.label))
          .slice(0, ITEM_LIMIT);
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
  workspaceKey,
  builtinProviders,
  providers = EMPTY_PROVIDERS,
  createInlineTagEffect,
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
  }, [builtinProviders, providers, t, workspaceActionsRef]);
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
            const maxItems =
              providerId === FILE_PROVIDER_ID && query.length === 0
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
      const filteredProviders = providerViewsRef.current.filter((provider) => {
        return matchesQuery(
          parsed.query,
          provider.textValue,
          provider.description,
        );
      });
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
    selectTab,
    backToCategories,
    updateSearch,
  };
}
