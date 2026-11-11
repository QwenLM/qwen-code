/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolUseContext } from '../tools/tool-types.js';
import type { Config } from '../config/config.js';
import type { CellProgress } from './cells.js';
import {
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
} from '../tools/tool-names.js';
import type { ScopeSummary, ToolExecutionScope } from './scope.js';
import { loadStore } from './session.js';
import { StoreRestoreError, type CodeModeStore } from './store.js';
import { ToolSearchIndex } from './tool-search.js';
import { BoundedLruMap } from '../utils/boundedLruMap.js';
import {
  recordSearchResults,
  searchRank,
  takeFirstMcpSuccess,
} from '../tools/discovery-stats.js';
import { bucketMcpListResultCount } from '../tools/mcp-lazy/result-buckets.js';
import {
  MCP_QUALIFIED_NAME_SEPARATOR,
  MCP_TOOL_PREFIX,
} from '../mcp/tools/mcp-names.js';
import type {
  JsonObject,
  JsonValue,
  ScriptHost,
  ScriptImage,
  ScriptNamespace,
  ScriptSearchRequest,
  ScriptSearchStats,
  ScriptStatus,
  ScriptToolDescription,
  ScriptToolSet,
  StoreWrite,
} from './types.js';

/** How long a starting script waits for the MCP servers it needs to finish connecting. */
export const MCP_DISCOVERY_WAIT_MS = 30_000;
const DISCOVERY_GLOBALS = /\b(?:searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;
const MCP_REFERENCE = new RegExp(
  `${MCP_TOOL_PREFIX}([A-Za-z0-9_-]+?)${MCP_QUALIFIED_NAME_SEPARATOR}`,
  'g',
);

/**
 * A script binds its callable tools when it starts, so it first gives the MCP
 * servers it references (every server when it uses discovery) a bounded chance
 * to finish connecting.
 */
export async function waitForScriptMcpServers(
  config: Config,
  code: string,
  signal: AbortSignal,
): Promise<void> {
  const manager = config.getMcpClientManager?.();
  if (!manager) return;
  const servers = DISCOVERY_GLOBALS.test(code)
    ? undefined
    : [...new Set([...code.matchAll(MCP_REFERENCE)].map((match) => match[1]!))];
  if (servers?.length === 0 || signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      manager.whenDiscovered(servers),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MCP_DISCOVERY_WAIT_MS);
        onAbort = resolve;
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export interface CodeModeSummary extends ScopeSummary {
  storeError?: string;
  search?: ScriptSearchStats;
  /** Writes committed to the store; recorded in the CodeMode result so they follow the conversation. */
  storeWrites?: StoreWrite[];
}

/** Each registry catalog snapshot keeps the indexes of the tool sets scripts searched. */
const searchIndexes = new WeakMap<
  readonly ScriptToolDescription[],
  BoundedLruMap<string, ToolSearchIndex<ScriptToolDescription>>
>();
const MAX_INDEXES_PER_CATALOG = 8;

/** The runtime's view of the host: child tool calls through the scope plus the agent's script state. */
export class CodeModeHost implements ScriptHost {
  private store?: CodeModeStore;
  private storeError?: string;
  private searchable?: {
    catalog: readonly ScriptToolDescription[];
    tools: ScriptToolDescription[];
    namespaces: ScriptNamespace[];
  };
  private index?: ToolSearchIndex<ScriptToolDescription>;
  private readonly searchStats: ScriptSearchStats = {
    calls: 0,
    resultBuckets: [],
    namespaceCalls: 0,
    calledRanks: [],
  };
  private readonly rankedCalls = new Set<string>();

  constructor(
    private readonly ctx: ToolUseContext,
    private readonly scope: ToolExecutionScope,
    private readonly sessionId: string,
    private readonly agentId: string | undefined,
  ) {}

  get signal(): AbortSignal {
    return this.scope.signal;
  }

  progress(): CellProgress {
    return {
      calls: this.scope.callSummaries,
      children: this.scope.displayChildren,
      storeError: this.storeError,
    };
  }

  async call(name: string, args: JsonObject): Promise<JsonValue> {
    if (!this.rankedCalls.has(name)) {
      this.rankedCalls.add(name);
      const rank = searchRank(this.sessionId, name);
      if (rank !== undefined) this.searchStats.calledRanks.push(rank);
    }
    const value = await this.scope.call(name, args);
    if (this.scope.tools.get(name)?.exposureHints.namespace?.kind === 'mcp') {
      const first = takeFirstMcpSuccess(this.sessionId, this.ctx.promptId);
      if (first) this.searchStats.firstMcpSuccess = first;
    }
    return value;
  }

  discardResult(value: JsonValue): void {
    this.scope.discardResult(value);
  }

  async readImage(path: string): Promise<ScriptImage> {
    const value = await this.scope.call(
      READ_FILE_TOOL_NAME,
      { file_path: path },
      { hostImageRead: true },
    );
    const { mimeType, data } = value as { mimeType: string; data: string };
    return { mimeType, data };
  }

  subscribeApprovalWait(listener: (waiting: boolean) => void): () => void {
    return this.scope.subscribeApprovalWait(listener);
  }

  /** The state visible to this script; persistence is read once per conversation revision. */
  async storeSnapshot(): Promise<JsonObject> {
    const context = this.ctx.agentLoopContext!;
    try {
      this.store = await loadStore(
        context.config,
        this.sessionId,
        this.agentId,
        context.config.getActiveConversation(),
        this.scope.signal,
      );
    } catch (error) {
      if (error instanceof StoreRestoreError) this.storeError = error.message;
      throw error;
    }
    return this.store.snapshot();
  }

  /** Store writes commit only after the scope settled cleanly. */
  async close(
    status: ScriptStatus,
    storeWrites: readonly StoreWrite[] = [],
  ): Promise<CodeModeSummary> {
    const summary: CodeModeSummary = await this.scope.close(status);
    if (this.storeError) summary.storeError = this.storeError;
    const { calls, calledRanks, firstMcpSuccess } = this.searchStats;
    if (calls || calledRanks.length || firstMcpSuccess)
      summary.search = this.searchStats;
    if (
      status === 'completed' &&
      !summary.stopReason &&
      !this.scope.signal.aborted &&
      this.store &&
      !this.storeError &&
      storeWrites.length
    ) {
      try {
        this.store.commit(storeWrites);
        summary.storeWrites = [...storeWrites];
      } catch (error) {
        summary.stopReason =
          error instanceof Error
            ? error.message
            : 'Unable to commit script state';
      }
    }
    return summary;
  }

  /** Callable names and discovery data for this scope's admitted tools. */
  describeTools(): ScriptToolSet {
    const registry = this.ctx.agentLoopContext!.toolRegistry;
    const admitted = this.scope.tools;
    const catalog = registry.getProgrammaticToolCatalog(this.ctx.modelKey);
    const searchable = catalog.filter((entry) => admitted.has(entry.name));
    const namespaces = this.namespaces(searchable);
    this.searchable = { catalog, tools: searchable, namespaces };
    // Search text stays on the host, which owns the index.
    const toolCatalog = searchable.map(({ name, description, namespace }) => ({
      name,
      description,
      ...(namespace === undefined ? {} : { namespace }),
    }));
    return {
      tools: [...admitted.keys()],
      // Only advertise escape hatches that are actually exposed to this model.
      directTools: registry
        .getModelFunctionDeclarations(this.ctx.modelKey)
        .flatMap(({ name }) =>
          name &&
          name !== CODE_MODE_TOOL_NAME &&
          name !== CODE_MODE_WAIT_TOOL_NAME
            ? [name]
            : [],
        ),
      toolCatalog,
      namespaces,
    };
  }

  search(request: ScriptSearchRequest): string[] {
    this.index ??= this.searchIndex();
    const found =
      this.index
        ?.search(request.query, {
          limit: request.limit,
          namespace: request.namespace,
        })
        .map((tool) => tool.name) ?? [];
    const stats = this.searchStats;
    stats.calls++;
    if (request.namespace !== undefined) stats.namespaceCalls++;
    stats.resultBuckets.push(bucketMcpListResultCount(found.length));
    recordSearchResults(this.sessionId, found, this.ctx.promptId);
    return found;
  }

  /** Reuses the index of an identical tool set; it changes only when tools or servers do. */
  private searchIndex(): ToolSearchIndex<ScriptToolDescription> | undefined {
    if (!this.searchable) return undefined;
    const { catalog, tools, namespaces } = this.searchable;
    const key = JSON.stringify([
      tools.map((tool) => tool.name),
      namespaces.map((item) => [item.name, item.description, item.instructions]),
    ]);
    let indexes = searchIndexes.get(catalog);
    if (!indexes) {
      indexes = new BoundedLruMap(MAX_INDEXES_PER_CATALOG);
      searchIndexes.set(catalog, indexes);
    }
    let index = indexes.get(key);
    if (!index) {
      index = new ToolSearchIndex(tools, namespaces);
      indexes.set(key, index);
    }
    return index;
  }

  /** MCP servers of the admitted tools, with the metadata describeNamespace() returns. */
  private namespaces(
    catalog: readonly ScriptToolDescription[],
  ): ScriptNamespace[] {
    const byServer = new Map<string, string[]>();
    for (const entry of catalog) {
      if (!entry.namespace) continue;
      const tools = byServer.get(entry.namespace);
      if (tools) tools.push(entry.name);
      else byServer.set(entry.namespace, [entry.name]);
    }
    if (!byServer.size) return [];
    const manager = this.ctx.agentLoopContext!.config.getMcpClientManager?.();
    const servers = manager?.getMcpServers?.() ?? {};
    return [...byServer].map(([name, tools]) => {
      const description = servers[name]?.description?.trim();
      const instructions = manager?.getClientByName?.(name)?.getInstructions();
      return {
        name,
        ...(description ? { description } : {}),
        ...(instructions ? { instructions } : {}),
        tools,
      };
    });
  }
}
