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
import { LspServerManager } from './lsp-server-manager.js';
import { sortJsonValue } from './sort-json-value.js';
import { resolveTextDocumentSync } from './types.js';
import type {
  LspConnectionInterface,
  LspServerHandle,
  LspServerConfig,
  LspServiceReinitializeResult,
  LspSkippedServer,
  LspServerStatus,
  LspStatusSnapshot,
  NativeLspServiceOptions,
} from './types.js';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as fs from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
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

class StaleCallHierarchyItemError extends Error {
  constructor(uri?: string) {
    super(
      uri
        ? `Call hierarchy item is stale or has unknown provenance; prepare call hierarchy again at a current location inside ${uri}.`
        : 'Call hierarchy item is stale or has unknown provenance; prepare call hierarchy again.',
    );
  }
}

interface DocumentSnapshot {
  readonly text: string;
  readonly version: number;
}

interface DocumentLifecycle {
  version: number;
  pendingClose?: { error: unknown };
  readFailures?: number;
}

interface CallHierarchyRevision {
  checkpoint(): void;
  sign(item: LspCallHierarchyItem): string | undefined;
}

export class NativeLspService {
  private config: CoreConfig;
  private workspaceContext: WorkspaceContext;
  private fileDiscoveryService: FileDiscoveryService;
  private requireTrustedWorkspace: boolean;
  private workspaceRoot: string;
  private configLoader: LspConfigLoader;
  private serverManager: LspServerManager;
  private normalizer: LspResponseNormalizer;
  private openedDocuments = new Map<string, Map<string, DocumentSnapshot>>();
  private documentLifecycles = new Map<
    string,
    Map<string, DocumentLifecycle>
  >();
  private workspaceSymbolFiles = new WeakMap<LspConnectionInterface, string>();
  private snapshotDigests = new WeakMap<DocumentSnapshot, string>();
  private callHierarchySecrets = new WeakMap<LspConnectionInterface, Buffer>();
  private lastConnections = new Map<string, LspConnectionInterface>();
  // URIs to re-deliver after a connection swap or synchronization failure.
  // openedDocuments selects didOpen/didChange and is wiped on connection changes; this
  // set survives that wipe so a later workspaceDiagnostics can still replay them.
  private replayUris = new Map<string, Set<string>>();
  private reinitializeQueue: Promise<unknown> = Promise.resolve();
  private reinitializeAbortController: AbortController | undefined;
  private stopping = false;

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
    const { admitted, skipped } = this.filterServerConfigs(
      serverConfigs,
      workspaceTrusted,
    );
    debugLogger.info(
      `Discovered ${admitted.length} LSP server config(s): ${formatServerNames(
        admitted.map((config) => config.name),
      )}, skipped=${formatServerNames(skipped.map((server) => server.name))}`,
    );
    this.serverManager.setServerConfigs(admitted);
  }

  async reinitialize(): Promise<LspServiceReinitializeResult> {
    if (this.stopping) {
      throw new Error('LSP reinitialize cancelled');
    }
    const controller = new AbortController();
    const run = async () => {
      this.throwIfReinitializeAborted(controller.signal);
      this.reinitializeAbortController = controller;
      try {
        return await this.doReinitialize(controller.signal);
      } finally {
        if (this.reinitializeAbortController === controller) {
          this.reinitializeAbortController = undefined;
        }
      }
    };
    const next = this.reinitializeQueue.then(run, run);
    this.reinitializeQueue = next.catch(() => undefined);
    return next;
  }

  private throwIfReinitializeAborted(signal: AbortSignal): void {
    if (this.stopping || signal.aborted) {
      throw new Error('LSP reinitialize cancelled');
    }
  }

  private async doReinitialize(
    signal: AbortSignal,
  ): Promise<LspServiceReinitializeResult> {
    this.throwIfReinitializeAborted(signal);
    const workspaceTrusted = this.config.isTrustedFolder();
    debugLogger.info(
      `Reinitializing LSP servers: workspaceRoot=${this.workspaceRoot}, trusted=${workspaceTrusted}`,
    );
    if (this.requireTrustedWorkspace && !workspaceTrusted) {
      this.throwIfReinitializeAborted(signal);
      const removed = Array.from(this.serverManager.getHandles().keys());
      await this.serverManager.stopAll();
      this.throwIfReinitializeAborted(signal);
      this.clearDocumentTrackingForServers(removed);
      const result = {
        reconcile: {
          added: [],
          removed,
          restarted: [],
          unchanged: [],
          failed: [],
        },
        skipped: [],
      };
      debugLogger.info(
        `LSP reinitialize result: added=<none>, removed=${formatServerNames(
          removed,
        )}, restarted=<none>, unchanged=<none>, failed=<none>, skipped=<none>`,
      );
      return result;
    }

    this.throwIfReinitializeAborted(signal);
    const userConfigs = await this.configLoader.loadUserConfigsStrict();
    this.throwIfReinitializeAborted(signal);
    if (!userConfigs.ok) {
      throw userConfigs.error;
    }

    const extensionConfigs = await this.configLoader.loadExtensionConfigs(
      this.getActiveExtensions(),
    );
    this.throwIfReinitializeAborted(signal);
    const serverConfigs = this.configLoader.mergeConfigs(
      [],
      extensionConfigs,
      userConfigs.configs,
    );
    const { admitted, skipped } = this.filterServerConfigs(
      serverConfigs,
      workspaceTrusted,
    );
    this.throwIfReinitializeAborted(signal);
    const reconcile = await this.serverManager.reconcileServerConfigs(admitted);
    this.throwIfReinitializeAborted(signal);
    const restartedOpenDocuments = this.snapshotOpenDocuments(
      reconcile.restarted,
    );
    this.clearDocumentTrackingForServers([
      ...reconcile.removed,
      ...reconcile.restarted,
    ]);
    await this.replayOpenDocuments(
      reconcile.restarted,
      restartedOpenDocuments,
      signal,
    );
    this.throwIfReinitializeAborted(signal);
    debugLogger.info(
      `LSP reinitialize result: added=${formatServerNames(
        reconcile.added,
      )}, removed=${formatServerNames(
        reconcile.removed,
      )}, restarted=${formatServerNames(
        reconcile.restarted,
      )}, unchanged=${formatServerNames(
        reconcile.unchanged,
      )}, failed=${formatServerNames(
        reconcile.failed,
      )}, skipped=${formatServerNames(skipped.map((server) => server.name))}`,
    );
    return { reconcile, skipped };
  }

  private filterServerConfigs(
    configs: LspServerConfig[],
    workspaceTrusted: boolean,
  ): { admitted: LspServerConfig[]; skipped: LspSkippedServer[] } {
    const admitted: LspServerConfig[] = [];
    const skipped: LspSkippedServer[] = [];
    for (const config of configs) {
      if (!workspaceTrusted && config.trustRequired) {
        debugLogger.warn(
          `LSP server ${config.name} requires trusted workspace, skipping`,
        );
        skipped.push({ name: config.name, reason: 'server_trust_required' });
        continue;
      }
      admitted.push(config);
    }
    return { admitted, skipped };
  }

  private clearDocumentTrackingForServers(serverNames: string[]): void {
    for (const name of serverNames) {
      this.openedDocuments.delete(name);
      this.documentLifecycles.delete(name);
      this.lastConnections.delete(name);
      this.replayUris.delete(name);
    }
  }

  /** The tracked set for one server: delivered documents and durable replay obligations. */
  private trackedUrisFor(serverName: string): Set<string> {
    return new Set([
      ...(this.openedDocuments.get(serverName)?.keys() ?? []),
      ...(this.replayUris.get(serverName) ?? []),
    ]);
  }

  /**
   * Drop the delivered snapshot without dropping the obligation to re-deliver it: a
   * connection change wipes openedDocuments, but a later sweep must still know what the
   * new connection never received. Callers keep lastConnections bookkeeping themselves.
   */
  private parkTrackedUris(serverName: string): void {
    const prior = this.openedDocuments.get(serverName);
    if (prior && prior.size > 0) {
      const durable = this.replayUris.get(serverName) ?? new Set<string>();
      for (const tracked of prior.keys()) durable.add(tracked);
      this.replayUris.set(serverName, durable);
    }
    this.openedDocuments.delete(serverName);
    this.documentLifecycles.delete(serverName);
  }

  private snapshotOpenDocuments(
    serverNames: string[],
  ): Map<string, Set<string>> {
    const snapshots = new Map<string, Set<string>>();
    for (const name of serverNames) {
      // A durable-only entry must still be replayed, and its presence must defeat the
      // early return in replayOpenDocuments.
      const uris = this.trackedUrisFor(name);
      if (uris.size > 0) {
        snapshots.set(name, uris);
      }
    }
    return snapshots;
  }

  private async replayOpenDocuments(
    serverNames: string[],
    snapshots: Map<string, Set<string>>,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfReinitializeAborted(signal);
    if (
      serverNames.length === 0 ||
      !serverNames.some((name) => snapshots.has(name))
    ) {
      return;
    }
    const readyHandles = new Map(this.getReadyHandles());
    for (const name of serverNames) {
      this.throwIfReinitializeAborted(signal);
      const handle = readyHandles.get(name);
      const documents = snapshots.get(name);
      if (!handle || !documents) {
        continue;
      }
      let openedAny = false;
      for (const uri of documents) {
        this.throwIfReinitializeAborted(signal);
        try {
          openedAny =
            this.synchronizeDocument(name, handle, uri).sent || openedAny;
        } catch (error) {
          debugLogger.warn(
            `Failed to replay document ${uri} for LSP server ${name}:`,
            error,
          );
        }
      }
      if (openedAny) {
        await this.delay(DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS, signal);
      }
    }
  }

  private getActiveExtensions(): Extension[] {
    // SAFETY: Partial Config fixtures may omit this method; check it before calling.
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
    this.stopping = true;
    this.reinitializeAbortController?.abort();
    await this.serverManager.stopAll();
    this.openedDocuments.clear();
    this.documentLifecycles.clear();
    this.lastConnections.clear();
    this.replayUris.clear();
  }

  /**
   * Get LSP server status
   */
  getStatus(): Map<string, LspServerStatus> {
    return this.serverManager.getStatus();
  }

  /**
   * Get all server handles for status reporting.
   */
  getServerHandles(): ReadonlyMap<string, LspServerHandle> {
    return this.serverManager.getHandles();
  }

  /**
   * Get detailed LSP server status for UI and debug logging.
   */
  getStatusSnapshot(): LspStatusSnapshot {
    const servers = Array.from(this.serverManager.getHandles().entries()).map(
      ([name, handle]) => {
        const error =
          handle.error instanceof Error
            ? handle.error.message
            : handle.error
              ? String(handle.error)
              : undefined;

        return {
          name,
          status: handle.status,
          languages: handle.config.languages,
          transport: handle.config.transport,
          ...(handle.config.command ? { command: handle.config.command } : {}),
          ...(handle.config.args ? { args: handle.config.args } : {}),
          ...(handle.config.rootUri ? { rootUri: handle.config.rootUri } : {}),
          ...(handle.config.workspaceFolder
            ? { workspaceFolder: handle.config.workspaceFolder }
            : {}),
          ...(handle.process?.pid ? { pid: handle.process.pid } : {}),
          ...(handle.warmedUp === undefined
            ? {}
            : { warmedUp: handle.warmedUp }),
          ...(handle.restartAttempts === undefined
            ? {}
            : { restartAttempts: handle.restartAttempts }),
          ...(handle.processDiagnostics?.stderrTail
            ? { stderrTail: handle.processDiagnostics.stderrTail }
            : {}),
          ...(handle.processDiagnostics?.exitCode === undefined
            ? {}
            : { exitCode: handle.processDiagnostics.exitCode }),
          ...(handle.processDiagnostics?.exitSignal === undefined
            ? {}
            : { exitSignal: handle.processDiagnostics.exitSignal }),
          ...(error ? { error } : {}),
        };
      },
    );

    return {
      enabled: true,
      configuredServers: servers.length,
      readyServers: servers.filter((server) => server.status === 'READY')
        .length,
      failedServers: servers.filter((server) => server.status === 'FAILED')
        .length,
      inProgressServers: servers.filter(
        (server) => server.status === 'IN_PROGRESS',
      ).length,
      notStartedServers: servers.filter(
        (server) => server.status === 'NOT_STARTED',
      ).length,
      servers,
    };
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

  /** Synchronize disk text before a query; only a new didOpen needs warmup delay. */
  private async ensureDocumentSynchronized(
    serverName: string,
    handle: LspServerHandle & { connection: LspConnectionInterface },
    uri: string,
  ): Promise<boolean> {
    const { opened: justOpened } = this.synchronizeDocument(
      serverName,
      handle,
      uri,
    );
    if (justOpened) {
      // Preserve the indexing delay for servers that cannot answer immediately.
      await this.delay(DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS);
    }
    return justOpened;
  }

  private synchronizeDocument(
    serverName: string,
    handle: LspServerHandle & { connection: LspConnectionInterface },
    uri: string,
    languageId?: string,
    force = false,
  ): { sent: boolean; opened: boolean } {
    if (!uri.startsWith('file://')) {
      return { sent: false, opened: false };
    }
    if (
      !handle.connection ||
      this.serverManager.getHandles().get(serverName) !== handle
    ) {
      throw new Error(
        `LSP server ${serverName} connection is no longer active`,
      );
    }
    if (this.lastConnections.get(serverName) !== handle.connection) {
      // Preserve the replay obligation across the connection change: openedDocuments
      // must not retain stale entries (the new connection never saw them).
      this.parkTrackedUris(serverName);
      this.lastConnections.set(serverName, handle.connection);
    }

    const documents =
      this.openedDocuments.get(serverName) ??
      new Map<string, DocumentSnapshot>();
    const lifecycles =
      this.documentLifecycles.get(serverName) ??
      new Map<string, DocumentLifecycle>();
    this.documentLifecycles.set(serverName, lifecycles);
    const lifecycle = lifecycles.get(uri);
    if (lifecycle?.pendingClose) {
      try {
        this.closeUnsynchronizableDocument(serverName, handle, uri);
      } catch (error) {
        // Name the close that is actually holding the document shut; rethrowing the
        // retained read error would report a stale ENOENT for a file now present.
        throw new Error(
          `LSP server ${serverName} still cannot close ${uri}; refusing to reopen it (${(error as Error).message})`,
          { cause: error },
        );
      }
    }
    const previous = documents.get(uri);
    const { change, openClose } = resolveTextDocumentSync(
      handle.textDocumentSync,
    );
    if (!previous && !openClose) {
      return { sent: false, opened: false };
    }
    let filePath: string;
    let text: string;
    try {
      filePath = fileURLToPath(uri);
      text = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      const replay = this.replayUris.get(serverName) ?? new Set<string>();
      if (previous || replay.has(uri)) {
        const readFailures = (lifecycle?.readFailures ?? 0) + 1;
        lifecycles.set(uri, {
          version: previous?.version ?? lifecycle?.version ?? 0,
          readFailures,
          ...(previous ? { pendingClose: { error } } : {}),
        });
        if (readFailures < 2) replay.add(uri);
        else replay.delete(uri);
        this.replayUris.set(serverName, replay);
        if (previous) {
          documents.delete(uri);
          this.closeUnsynchronizableDocument(serverName, handle, uri);
        }
      }
      throw error;
    }
    if (lifecycle) delete lifecycle.readFailures;
    if (previous?.text === text && !force) {
      return { sent: false, opened: false };
    }
    const version = (previous?.version ?? lifecycle?.version ?? 0) + 1;
    if (!previous && openClose) {
      handle.connection.send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId:
              languageId ??
              this.resolveLanguageId(filePath, handle) ??
              'plaintext',
            version,
            text,
          },
        },
      });
    } else if (previous) {
      if (change !== 1 && change !== 2) {
        if (previous.text === text) return { sent: false, opened: false };
        const error = new Error(
          `LSP server ${serverName} cannot synchronize changed document ${uri}: textDocumentSync.change is None or absent`,
        );
        lifecycles.set(uri, {
          version: previous.version,
          pendingClose: { error },
        });
        documents.delete(uri);
        const replay = this.replayUris.get(serverName) ?? new Set<string>();
        replay.add(uri);
        this.replayUris.set(serverName, replay);
        this.closeUnsynchronizableDocument(serverName, handle, uri);
        throw error;
      }
      const contentChange: { text: string; range?: LspRange } = { text };
      if (change === 2) {
        // Whole-range replacement still sends all text; use a minimal diff only
        // if large-file measurements justify it. LSP defaults to UTF-16: JS
        // length counts code units, and CRLF is one newline.
        const lines = previous.text.split(/\r\n|\r|\n/);
        contentChange.range = {
          start: { line: 0, character: 0 },
          end: {
            line: lines.length - 1,
            character: lines[lines.length - 1]!.length,
          },
        };
      }
      handle.connection.send({
        jsonrpc: '2.0',
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version },
          contentChanges: [contentChange],
        },
      });
    }
    documents.set(uri, { text, version });
    lifecycles.set(uri, { version });
    this.openedDocuments.set(serverName, documents);
    return { sent: true, opened: !previous && openClose };
  }

  private closeUnsynchronizableDocument(
    serverName: string,
    handle: LspServerHandle & { connection: LspConnectionInterface },
    uri: string,
  ): void {
    const lifecycle = this.documentLifecycles.get(serverName)?.get(uri);
    if (!lifecycle?.pendingClose) return;
    const originalError = lifecycle.pendingClose.error;
    const connection = this.lastConnections.get(serverName);
    if (
      connection !== handle.connection ||
      this.serverManager.getHandles().get(serverName) !== handle
    ) {
      throw originalError;
    }
    try {
      connection.send({
        jsonrpc: '2.0',
        method: 'textDocument/didClose',
        params: { textDocument: { uri } },
      });
    } catch {
      // No duplicate didOpen while a close is known to have failed. A void
      // send is not an acknowledgement; transport failure reporting is separate.
      throw originalError;
    }
    delete lifecycle.pendingClose;
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
    if (
      this.lastConnections.get(serverName) === handle.connection &&
      openedForServer &&
      openedForServer.size > 0
    ) {
      return true;
    }

    const connection = handle.connection;
    let filePath = this.workspaceSymbolFiles.get(connection);
    if (filePath && !this.isUsableWorkspaceSymbolFile(filePath)) {
      this.workspaceSymbolFiles.delete(connection);
      filePath = undefined;
    }
    filePath ??= this.findWorkspaceFileForServer(handle);
    if (!filePath) return false;

    const uri = pathToFileURL(filePath).toString();
    try {
      // Even disk-reading servers need a readable discovery candidate, but
      // ordinary queries need not read text that cannot be delivered.
      fs.accessSync(filePath, fs.constants.R_OK);
      await this.ensureDocumentSynchronized(
        serverName,
        handle as LspServerHandle & { connection: LspConnectionInterface },
        uri,
      );
    } catch (error) {
      debugLogger.warn(
        `LSP workspace symbol warmup skipped for ${uri}:`,
        error,
      );
      // Drop the failed candidate so the next call re-runs discovery instead of
      // retrying a path whose read failed after accessSync passed (EISDIR/ESTALE).
      this.workspaceSymbolFiles.delete(connection);
      return false;
    }
    this.workspaceSymbolFiles.set(connection, filePath);
    await this.delay(DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS);
    // A connection replaced inside the open or warmup delay received nothing, so
    // it must not be reported warm (mirrors the manager's post-delay guard).
    return handle.connection === connection;
  }

  private isUsableWorkspaceSymbolFile(filePath: string): boolean {
    try {
      if (!fs.statSync(filePath).isFile()) return false;
      fs.accessSync(filePath, fs.constants.R_OK);
    } catch {
      return false;
    }
    // A cached candidate must still live under a current workspace root: removing
    // a directory at runtime does not replace the connection, so without this the
    // stale entry would re-open a file inside a root the user just revoked.
    return this.workspaceContext
      .getDirectories()
      .some((root) =>
        filePath.startsWith(root.endsWith(path.sep) ? root : root + path.sep),
      );
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
      } catch {
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
    if (!handle.connection) {
      return;
    }
    const connectedHandle = handle as LspServerHandle & {
      connection: LspConnectionInterface;
    };
    await this.serverManager.warmupTypescriptServer(
      handle,
      (uri, languageId) =>
        this.synchronizeDocument(
          serverName,
          connectedHandle,
          uri,
          languageId,
          force,
        ).sent,
      force,
    );
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

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }
    this.throwIfReinitializeAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('LSP reinitialize cancelled'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
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
        await this.warmupAndTrack(name, handle);
        const justOpened = await this.ensureDocumentSynchronized(
          name,
          handle,
          location.uri,
        );

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
        await this.warmupAndTrack(name, handle);
        const justOpened = await this.ensureDocumentSynchronized(
          name,
          handle,
          location.uri,
        );

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
        await this.warmupAndTrack(name, handle);
        const justOpened = await this.ensureDocumentSynchronized(
          name,
          handle,
          location.uri,
        );

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
        await this.warmupAndTrack(name, handle);
        const justOpened = await this.ensureDocumentSynchronized(
          name,
          handle,
          uri,
        );

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
        await this.warmupAndTrack(name, handle);
        const justOpened = await this.ensureDocumentSynchronized(
          name,
          handle,
          location.uri,
        );

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

  private captureCallHierarchyRevision(
    name: string,
    handle: LspServerHandle & { connection: LspConnectionInterface },
    uri: string,
  ): CallHierarchyRevision {
    const connection = handle.connection;
    const assertActive = () => {
      if (
        !connection ||
        handle.connection !== connection ||
        handle.status !== 'READY' ||
        this.serverManager.getHandles().get(name) !== handle
      ) {
        throw new StaleCallHierarchyItemError();
      }
    };
    assertActive();
    const readText = (target: string): string | undefined => {
      try {
        return fs.readFileSync(fileURLToPath(target), 'utf-8');
      } catch {
        return undefined;
      }
    };
    const snapshots = new Map(
      this.lastConnections.get(name) === connection
        ? this.openedDocuments.get(name)
        : undefined,
    );
    // Observations are shared only within one synchronous checkpoint/batch.
    const observations = new Map<string, string | undefined>();
    if (!snapshots.has(uri) && uri.startsWith('file://')) {
      const text = readText(uri);
      observations.set(uri, text);
      if (text !== undefined)
        snapshots.set(uri, {
          text,
          version:
            this.lastConnections.get(name) === connection
              ? (this.documentLifecycles.get(name)?.get(uri)?.version ?? 0)
              : 0,
        });
    }
    const isFresh = (target: string): boolean => {
      assertActive();
      const snapshot = snapshots.get(target);
      if (!snapshot) return false;
      const current =
        this.lastConnections.get(name) === connection
          ? this.openedDocuments.get(name)?.get(target)
          : undefined;
      const lifecycle =
        this.lastConnections.get(name) === connection
          ? this.documentLifecycles.get(name)?.get(target)
          : undefined;
      if (!observations.has(target)) observations.set(target, readText(target));
      return (
        !lifecycle?.pendingClose &&
        (current?.version ?? lifecycle?.version ?? 0) === snapshot.version &&
        (!current || current.text === snapshot.text) &&
        // A previously delivered snapshot must still be open, not just identical on disk.
        (snapshot.version === 0 || current === snapshot) &&
        observations.get(target) === snapshot.text
      );
    };
    const assertRoot = () => {
      assertActive();
      // Name the root file so a cross-file item whose own file was delivered then
      // closed guides the model to re-prepare there, instead of a generic stale
      // error that only re-syncs the original root and reproduces the same item.
      if (uri.startsWith('file://') && !isFresh(uri))
        throw new StaleCallHierarchyItemError(uri);
    };
    assertRoot();
    let secret = this.callHierarchySecrets.get(connection);
    if (!secret) {
      secret = randomBytes(32);
      this.callHierarchySecrets.set(connection, secret);
    }
    return {
      checkpoint: () => {
        observations.clear();
        assertRoot();
      },
      sign: (item) => {
        assertActive();
        if (!item.uri.startsWith('file://')) return undefined;
        if (!isFresh(item.uri)) {
          if (item.uri === uri) throw new StaleCallHierarchyItemError();
          return undefined;
        }
        const snapshot = snapshots.get(item.uri)!;
        let digest = this.snapshotDigests.get(snapshot);
        if (!digest) {
          digest = createHash('sha256').update(snapshot.text).digest('hex');
          this.snapshotDigests.set(snapshot, digest);
        }
        return createHmac('sha256', secret)
          .update(
            JSON.stringify(
              sortJsonValue([
                name,
                this.normalizer.toCallHierarchyItemParams(item),
                { digest, version: snapshot.version },
              ]),
            ),
          )
          .digest('hex');
      },
    };
  }

  private validateCallHierarchyItem(
    item: LspCallHierarchyItem,
    revision: CallHierarchyRevision,
  ): void {
    if (!item.uri.startsWith('file://')) {
      throw new Error(
        `Call hierarchy item ${item.uri} has no verifiable disk snapshot and cannot be traversed; prepare call hierarchy at a file location instead.`,
      );
    }
    if (
      !item.documentRevision ||
      item.documentRevision !== revision.sign(item)
    ) {
      throw new StaleCallHierarchyItemError(item.uri);
    }
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
      const connection = handle.connection;
      let revision: CallHierarchyRevision | undefined;
      try {
        let originalText: string | undefined;
        if (location.uri.startsWith('file://')) {
          try {
            originalText = fs.readFileSync(
              fileURLToPath(location.uri),
              'utf-8',
            );
          } catch (error) {
            // Shared synchronization owns cleanup of previously opened targets.
            this.synchronizeDocument(name, handle, location.uri);
            throw error;
          }
        }
        const assertOriginal = () => {
          if (
            handle.connection !== connection ||
            handle.status !== 'READY' ||
            this.serverManager.getHandles().get(name) !== handle
          ) {
            throw new StaleCallHierarchyItemError();
          }
          if (originalText !== undefined) {
            let current: string;
            try {
              current = fs.readFileSync(fileURLToPath(location.uri), 'utf-8');
            } catch {
              throw new StaleCallHierarchyItemError();
            }
            if (current !== originalText)
              throw new StaleCallHierarchyItemError();
          }
        };
        await this.warmupAndTrack(name, handle);
        assertOriginal();
        const justOpened = await this.ensureDocumentSynchronized(
          name,
          handle,
          location.uri,
        );
        assertOriginal();
        revision = this.captureCallHierarchyRevision(
          name,
          handle,
          location.uri,
        );
        let response = await connection.request(
          'textDocument/prepareCallHierarchy',
          requestParams,
        );
        revision.checkpoint();
        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          revision.checkpoint();
          response = await connection.request(
            'textDocument/prepareCallHierarchy',
            requestParams,
          );
          revision.checkpoint();
        }
        const normalize = (value: unknown): LspCallHierarchyItem[] => {
          const items: LspCallHierarchyItem[] = [];
          for (const candidate of Array.isArray(value)
            ? value
            : value
              ? [value]
              : []) {
            const item = this.normalizer.normalizeCallHierarchyItem(
              candidate,
              name,
            );
            if (item) items.push(item);
            if (items.length >= limit) break;
          }
          return items.slice(0, limit);
        };
        const items = normalize(response);
        for (const item of items) item.documentRevision = revision.sign(item);
        if (items.length > 0) return items;
      } catch (error) {
        revision?.checkpoint();
        if (error instanceof StaleCallHierarchyItemError) throw error;
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
    if (handles.length !== 1) throw new StaleCallHierarchyItemError();

    for (const [name, handle] of handles) {
      const revision = this.captureCallHierarchyRevision(
        name,
        handle,
        item.uri,
      );
      this.validateCallHierarchyItem(item, revision);
      await this.warmupAndTrack(name, handle);
      revision.checkpoint();
      this.validateCallHierarchyItem(item, revision);
      try {
        const response = await handle.connection.request(
          'callHierarchy/incomingCalls',
          {
            item: this.normalizer.toCallHierarchyItemParams(item),
          },
        );
        revision.checkpoint();
        this.validateCallHierarchyItem(item, revision);
        if (!Array.isArray(response)) {
          continue;
        }
        const calls: LspCallHierarchyIncomingCall[] = [];
        for (const call of response) {
          const normalized = this.normalizer.normalizeIncomingCall(call, name);
          if (normalized) {
            normalized.from.documentRevision = revision.sign(normalized.from);
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
        revision.checkpoint();
        this.validateCallHierarchyItem(item, revision);
        if (error instanceof StaleCallHierarchyItemError) throw error;
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
    if (handles.length !== 1) throw new StaleCallHierarchyItemError();

    for (const [name, handle] of handles) {
      const revision = this.captureCallHierarchyRevision(
        name,
        handle,
        item.uri,
      );
      this.validateCallHierarchyItem(item, revision);
      await this.warmupAndTrack(name, handle);
      revision.checkpoint();
      this.validateCallHierarchyItem(item, revision);
      try {
        const response = await handle.connection.request(
          'callHierarchy/outgoingCalls',
          {
            item: this.normalizer.toCallHierarchyItemParams(item),
          },
        );
        revision.checkpoint();
        this.validateCallHierarchyItem(item, revision);
        if (!Array.isArray(response)) {
          continue;
        }
        const calls: LspCallHierarchyOutgoingCall[] = [];
        for (const call of response) {
          const normalized = this.normalizer.normalizeOutgoingCall(call, name);
          if (normalized) {
            normalized.to.documentRevision = revision.sign(normalized.to);
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
        revision.checkpoint();
        this.validateCallHierarchyItem(item, revision);
        if (error instanceof StaleCallHierarchyItemError) throw error;
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
      // A sync failure must reject, not report incomplete diagnostics as clean.
      await this.warmupAndTrack(name, handle);
      await this.ensureDocumentSynchronized(name, handle, uri);

      try {
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
      const connection = handle.connection;
      // Capture the tracked set before warmup: for a TypeScript server the warmup's
      // own connection-change reset would otherwise wipe it first, including the
      // durable URIs parked by a swap triggered by an earlier query.
      const trackedUris = [...this.trackedUrisFor(name)];
      await this.warmupAndTrack(name, handle);
      // Querying a connection that never received the replayed documents can
      // return empty diagnostics, which the tool would display as clean.
      if (
        handle.connection !== connection ||
        handle.status !== 'READY' ||
        this.serverManager.getHandles().get(name) !== handle
      ) {
        throw new Error(`LSP server ${name} connection is no longer active`);
      }
      if (this.lastConnections.get(name) !== connection) {
        this.parkTrackedUris(name);
        this.lastConnections.set(name, connection);
      }
      for (const [uri, lifecycle] of this.documentLifecycles.get(name) ?? []) {
        if (lifecycle.pendingClose) {
          try {
            this.closeUnsynchronizableDocument(name, handle, uri);
          } catch (error) {
            // Name the close that is actually holding the document shut; rethrowing
            // the retained read error reports a stale ENOENT for a file now present.
            throw new Error(
              `LSP server ${name} still cannot close ${uri}; refusing to reopen it (${(error as Error).message})`,
              { cause: error },
            );
          }
        }
      }
      let openedAny = false;
      let syncError: unknown;
      for (const uri of trackedUris) {
        // Isolate per URI so one unreadable tracked file still lets the survivors
        // re-deliver before the call rejects; a survivor stranded behind a throw
        // would leave the connection queried with zero documents and report clean.
        // The shared helper bounds consecutive read failures; a URI whose send
        // threw stays parked for the next sweep.
        try {
          openedAny =
            this.synchronizeDocument(name, handle, uri).opened || openedAny;
          this.replayUris.get(name)?.delete(uri);
        } catch (error) {
          syncError ??= error;
        }
      }
      // A sync failure must reject, not report incomplete diagnostics as clean.
      if (syncError) throw syncError;
      if (openedAny) await this.delay(DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS);
      if (
        handle.connection !== connection ||
        handle.status !== 'READY' ||
        this.serverManager.getHandles().get(name) !== handle
      ) {
        throw new Error(`LSP server ${name} connection is no longer active`);
      }

      try {
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
        await this.warmupAndTrack(name, handle);
        await this.ensureDocumentSynchronized(name, handle, uri);

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

    // Concurrency: this is an async read-modify-write (readFile → splice →
    // access(W_OK) → atomicWriteFile) with await points between read and
    // write. atomicWriteFile keeps the file from being torn, but does NOT
    // serialize writers — two overlapping applyTextEdits calls for the SAME
    // path can both read the same base content and the second rename clobbers
    // the first (lost update). Latent today: applyWorkspaceEdit has no
    // production caller and no workspace/applyEdit handler is wired. Before
    // wiring one, serialize per resolved filePath (see jsonl-utils getFileLock).

    // Read the current file content. Only treat ENOENT as "new file"; any
    // other read failure (EACCES on a read-protected file, EISDIR, etc.)
    // must propagate — otherwise the atomic rename below would silently
    // replace the unreadable target with edits applied to an empty buffer.
    let content: string;
    try {
      content = await fsp.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
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

    // Honor file-level write permissions. Atomic rename (tmp + rename)
    // would otherwise bypass a chmod 0444 lock because rename only needs
    // parent-directory write access. ENOENT is fine — LSP may be creating
    // the file via edits.
    try {
      await fsp.access(filePath, fs.constants.W_OK);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
    }

    // Atomic write so a crash mid-edit can't leave the user file half-written.
    // Async variant avoids blocking the event loop on the LSP edit hot path
    // (sync renameWithRetry can stall up to 350ms under Atomics.wait backoff).
    await atomicWriteFile(filePath, lines.join('\n'), { encoding: 'utf-8' });
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

function formatServerNames(names: readonly string[]): string {
  return names.length === 0 ? '<none>' : names.join(',');
}
