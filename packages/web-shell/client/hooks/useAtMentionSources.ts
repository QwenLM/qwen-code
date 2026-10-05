import type {
  WebShellAtItem,
  WebShellAtProvider,
  WebShellBuiltinAtProviderId,
  WebShellComposerTag,
} from '../customization';

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
export type McpStatus = Awaited<ReturnType<LoadMcpStatusFn>>;
type McpResources = Awaited<ReturnType<LoadMcpResourcesFn>>;

export interface BuiltinProviderCache {
  directories: Map<string, Promise<DirectoryListing>>;
  globResults: Map<string, Promise<GlobWorkspaceResult>>;
  extensionsStatus?: Promise<ExtensionsStatus>;
  mcpStatus?: Promise<McpStatus>;
  mcpResources: Map<string, Promise<McpResources>>;
}

export function createBuiltinProviderCache(): BuiltinProviderCache {
  return {
    directories: new Map(),
    globResults: new Map(),
    mcpResources: new Map(),
  };
}

export function getCached<K, V>(
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

export interface AtMentionWorkspaceActions {
  globWorkspace?: GlobWorkspaceFn;
  loadExtensionsStatus?: LoadExtensionsStatusFn;
  listDirectory?: ListDirectoryFn;
  loadMcpStatus?: LoadMcpStatusFn;
  loadMcpResources?: LoadMcpResourcesFn;
}

export interface AtMentionItem extends WebShellAtItem {
  kind?: 'insert' | 'directory' | 'mcp-server' | 'upload';
  fileKind?: DirectoryEntry['kind'];
  targetPath?: string;
  serverName?: string;
}

export const ITEM_LIMIT = 50;
// The empty-query file root view prefixes the current-directory item and,
// when upload is available, the upload item ahead of the file entries.
export const FILE_ROOT_ITEM_LIMIT = ITEM_LIMIT + 2;
export const FILE_PROVIDER_ID = 'files';
export const EXTENSIONS_PROVIDER_ID = 'extensions';
export const MCP_RESOURCES_PROVIDER_ID = 'mcp-resources';
export const BUILTIN_PROVIDER_IDS: readonly WebShellBuiltinAtProviderId[] = [
  FILE_PROVIDER_ID,
  EXTENSIONS_PROVIDER_ID,
  MCP_RESOURCES_PROVIDER_ID,
];
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'g');
// Strip zero-width and BiDi controls so provider text cannot spoof paths/URIs.
const BIDI_CONTROL_RE = /[\u200B\u200E\u200F\u061C\u2066-\u2069\u202A-\u202E]/g;
export const SAFE_DISPLAY_FALLBACK = '[invalid]';
const AT_REFERENCE_UNSAFE_CHARS = /[^\p{L}\p{N}_./-]/gu;

function joinWorkspacePath(dirPath: string, name: string): string {
  if (dirPath === '.' || dirPath === '') return name;
  return `${dirPath.replace(/\/+$/, '')}/${name}`;
}

export function normalizeDirectoryPath(path: string): string {
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

export function escapeGlobQuery(query: string): string {
  return Array.from(query, (char) => {
    if (/[a-z]/i.test(char)) {
      return `[${char.toLowerCase()}${char.toUpperCase()}]`;
    }
    return /[\\*?[{\]}()!@+|]/.test(char) ? `\\${char}` : char;
  }).join('');
}

export function fileSearchGlobPattern(query: string): string {
  const normalizedQuery = unescapeAtReferenceText(query).replace(/^\.\//, '');
  return normalizedQuery ? `**/*${escapeGlobQuery(normalizedQuery)}*` : '**/*';
}

export function matchesQuery(
  query: string,
  ...values: Array<string | undefined>
) {
  const lowerQuery = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(lowerQuery));
}

function directoryInsertText(path: string): string {
  const normalized = normalizeDirectoryPath(path);
  const safePath = sanitizeInsertText(normalized);
  return normalized === '.' ? '@./ ' : `@${escapeAtReferenceText(safePath)}/ `;
}

export function escapeAtReferenceText(ref: string): string {
  return ref.replace(AT_REFERENCE_UNSAFE_CHARS, '\\$&');
}

export function unescapeAtReferenceText(ref: string): string {
  return ref.replace(/\\(.)/g, '$1');
}

function isSafeTextChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code > 0x1f && code !== 0x7f && (code < 0x80 || code > 0x9f);
}

export function splitFileQuery(query: string, fallbackDir: string) {
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

export function sanitizeInsertText(raw: string): string {
  const stripped = raw
    .replace(ANSI_RE, '')
    .replace(BIDI_CONTROL_RE, '')
    .split('')
    .filter(isSafeTextChar)
    .join('');
  return stripped.length > 0 ? stripped : SAFE_DISPLAY_FALLBACK;
}

/**
 * Build the composer insert text for a workspace file reference, e.g.
 * `@path/to/file `. Shared by the @ file provider and the file-upload flow so
 * both escape identically (filenames with spaces / non-ASCII / `%` are common).
 */
export function fileReferenceInsertText(filePath: string): string {
  return `@${escapeAtReferenceText(sanitizeInsertText(filePath))} `;
}

export function safeDisplayText(raw: string | undefined): string {
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

export function sanitizeAtMentionItem(
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

export function createComposerTagForItem(
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
      ...(item.fileKind ? { metadata: { fileKind: item.fileKind } } : {}),
      serialized,
    };
  }
  return null;
}

export function createFileProvider(
  getActions: () => AtMentionWorkspaceActions | undefined,
  getCurrentDir: () => string,
  getCache: () => BuiltinProviderCache,
  label: string,
  description: string,
  getUploadItem: () => AtMentionItem | null,
  browseDirectories = false,
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
      if (
        listDirectory &&
        (!query ||
          (browseDirectories && query.endsWith('/')) ||
          !actions?.globWorkspace)
      ) {
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
            fileKind: 'directory',
          };
          // The upload item only shows with an empty entry query (like the
          // current-directory item) so it never pollutes filtered results.
          const uploadItem = entryQuery ? null : getUploadItem();
          return [
            ...(uploadItem ? [uploadItem] : []),
            ...(entryQuery ? [] : [currentDirectoryItem]),
            ...entries.slice(0, ITEM_LIMIT).map((entry): AtMentionItem => {
              const path = joinWorkspacePath(dirPath, entry.name);
              const safeName = safeDisplayText(entry.name);
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
                insertText: fileReferenceInsertText(path),
                kind: 'insert',
                fileKind: entry.kind,
              };
            }),
          ].slice(0, entryQuery ? ITEM_LIMIT : FILE_ROOT_ITEM_LIMIT);
        } catch (error) {
          if (!signal.aborted) {
            console.warn('Failed to load @ file suggestions', error);
          }
          throw error;
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
            insertText: fileReferenceInsertText(file),
            kind: 'insert',
            fileKind: 'file',
          }));
      } catch (error) {
        if (!signal.aborted) {
          console.warn('Failed to load @ file suggestions', error);
        }
        throw error;
      }
    },
  };
}

export function createExtensionProvider(
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
            const serialized = `@ext:${insertName}`;
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
              composerTag: {
                id: `extension:${serialized}`,
                kind: 'extension',
                value: displayName || label,
                serialized,
              },
              insertText: `${serialized} `,
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
          });
      } catch (error) {
        if (!signal.aborted) {
          console.warn('Failed to load @ extension suggestions', error);
        }
        throw error;
      }
    },
  };
}

export function createMcpResourcesProvider(
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
          .sort((a, b) => a.label.localeCompare(b.label));
      } catch (error) {
        if (!signal.aborted) {
          console.warn('Failed to load @ MCP resource suggestions', error);
        }
        throw error;
      }
    },
  };
}
