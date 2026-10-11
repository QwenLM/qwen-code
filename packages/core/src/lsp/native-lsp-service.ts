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
import { LspJsonRpcError } from './LspConnectionFactory.js';
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
import { isSubpaths } from '../utils/paths.js';
import {
  getLspServerExtensions,
  getLspWorkspaceRoots,
  isLspDocumentApplicable,
} from './file-routing.js';
import { resolveWorkspacePath } from '../utils/workspaceContext.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import { globSync } from 'glob';

const debugLogger = createDebugLogger('LSP');

/**
 * Render one server a diagnostics query could not use, by name, state and the
 * cause the manager recorded. Every reachable FAILED transition assigns
 * `handle.error` in the same block that fails the handle, so the recorded
 * error is the whole contract: a FAILED handle's stderr tail is vendor
 * logging, not a cause, and is never rendered as one. The cause goes through
 * `getErrorMessage` like the failures arm it is joined with, then is bounded
 * to its last non-empty line (a stack-packed message must not flood the tool
 * result verbatim).
 */
function describeLspServerState(name: string, handle: LspServerHandle): string {
  if (handle.status === 'READY' && !handle.connection) {
    return `${name} has no active connection`;
  }
  // The recorded cause goes through `getErrorMessage` like the failures arm it
  // is joined with; the last-line bound below then keeps a stack-packed
  // message from flooding the tool result verbatim.
  const raw = handle.error ? getErrorMessage(handle.error) : undefined;
  const lines = raw
    ?.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const reason =
    lines && lines.length > 0
      ? lines[lines.length - 1]!.slice(-200)
      : undefined;
  const state = handle.status.toLowerCase().replace(/_/g, ' ');
  return `${name} is ${state}${reason ? ` (${reason})` : ''}`;
}

/**
 * Aggregate budget for the `No LSP diagnostics could be retrieved (…)`
 * detail: per-entry caps (`getErrorMessage`, `describeLspServerState`) bound
 * each entry, but the join grows linearly with the number of unusable
 * servers and would otherwise break the message-level bound the tool tests
 * assert.
 */
const MAX_DIAGNOSTIC_REJECTION_DETAIL_LENGTH = 1000;

/**
 * Join rejection entries under the aggregate budget without dropping a server
 * name: the join pays `'; '` separators and the shrink ellipsis, so the
 * per-entry share is what remains after both. When the separators alone
 * exceed the budget (hundreds of servers) a final hard cut keeps the ceiling
 * absolute.
 */
function boundedRejectionDetail(entries: string[]): string {
  const detail = entries.join('; ');
  if (detail.length <= MAX_DIAGNOSTIC_REJECTION_DETAIL_LENGTH) {
    return detail;
  }
  const share = Math.max(
    1,
    Math.floor(
      (MAX_DIAGNOSTIC_REJECTION_DETAIL_LENGTH - 2 * (entries.length - 1)) /
        entries.length,
    ) - 1,
  );
  const shrunk = entries
    .map((entry) =>
      entry.length > share ? `${entry.slice(0, share)}…` : entry,
    )
    .join('; ');
  return shrunk.length > MAX_DIAGNOSTIC_REJECTION_DETAIL_LENGTH
    ? `${shrunk.slice(0, MAX_DIAGNOSTIC_REJECTION_DETAIL_LENGTH - 1)}…`
    : shrunk;
}

/**
 * Build the rejection for a diagnostics query that retrieved nothing while
 * something was wrong: a selected server whose pull failed or answered
 * unusably, or a configured server that was never queried because it is not
 * ready. Whatever was retrieved is always returned instead, so a partial
 * success survives and only an unbacked clean answer is refused.
 */
function nothingRetrievedForDiagnostics(
  failures: Array<{ name: string; error: unknown }>,
  skipped: string[],
): Error {
  const entries = [
    ...failures.map(({ name, error }) => `${name}: ${getErrorMessage(error)}`),
    ...skipped,
  ];
  return new Error(
    `No LSP diagnostics could be retrieved (${boundedRejectionDetail(entries)})`,
  );
}

/** JSON-RPC "method not found": the server does not implement the request. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

/**
 * Whether a diagnostics pull failed because the server does not implement
 * pull diagnostics at all. The reply code is the only signal that works:
 * real servers that serve `textDocument/diagnostic` (pyright, gopls) do not
 * advertise `diagnosticProvider` for it, while servers that do not serve it
 * (typescript-language-server, clangd) answer `-32601` every time. Such a
 * server says nothing about the queried file, so it neither vetoes another
 * server's answer nor backs a clean one — and it is still named when nothing
 * else answered, with wording that says what it actually did. Every other
 * failure (a crash, a timeout, a malformed report, `-32600`) keeps vetoing.
 */
function pullUnsupported(error: unknown): boolean {
  return (
    error instanceof LspJsonRpcError && error.code === JSON_RPC_METHOD_NOT_FOUND
  );
}

/** Reason recorded for a server that does not implement the pull at all. */
const PULL_UNSUPPORTED_REASON = 'does not support pull diagnostics';

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

/**
 * Diagnostics-local aliases for language IDs that do not name their
 * extension (`rust` serves `.rs`, `yaml` serves `.yml`): the `?? [id]`
 * fallback would otherwise guess the ID as the extension and an ownership
 * check misreads the server. Kept OUT of LANGUAGE_ID_TO_EXTENSIONS, which
 * also feeds the warmup-file chooser — these rows exist only for veto
 * decisions. A row must still carry its own ID when that ID is in
 * DIAGNOSTIC_LANGUAGE_IDS: the row shadows the `?? [id]` fallback, so
 * dropping the ID would leave the server with nothing attributable.
 */
const DIAGNOSTIC_LANGUAGE_ALIASES: Record<string, string[]> = {
  rust: ['rs', 'rust'],
  yaml: ['yml', 'yaml'],
  markdown: ['md', 'markdown'],
  kotlin: ['kt', 'kts'],
  elixir: ['ex', 'exs'],
  erlang: ['erl', 'hrl'],
  haskell: ['hs'],
  ocaml: ['ml', 'mli'],
  perl: ['pl', 'pm'],
  terraform: ['tf'],
  fortran: ['f', 'for', 'f90', 'f95'],
  'objective-c': ['m', 'mm'],
  objectivec: ['m', 'mm'],
  shellscript: ['sh', 'bash'],
  protobuf: ['proto'],
  xml: ['xml'],
  vue: ['vue'],
  svelte: ['svelte'],
  lua: ['lua'],
  r: ['r'],
  dart: ['dart'],
  swift: ['swift'],
  scala: ['scala', 'sc'],
  groovy: ['groovy', 'gvy'],
  clojure: ['clj', 'cljs'],
  zig: ['zig'],
};

/**
 * Extensions positively attributable to a language through the mapping above.
 * A declared language ID is not always an extension (`rust` serves `.rs`,
 * `yaml` serves `.yml`), which is what the alias table below carries.
 */
const KNOWN_DIAGNOSTIC_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.values(LANGUAGE_ID_TO_EXTENSIONS).flat(),
);

/**
 * Language IDs the table above omits because the ID already names the
 * language, so `?? [id]` is not a guess for them: `cpp` serves `.cpp`, `go`
 * serves `.go`. A `.lsp.json` key in this set declares a real language, which
 * is what makes a veto decision possible; a key that is a server name
 * (`pyright`, `remote-lsp`) is in neither set and still proves nothing. The
 * table itself must not be widened to carry these: the set derived from it
 * also gates which queried files get a relevance decision at all.
 */
const DIAGNOSTIC_LANGUAGE_IDS: ReadonlySet<string> = new Set([
  'c',
  'cpp',
  'css',
  'dockerfile',
  'go',
  'html',
  'java',
  'json',
  'markdown',
  'php',
  'rust',
  'swift',
  'yaml',
]);

/**
 * Every extension the diagnostics tables can place: the mapping above, the
 * alias rows, and the identity-mapped language IDs. An extension outside this
 * set (`h`, `mts`, `ps1`, an extensionless file) cannot be attributed to any
 * language at all, so neither an answer about it can be required to be
 * positively owned nor a server excused for it — those files are undecidable
 * and fall back to the relevance ledger, as they did before ownership became a
 * requirement. Only a placeable extension can carry either decision.
 */
const ATTRIBUTABLE_DIAGNOSTIC_EXTENSIONS: ReadonlySet<string> = new Set([
  ...KNOWN_DIAGNOSTIC_EXTENSIONS,
  ...Object.values(DIAGNOSTIC_LANGUAGE_ALIASES).flat(),
  ...DIAGNOSTIC_LANGUAGE_IDS,
]);

/**
 * Language IDs one JS/TS-family server answers for. `warmupTypescriptServer`
 * already relies on this: it opens a `.js`/`.jsx` file with languageId
 * `javascript`/`javascriptreact` against a server it recognizes by a
 * `typescript` name or command. Extensions are derived from the table above so
 * the two cannot drift; the table itself stays untouched because
 * `getWorkspaceSymbolExtensions` and the warmup chooser also read it.
 */
const JS_TS_FAMILY_LANGUAGE_IDS = [
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
];
const JS_TS_FAMILY_EXTENSIONS = JS_TS_FAMILY_LANGUAGE_IDS.flatMap(
  (id) => LANGUAGE_ID_TO_EXTENSIONS[id] ?? [],
);

/**
 * Declarations that cover the whole family, both for relevance and for
 * ownership: a `typescript` server answers for `.js`/`.jsx` too, while a
 * `javascript`-only declaration serves neither `.ts` nor `.tsx`, so widening
 * the other direction would hold that server relevant to a file it can never
 * own — and its absence would veto a healthy sibling's answer for it.
 */
const JS_FAMILY_WIDENING_LANGUAGE_IDS = ['typescript', 'typescriptreact'];

const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
];

const MIN_WORKSPACE_RESULT_SCAN_LIMIT = 1000;
const MIN_WORKSPACE_DIAGNOSTIC_REPORT_SCAN_LIMIT = 100000;

class WorkspaceResultScanLimitError extends Error {
  constructor(
    limit: number,
    advice = 'narrow the query or select a server with serverName',
  ) {
    super(`LSP workspace result scan limit (${limit}) exceeded; ${advice}`);
  }
}

class LspDocumentScopeError extends Error {}

class InvalidDiagnosticReportError extends Error {}

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
  private callHierarchyGenerations = new WeakMap<
    LspConnectionInterface,
    Map<string, number>
  >();
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

  /** Delivered documents, replay obligations and unfinished closes. */
  private trackedUrisFor(serverName: string): Set<string> {
    return new Set([
      ...(this.openedDocuments.get(serverName)?.keys() ?? []),
      ...(this.replayUris.get(serverName) ?? []),
      ...[...(this.documentLifecycles.get(serverName) ?? [])].flatMap(
        ([uri, lifecycle]) => (lifecycle.pendingClose ? [uri] : []),
      ),
    ]);
  }

  /**
   * Drop the delivered snapshot without dropping the obligation to re-deliver it: a
   * connection change wipes openedDocuments, but a later sweep must still know what the
   * new connection never received. Callers keep lastConnections bookkeeping themselves.
   */
  private parkTrackedUris(serverName: string): void {
    const durable = this.trackedUrisFor(serverName);
    if (durable.size > 0) this.replayUris.set(serverName, durable);
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
          const synchronized = this.synchronizeDocument(name, handle, uri);
          openedAny = synchronized.sent || openedAny;
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

  private canonicalDocumentUri(uri: string): string {
    if (!/^file:/i.test(uri)) return uri;
    try {
      return pathToFileURL(fileURLToPath(uri)).toString();
    } catch {
      // Preserve malformed input for the existing scope refusal.
      return uri;
    }
  }

  /**
   * Get ready server handles filtered by optional server name.
   * Each handle is guaranteed to have a valid connection.
   *
   * @param serverName - Explicit override of language and server root, not workspace containment
   * @param uri - Document URI for automatic file-scoped routing
   * @returns Array of [serverName, handle] tuples with active connections
   */
  private getReadyHandles(
    serverName?: string,
    uri?: string,
    requireMatch = true,
  ): Array<[string, LspServerHandle & { connection: LspConnectionInterface }]> {
    const configured = this.serverManager.getHandles();
    const handles = Array.from(configured.entries()).filter(
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
    if (!uri) return handles;

    const directories = /^file:/i.test(uri)
      ? this.workspaceContext.getDirectories()
      : [];
    const resolvedFilePath = /^file:/i.test(uri)
      ? this.resolveWorkspaceDocument(uri, directories)
      : undefined;
    if (requireMatch) this.assertServersAvailable(handles.length, serverName);
    if (!resolvedFilePath) {
      throw new Error(
        `LSP document ${uri} is not a file URI; only file: documents can be queried`,
      );
    }
    if (serverName) return handles;

    const primaryRoot = resolveWorkspacePath(this.workspaceRoot);
    const scoped = handles.filter(([, handle]) => {
      const roots = getLspWorkspaceRoots(
        handle.config,
        primaryRoot,
        directories,
      );
      return roots === directories || isSubpaths(roots, resolvedFilePath);
    });
    if (scoped.length === 0) {
      if (!requireMatch) return [];
      const message = `Document ${uri} is outside every ready LSP server's workspaceFolder or its root is unusable; retry with serverName to bypass the workspaceFolder filter (not workspace containment)`;
      debugLogger.warn(message);
      throw new Error(message);
    }
    const applicable = scoped.filter(([, handle]) =>
      isLspDocumentApplicable(handle.config, fileURLToPath(uri)),
    );
    if (applicable.length === 0) {
      if (!requireMatch) return [];
      const message = `No ready LSP server matches document ${uri}; check extensionToLanguage and the configured languages`;
      debugLogger.warn(message);
      throw new Error(message);
    }
    return applicable;
  }

  private assertServersAvailable(count: number, serverName?: string): void {
    if (count > 0) return;
    const configured = this.serverManager.getHandles();
    const message = serverName
      ? `LSP server ${serverName} is ${configured.has(serverName) ? 'not ready' : 'not configured'}; check /lsp`
      : configured.size === 0
        ? 'No LSP servers are configured; configure .lsp.json and check /lsp'
        : 'No LSP servers are ready; check /lsp';
    debugLogger.warn(message);
    throw new Error(message);
  }

  private isCurrentWorkspaceDocument(
    uri: string,
    directories: readonly string[],
    cache: Map<string, boolean>,
  ): boolean | undefined {
    if (typeof uri !== 'string' || path.isAbsolute(uri)) return undefined;
    const cached = cache.get(uri);
    if (cached !== undefined) return cached;
    let current = false;
    let filePath: string | undefined;
    try {
      const url = new URL(uri);
      current = url.protocol !== 'file:';
      if (!current) filePath = fileURLToPath(url);
    } catch {
      return undefined;
    }
    if (filePath !== undefined) {
      try {
        current = isSubpaths(directories, resolveWorkspacePath(filePath));
      } catch (error) {
        throw new LspDocumentScopeError(
          `Cannot resolve LSP document ${uri}: ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
    }
    cache.set(uri, current);
    if (!current) this.deferWorkspaceDocument(uri);
    return current;
  }

  private deferWorkspaceDocument(uri: string, cause?: unknown): void {
    uri = this.canonicalDocumentUri(uri);
    for (const connection of new Set(this.lastConnections.values())) {
      const generations = this.callHierarchyGenerations.get(connection);
      const generation = generations?.get(uri);
      if (generations && generation !== undefined) {
        generations.set(uri, generation + 1);
      }
    }
    // Losing scope does not close the peer's buffer; defer closure until scope returns.
    for (const [serverName, documents] of this.openedDocuments) {
      const previous = documents.get(uri);
      if (previous) {
        this.documentLifecycles.get(serverName)?.set(uri, {
          version: previous.version,
          pendingClose: {
            error: new Error('Document must be closed before reopening', {
              cause,
            }),
          },
        });
        documents.delete(uri);
      }
    }
  }

  private resolveWorkspaceDocument(
    uri: string,
    directories: readonly string[],
  ): string {
    let resolved: string;
    try {
      resolved = resolveWorkspacePath(fileURLToPath(uri));
    } catch (error) {
      const message = `Cannot resolve LSP document ${uri} inside the current workspace directories`;
      debugLogger.warn(message, error);
      const refusal = new LspDocumentScopeError(message, { cause: error });
      this.deferWorkspaceDocument(uri, refusal);
      throw refusal;
    }
    if (!isSubpaths(directories, resolved)) {
      const message = `${uri} is outside the current workspace directories; add a directory with /directory add before querying`;
      debugLogger.warn(message);
      const refusal = new LspDocumentScopeError(message);
      this.deferWorkspaceDocument(uri, refusal);
      throw refusal;
    }
    return resolved;
  }

  private async requestDocument(
    connection: LspConnectionInterface,
    method: string,
    params: { textDocument: { uri: string }; [key: string]: unknown },
  ): Promise<unknown> {
    this.resolveWorkspaceDocument(
      params.textDocument.uri,
      this.workspaceContext.getDirectories(),
    );
    try {
      return await connection.request(method, params);
    } finally {
      this.resolveWorkspaceDocument(
        params.textDocument.uri,
        this.workspaceContext.getDirectories(),
      );
    }
  }

  /**
   * Ready handles for a diagnostics query. Rejects outright when nothing is
   * ready — no matching server, a server that failed or never started, a
   * server still starting up — because an empty ready set would otherwise be
   * reported as a clean result. For a document query (`uri` given) the
   * rejection names only servers the queried file does not provably exclude;
   * when every configured server is irrelevant for the file the rejection
   * says so instead of blaming a server that could never own it. Servers
   * left out of a non-empty ready set are accounted for at the decision
   * point by `unreachableDiagnosticServers`, which re-reads live handle
   * state: a snapshot taken here would be stale by the time the query loop
   * finishes. `getReadyHandles` itself must keep returning an empty array
   * for the not-ready case: `replayOpenDocuments` skips handles missing from
   * its map rather than rejecting.
   */
  private getDiagnosticHandles(
    serverName?: string,
    uri?: string,
  ): Array<[string, LspServerHandle & { connection: LspConnectionInterface }]> {
    const handles = this.getReadyHandles(serverName, uri, false);
    if (handles.length > 0) return handles;
    const configured = Array.from(this.serverManager.getHandles()).filter(
      ([name]) => !serverName || name === serverName,
    );
    const extension =
      uri && !serverName ? this.diagnosticFileExtension(uri) : undefined;
    const skipped = configured
      .filter(
        ([, handle]) =>
          !(handle.status === 'READY' && handle.connection) &&
          !this.serverDeclaredIrrelevant(handle, extension),
      )
      .map(([name, handle]) => describeLspServerState(name, handle));
    if (skipped.length > 0) {
      throw new Error(
        `No LSP server is ready to provide diagnostics (${boundedRejectionDetail(skipped)})`,
      );
    }
    if (uri && configured.length > 0) {
      try {
        return this.getReadyHandles(serverName, uri);
      } catch (error) {
        if (error instanceof LspDocumentScopeError) throw error;
        throw new Error(
          `${getErrorMessage(error)}; no configured server covers the queried file`,
          { cause: error },
        );
      }
    }
    throw new Error(
      serverName
        ? `No LSP server named ${serverName} is configured or running`
        : 'No LSP servers are configured or running',
    );
  }

  /**
   * Ready handles a diagnostics query has not asked yet, read from live state
   * so a server that finished starting while the query was in flight is asked
   * rather than reported as unreachable. Uses the same relevance test as
   * `unreachableDiagnosticServers`, so a server the queried file provably
   * excludes is neither asked nor named.
   */
  private newlyReadyDiagnosticHandles(
    asked: ReadonlyArray<readonly [string, unknown]>,
    serverName?: string,
    uri?: string,
  ): Array<[string, LspServerHandle & { connection: LspConnectionInterface }]> {
    const extension =
      uri && !serverName ? this.diagnosticFileExtension(uri) : undefined;
    return this.getReadyHandles(serverName, uri, false).filter(
      ([name, handle]) =>
        !asked.some(([askedName]) => askedName === name) &&
        !this.serverDeclaredIrrelevant(handle, extension),
    );
  }

  /**
   * Lowercased extension of the queried file URI, or undefined when the URI
   * is unparseable or the file has no extension: an extensionless file
   * cannot prove any server irrelevant, so the veto decision fails closed.
   */
  private diagnosticFileExtension(uri: string): string | undefined {
    try {
      return (
        path.extname(fileURLToPath(uri)).slice(1).toLowerCase() || undefined
      );
    } catch {
      // An unparseable URI cannot prove any server irrelevant; keep the veto.
      return undefined;
    }
  }

  /**
   * Every extension a server declares it can serve: the explicit
   * `extensionToLanguage` keys unioned with the extensions its language IDs
   * imply. Unlike `getWorkspaceSymbolExtensions` — a warmup-file chooser
   * that deliberately prefers the explicit mapping — a veto decision must
   * not let a partial user mapping (e.g. only `.tsx`) hide a declared
   * language (`typescript` still owns `.ts`). The JS/TS family widens in one
   * direction, exactly as `declaredOwnerExtensions` does: a `typescript`
   * declaration covers the family's JavaScript side, while a
   * `javascript`-only declaration serves no `.ts` at all, so it must not be
   * held relevant to a file it can never own — its absence would otherwise
   * veto a healthy sibling's answer for that file.
   */
  private declaredDiagnosticExtensions(handle: LspServerHandle): Set<string> {
    const owned = new Set(this.getWorkspaceSymbolExtensions(handle));
    // The mapping's VALUES are language ids: a partial user mapping (only
    // `.tsx` for a `typescript` server) must not hide the declared
    // language's other extensions.
    const languageIds = [...handle.config.languages];
    const extMapping = handle.config.extensionToLanguage;
    if (extMapping) {
      for (const value of Object.values(extMapping)) languageIds.push(value);
    }
    for (const language of languageIds) {
      // `.lsp.json` keys reach `languages` unnormalized, while every extension
      // this set is compared against is lowercase.
      const id = language.toLowerCase();
      if (JS_FAMILY_WIDENING_LANGUAGE_IDS.includes(id)) {
        for (const ext of JS_TS_FAMILY_EXTENSIONS) {
          owned.add(ext);
        }
        continue;
      }
      for (const ext of DIAGNOSTIC_LANGUAGE_ALIASES[id] ??
        LANGUAGE_ID_TO_EXTENSIONS[id] ?? [id]) {
        owned.add(ext);
      }
    }
    return owned;
  }

  /**
   * The owner test for a veto: stricter than relevance — no JS/TS family
   * widening, so a javascript-only server does not own `.ts` (a family
   * widened set would let its empty answer back a refusal it knows nothing
   * about), and the diagnostics-local alias map so `rust` owns `.rs`.
   * Positive answers pass `widenTypescriptFamily` so a TypeScript server can
   * back the JavaScript side of the family without giving JavaScript-only
   * servers the reverse ownership.
   */
  private declaredOwnerExtensions(
    handle: LspServerHandle,
    widenTypescriptFamily = false,
  ): Set<string> {
    const owned = new Set(this.getWorkspaceSymbolExtensions(handle));
    const ids = [...handle.config.languages];
    const extMapping = handle.config.extensionToLanguage;
    if (extMapping) {
      for (const value of Object.values(extMapping)) ids.push(value);
    }
    for (const language of ids) {
      const id = language.toLowerCase();
      if (
        widenTypescriptFamily &&
        JS_FAMILY_WIDENING_LANGUAGE_IDS.includes(id)
      ) {
        for (const ext of JS_TS_FAMILY_EXTENSIONS) {
          owned.add(ext);
        }
        continue;
      }
      for (const ext of DIAGNOSTIC_LANGUAGE_ALIASES[id] ??
        LANGUAGE_ID_TO_EXTENSIONS[id] ?? [id]) {
        owned.add(ext);
      }
    }
    return owned;
  }

  /**
   * Whether the queried file's extension positively proves this server
   * cannot own the file. Fails closed on every uncertainty: an undefined
   * extension (extensionless or unparseable file), an extension no diagnostics
   * table can place (`h`, `mts`, …), or a server whose declared set holds no
   * attributable extension can prove nothing, so the veto stands. Only a
   * positively attributable extension the server does not declare excuses it —
   * `python`'s `py` vs a queried `.ts` is the canonical case, and `go`'s
   * identity-mapped `.go` is the one that keeps a downed python server from
   * vetoing a clean gopls answer.
   */
  private serverDeclaredIrrelevant(
    handle: LspServerHandle,
    extension: string | undefined,
  ): boolean {
    if (
      extension === undefined ||
      !ATTRIBUTABLE_DIAGNOSTIC_EXTENSIONS.has(extension)
    ) {
      return false;
    }
    const owned = this.declaredDiagnosticExtensions(handle);
    // `.lsp.json` keys reach `languages` unvalidated, so a key that is a
    // server name (`pyright`, `remote-lsp`) seeds `owned` with the guess
    // `[id]`. A set made only of such guesses proves nothing about the
    // queried file — reading it as proof both excuses a downed server from
    // the veto and strips a ready one of its backing. An ID that names a
    // real language (`cpp`, `go`) is not such a guess, even though the
    // mapping table omits it, and neither is an alias row's extension
    // (`kt`, `yml`, `hs`): the row is a real language fact the mapping and
    // the ID list both omit, which is why all three sources answer here.
    const attributed = [...owned].some((ext) =>
      ATTRIBUTABLE_DIAGNOSTIC_EXTENSIONS.has(ext),
    );
    return attributed && !owned.has(extension);
  }

  /**
   * Rendered states of the servers a diagnostics query did not reach and
   * still cannot reach, recomputed from live handle state at the decision
   * point. The query loop re-reads that state after every pull and asks
   * whatever became ready, so a server that finished starting mid-query is
   * normally queried instead of being named here; only a server whose
   * readiness becomes observable after the loop's last read can still arrive
   * as ready-and-unasked, and it is no clean bill either — it received zero
   * requests, so its slice of the answer is as unbacked as any other
   * unreachable server's, and it is named with wording that cannot be
   * mistaken for an answer. For a document query (`uri` given), only servers
   * the file does not provably exclude can veto — a server that could never
   * own the file must not discard another server's authoritative empty
   * report. For a workspace query every unreachable server vetoes, since the
   * report would otherwise certify that server's slice of the workspace as
   * clean.
   */
  private unreachableDiagnosticServers(
    queried: ReadonlyArray<readonly [string, unknown]>,
    serverName: string | undefined,
    uri?: string,
  ): string[] {
    const extension =
      uri && !serverName ? this.diagnosticFileExtension(uri) : undefined;
    const routed = new Set(
      this.getReadyHandles(serverName, uri, false).map(([name]) => name),
    );
    return Array.from(this.serverManager.getHandles())
      .filter(
        ([name, handle]) =>
          (!serverName || name === serverName) &&
          !queried.some(([queriedName]) => queriedName === name) &&
          !(
            handle.status === 'READY' &&
            handle.connection &&
            !routed.has(name)
          ) &&
          !this.serverDeclaredIrrelevant(handle, extension),
      )
      .map(([name, handle]) =>
        handle.status === 'READY' && handle.connection !== undefined
          ? `${name} became ready during the query and was not asked`
          : describeLspServerState(name, handle),
      );
  }

  /** Synchronize disk text before a query; only a new didOpen needs warmup delay. */
  private async ensureDocumentSynchronized(
    serverName: string,
    handle: LspServerHandle & { connection: LspConnectionInterface },
    uri: string,
  ): Promise<boolean> {
    const { opened: justOpened, deferred } = this.synchronizeDocument(
      serverName,
      handle,
      uri,
    );
    if (deferred) {
      throw new LspDocumentScopeError(
        `Cannot synchronize LSP document ${uri} inside the current workspace directories`,
      );
    }
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
  ): { sent: boolean; opened: boolean; deferred?: boolean } {
    uri = this.canonicalDocumentUri(uri);
    if (!/^file:/i.test(uri)) {
      return { sent: false, opened: false };
    }
    try {
      this.resolveWorkspaceDocument(
        uri,
        this.workspaceContext.getDirectories(),
      );
    } catch (error) {
      if (
        !(error instanceof LspDocumentScopeError) ||
        error.cause !== undefined
      ) {
        throw error;
      }
      return { sent: false, opened: false, deferred: true };
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
      [...openedForServer.keys()].some((uri) =>
        this.isUsableWorkspaceSymbolFile(fileURLToPath(uri), handle),
      )
    ) {
      return true;
    }

    const connection = handle.connection;
    let filePath = this.workspaceSymbolFiles.get(connection);
    if (filePath && !this.isUsableWorkspaceSymbolFile(filePath, handle)) {
      this.workspaceSymbolFiles.delete(connection);
      filePath = undefined;
    }
    filePath ??= this.findWorkspaceFileForServer(handle);
    if (!filePath) return false;

    const uri = pathToFileURL(filePath).toString();
    try {
      // Even disk-reading servers need a readable discovery candidate, but
      // ordinary queries need not read text that cannot be delivered.
      if (!this.isUsableWorkspaceSymbolFile(filePath, handle)) {
        throw new Error(
          'Workspace symbol warmup candidate is no longer usable.',
        );
      }
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

  private isUsableWorkspaceSymbolFile(
    filePath: string,
    handle: LspServerHandle,
  ): boolean {
    try {
      if (!fs.statSync(filePath).isFile()) return false;
      fs.accessSync(filePath, fs.constants.R_OK);
      // Removing a directory does not replace the connection, so cached candidates
      // must be revalidated against current workspace and server roots.
      return isSubpaths(
        getLspWorkspaceRoots(
          handle.config,
          resolveWorkspacePath(this.workspaceRoot),
          this.workspaceContext.getDirectories(),
        ),
        resolveWorkspacePath(filePath),
      );
    } catch {
      return false;
    }
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
    const roots = getLspWorkspaceRoots(
      handle.config,
      resolveWorkspacePath(this.workspaceRoot),
      this.workspaceContext.getDirectories(),
    );

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
          if (!this.isUsableWorkspaceSymbolFile(match, handle)) {
            debugLogger.warn(
              `LSP workspace symbol warmup skipped for ${match}:`,
              new Error(
                'Workspace symbol warmup candidate is no longer usable.',
              ),
            );
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
    return getLspServerExtensions(handle.config);
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
    selectedServer?: string,
  ): Promise<LspSymbolInformation[]> {
    const handles = this.getReadyHandles(selectedServer);
    this.assertServersAvailable(handles.length, selectedServer);
    const results: LspSymbolInformation[] = [];
    const scanLimit = Math.max(MIN_WORKSPACE_RESULT_SCAN_LIMIT, limit);
    let scanned = 0;

    for (const [serverName, handle] of handles) {
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
        const directories = this.workspaceContext.getDirectories();
        const scopeCache = new Map<string, boolean>();
        for (const item of response) {
          if (++scanned > scanLimit) {
            throw new WorkspaceResultScanLimitError(scanLimit);
          }
          const symbol = this.normalizer.normalizeSymbolResult(
            item,
            serverName,
          );
          if (
            symbol &&
            this.isCurrentWorkspaceDocument(
              symbol.location.uri,
              directories,
              scopeCache,
            )
          ) {
            results.push(symbol);
          }
          if (results.length >= limit) {
            return results.slice(0, limit);
          }
        }
      } catch (error) {
        if (
          error instanceof WorkspaceResultScanLimitError ||
          error instanceof LspDocumentScopeError
        ) {
          throw error;
        }
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
    location = { ...location, uri: this.canonicalDocumentUri(location.uri) };
    const handles = this.getReadyHandles(serverName, location.uri);
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

        let response = await this.requestDocument(
          handle.connection,
          'textDocument/definition',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await this.requestDocument(
            handle.connection,
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
        if (error instanceof LspDocumentScopeError) throw error;
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
    location = { ...location, uri: this.canonicalDocumentUri(location.uri) };
    const handles = this.getReadyHandles(serverName, location.uri);
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

        let response = await this.requestDocument(
          handle.connection,
          'textDocument/references',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await this.requestDocument(
            handle.connection,
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
        if (error instanceof LspDocumentScopeError) throw error;
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
    location = { ...location, uri: this.canonicalDocumentUri(location.uri) };
    const handles = this.getReadyHandles(serverName, location.uri);
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

        let response = await this.requestDocument(
          handle.connection,
          'textDocument/hover',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await this.requestDocument(
            handle.connection,
            'textDocument/hover',
            requestParams,
          );
        }

        const normalized = this.normalizer.normalizeHoverResult(response, name);
        if (normalized) {
          return normalized;
        }
      } catch (error) {
        if (error instanceof LspDocumentScopeError) throw error;
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
    uri = this.canonicalDocumentUri(uri);
    const handles = this.getReadyHandles(serverName, uri);
    const requestParams = { textDocument: { uri } };

    for (const [name, handle] of handles) {
      try {
        await this.warmupAndTrack(name, handle);
        const justOpened = await this.ensureDocumentSynchronized(
          name,
          handle,
          uri,
        );

        let response = await this.requestDocument(
          handle.connection,
          'textDocument/documentSymbol',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await this.requestDocument(
            handle.connection,
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
        if (error instanceof LspDocumentScopeError) throw error;
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
    location = { ...location, uri: this.canonicalDocumentUri(location.uri) };
    const handles = this.getReadyHandles(serverName, location.uri);
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

        let response = await this.requestDocument(
          handle.connection,
          'textDocument/implementation',
          requestParams,
        );

        if (
          this.isEmptyResponse(response) &&
          this.shouldRetryAfterOpen(justOpened, handle)
        ) {
          await this.delay(DEFAULT_LSP_DOCUMENT_RETRY_DELAY_MS);
          response = await this.requestDocument(
            handle.connection,
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
        if (error instanceof LspDocumentScopeError) throw error;
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
        this.resolveWorkspaceDocument(
          target,
          this.workspaceContext.getDirectories(),
        );
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
    if (!snapshots.has(uri) && /^file:/i.test(uri)) {
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
    const generations =
      this.callHierarchyGenerations.get(connection) ??
      new Map<string, number>();
    this.callHierarchyGenerations.set(connection, generations);
    const snapshotGenerations = new Map<string, number>();
    for (const target of snapshots.keys()) {
      const generation = generations.get(target) ?? 0;
      generations.set(target, generation);
      snapshotGenerations.set(target, generation);
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
        generations.get(target) === snapshotGenerations.get(target) &&
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
      if (/^file:/i.test(uri) && !isFresh(uri))
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
        if (!/^file:/i.test(item.uri)) return undefined;
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
                {
                  digest,
                  version: snapshot.version,
                  generation: snapshotGenerations.get(item.uri),
                },
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
    if (!/^file:/i.test(item.uri)) {
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
    location = { ...location, uri: this.canonicalDocumentUri(location.uri) };
    const handles = this.getReadyHandles(serverName, location.uri);
    const requestParams = {
      textDocument: { uri: location.uri },
      position: location.range.start,
    };

    for (const [name, handle] of handles) {
      const connection = handle.connection;
      let revision: CallHierarchyRevision | undefined;
      try {
        let originalText: string | undefined;
        if (/^file:/i.test(location.uri)) {
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
              this.resolveWorkspaceDocument(
                location.uri,
                this.workspaceContext.getDirectories(),
              );
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
            if (item) {
              item.uri = this.canonicalDocumentUri(item.uri);
              items.push(item);
            }
            if (items.length >= limit) break;
          }
          return items.slice(0, limit);
        };
        const items = normalize(response);
        for (const item of items) item.documentRevision = revision.sign(item);
        if (items.length > 0) return items;
      } catch (error) {
        revision?.checkpoint();
        if (
          error instanceof StaleCallHierarchyItemError ||
          error instanceof LspDocumentScopeError
        ) {
          throw error;
        }
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
    item = { ...item, uri: this.canonicalDocumentUri(item.uri) };
    const targetServer = serverName ?? item.serverName;
    const handles = this.getReadyHandles(targetServer);
    this.assertServersAvailable(handles.length, targetServer);
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
            normalized.from.uri = this.canonicalDocumentUri(
              normalized.from.uri,
            );
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
    item = { ...item, uri: this.canonicalDocumentUri(item.uri) };
    const targetServer = serverName ?? item.serverName;
    const handles = this.getReadyHandles(targetServer);
    this.assertServersAvailable(handles.length, targetServer);
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
            normalized.to.uri = this.canonicalDocumentUri(normalized.to.uri);
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
    uri = this.canonicalDocumentUri(uri);
    const handles = this.getDiagnosticHandles(serverName, uri);
    const extension = serverName
      ? undefined
      : this.diagnosticFileExtension(uri);
    // Ownership is only decidable for an extension the tables can place. For
    // anything else (`h`, `mts`, an extensionless file) the answer is backed by
    // relevance alone, because no declaration can be shown to cover the file
    // and a refusal on that basis would reject a configuration that works.
    const attributable =
      extension !== undefined &&
      ATTRIBUTABLE_DIAGNOSTIC_EXTENSIONS.has(extension);
    const allDiagnostics: LspDiagnostic[] = [];
    const failures: Array<{
      name: string;
      error: unknown;
      handle: LspServerHandle;
    }> = [];
    // Queried servers that answered `-32601`: they do not implement the pull
    // at all, so unlike `failures` they never veto a sibling's answer. They
    // are kept apart to be named when no positively attributable answer exists;
    // their handles let the error name only a refusal whose declaration proves
    // ownership of a document query.
    const unsupported: Array<{
      name: string;
      error: unknown;
      handle: LspServerHandle;
    }> = [];
    // Queried servers that answered with a usable report, including an
    // authoritative empty one, and that `serverDeclaredIrrelevant` does not
    // exclude. This is the fallback backing for an extension the tables cannot
    // place, where no declaration can be required to prove ownership.
    let answeredRelevant = 0;
    // Of those, the answers that positively own an attributable queried
    // extension. TypeScript answers widen directionally to the JS/TS family;
    // JavaScript answers stay strict so they cannot back a TypeScript refusal.
    // Only this ledger can certify an attributable extension clean.
    let answeredOwner = 0;

    // Every pull re-reads live handle state and appends whatever became ready,
    // so a server that finishes starting while this query is in flight is
    // asked too instead of vetoing as unasked at the decision point.
    const queried: Array<
      [string, LspServerHandle & { connection: LspConnectionInterface }]
    > = [];
    const pending = [...handles];
    for (let index = 0; index < pending.length; index++) {
      const [name, handle] = pending[index]!;
      queried.push([name, handle]);
      // A sync failure must reject, not report incomplete diagnostics as clean.
      await this.warmupAndTrack(name, handle);
      await this.ensureDocumentSynchronized(name, handle, uri);

      try {
        // Request pull diagnostics if the server supports it
        const response = await this.requestDocument(
          handle.connection,
          'textDocument/diagnostic',
          {
            textDocument: { uri },
          },
        );

        if (response == null) {
          failures.push({
            name,
            handle,
            error: new Error(
              'Invalid diagnostic report: server returned no response',
            ),
          });
        } else {
          const items =
            typeof response === 'object'
              ? (response as Record<string, unknown>)['items']
              : undefined;
          if (!Array.isArray(items)) {
            throw new InvalidDiagnosticReportError(
              'Invalid diagnostic report: server returned an unusable diagnostic report',
            );
          }
          for (const item of items) {
            const normalized = this.normalizer.normalizeDiagnostic(item, name);
            if (!normalized) {
              throw new InvalidDiagnosticReportError(
                'Invalid diagnostic report: malformed diagnostic (server returned only unusable diagnostics)',
              );
            }
            allDiagnostics.push(normalized);
          }
          if (!this.serverDeclaredIrrelevant(handle, extension)) {
            answeredRelevant++;
            if (
              extension !== undefined &&
              attributable &&
              this.declaredOwnerExtensions(handle, true).has(extension)
            ) {
              answeredOwner++;
            }
          }
        }
      } catch (error) {
        if (error instanceof LspDocumentScopeError) throw error;
        if (error instanceof InvalidDiagnosticReportError) {
          throw new Error(
            `LSP textDocument/diagnostic failed for ${name}: ${error.message}`,
            { cause: error },
          );
        }
        // A failed pull is not a clean result: keep partial results from
        // healthier servers, but reject when nothing was retrieved.
        debugLogger.warn(
          `LSP textDocument/diagnostic failed for ${name}:`,
          error,
        );
        if (pullUnsupported(error)) {
          unsupported.push({
            name,
            handle,
            error: new Error(PULL_UNSUPPORTED_REASON),
          });
        } else {
          failures.push({ name, handle, error });
        }
      }
      pending.push(
        ...this.newlyReadyDiagnosticHandles(pending, serverName, uri),
      );
    }

    if (allDiagnostics.length === 0) {
      // A server the queried file provably excludes cannot veto the answer —
      // its failure says nothing about this file — and neither can a server
      // that answered `-32601`, which never implemented the pull in the first
      // place (and so is already out of `failures`). A failure or unusable
      // answer from a server that could own the file must still veto.
      const relevantFailures = failures.filter(
        ({ handle }) => !this.serverDeclaredIrrelevant(handle, extension),
      );
      const unreachable = this.unreachableDiagnosticServers(
        queried,
        serverName,
        uri,
      );
      if (relevantFailures.length > 0 || unreachable.length > 0) {
        throw nothingRetrievedForDiagnostics(relevantFailures, unreachable);
      }
      // A -32601 refusal is excluded from `failures`, but an empty result is
      // clean only when a relevant answer is also positively attributable —
      // and only an attributable extension can be attributed at all. Relevance
      // may excuse one server from vetoing another's answer; it cannot make an
      // unknown or unowned answer certify the file.
      if (answeredRelevant === 0 || (attributable && answeredOwner === 0)) {
        // For a document query, name a refusal only when the server's
        // declaration can own the queried extension, using the same
        // TypeScript-family widening as `answeredOwner`: a `typescript`
        // declaration answers for the JS family, so its refusal explains the
        // empty result, while a JavaScript-only declaration cannot claim
        // TypeScript. A server-name key or an unplaceable alias still cannot
        // explain why this file has no backing answer. Workspace queries have
        // no extension to attribute, so retain their existing refusal details.
        const blame = [
          ...relevantFailures,
          ...unsupported.filter(
            ({ handle }) =>
              extension === undefined ||
              this.declaredOwnerExtensions(handle, true).has(extension),
          ),
        ];
        throw blame.length > 0
          ? nothingRetrievedForDiagnostics(blame, unreachable)
          : new Error(
              answeredRelevant > 0
                ? 'No LSP diagnostics could be retrieved (a server answered but its answer could not be attributed to the queried file)'
                : 'No LSP diagnostics could be retrieved (no configured server covers the queried file)',
            );
      }
    }
    return allDiagnostics;
  }

  /**
   * Get diagnostics for all documents in the workspace. A pull that failed on
   * a server which never implemented the optional `workspace/diagnostic`
   * request (`-32601`) says nothing about the workspace and cannot veto a
   * sibling's report; a failed pull from any other cause, and a configured
   * server that was never queried, still can.
   */
  async workspaceDiagnostics(
    serverName?: string,
    limit = 100,
  ): Promise<LspFileDiagnostics[]> {
    const handles = this.getDiagnosticHandles(serverName);
    const results: LspFileDiagnostics[] = [];
    let answered = 0;
    const failures: Array<{ name: string; error: unknown }> = [];
    const unsupported: Array<{ name: string; error: unknown }> = [];
    const scanLimit = Math.max(MIN_WORKSPACE_RESULT_SCAN_LIMIT, limit);
    const reportScanLimit = Math.max(
      MIN_WORKSPACE_DIAGNOSTIC_REPORT_SCAN_LIMIT,
      limit,
    );
    let scanned = 0;
    let reportsScanned = 0;

    // Same worklist as the document leg: a server that finishes starting while
    // this sweep is in flight is asked, so its slice of the workspace is
    // queried instead of vetoing the report as unasked.
    const queried: Array<
      [string, LspServerHandle & { connection: LspConnectionInterface }]
    > = [];
    const pending = [...handles];
    for (let index = 0; index < pending.length; index++) {
      const [name, handle] = pending[index]!;
      queried.push([name, handle]);
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
      let openedAny = false;
      let syncError: unknown;
      for (const uri of trackedUris) {
        // Isolate per URI so one unreadable tracked file still lets the survivors
        // re-deliver before the call rejects; a survivor stranded behind a throw
        // would leave the connection queried with zero documents and report clean.
        // The shared helper bounds consecutive read failures; a URI whose send
        // threw stays parked for the next sweep.
        try {
          const synchronized = this.synchronizeDocument(name, handle, uri);
          openedAny = synchronized.opened || openedAny;
          if (!synchronized.deferred) this.replayUris.get(name)?.delete(uri);
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

        if (response == null) {
          failures.push({
            name,
            error: new Error(
              'Invalid diagnostic report: server returned no response',
            ),
          });
        } else {
          const items =
            typeof response === 'object'
              ? (response as Record<string, unknown>)['items']
              : undefined;
          if (!Array.isArray(items)) {
            throw new InvalidDiagnosticReportError(
              'Invalid diagnostic report: server returned an unusable diagnostic report',
            );
          }
          let dropped = 0;
          let pushed = 0;
          const directories = this.workspaceContext.getDirectories();
          const scopeCache = new Map<string, boolean>();
          for (const item of items) {
            if (results.length >= limit) break;
            scanned++;
            reportsScanned++;
            if (scanned > scanLimit || reportsScanned > reportScanLimit) {
              const exhaustedLimit =
                scanned > scanLimit ? scanLimit : reportScanLimit;
              throw new WorkspaceResultScanLimitError(
                exhaustedLimit,
                `increase limit above ${exhaustedLimit} or select a server with serverName`,
              );
            }
            const report =
              item && typeof item === 'object'
                ? (item as Record<string, unknown>)
                : undefined;
            const uri = report?.['uri'];
            if (typeof uri !== 'string') {
              dropped++;
              continue;
            }
            const current = this.isCurrentWorkspaceDocument(
              uri,
              directories,
              scopeCache,
            );
            if (current === undefined) dropped++;
            if (!current) continue;
            const fileItems = report?.['items'];
            const normalized = this.normalizer.normalizeFileDiagnostics(
              item,
              name,
            );
            if (
              !Array.isArray(fileItems) ||
              !normalized ||
              normalized.diagnostics.length !== fileItems.length
            ) {
              throw new InvalidDiagnosticReportError(
                `Invalid diagnostic report for ${uri}: server returned only unusable diagnostics`,
              );
            }
            if (normalized.diagnostics.length > 0) {
              results.push(normalized);
              pushed++;
            } else {
              // Valid clean reports consume only the larger total-report budget.
              scanned--;
            }
          }
          if (dropped > 0 && pushed === 0) {
            throw new InvalidDiagnosticReportError(
              'Invalid diagnostic report: server returned only unusable diagnostics',
            );
          }
          answered++;
        }
      } catch (error) {
        if (
          error instanceof WorkspaceResultScanLimitError ||
          error instanceof LspDocumentScopeError
        ) {
          throw error;
        }
        if (error instanceof InvalidDiagnosticReportError) {
          throw new Error(
            `LSP workspace/diagnostic failed for ${name}: ${error.message}`,
            { cause: error },
          );
        }
        // A failed pull is not a clean result: keep partial results from
        // healthier servers, but reject when nothing was retrieved. A server
        // that answered `-32601` never implemented the optional request, so
        // its refusal cannot veto a sibling's report — the document leg's
        // bucket, on a query with no extension to attribute it to.
        debugLogger.warn(`LSP workspace/diagnostic failed for ${name}:`, error);
        if (pullUnsupported(error)) {
          unsupported.push({ name, error: new Error(PULL_UNSUPPORTED_REASON) });
        } else {
          failures.push({ name, error });
        }
      }

      pending.push(...this.newlyReadyDiagnosticHandles(pending, serverName));

      if (results.length >= limit) {
        break;
      }
    }

    if (results.length === 0) {
      const unreachable = this.unreachableDiagnosticServers(
        queried,
        serverName,
      );
      if (failures.length > 0 || unreachable.length > 0 || answered === 0) {
        // A workspace query covers every file, so no extension can attribute
        // a refusal to one: every collected `-32601` refusal is named beside
        // the failures and the unreachable servers, unfiltered.
        throw nothingRetrievedForDiagnostics(
          [...failures, ...unsupported],
          unreachable,
        );
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
    uri = this.canonicalDocumentUri(uri);
    const handles = this.getReadyHandles(serverName, uri);

    for (const [name, handle] of handles) {
      try {
        await this.warmupAndTrack(name, handle);
        await this.ensureDocumentSynchronized(name, handle, uri);

        // Convert context diagnostics to LSP format
        const lspDiagnostics = context.diagnostics.map((d: LspDiagnostic) =>
          this.normalizer.denormalizeDiagnostic(d),
        );

        const response = await this.requestDocument(
          handle.connection,
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
        if (error instanceof LspDocumentScopeError) throw error;
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
    let filePath = /^file:/i.test(uri) ? fileURLToPath(uri) : uri;
    if (!path.isAbsolute(filePath)) {
      filePath = path.resolve(this.workspaceRoot, filePath);
    }
    if (
      !isSubpaths(
        this.workspaceContext.getDirectories(),
        resolveWorkspacePath(filePath),
      )
    ) {
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
