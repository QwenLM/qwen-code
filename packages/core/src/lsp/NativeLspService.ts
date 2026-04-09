/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config as CoreConfig } from '../config/config.js';
import type { Extension } from '../extension/extensionManager.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type {
  LspCallHierarchyIncomingCall,
  LspCallHierarchyItem,
  LspCallHierarchyOutgoingCall,
  LspCodeAction,
  LspCodeActionContext,
  LspDefinition,
  LspDiagnostic,
  LspFileDiagnostics,
  LspHoverResult,
  LspLocation,
  LspRange,
  LspReference,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
} from './types.js';
import type { EventEmitter } from 'events';
import {
  DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS,
  DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS,
  DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS,
} from './constants.js';
import { LspConfigLoader } from './LspConfigLoader.js';
import { LspResponseNormalizer } from './LspResponseNormalizer.js';
import { LspServerManager } from './LspServerManager.js';
import type {
  LspConnectionInterface,
  LspServerHandle,
  LspServerStatus,
  NativeLspServiceOptions,
} from './types.js';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as fs from 'node:fs';
import { createDebugLogger } from '../utils/debugLogger.js';
import { globSync } from 'glob';

const debugLogger = createDebugLogger('LSP');

/**
 * Mapping from LSP language identifiers to file extensions, only for cases
 * where the language ID does NOT match the file extension directly.
 * Languages whose ID is already a valid extension (e.g. "cpp", "java", "go")
 * are handled by the fallback in getWorkspaceSymbolExtensions().
 */
const LANGUAGE_ID_TO_EXTENSIONS: Record<string, string[]> = {
  typescript: ['ts', 'tsx'],
  typescriptreact: ['tsx'],
  javascript: ['js', 'jsx'],
  javascriptreact: ['jsx'],
  python: ['py'],
  csharp: ['cs'],
  ruby: ['rb'],
};

const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
];

export class NativeLspService {
  private config: CoreConfig;
  private workspaceContext: WorkspaceContext;
  private fileDiscoveryService: FileDiscoveryService;
  private requireTrustedWorkspace: boolean;
  private workspaceRoot: string;
  private configLoader: LspConfigLoader;
  private serverManager: LspServerManager;
  private normalizer: LspResponseNormalizer;
  private openedDocuments = new Map<string, Set<string>>();
  private lastConnections = new Map<string, LspConnectionInterface>();

  constructor(
    config: CoreConfig,
    workspaceContext: WorkspaceContext,
    _eventEmitter: EventEmitter,
    fileDiscoveryService: FileDiscoveryService,
    _ideContextStore: IdeContextStore,
    options: NativeLspServiceOptions = {},
  ) {
    this.config = config;
    this.workspaceContext = workspaceContext;
    this.fileDiscoveryService = fileDiscoveryService;
    this.requireTrustedWorkspace = options.requireTrustedWorkspace ?? true;
    this.workspaceRoot =
      options.workspaceRoot ??
      (config as { getProjectRoot: () => string }).getProjectRoot();
    this.configLoader = new LspConfigLoader(this.workspaceRoot);
    this.normalizer = new LspResponseNormalizer();
    this.serverManager = new LspServerManager(
      this.config,
      this.workspaceContext,
      this.fileDiscoveryService,
      {
        requireTrustedWorkspace: this.requireTrustedWorkspace,
        workspaceRoot: this.workspaceRoot,
      },
    );
  }

  /**
   * Discover and prepare LSP servers
   */
  async discoverAndPrepare(): Promise<void> {
    const workspaceTrusted = this.config.isTrustedFolder();
    this.serverManager.clearServerHandles();

    // Check if workspace is trusted
    if (this.requireTrustedWorkspace && !workspaceTrusted) {
      debugLogger.warn(
        'Workspace is not trusted, skipping LSP server discovery',
      );
      return;
    }

    // Load LSP configs
    const userConfigs = await this.configLoader.loadUserConfigs();
    const extensionConfigs = await this.configLoader.loadExtensionConfigs(
      this.getActiveExtensions(),
    );
    // Merge configs: extension LSP configs + user .lsp.json
    const serverConfigs = this.configLoader.mergeConfigs(
      [],
      extensionConfigs,
      userConfigs,
    );
    this.serverManager.setServerConfigs(serverConfigs);
  }

  private getActiveExtensions(): Extension[] {
    const configWithExtensions = this.config as unknown as {
      getActiveExtensions?: () => Extension[];
    };
    return typeof configWithExtensions.getActiveExtensions === 'function'
      ? configWithExtensions.getActiveExtensions()
      : [];
  }

  /**
   * Start all LSP servers
   */
  async start(): Promise<void> {
    await this.serverManager.startAll();
  }

  /**
   * Stop all LSP servers
   */
  async stop(): Promise<void> {
    await this.serverManager.stopAll();
  }

  /**
   * Get LSP server status
   */
  getStatus(): Map<string, LspServerStatus> {
    return this.serverManager.getStatus();
  }

  /**
   * Get ready server handles filtered by optional server name.
   * Each handle is guaranteed to have a valid connection.
   *
   * @param serverName - Optional server name to filter by
   * @returns Array of [serverName, handle] tuples with active connections
   */
  private getReadyHandles(
    serverName?: string,
  ): Array<[string, LspServerHandle & { connection: LspConnectionInterface }]> {
    return Array.from(this.serverManager.getHandles().entries()).filter(
      (
        entry,
      ): entry is [
        string,
        LspServerHandle & { connection: LspConnectionInterface },
      ] =>
        entry[1].status === 'READY' &&
        entry[1].connection !== undefined &&
        (!serverName || entry[0] === serverName),
    );
  }

  /**
   * Ensure a document is open on the given LSP server. Sends textDocument/didOpen
   * if not already tracked, then waits for the server to process the file before
   * returning. This delay prevents empty results when the server hasn't analyzed
   * the file yet.
   *
   * @param serverName - The name of the LSP server
   * @param handle - The server handle with an active connection
   * @param uri - The document URI to open
   * @returns true if a new didOpen was sent; false if already open or failed
   */
  private async ensureDocumentOpen(
    serverName: string,
    handle: LspServerHandle & { connection: LspConnectionInterface },
    uri: string,
  ): Promise<boolean> {
    const lastConnection = this.lastConnections.get(serverName);
    if (lastConnection && lastConnection !== handle.connection) {
      this.openedDocuments.delete(serverName);
    }
    this.lastConnections.set(serverName, handle.connection);

    if (!uri.startsWith('file://')) {
      return false;
    }
    const openedForServer = this.openedDocuments.get(serverName);
    if (openedForServer?.has(uri)) {
      return false;
    }

    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch (error) {
      debugLogger.warn(`Failed to resolve file path for ${uri}:`, error);
      return false;
    }

    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      debugLogger.warn(
        `Failed to read file for LSP didOpen: ${filePath}`,
        error,
      );
      return false;
    }

    const languageId = this.resolveLanguageId(filePath, handle) ?? 'plaintext';

    handle.connection.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text,
        },
      },
    });

    const nextOpened = openedForServer ?? new Set<string>();
    nextOpened.add(uri);
    this.openedDocuments.set(serverName, nextOpened);

    // Wait for the LSP server to process the newly opened document.
    // Without this delay, requests sent immediately after didOpen may return
    // empty results because the server hasn't finished analyzing the file.
    await this.delay(DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS);

    return true;
  }

  /**
   * Register a URI that was opened externally (e.g. by warmupTypescriptServer)
   * so that ensureDocumentOpen does not send a duplicate textDocument/didOpen.
   *
   * @param serverName - The name of the LSP server
   * @param uri - The document URI to track as already opened
   */
  private trackExternallyOpenedDocument(serverName: string, uri: string): void {
    const openedForServer =
      this.openedDocuments.get(serverName) ?? new Set<string>();
    openedForServer.add(uri);
    this.openedDocuments.set(serverName, openedForServer);
  }

  private resolveLanguageId(
    filePath: string,
    handle: LspServerHandle,
  ): string | undefined {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (ext && handle.config.extensionToLanguage) {
      const mapping = handle.config.extensionToLanguage;
      return mapping[ext] ?? mapping['.' + ext];
    }
    if (handle.config.languages && handle.config.languages.length > 0) {
      return handle.config.languages[0];
    }
    return ext || undefined;
  }

  private async warmupWorkspaceSymbols(
    serverName: string,
    handle: LspServerHandle,
  ): Promise<boolean> {
    if (!handle.connection) {
      return false;
    }
    const openedForServer = this.openedDocuments.get(serverName);
    if (openedForServer && openedForServer.size > 0) {
      return true;
    }

    const filePath = this.findWorkspaceFileForServer(handle);
    if (!filePath) {
      return false;
    }

    const uri = pathToFileURL(filePath).toString();
    const didOpen = await this.ensureDocumentOpen(
      serverName,
      handle as LspServerHandle & { connection: LspConnectionInterface },
      uri,
    );
    if (!didOpen) {
      return false;
    }
    await this.delay(DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS);
    return true;
  }

  /**
   * Find the first source file in the workspace that matches the server's
   * language extensions. Used to open a file for workspace symbol warmup.
   *
   * @param handle - The LSP server handle to determine target extensions
   * @returns Absolute path of the first matching file, or undefined
   */
  private findWorkspaceFileForServer(
    handle: LspServerHandle,
  ): string | undefined {
    const extensions = this.getWorkspaceSymbolExtensions(handle);
    if (extensions.length === 0) {
      return undefined;
    }
    // Brace expansion requires at least 2 items; use plain glob for a single ext
    const extGlob =
      extensions.length === 1 ? extensions[0]! : `{${extensions.join(',')}}`;
    const pattern = `**/*.${extGlob}`;
    const roots = this.workspaceContext.getDirectories();

    for (const root of roots) {
      try {
        // Use maxDepth to avoid scanning deeply nested directories;
        // we only need one file to trigger server indexing.
        const matches = globSync(pattern, {
          cwd: root,
          ignore: DEFAULT_EXCLUDE_PATTERNS,
          absolute: true,
          nodir: true,
          maxDepth: 5,
        });
        for (const match of matches) {
          if (this.fileDiscoveryService.shouldIgnoreFile(match)) {
            continue;
          }
          return match;
        }
      } catch (_error) {
        // ignore glob errors
      }
    }

    return undefined;
  }

  /**
   * Determine file extensions this server can handle, used to find a workspace
   * file to open for warmup. Resolution order:
   *   1. Keys from config.extensionToLanguage (explicit user/extension mapping)
   *   2. Derived from config.languages via LANGUAGE_ID_TO_EXTENSIONS, falling
   *      back to treating the language ID itself as a file extension
   */
  private getWorkspaceSymbolExtensions(handle: LspServerHandle): string[] {
    const extensions = new Set<string>();

    // Prefer explicit extension-to-language mapping from server config
    const extMapping = handle.config.extensionToLanguage;
    if (extMapping) {
      for (const key of Object.keys(extMapping)) {
        const normalized = key.startsWith('.') ? key.slice(1) : key;
        if (normalized) {
          extensions.add(normalized.toLowerCase());
        }
      }
    }

    // Fall back to deriving extensions from language identifiers
    if (extensions.size === 0) {
      for (const language of handle.config.languages) {
        const mapped = LANGUAGE_ID_TO_EXTENSIONS[language];
        if (mapped) {
          for (const ext of mapped) {
            extensions.add(ext);
          }
        } else {
          // For languages like "cpp", "java", "go", "rust" etc.,
          // the language ID itself is a valid file extension
          extensions.add(language.toLowerCase());
        }
      }
    }

    return Array.from(extensions);
  }

  /**
   * Run TypeScript server warmup and track the opened URI to prevent
   * duplicate didOpen notifications.
   *
   * @param serverName - The name of the LSP server
   * @param handle - The server handle
   * @param force - Force re-warmup even if already warmed up
   */
  private async warmupAndTrack(
    serverName: string,
    handle: LspServerHandle,
    force = false,
  ): Promise<void> {
    const warmupUri = await this.serverManager.warmupTypescriptServer(
      handle,
      force,
    );
    if (warmupUri) {
      this.trackExternallyOpenedDocument(serverName, warmupUri);
    }
  }

  /**
   * Whether we should retry a document-level operation that returned empty
   * results. We retry when a textDocument/didOpen was just sent (the server
   * may still be indexing) AND the server is not a fast TypeScript server.
   */
  private shouldRetryAfterOpen(
    justOpened: boolean,
    handle: LspServerHandle,
  ): boolean {
    return justOpened && !this.serverManager.isTypescriptServer(handle);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Workspace symbol search across all ready LSP servers.
   */
  async workspaceSymbols(
    query: string,
    limit = 50,
  ): Promise<LspSymbolInformation[]> {
    const results: LspSymbolInformation[] = [];

    for (const [serverName, handle] of Array.from(
      this.serverManager.getHandles(),
    )) {
      if (handle.status !== 'READY' || !handle.connection) {
        continue;
      }
      try {
        await this.warmupAndTrack(serverName, handle);
        const warmedUp = this.serverManager.isTypescriptServer(handle)
          ? false
          : await this.warmupWorkspaceSymbols(serverName, handle);
        let response = await handle.connection.request('workspace/symbol', {
          query,
        });
        if (
          !this.serverManager.isTypescriptServer(handle) &&
          Array.isArray(response) &&
          response.length === 0 &&
          warmedUp
        ) {
          await this.delay(DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS);
          response = await handle.connection.request('workspace/symbol', {
            query,
          });
        }
        if (
          this.serverManager.isTypescriptServer(handle) &&
          this.isNoProjectErrorResponse(response)
        ) {
          await this.warmupAndTrack(serverName, handle, true);
          response = await handle.connection.request('workspace/symbol', {
            query,
          });
        }
        if (!Array.isArray(response)) {
          continue;
        }
        for (const item of response) {
          const symbol = this.normalizer.normalizeSymbolResult(
            item,
            serverName,
          );
          if (symbol) {
            results.push(symbol);
          }
          if (results.length >= limit) {
            return results.slice(0, limit);
          }
        }
      } catch (error) {
        debugLogger.warn(
          `LSP workspace/symbol failed for ${serverName}:`,
          error,
        );
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Go to definition
   */
  async definitions(
    location: LspLocation,
    serverName?: string,
    limit = 50,
  ): Promise<LspDefinition[]> {
    const handles = this.getReadyHandles(serverName);
    const requestParams = {
      textDocument: { uri: location.uri },
      position: location.range.start,
    };

    for (const [name, handle] of handles) {
      try {
        const justOpened = await this.ensureDocumentOpen(
          name,
          handle,
          location.uri,
        );
        await this.warmupAndTrack(name, handle);

        let response = await handle.connection.request(
          'textDocument/definition',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await handle.connection.request(
            'textDocument/definition',
            requestParams,
          );
        }

        const candidates = Array.isArray(response)
          ? response
          : response
            ? [response]
            : [];
        const definitions: LspDefinition[] = [];
        for (const def of candidates) {
          const normalized = this.normalizer.normalizeLocationResult(def, name);
          if (normalized) {
            definitions.push(normalized);
            if (definitions.length >= limit) {
              return definitions.slice(0, limit);
            }
          }
        }
        if (definitions.length > 0) {
          return definitions.slice(0, limit);
        }
      } catch (error) {
        debugLogger.warn(
          `LSP textDocument/definition failed for ${name}:`,
          error,
        );
      }
    }

    return [];
  }

  /**
   * Find references
   */
  async references(
    location: LspLocation,
    serverName?: string,
    includeDeclaration = false,
    limit = 200,
  ): Promise<LspReference[]> {
    const handles = this.getReadyHandles(serverName);
    const requestParams = {
      textDocument: { uri: location.uri },
      position: location.range.start,
      context: { includeDeclaration },
    };

    for (const [name, handle] of handles) {
      try {
        const justOpened = await this.ensureDocumentOpen(
          name,
          handle,
          location.uri,
        );
        await this.warmupAndTrack(name, handle);

        let response = await handle.connection.request(
          'textDocument/references',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await handle.connection.request(
            'textDocument/references',
            requestParams,
          );
        }

        if (!Array.isArray(response)) {
          continue;
        }
        const refs: LspReference[] = [];
        for (const ref of response) {
          const normalized = this.normalizer.normalizeLocationResult(ref, name);
          if (normalized) {
            refs.push(normalized);
          }
          if (refs.length >= limit) {
            return refs.slice(0, limit);
          }
        }
        if (refs.length > 0) {
          return refs.slice(0, limit);
        }
      } catch (error) {
        debugLogger.warn(
          `LSP textDocument/references failed for ${name}:`,
          error,
        );
      }
    }

    return [];
  }

  /**
   * Get hover information
   */
  async hover(
    location: LspLocation,
    serverName?: string,
  ): Promise<LspHoverResult | null> {
    const handles = this.getReadyHandles(serverName);
    const requestParams = {
      textDocument: { uri: location.uri },
      position: location.range.start,
    };

    for (const [name, handle] of handles) {
      try {
        const justOpened = await this.ensureDocumentOpen(
          name,
          handle,
          location.uri,
        );
        await this.warmupAndTrack(name, handle);

        let response = await handle.connection.request(
          'textDocument/hover',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await handle.connection.request(
            'textDocument/hover',
            requestParams,
          );
        }

        const normalized = this.normalizer.normalizeHoverResult(response, name);
        if (normalized) {
          return normalized;
        }
      } catch (error) {
        debugLogger.warn(`LSP textDocument/hover failed for ${name}:`, error);
      }
    }

    return null;
  }

  /**
   * Get document symbols
   */
  async documentSymbols(
    uri: string,
    serverName?: string,
    limit = 200,
  ): Promise<LspSymbolInformation[]> {
    const handles = this.getReadyHandles(serverName);
    const requestParams = { textDocument: { uri } };

    for (const [name, handle] of handles) {
      try {
        const justOpened = await this.ensureDocumentOpen(name, handle, uri);
        await this.warmupAndTrack(name, handle);

        let response = await handle.connection.request(
          'textDocument/documentSymbol',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await handle.connection.request(
            'textDocument/documentSymbol',
            requestParams,
          );
        }

        if (!Array.isArray(response)) {
          continue;
        }
        const symbols: LspSymbolInformation[] = [];
        for (const item of response) {
          if (!item || typeof item !== 'object') {
            continue;
          }
          const itemObj = item as Record<string, unknown>;
          if (this.normalizer.isDocumentSymbol(itemObj)) {
            this.normalizer.collectDocumentSymbol(
              itemObj,
              uri,
              name,
              symbols,
              limit,
            );
          } else {
            const normalized = this.normalizer.normalizeSymbolResult(
              itemObj,
              name,
            );
            if (normalized) {
              symbols.push(normalized);
            }
          }
          if (symbols.length >= limit) {
            return symbols.slice(0, limit);
          }
        }
        if (symbols.length > 0) {
          return symbols.slice(0, limit);
        }
      } catch (error) {
        debugLogger.warn(
          `LSP textDocument/documentSymbol failed for ${name}:`,
          error,
        );
      }
    }

    return [];
  }

  /**
   * Find implementations
   */
  async implementations(
    location: LspLocation,
    serverName?: string,
    limit = 50,
  ): Promise<LspDefinition[]> {
    const handles = this.getReadyHandles(serverName);
    const requestParams = {
      textDocument: { uri: location.uri },
      position: location.range.start,
    };

    for (const [name, handle] of handles) {
      try {
        const justOpened = await this.ensureDocumentOpen(
          name,
          handle,
          location.uri,
        );
        await this.warmupAndTrack(name, handle);

        let response = await handle.connection.request(
          'textDocument/implementation',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await handle.connection.request(
            'textDocument/implementation',
            requestParams,
          );
        }

        const candidates = Array.isArray(response)
          ? response
          : response
            ? [response]
            : [];
        const implementations: LspDefinition[] = [];
        for (const item of candidates) {
          const normalized = this.normalizer.normalizeLocationResult(
            item,
            name,
          );
          if (normalized) {
            implementations.push(normalized);
            if (implementations.length >= limit) {
              return implementations.slice(0, limit);
            }
          }
        }
        if (implementations.length > 0) {
          return implementations.slice(0, limit);
        }
      } catch (error) {
        debugLogger.warn(
          `LSP textDocument/implementation failed for ${name}:`,
          error,
        );
      }
    }

    return [];
  }

  /**
   * Prepare call hierarchy
   */
  async prepareCallHierarchy(
    location: LspLocation,
    serverName?: string,
    limit = 50,
  ): Promise<LspCallHierarchyItem[]> {
    const handles = this.getReadyHandles(serverName);
    const requestParams = {
      textDocument: { uri: location.uri },
      position: location.range.start,
    };

    for (const [name, handle] of handles) {
      try {
        const justOpened = await this.ensureDocumentOpen(
          name,
          handle,
          location.uri,
        );
        await this.warmupAndTrack(name, handle);

        let response = await handle.connection.request(
          'textDocument/prepareCallHierarchy',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await handle.connection.request(
            'textDocument/prepareCallHierarchy',
            requestParams,
          );
        }

        const candidates = Array.isArray(response)
          ? response
          : response
            ? [response]
            : [];
        const items: LspCallHierarchyItem[] = [];
        for (const item of candidates) {
          const normalized = this.normalizer.normalizeCallHierarchyItem(
            item,
            name,
          );
          if (normalized) {
            items.push(normalized);
            if (items.length >= limit) {
              return items.slice(0, limit);
            }
          }
        }
        if (items.length > 0) {
          return items.slice(0, limit);
        }
      } catch (error) {
        debugLogger.warn(
          `LSP textDocument/prepareCallHierarchy failed for ${name}:`,
          error,
        );
      }
    }

    return [];
  }

  /**
   * Find callers of the current function
   */
  async incomingCalls(
    item: LspCallHierarchyItem,
    serverName?: string,
    limit = 50,
  ): Promise<LspCallHierarchyIncomingCall[]> {
    const targetServer = serverName ?? item.serverName;
    const handles = this.getReadyHandles(targetServer);

    for (const [name, handle] of handles) {
      try {
        await this.warmupAndTrack(name, handle);
        const response = await handle.connection.request(
          'callHierarchy/incomingCalls',
          {
            item: this.normalizer.toCallHierarchyItemParams(item),
          },
        );
        if (!Array.isArray(response)) {
          continue;
        }
        const calls: LspCallHierarchyIncomingCall[] = [];
        for (const call of response) {
          const normalized = this.normalizer.normalizeIncomingCall(call, name);
          if (normalized) {
            calls.push(normalized);
            if (calls.length >= limit) {
              return calls.slice(0, limit);
            }
          }
        }
        if (calls.length > 0) {
          return calls.slice(0, limit);
        }
      } catch (error) {
        debugLogger.warn(
          `LSP callHierarchy/incomingCalls failed for ${name}:`,
          error,
        );
      }
    }

    return [];
  }

  /**
   * Find functions called by the current function
   */
  async outgoingCalls(
    item: LspCallHierarchyItem,
    serverName?: string,
    limit = 50,
  ): Promise<LspCallHierarchyOutgoingCall[]> {
    const targetServer = serverName ?? item.serverName;
    const handles = this.getReadyHandles(targetServer);

    for (const [name, handle] of handles) {
      try {
        await this.warmupAndTrack(name, handle);
        const response = await handle.connection.request(
          'callHierarchy/outgoingCalls',
          {
            item: this.normalizer.toCallHierarchyItemParams(item),
          },
        );
        if (!Array.isArray(response)) {
          continue;
        }
        const calls: LspCallHierarchyOutgoingCall[] = [];
        for (const call of response) {
          const normalized = this.normalizer.normalizeOutgoingCall(call, name);
          if (normalized) {
            calls.push(normalized);
            if (calls.length >= limit) {
              return calls.slice(0, limit);
            }
          }
        }
        if (calls.length > 0) {
          return calls.slice(0, limit);
        }
      } catch (error) {
        debugLogger.warn(
          `LSP callHierarchy/outgoingCalls failed for ${name}:`,
          error,
        );
      }
    }

    return [];
  }

  /**
   * Get diagnostics for a document
   */
  async diagnostics(
    uri: string,
    serverName?: string,
  ): Promise<LspDiagnostic[]> {
    const handles = this.getReadyHandles(serverName);
    const allDiagnostics: LspDiagnostic[] = [];

    for (const [name, handle] of handles) {
      try {
        await this.ensureDocumentOpen(name, handle, uri);
        await this.warmupAndTrack(name, handle);

        // Request pull diagnostics if the server supports it
        const response = await handle.connection.request(
          'textDocument/diagnostic',
          {
            textDocument: { uri },
          },
        );

        if (response && typeof response === 'object') {
          const responseObj = response as Record<string, unknown>;
          const items = responseObj['items'];
          if (Array.isArray(items)) {
            for (const item of items) {
              const normalized = this.normalizer.normalizeDiagnostic(
                item,
                name,
              );
              if (normalized) {
                allDiagnostics.push(normalized);
              }
            }
          }
        }
      } catch (error) {
        // Fall back to cached diagnostics from publishDiagnostics notifications
        // This is handled by the notification handler if implemented
        debugLogger.warn(
          `LSP textDocument/diagnostic failed for ${name}:`,
          error,
        );

        // Force-refresh the document: send didClose + didOpen to trigger fresh analysis
        handle.cachedDiagnostics.delete(uri);
        const openedForServer = this.openedDocuments.get(name);
        if (openedForServer?.has(uri)) {
          openedForServer.delete(uri);
          try {
            const filePath = fileURLToPath(uri);
            const text = fs.readFileSync(filePath, 'utf-8');
            const languageId =
              this.resolveLanguageId(filePath, handle) ?? 'plaintext';
            handle.connection.send({
              jsonrpc: '2.0',
              method: 'textDocument/didClose',
              params: { textDocument: { uri } },
            });
            handle.connection.send({
              jsonrpc: '2.0',
              method: 'textDocument/didOpen',
              params: {
                textDocument: {
                  uri,
                  languageId,
                  version: Date.now(),
                  text,
                },
              },
            });
            await this.delay(DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS * 5);
            openedForServer.add(uri);
          } catch (err) {
            debugLogger.warn(`Failed to refresh document:`, err);
            openedForServer.add(uri);
          }
        }
        // Check push diagnostics cache (freshly updated after didOpen)
        const cache = handle.cachedDiagnostics;
        if (cache) {
          const cached = cache.get(uri);
          if (cached && cached.length > 0) {
            for (const item of cached) {
              const normalized2 = this.normalizer.normalizeDiagnostic(
                item,
                name,
              );
              if (normalized2) {
                allDiagnostics.push(normalized2);
              }
            }
            continue;
          }
        }
        // Await push diagnostics via pub/sub (Promise.race with 5s timeout)
        if (handle.pendingDiagnostics) {
          await Promise.race([
            new Promise<void>((resolve) => {
              handle.pendingDiagnostics!.set(uri, { resolve });
            }),
            new Promise<void>((resolve) => {
              setTimeout(() => {
                handle.pendingDiagnostics!.delete(uri);
                resolve();
              }, 5000);
            }),
          ]);
        }
        // Read diagnostics after notification arrives or timeout
        if (cache) {
          const cached = cache.get(uri);
          if (cached) {
            for (const item of cached) {
              const normalized = this.normalizer.normalizeDiagnostic(
                item,
                name,
              );
              if (normalized) {
                allDiagnostics.push(normalized);
              }
            }
          }
        }
      }
    }

    return allDiagnostics;
  }

  /**
   * Get diagnostics for all documents in the workspace
   */
  async workspaceDiagnostics(
    serverName?: string,
    limit = 100,
  ): Promise<LspFileDiagnostics[]> {
    const handles = this.getReadyHandles(serverName);
    const results: LspFileDiagnostics[] = [];

    for (const [name, handle] of handles) {
      try {
        await this.warmupAndTrack(name, handle);

        // Request workspace diagnostics if supported
        const response = await handle.connection.request(
          'workspace/diagnostic',
          {
            previousResultIds: [],
          },
        );

        if (response && typeof response === 'object') {
          const responseObj = response as Record<string, unknown>;
          const items = responseObj['items'];
          if (Array.isArray(items)) {
            for (const item of items) {
              if (results.length >= limit) {
                break;
              }
              const normalized = this.normalizer.normalizeFileDiagnostics(
                item,
                name,
              );
              if (normalized && normalized.diagnostics.length > 0) {
                results.push(normalized);
              }
            }
          }
        }
      } catch (error) {
        debugLogger.warn(`LSP workspace/diagnostic failed for ${name}:`, error);

        if (handle.cachedDiagnostics) {
          const workspaceRootUris = this.workspaceContext
            .getDirectories()
            .map((dir) => pathToFileURL(dir).toString());
          for (const [uri, diagnostics] of handle.cachedDiagnostics) {
            if (!workspaceRootUris.some((rootUri) => uri.startsWith(rootUri))) {
              continue;
            }
            if (results.length >= limit) break;
            if (diagnostics && diagnostics.length > 0) {
              const normalizedDiagnostics = [];
              for (const diag of diagnostics) {
                const n = this.normalizer.normalizeDiagnostic(diag, name);
                if (n) normalizedDiagnostics.push(n);
              }
              if (normalizedDiagnostics.length > 0) {
                results.push({
                  uri,
                  diagnostics: normalizedDiagnostics,
                  serverName: name,
                });
              }
            }
          }
        }
      }

      if (results.length >= limit) {
        break;
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Get code actions at the specified position
   */
  async codeActions(
    uri: string,
    range: LspRange,
    context: LspCodeActionContext,
    serverName?: string,
    limit = 20,
  ): Promise<LspCodeAction[]> {
    const handles = this.getReadyHandles(serverName);

    for (const [name, handle] of handles) {
      try {
        await this.ensureDocumentOpen(name, handle, uri);
        await this.warmupAndTrack(name, handle);

        // Convert context diagnostics to LSP format
        const lspDiagnostics = context.diagnostics.map((d: LspDiagnostic) =>
          this.normalizer.denormalizeDiagnostic(d),
        );

        const response = await handle.connection.request(
          'textDocument/codeAction',
          {
            textDocument: { uri },
            range,
            context: {
              diagnostics: lspDiagnostics,
              only: context.only,
              triggerKind:
                context.triggerKind === 'automatic'
                  ? 2 // CodeActionTriggerKind.Automatic
                  : 1, // CodeActionTriggerKind.Invoked
            },
          },
        );

        if (!Array.isArray(response)) {
          continue;
        }

        const actions: LspCodeAction[] = [];
        for (const item of response) {
          const normalized = this.normalizer.normalizeCodeAction(item, name);
          if (normalized) {
            actions.push(normalized);
            if (actions.length >= limit) {
              break;
            }
          }
        }

        if (actions.length > 0) {
          return actions.slice(0, limit);
        }
      } catch (error) {
        debugLogger.warn(
          `LSP textDocument/codeAction failed for ${name}:`,
          error,
        );
      }
    }

    return [];
  }

  /**
   * Apply workspace edit
   */
  async applyWorkspaceEdit(
    edit: LspWorkspaceEdit,
    _serverName?: string,
  ): Promise<boolean> {
    // Apply edits locally - this doesn't go through LSP server
    // Instead, it applies the edits to the file system
    try {
      if (edit.changes) {
        for (const [uri, edits] of Object.entries(edit.changes)) {
          await this.applyTextEdits(uri, edits as LspTextEdit[]);
        }
      }

      if (edit.documentChanges) {
        for (const docChange of edit.documentChanges) {
          await this.applyTextEdits(
            docChange.textDocument.uri,
            docChange.edits,
          );
        }
      }

      return true;
    } catch (error) {
      debugLogger.error('Failed to apply workspace edit:', error);
      return false;
    }
  }

  /**
   * Apply text edits to a file
   */
  private async applyTextEdits(
    uri: string,
    edits: LspTextEdit[],
  ): Promise<void> {
    let filePath = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(this.workspaceRoot, filePath);
    }
    if (!this.workspaceContext.isPathWithinWorkspace(filePath)) {
      throw new Error(`Refusing to apply edits outside workspace: ${filePath}`);
    }

    // Read the current file content
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // File doesn't exist, treat as empty
      content = '';
    }

    // Sort edits in reverse order to apply from end to start
    const sortedEdits = [...edits].sort((a, b) => {
      if (a.range.start.line !== b.range.start.line) {
        return b.range.start.line - a.range.start.line;
      }
      return b.range.start.character - a.range.start.character;
    });

    const lines = content.split('\n');

    for (const edit of sortedEdits) {
      const { range, newText } = edit;
      const startLine = range.start.line;
      const endLine = range.end.line;
      const startChar = range.start.character;
      const endChar = range.end.character;

      // Get the affected lines
      const startLineText = lines[startLine] ?? '';
      const endLineText = lines[endLine] ?? '';

      // Build the new content
      const before = startLineText.slice(0, startChar);
      const after = endLineText.slice(endChar);

      // Replace the range with new text
      const newLines = (before + newText + after).split('\n');

      // Replace affected lines
      lines.splice(startLine, endLine - startLine + 1, ...newLines);
    }

    // Write back to file
    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  }

  /**
   * Check if an LSP response represents an empty/null result, used to decide
   * whether a retry is worthwhile after a freshly opened document.
   */
  private isEmptyResponse(response: unknown): boolean {
    if (response === null || response === undefined) {
      return true;
    }
    if (Array.isArray(response) && response.length === 0) {
      return true;
    }
    return false;
  }

  private isNoProjectErrorResponse(response: unknown): boolean {
    if (!response) {
      return false;
    }
    const message =
      typeof response === 'string'
        ? response
        : typeof (response as Record<string, unknown>)['message'] === 'string'
          ? ((response as Record<string, unknown>)['message'] as string)
          : '';
    return message.includes('No Project');
  }
}
