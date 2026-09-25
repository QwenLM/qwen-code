/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import type {
  AnyDeclarativeTool,
  ToolResult,
  ToolResultDisplay,
  ToolInvocation,
} from './tools.js';
import { Kind, BaseDeclarativeTool, BaseToolInvocation } from './tools.js';
import { type Config, matchesAnyServerPattern } from '../config/config.js';
import { isMediaPolicyToolHiddenFromModel } from '../omni/policy/model-access.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { SendSdkMcpMessage } from './mcp-client.js';
import {
  isEnabled,
  removeMCPServerStatus,
  populateMcpServerCommand,
} from './mcp-client.js';
import { McpClientManager } from './mcp-client-manager.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { parse } from 'shell-quote';
import { ToolErrorType } from './tool-error.js';
import { ToolNames } from './tool-names.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import type { EventEmitter } from 'node:events';
import { createDebugLogger } from '../utils/debugLogger.js';
import { sanitizeChildEnv } from '../utils/sanitize-child-env.js';
import { normalizePathEnvForWindows } from '../utils/windowsPath.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { normalizeMcpToolName } from '../utils/tool-name-utils.js';
import { CHARS_PER_TOKEN } from '../services/tokenEstimation.js';
import {
  buildExecDeclaration,
  getToolExposure,
  planCodeModeBindings,
  ToolMode,
  type CodeModeBindingPlan,
} from './code-mode.js';

type ToolParams = Record<string, unknown>;

/** Factory function for lazy tool instantiation via dynamic import. */
export type ToolFactory = () => Promise<AnyDeclarativeTool>;

export interface DeferredToolSummary {
  name: string;
  description: string;
  serverName?: string;
}

const debugLogger = createDebugLogger('TOOL_REGISTRY');

class DiscoveredToolInvocation extends BaseToolInvocation<
  ToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    private readonly toolName: string,
    params: ToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return safeJsonStringify(this.params);
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    const callCommand = this.config.getToolCallCommand()!;
    // The user-configured tool-call command is a child process launched on the
    // agent's behalf, so it must not inherit Qwen-internal daemon secrets.
    // Passing `env` explicitly loses the native inheritance that resolved
    // Windows' case-insensitive PATH keys, so normalize as the shell and MCP
    // spawn sites do (a no-op off win32).
    const child = spawn(callCommand, [this.toolName], {
      env: normalizePathEnvForWindows(sanitizeChildEnv(process.env)),
    });
    child.stdin.write(JSON.stringify(this.params));
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let error: Error | null = null;
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;

    await new Promise<void>((resolve) => {
      const onStdout = (data: Buffer) => {
        stdout += data?.toString();
      };

      const onStderr = (data: Buffer) => {
        stderr += data?.toString();
      };

      const onError = (err: Error) => {
        error = err;
      };

      const onClose = (
        _code: number | null,
        _signal: NodeJS.Signals | null,
      ) => {
        code = _code;
        signal = _signal;
        cleanup();
        resolve();
      };

      const cleanup = () => {
        child.stdout.removeListener('data', onStdout);
        child.stderr.removeListener('data', onStderr);
        child.removeListener('error', onError);
        child.removeListener('close', onClose);
        if (child.connected) {
          child.disconnect();
        }
      };

      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.on('error', onError);
      child.on('close', onClose);
    });

    // if there is any error, non-zero exit code, signal, or stderr, return error details instead of stdout
    if (error || code !== 0 || signal || stderr) {
      const llmContent = [
        `Stdout: ${stdout || '(empty)'}`,
        `Stderr: ${stderr || '(empty)'}`,
        `Error: ${error ?? '(none)'}`,
        `Exit Code: ${code ?? '(none)'}`,
        `Signal: ${signal ?? '(none)'}`,
      ].join('\n');
      return {
        llmContent,
        returnDisplay: llmContent,
        error: {
          message: llmContent,
          type: ToolErrorType.DISCOVERED_TOOL_EXECUTION_ERROR,
        },
      };
    }

    return {
      llmContent: stdout,
      returnDisplay: stdout,
    };
  }
}

export class DiscoveredTool extends BaseDeclarativeTool<
  ToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    name: string,
    override readonly description: string,
    override readonly parameterSchema: Record<string, unknown>,
  ) {
    const discoveryCmd = config.getToolDiscoveryCommand()!;
    const callCommand = config.getToolCallCommand()!;
    description += `

This tool was discovered from the project by executing the command \`${discoveryCmd}\` on project root.
When called, this tool will execute the command \`${callCommand} ${name}\` on project root.
Tool discovery and call commands can be configured in project or user settings.

When called, the tool call command is executed as a subprocess.
On success, tool output is returned as a json string.
Otherwise, the following information is returned:

Stdout: Output on stdout stream. Can be \`(empty)\` or partial.
Stderr: Output on stderr stream. Can be \`(empty)\` or partial.
Error: Error or \`(none)\` if no error was reported for the subprocess.
Exit Code: Exit code or \`(none)\` if terminated by signal.
Signal: Signal number or \`(none)\` if no signal was received.
`;
    super(
      name,
      name,
      description,
      Kind.Other,
      parameterSchema,
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected createInvocation(
    params: ToolParams,
  ): ToolInvocation<ToolParams, ToolResult> {
    return new DiscoveredToolInvocation(this.config, this.name, params);
  }
}

export class ToolRegistry {
  // The tools keyed by tool name as seen by the LLM.
  private tools: Map<string, AnyDeclarativeTool> = new Map();
  // Lazy tool factories keyed by tool name — resolved on first use.
  private factories: Map<string, ToolFactory> = new Map();
  // In-flight factory promises — ensures concurrent ensureTool() calls for the
  // same name share one promise instead of running the factory multiple times.
  private inflight: Map<string, Promise<AnyDeclarativeTool | undefined>> =
    new Map();
  // Deferred tools promoted into the declaration list by session setup,
  // compatibility replay, or an explicit runtime flow.
  private revealedDeferred: Set<string> = new Set();
  // Reveals that are session setup rather than transient runtime state (see
  // pinDeferredToolReveal): they survive the `/clear` reset that
  // intentionally drops transient reveals so the new session starts clean.
  private pinnedDeferredReveals: Set<string> = new Set();
  private codeModeCollisionWarnings = new Set<string>();
  // Built-in tools demoted to deferred by an active `settings.tools.eager`
  // allowlist (#9827, #10075). They are fully registered — listed
  // in `/tools`, discoverable via ToolSearch, callable through ToolCall and
  // the normal approval flow — but their schemas are kept out of the eager
  // model request exactly like `shouldDefer=true` tools. Unlike ordinary
  // deferred tools they are never auto-revealed by the budget preload:
  // re-adding their schemas at startup would defeat the allowlist's
  // schema-shrink purpose (#9827).
  private permissionDeferred: Set<string> = new Set();
  private config: Config;
  private mcpClientManager: McpClientManager;
  // In-flight `discoverToolsForServer` passes keyed by server name. The
  // purge runs synchronously before the await, so an unguarded second
  // caller snapshots-and-deletes the first caller's FRESHLY registered
  // tools while the manager dedups it onto the first pass's promise —
  // which resolves, so no restore runs and the server is left with a
  // live client but zero registrations. Mirrors the manager's own
  // `serverDiscoveryPromises` contract: a concurrent caller awaits and
  // observes the in-flight outcome instead of purging again.
  private serverDiscoveryInFlight = new Map<string, Promise<void>>();

  // Monotonic per-server generation, bumped by every operator teardown
  // path (`markMcpServerTornDown`, reached from `disconnectServer` /
  // `disableMcpServer` / the manager's operator-intent removals). A
  // discovery pass captures the generation before awaiting the manager;
  // if it moved by the time the pass settles, the server was
  // deliberately torn down mid-pass and the snapshot restore must NOT
  // run — it would re-expose a server the operator just removed, bound
  // to a client that no longer exists (R3-7). The teardown paths also
  // drop the in-flight dedup entry so a post-teardown reconnect starts
  // a fresh pass instead of inheriting the pre-teardown promise
  // (R2-1 round 4). The bump lives in `markMcpServerTornDown`, NOT in
  // `removeMcpToolsByServer`: the manager's own in-pass
  // `purgeServerRegistries` (the existing-client branch of a
  // rediscovery) also calls `removeMcpToolsByServer`, and that call is
  // not teardown intent — treating it as such suppressed the resolve
  // restore on EVERY legacy reconnect of a tracked server (R3-7 round
  // 5) and disarmed the R2-1 dedup for its duration.
  private serverTeardownGeneration = new Map<string, number>();

  // Monotonic epoch bumped by every DELIBERATE reveal reset
  // (`clearRevealedDeferredTools` — `/clear` and session resets). A
  // discovery pass captures it before awaiting the manager; the restore
  // leg replays pre-pass reveal state only when the epoch still matches
  // (R5-48 round 6). Pinned reveals are exempt on the replay side via
  // `pinnedDeferredReveals`, matching `clearRevealedDeferredTools`'s own
  // re-pin loop.
  private revealResetEpoch = 0;

  // Server names whose current `DiscoveredMCPTool` entries were copied
  // in from ANOTHER registry by `copyDiscoveredToolsFrom` (per-agent
  // registries are seeded this way — discovery is expensive). Those
  // tool objects carry the PARENT's McpClient; this registry's own
  // manager never produced them. A failed per-agent rediscovery must
  // not "restore" the parent's live tool objects — that silently undoes
  // the agent frontmatter's server override (the subagent's model would
  // call the session-level server through the replaced connection) and
  // must instead fail closed with no tools for the server (R4-3).
  private copiedMcpServers = new Set<string>();

  constructor(
    config: Config,
    eventEmitter?: EventEmitter,
    sendSdkMcpMessage?: SendSdkMcpMessage,
  ) {
    this.config = config;
    // options-bag
    // ctor; previously 7 positional args with `undefined, undefined`
    // sentinels for `healthConfig` / `budgetConfig`. `pool` is
    // forwarded from Config (set by daemon-mode QwenAgent in
    // `newSessionConfig`); when undefined the manager keeps its previous
    // per-session spawn behavior, when defined non-SDK MCP discovery
    // goes through `pool.acquire` so N sessions in the same workspace
    // share one transport per unique server config.
    this.mcpClientManager = new McpClientManager(this.config, this, {
      eventEmitter,
      sendSdkMcpMessage,
      pool: this.config.getMcpTransportPool(),
    });
  }

  // Stable declaration order keeps the serialized tools block independent of
  // async registration history (MCP discovery, reconnects, deferred reveals).
  private static compareToolsByDeclarationName(
    a: AnyDeclarativeTool,
    b: AnyDeclarativeTool,
  ): number {
    const aName = a.schema.name ?? a.name;
    const bName = b.schema.name ?? b.name;
    const byName = aName.localeCompare(bName);
    if (byName !== 0) return byName;
    return a.displayName.localeCompare(b.displayName);
  }

  private static compareCodeModeTools(
    a: AnyDeclarativeTool,
    b: AnyDeclarativeTool,
  ): number {
    const aName = a.schema.name ?? a.name;
    const bName = b.schema.name ?? b.name;
    if (aName !== bName) return aName < bName ? -1 : 1;
    return a.displayName < b.displayName
      ? -1
      : a.displayName > b.displayName
        ? 1
        : 0;
  }

  /**
   * Returns true when `name` is in the Config's `disabledTools` set, in
   * which case `registerTool` / `registerFactory` will skip it. This is
   * the chokepoint for the daemon mutation route at `POST /workspace/
   * tools/:name/enable {enabled:false}`; both
   * built-ins and MCP-discovered tools flow through `registerTool`, so
   * gating here covers every registration path.
   */
  private isToolDisabled(
    name: string,
    aliases: readonly string[] = [],
  ): boolean {
    const disabledTools = this.config.getDisabledTools();
    const hasExactMatch =
      disabledTools.has(name) ||
      aliases.some((alias) => disabledTools.has(alias));
    if (hasExactMatch || !name.startsWith('mcp__')) {
      return hasExactMatch;
    }

    for (const disabledName of disabledTools) {
      if (normalizeMcpToolName(disabledName) === name) {
        return true;
      }
    }
    return false;
  }

  /**
   * Registers a tool definition.
   * @param tool - The tool object containing schema and execution logic.
   */
  registerTool(tool: AnyDeclarativeTool): void {
    if (
      this.isToolDisabled(
        tool.name,
        tool instanceof DiscoveredMCPTool ? tool.permissionAliases : [],
      )
    ) {
      debugLogger.info(
        `Tool "${tool.name}" skipped: present in disabledTools set.`,
      );
      return;
    }
    // A name collision can happen against either the eager `tools` map
    // (already-instantiated tools) or the lazy `factories` map (registered
    // but not yet constructed — `structured_output` lives here when
    // `--json-schema` is set, but the same is true for every other lazy
    // built-in). Without considering factories, an MCP server registering
    // a tool with a name that shadows a built-in factory would silently
    // win: `tools.has(name)` returns false, no rename happens, then the
    // first `ensureTool(name)` resolves from `tools` and the factory is
    // discarded. For MCP tools we resolve this by appending the server-
    // qualified suffix; for other internal callers we keep the existing
    // overwrite-with-warning behaviour for parity with the eager-only
    // path.
    const collidesWithEager = this.tools.has(tool.name);
    const collidesWithFactory = this.factories.has(tool.name);
    if (collidesWithEager || collidesWithFactory) {
      if (tool instanceof DiscoveredMCPTool) {
        tool = tool.asFullyQualifiedTool();
      } else {
        debugLogger.warn(
          `Tool with name "${tool.name}" is already registered. Overwriting.`,
        );
      }
    }
    // Re-check the disabled set against
    // the FINAL registration name. Without this, an MCP tool that
    // collides with a lazy factory and gets renamed via
    // `asFullyQualifiedTool()` (e.g. `structured_output` →
    // `mcp__server__structured_output`) would slip past the up-front
    // `isToolDisabled(tool.name)` gate above when the operator
    // disabled the renamed-and-exposed name. Re-evaluating after the
    // rename closes that hole.
    if (
      this.isToolDisabled(
        tool.name,
        tool instanceof DiscoveredMCPTool ? tool.permissionAliases : [],
      )
    ) {
      debugLogger.info(
        `Tool "${tool.name}" skipped (post-rename): present in disabledTools set.`,
      );
      return;
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Registers a lazy tool factory. The tool module is not imported and the tool
   * is not instantiated until {@link ensureTool} or {@link warmAll} is called.
   */
  registerFactory(name: string, factory: ToolFactory): void {
    if (this.isToolDisabled(name)) {
      debugLogger.info(
        `Tool factory "${name}" skipped: present in disabledTools set.`,
      );
      return;
    }
    this.factories.set(name, factory);
  }

  /**
   * Registers a lazy tool factory for a tool that an active
   * `settings.tools.eager` allowlist demoted to deferred (#9827,
   * #10075). Registration is identical to {@link registerFactory}; the name
   * is additionally tracked so every deferred-hiding decision
   * ({@link getFunctionDeclarations}, {@link isDeferredAndHidden},
   * {@link getDeferredToolSummary}) treats it like a `shouldDefer=true`
   * tool while {@link preloadDeferredToolsWithinBudget} skips it.
   */
  registerPermissionDeferredFactory(name: string, factory: ToolFactory): void {
    if (this.isToolDisabled(name)) {
      debugLogger.info(
        `Tool factory "${name}" skipped: present in disabledTools set.`,
      );
      return;
    }
    this.factories.set(name, factory);
    this.permissionDeferred.add(name);
  }

  /**
   * Whether a registered tool instance is permission-deferred (see
   * {@link registerPermissionDeferredFactory}).
   */
  isPermissionDeferred(name: string): boolean {
    return this.permissionDeferred.has(name);
  }

  /**
   * Whether a tool is deferred for hiding purposes: either the tool class
   * opted in via `shouldDefer=true`, or an active `settings.tools.eager`
   * allowlist demoted it (#10075).
   */
  private isEffectivelyDeferred(tool: AnyDeclarativeTool): boolean {
    return tool.shouldDefer || this.permissionDeferred.has(tool.name);
  }

  private isToolAvailable(name: string): boolean {
    return (
      name !== ToolNames.IMAGE_GEN || this.config.isImageGenerationEnabled()
    );
  }

  /**
   * Ensures a specific tool is loaded. Returns the cached instance if already
   * loaded, otherwise invokes the factory, caches the result, and returns it.
   * Concurrent calls for the same name share a single in-flight promise so the
   * factory is never executed more than once.
   */
  async ensureTool(name: string): Promise<AnyDeclarativeTool | undefined> {
    if (!this.isToolAvailable(name)) return undefined;
    const cached = this.tools.get(name);
    if (cached) {
      // Clean up any stale factory for this name so warmAll() and bulk
      // accessors don't treat it as still pending.
      this.factories.delete(name);
      return cached;
    }

    const existing = this.inflight.get(name);
    if (existing) return existing;

    const factory = this.factories.get(name);
    if (!factory) return undefined;

    const load = factory()
      .then((tool) => {
        this.tools.set(name, tool);
        this.factories.delete(name);
        this.inflight.delete(name);
        return this.isToolAvailable(name) ? tool : undefined;
      })
      .catch((err: unknown) => {
        this.inflight.delete(name);
        throw err;
      });

    this.inflight.set(name, load);
    return load;
  }

  /**
   * Loads all pending tool factories in parallel. Safe to call multiple times
   * (no-op when all factories have been resolved). Call this before any bulk
   * access such as {@link getAllTools} or {@link getFunctionDeclarations}.
   *
   * @param options.strict - When `true`, re-throws the first factory failure
   *   instead of swallowing it. Use this during startup (e.g. in
   *   `Config.initialize`) so a broken built-in tool surfaces immediately
   *   rather than leaving the session partially initialised.
   */
  async warmAll(options?: { strict?: boolean }): Promise<void> {
    const pending = Array.from(this.factories.keys());
    if (pending.length === 0) return;
    const results = await Promise.allSettled(
      pending.map((name) => this.ensureTool(name)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        if (options?.strict) throw result.reason as Error;
        debugLogger.warn('Failed to warm tool factory:', result.reason);
      }
    }
  }

  /**
   * Copies discovered (non-core) tools from another registry into this one.
   * Used to share MCP/command-discovered tools with per-agent registries
   * that were built with skipDiscovery.
   */
  copyDiscoveredToolsFrom(source: ToolRegistry): void {
    const copiedServers = new Set<string>();
    for (const tool of source.tools.values()) {
      if (
        (tool instanceof DiscoveredTool || tool instanceof DiscoveredMCPTool) &&
        !this.tools.has(tool.name)
      ) {
        this.tools.set(tool.name, tool);
        if (tool instanceof DiscoveredMCPTool) {
          copiedServers.add(tool.serverName);
        }
        if (source.isPermissionDeferred(tool.name)) {
          this.permissionDeferred.add(tool.name);
        }
      }
    }
    // Provenance (R4-3): the copied MCP tools carry the source
    // registry's clients. A later failed per-server rediscovery in THIS
    // registry must not restore them — that would re-expose the parent
    // connection the copy was only meant to pre-seed. Recorded per
    // server, not per tool, so the snapshot/restore gate stays O(1).
    for (const server of copiedServers) {
      this.copiedMcpServers.add(server);
    }
  }

  private removeDiscoveredTools(): void {
    for (const tool of this.tools.values()) {
      if (tool instanceof DiscoveredTool || tool instanceof DiscoveredMCPTool) {
        this.tools.delete(tool.name);
        // Drop reveal state too — see `removeMcpToolsByServer`. Without
        // this a re-discovered tool of the same name would inherit
        // stale "revealed" state across the disconnect/reconnect.
        this.revealedDeferred.delete(tool.name);
      }
    }
  }

  /**
   * Records operator teardown intent for a server: a discovery pass
   * pending across this teardown must not restore its snapshot, and a
   * reconnect issued after it starts a fresh pass rather than deduping
   * onto the pre-teardown promise. Split from the pure purge in
   * `removeMcpToolsByServer` (R3-7 round 5) because the manager's
   * in-pass `purgeServerRegistries` — which must NOT invalidate a
   * pending pass — reaches the registry only through that method.
   */
  markMcpServerTornDown(serverName: string): void {
    this.serverTeardownGeneration.set(
      serverName,
      (this.serverTeardownGeneration.get(serverName) ?? 0) + 1,
    );
    this.serverDiscoveryInFlight.delete(serverName);
    // The operator removed the server; whatever produced its current
    // registrations no longer applies to a future state of this
    // registry. Clearing provenance lets a deliberately re-added
    // server's OWN discovery pass restore normally afterwards.
    this.copiedMcpServers.delete(serverName);
  }

  /**
   * Removes all tools from a specific MCP server.
   * @param serverName The name of the server to remove tools from.
   */
  removeMcpToolsByServer(serverName: string): void {
    // Pure registry purge — no teardown intent. Operator teardown
    // (disconnect / disable / config removal) routes through
    // `markMcpServerTornDown` as well; the manager's in-pass purge of
    // the old config's entries before a rediscovery deliberately does
    // not, so it cannot invalidate a pending pass's restore (R3-7
    // round 5).
    for (const [name, tool] of this.tools.entries()) {
      if (tool instanceof DiscoveredMCPTool && tool.serverName === serverName) {
        this.tools.delete(name);
        // Drop reveal state for the removed tool. Otherwise a server
        // disconnect → reconnect cycle that re-registers a tool of the
        // same name would inherit `revealed: true` from the prior
        // session — `getFunctionDeclarations` would emit it (since it
        // checks reveal state) before the model has any way to know
        // the tool exists this session.
        this.revealedDeferred.delete(name);
      }
    }
  }

  /**
   * Disconnects an MCP server by removing its tools, prompts, and disconnecting the client.
   * Unlike disableMcpServer, this does NOT add the server to the exclusion list.
   * @param serverName The name of the server to disconnect.
   */
  async disconnectServer(serverName: string): Promise<void> {
    // Remove tools from registry
    this.removeMcpToolsByServer(serverName);
    this.markMcpServerTornDown(serverName);

    // Remove prompts
    this.config.getPromptRegistry().removePromptsByServer(serverName);

    // Remove resources
    this.config.getResourceRegistry().removeResourcesByServer(serverName);

    // Disconnect the MCP client
    await this.mcpClientManager.disconnectServer(serverName);
  }

  /**
   * Disables an MCP server by removing its tools, prompts, and disconnecting the client.
   * Also updates the config's exclusion list.
   * @param serverName The name of the server to disable.
   */
  async disableMcpServer(serverName: string): Promise<void> {
    // Remove tools from registry
    this.removeMcpToolsByServer(serverName);
    this.markMcpServerTornDown(serverName);

    // Remove prompts
    this.config.getPromptRegistry().removePromptsByServer(serverName);

    // Remove resources
    this.config.getResourceRegistry().removeResourcesByServer(serverName);

    try {
      // Disconnect the MCP client
      await this.mcpClientManager.disconnectServer(serverName);
    } finally {
      try {
        // Update the exclusion list before dropping the status entry,
        // so a server is already marked as disabled by the time it
        // disappears from the registry. Otherwise there's a (currently
        // synchronous, but easy to widen) window where doctorChecks
        // would observe a missing status (falling back to DISCONNECTED)
        // while isMcpServerDisabled still returns false, mis-reporting
        // an intentional disable as a connectivity failure.
        const currentExcluded = this.config.getExcludedMcpServers() || [];
        if (!matchesAnyServerPattern(serverName, currentExcluded)) {
          this.config.setExcludedMcpServers([...currentExcluded, serverName]);
        }
      } finally {
        // Always drop the server from the global status registry — even
        // if disconnect or the exclusion-list update throws — so the
        // Footer's MCP health pill stops counting it as "offline". A
        // leftover entry would resurrect the bug.
        removeMCPServerStatus(serverName);
      }
    }
  }

  /**
   * Returns the manager that owns MCP client lifecycles. Exposed so
   * `Config.initialize()`'s background discovery path can call
   * `discoverAllMcpToolsIncremental` directly without going through
   * `discoverMcpTools` (which would wipe already-registered tools).
   */
  getMcpClientManager(): McpClientManager {
    return this.mcpClientManager;
  }

  /**
   * Discovers tools from project (if available and configured).
   * Can be called multiple times to update discovered tools.
   * This will discover tools from the command line and from MCP servers.
   */
  async discoverAllTools(): Promise<void> {
    // remove any previously discovered tools
    this.removeDiscoveredTools();

    this.config.getPromptRegistry().clear();
    this.config.getResourceRegistry().clear();

    await this.discoverAndRegisterToolsFromCommand();

    // discover tools using MCP servers, if configured
    await this.mcpClientManager.discoverAllMcpTools(this.config);
  }

  /**
   * Discovers tools from project (if available and configured).
   * Can be called multiple times to update discovered tools.
   * This will NOT discover tools from the command line, only from MCP servers.
   */
  async discoverMcpTools(): Promise<void> {
    // remove any previously discovered tools
    this.removeDiscoveredTools();

    this.config.getPromptRegistry().clear();
    this.config.getResourceRegistry().clear();

    // discover tools using MCP servers, if configured
    await this.mcpClientManager.discoverAllMcpTools(this.config);
  }

  /**
   * Restarts all MCP servers and re-discovers tools.
   */
  async restartMcpServers(): Promise<void> {
    await this.discoverMcpTools();
  }

  /**
   * Discover or re-discover tools for a single MCP server.
   * @param serverName - The name of the server to discover tools from.
   */
  async discoverToolsForServer(serverName: string): Promise<void> {
    // R2-1: dedup concurrent passes per server. The second caller awaits
    // the first pass's outcome (it must still observe it — one layer down
    // the manager's `serverDiscoveryPromises` established that contract)
    // but never runs its own snapshot+purge: purging here while the first
    // pass is mid-rediscovery deletes that pass's freshly registered
    // tools, and because the deduped discovery RESOLVES, no restore would
    // put them back — a CONNECTED server left with zero registrations.
    const inFlight = this.serverDiscoveryInFlight.get(serverName);
    if (inFlight) {
      return inFlight;
    }
    // Capture the teardown generation before the await; the resolve-path
    // restore is suppressed if a teardown path bumped it mid-pass (R3-7).
    const discoveryGeneration =
      this.serverTeardownGeneration.get(serverName) ?? 0;
    // Capture the reveal-reset epoch too: a mid-pass `/clear` deliberately
    // drops reveal state, and the restore must not replay its pre-pass
    // snapshot over that decision (R5-48 round 6).
    const revealEpoch = this.revealResetEpoch;
    const run = this.discoverToolsForServerInner(
      serverName,
      discoveryGeneration,
      revealEpoch,
    ).finally(() => {
      // Identity-check the eviction (R7-1 round 7): a teardown between
      // two passes deliberately deletes the dedup entry
      // (`markMcpServerTornDown`) so pass B installs its OWN entry; a
      // late-settling pass A must not then delete by name and unhook
      // B — a pass C would start concurrently with B, purge B's
      // freshly registered tools after snapshotting them, and skip the
      // restore on the all-empty leg.
      if (this.serverDiscoveryInFlight.get(serverName) === run) {
        this.serverDiscoveryInFlight.delete(serverName);
      }
    });
    this.serverDiscoveryInFlight.set(serverName, run);
    return run;
  }

  private async discoverToolsForServerInner(
    serverName: string,
    discoveryGeneration: number,
    revealEpoch: number,
  ): Promise<void> {
    // Snapshot the server's current registrations so a FAILED rediscovery
    // can put them back. The purge below runs before the await, so without
    // restoration a failed rediscovery leaves the server with no tools for
    // the rest of the session — nothing else re-registers them (the
    // manager's internal catch only logs). Cancel-triggered recovery is
    // exactly the caller that must not widen that window.
    const previousTools: DiscoveredMCPTool[] = [];
    const previousRevealed: Array<[string, boolean]> = [];
    for (const [name, tool] of this.tools.entries()) {
      if (tool instanceof DiscoveredMCPTool && tool.serverName === serverName) {
        previousTools.push(tool);
        previousRevealed.push([name, this.revealedDeferred.has(name)]);
        // Drop reveal state too so a re-discovered tool of the same
        // name doesn't inherit a `revealed: true` from before the
        // disconnect (would surface in declarations immediately after
        // reconnection).
        this.revealedDeferred.delete(name);
        this.tools.delete(name);
      }
    }
    const previousPrompts = this.config
      .getPromptRegistry()
      .getPromptsByServer(serverName);
    const previousResources = this.config
      .getResourceRegistry()
      .getResourcesByServer(serverName);

    this.config.getPromptRegistry().removePromptsByServer(serverName);
    this.config.getResourceRegistry().removeResourcesByServer(serverName);

    try {
      await this.mcpClientManager.discoverMcpToolsForServer(
        serverName,
        this.config,
      );
      // R1-3: on the legacy path the manager RESOLVES even for a failed
      // rediscovery (the internal catch logs and deliberately does not
      // rethrow; five policy early-returns also resolve without
      // registering). The restore must therefore fire on the observed
      // OUTCOME — a server that had registrations and came back with
      // none — not only on a rejection.
      //
      // R3-3/R3-5/R1-3 (round 4): each registry is gated on ITS OWN
      // emptiness, and only a deliberate teardown (the
      // `markMcpServerTornDown` generation bump) or an operator
      // filter/policy removal (R1-3 round 4) suppresses the restore.
      // - gating prompts on `previousTools.length` dropped a prompt-only
      //   server's registrations forever (R3-3);
      // - restoring prompts into a non-empty prompt registry hits
      //   `registerPrompt`'s rename-on-collision and leaves a
      //   `<server>_<prompt>` ghost bound to the dead client (R3-5);
      // - restoring tools the operator's CURRENT includeTools/excludeTools
      //   just filtered out re-exposes excluded tools (R1-3 entrance 1);
      // - restoring after the server was torn down mid-pass undoes the
      //   teardown (R3-7).
      const restoreCandidates = this.restoreEligibleSnapshot(
        serverName,
        previousTools,
        previousPrompts,
        previousResources,
        discoveryGeneration,
      );
      if (restoreCandidates) {
        this.restoreServerRegistrations(
          serverName,
          restoreCandidates.tools,
          restoreCandidates.prompts,
          restoreCandidates.resources,
          previousRevealed,
          revealEpoch,
        );
      }
    } catch (error) {
      // Rediscovery failed: the old registrations point at a client the
      // manager has already disconnected, but they are still the best
      // available state — `ensureTool` keeps resolving them and the
      // connection-error paths (`shouldAttemptReconnect`) can repair on
      // the next call. An empty registry would leave the server's tools
      // uncallable instead, with no path back short of a full restart.
      // The SAME gates as the resolve leg apply (R4-2 round 5): a
      // rejection is not a licence to restore what a teardown or a
      // policy removal just removed. Best-effort and deliberately
      // silent about re-registration errors: the original discovery
      // error is the one callers should see.
      const restoreCandidates = this.restoreEligibleSnapshot(
        serverName,
        previousTools,
        previousPrompts,
        previousResources,
        discoveryGeneration,
      );
      if (restoreCandidates) {
        this.restoreServerRegistrations(
          serverName,
          restoreCandidates.tools,
          restoreCandidates.prompts,
          restoreCandidates.resources,
          previousRevealed,
          revealEpoch,
        );
      }
      throw error;
    }
  }

  /**
   * The gated snapshot both restore legs share (R4-2 round 5): returns
   * the tools/prompts/resources a restore may put back, or undefined
   * when every gate refuses. The legs used to diverge — the resolve leg
   * checked teardown / policy / per-registry emptiness / operator
   * filters while the reject leg restored the snapshot unconditionally
   * — and the gate computation itself sat inside the `try`, so a
   * malformed filter shape (`excludeTools: "x"` reaches settings
   * uncoerced) threw the pass straight into the ungated leg.
   */
  private restoreEligibleSnapshot(
    serverName: string,
    previousTools: DiscoveredMCPTool[],
    previousPrompts: ReturnType<PromptRegistry['getPromptsByServer']>,
    previousResources: ReturnType<ResourceRegistry['getResourcesByServer']>,
    discoveryGeneration: number,
  ):
    | {
        tools: DiscoveredMCPTool[];
        prompts: ReturnType<PromptRegistry['getPromptsByServer']>;
        resources: ReturnType<ResourceRegistry['getResourcesByServer']>;
      }
    | undefined {
    const generationNow = this.serverTeardownGeneration.get(serverName) ?? 0;
    const tornDownWhilePending = generationNow !== discoveryGeneration;
    if (tornDownWhilePending) {
      return undefined;
    }
    // Copied-in registrations (per-agent registries seeded from the
    // parent's) carry the PARENT's clients; this registry's manager
    // never produced them. A failed override discovery must fail closed
    // instead of re-exposing the session-level connection (R4-3).
    if (this.copiedMcpServers.has(serverName)) {
      return undefined;
    }
    if (this.isPolicyRemoved(serverName)) {
      return undefined;
    }
    const tools =
      this.countMcpToolsForServer(serverName) === 0
        ? this.snapshotFilterPassingTools(serverName, previousTools)
        : [];
    const prompts =
      this.config.getPromptRegistry().getPromptsByServer(serverName).length ===
      0
        ? previousPrompts
        : [];
    const resources =
      this.config.getResourceRegistry().getResourcesByServer(serverName)
        .length === 0
        ? previousResources
        : [];
    if (tools.length === 0 && prompts.length === 0 && resources.length === 0) {
      return undefined;
    }
    return { tools, prompts, resources };
  }

  private countMcpToolsForServer(serverName: string): number {
    let count = 0;
    for (const tool of this.tools.values()) {
      if (tool instanceof DiscoveredMCPTool && tool.serverName === serverName) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Whether the operator's CURRENT policy removes this server from the
   * session entirely — a restore after such a removal would re-expose
   * tools bound to a client the manager will never hand out again.
   *
   * Asks the authority instead of re-deriving it (R4-1 round 5): the
   * config recipe is `getEffectiveMcpServers()` (settings plus the
   * `mcpServerCommand`-derived `mcp` server), and the manager's own
   * recorded budget refusal (`wasRefused`) plus its `stopped` state
   * cover the deliberate refusals the config gates cannot see. A
   * budget-refused server resolving without registering must NOT be
   * mistaken for a dead server whose snapshot belongs back.
   */
  private isPolicyRemoved(serverName: string): boolean {
    const effective = populateMcpServerCommand(
      this.config.getMcpServers() || {},
      this.config.getMcpServerCommand(),
      this.config.getTargetDir(),
    );
    const serverConfig =
      effective[serverName] ?? this.config.getRuntimeMcpServers?.()[serverName];
    return (
      !serverConfig ||
      this.config.isMcpServerDisabled?.(serverName) === true ||
      this.config.isMcpServerPendingApproval?.(serverName) === true ||
      this.config.isTrustedFolder?.() === false ||
      this.mcpClientManager.wasRefused(serverName) ||
      this.mcpClientManager.isStopped()
    );
  }

  /**
   * The snapshot tools the operator's CURRENT includeTools/excludeTools
   * still admit, filtered with the SAME predicate discovery uses —
   * `isEnabled` from `mcp-client.js`, so the restore can never drift
   * from discovery on any axis (R1-3 round 6): a JSON `null` allow-list
   * is absent (allow all), `[]` is allow-none, a string excludeTools is
   * substring-excluded. The round-5 re-derivation diverged from
   * `isEnabled` on exactly those shapes.
   */
  private snapshotFilterPassingTools(
    serverName: string,
    tools: DiscoveredMCPTool[],
  ): DiscoveredMCPTool[] {
    const effective = populateMcpServerCommand(
      this.config.getMcpServers() || {},
      this.config.getMcpServerCommand(),
      this.config.getTargetDir(),
    );
    const serverConfig =
      effective[serverName] ?? this.config.getRuntimeMcpServers?.()[serverName];
    if (!serverConfig) {
      return [];
    }
    return tools.filter((tool) =>
      isEnabled({ name: tool.serverToolName }, serverName, serverConfig),
    );
  }

  private restoreServerRegistrations(
    _serverName: string,
    previousTools: DiscoveredMCPTool[],
    previousPrompts: ReturnType<PromptRegistry['getPromptsByServer']>,
    previousResources: ReturnType<ResourceRegistry['getResourcesByServer']>,
    previousRevealed: Array<[string, boolean]>,
    revealEpoch: number,
  ): void {
    try {
      for (const tool of previousTools) {
        this.registerTool(tool);
      }
      // Replay reveal state only when no deliberate reveal reset (e.g.
      // `/clear`) landed mid-pass — otherwise the snapshot would re-reveal
      // tools in the fresh session the operator just cleared (R5-48
      // round 6). Pinned reveals are exempt: they are session-setup
      // state `clearRevealedDeferredTools` itself re-establishes.
      const revealResetLanded = revealEpoch !== this.revealResetEpoch;
      for (const [name, revealed] of previousRevealed) {
        if (
          revealed &&
          (!revealResetLanded || this.pinnedDeferredReveals.has(name))
        ) {
          this.revealedDeferred.add(name);
        }
      }
      for (const prompt of previousPrompts) {
        this.config.getPromptRegistry().registerPrompt(prompt);
      }
      for (const resource of previousResources) {
        this.config.getResourceRegistry().registerResource(resource);
      }
    } catch (restoreError) {
      debugLogger.error(
        `Failed to restore registrations for MCP server '${_serverName}' after rediscovery failure: ${restoreError}`,
      );
    }
  }

  private async discoverAndRegisterToolsFromCommand(): Promise<void> {
    const discoveryCmd = this.config.getToolDiscoveryCommand();
    if (!discoveryCmd) {
      return;
    }

    try {
      const cmdParts = parse(discoveryCmd);
      if (cmdParts.length === 0) {
        throw new Error(
          'Tool discovery command is empty or contains only whitespace.',
        );
      }
      // Same as the tool-call command above: the discovery command is
      // agent-launched, must not inherit Qwen-internal daemon secrets, and
      // needs the Windows PATH normalization that comes with an explicit env.
      const proc = spawn(cmdParts[0] as string, cmdParts.slice(1) as string[], {
        env: normalizePathEnvForWindows(sanitizeChildEnv(process.env)),
      });
      let stdout = '';
      const stdoutDecoder = new StringDecoder('utf8');
      let stderr = '';
      const stderrDecoder = new StringDecoder('utf8');
      let sizeLimitExceeded = false;
      const MAX_STDOUT_SIZE = 10 * 1024 * 1024; // 10MB limit
      const MAX_STDERR_SIZE = 10 * 1024 * 1024; // 10MB limit

      let stdoutByteLength = 0;
      let stderrByteLength = 0;

      proc.stdout.on('data', (data) => {
        if (sizeLimitExceeded) return;
        if (stdoutByteLength + data.length > MAX_STDOUT_SIZE) {
          sizeLimitExceeded = true;
          proc.kill();
          return;
        }
        stdoutByteLength += data.length;
        stdout += stdoutDecoder.write(data);
      });

      proc.stderr.on('data', (data) => {
        if (sizeLimitExceeded) return;
        if (stderrByteLength + data.length > MAX_STDERR_SIZE) {
          sizeLimitExceeded = true;
          proc.kill();
          return;
        }
        stderrByteLength += data.length;
        stderr += stderrDecoder.write(data);
      });

      await new Promise<void>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', (code) => {
          stdout += stdoutDecoder.end();
          stderr += stderrDecoder.end();

          if (sizeLimitExceeded) {
            return reject(
              new Error(
                `Tool discovery command output exceeded size limit of ${MAX_STDOUT_SIZE} bytes.`,
              ),
            );
          }

          if (code !== 0) {
            debugLogger.error(
              `Tool discovery command failed with code ${code}`,
            );
            debugLogger.error(stderr);
            return reject(
              new Error(`Tool discovery command failed with exit code ${code}`),
            );
          }
          resolve();
        });
      });

      // execute discovery command and extract function declarations (w/ or w/o "tool" wrappers)
      const functions: FunctionDeclaration[] = [];
      const discoveredItems = JSON.parse(stdout.trim());

      if (!discoveredItems || !Array.isArray(discoveredItems)) {
        throw new Error(
          'Tool discovery command did not return a JSON array of tools.',
        );
      }

      for (const tool of discoveredItems) {
        if (tool && typeof tool === 'object') {
          if (Array.isArray(tool['function_declarations'])) {
            functions.push(...tool['function_declarations']);
          } else if (Array.isArray(tool['functionDeclarations'])) {
            functions.push(...tool['functionDeclarations']);
          } else if (tool['name']) {
            functions.push(tool as FunctionDeclaration);
          }
        }
      }
      // register each function as a tool
      //
      // The same PermissionManager gate that createToolRegistry applies to
      // built-ins (via registerLazy) applies here too, with the same
      // three-state outcome. A discovered tool the `tools.eager` allowlist
      // omits is DEFERRED, not dropped: its schema stays out of the eager
      // model request (the #9827 guarantee) while the tool remains listed
      // in `/tools` and reachable on demand through the stable ToolSearch +
      // ToolCall bridge. Dropping it instead would recreate exactly the
      // silent-disappearance bug that #10075 reported for built-ins, just
      // under a different knob. Whole-tool deny rules still remove the tool
      // outright ("a whole-tool deny rule also removes the tool from the
      // registry", settings.md), and deny rules still apply at runtime
      // regardless.
      const permissionManager = this.config.getPermissionManager?.();
      for (const func of functions) {
        if (!func.name) {
          debugLogger.warn('Discovered a tool with no name. Skipping.');
          continue;
        }
        let deferred = false;
        if (permissionManager) {
          const status = await permissionManager.getToolRegistrationStatus(
            func.name,
          );
          if (status === 'disabled') {
            debugLogger.info(
              `Discovered tool "${func.name}" skipped: removed by a whole-tool deny rule or the legacy coreTools allowlist.`,
            );
            continue;
          }
          deferred = status === 'deferred';
        }
        const parameters =
          func.parametersJsonSchema &&
          typeof func.parametersJsonSchema === 'object' &&
          !Array.isArray(func.parametersJsonSchema)
            ? func.parametersJsonSchema
            : {};
        this.registerTool(
          new DiscoveredTool(
            this.config,
            func.name,
            func.description ?? '',
            parameters as Record<string, unknown>,
          ),
        );
        // Mark AFTER registerTool so every deferred-hiding decision
        // (getFunctionDeclarations / isDeferredAndHidden /
        // getDeferredToolSummary) treats it like a `shouldDefer` tool.
        if (deferred) {
          this.permissionDeferred.add(func.name);
        }
      }
    } catch (e) {
      debugLogger.error(`Tool discovery command "${discoveryCmd}" failed:`, e);
      throw e;
    }
  }

  /**
   * Retrieves the list of tool schemas (FunctionDeclaration array).
   * Extracts the declarations from the ToolListUnion structure.
   * Includes discovered (vs registered) tools if configured.
   *
   * By default, tools marked `shouldDefer=true` are excluded (they are
   * discovered and invoked by the model through the stable bridge). Pass
   * `{ includeDeferred: true }` to include them, e.g. for diagnostics.
   *
   * Tools marked `alwaysLoad=true` are always included regardless of
   * `shouldDefer`.
   *
   * @returns An array of FunctionDeclarations.
   */
  getFunctionDeclarations(options?: {
    includeDeferred?: boolean;
  }): FunctionDeclaration[] {
    if (this.config.getToolMode?.() === ToolMode.CodeModeOnly) {
      return this.getCodeModeFunctionDeclarations();
    }
    const includeDeferred = options?.includeDeferred === true;
    return Array.from(this.tools.values())
      .filter((tool) => this.isToolAvailable(tool.name))
      .filter((tool) => this.isToolDeclared(tool.name))
      .filter(
        (tool) =>
          includeDeferred ||
          !this.isEffectivelyDeferred(tool) ||
          tool.alwaysLoad ||
          !this.isDeferredAndHidden(tool.name),
      )
      .sort(ToolRegistry.compareToolsByDeclarationName)
      .map((tool) => tool.schema);
  }

  private getCodeModeFunctionDeclarations(
    allowedNames?: ReadonlySet<string>,
  ): FunctionDeclaration[] {
    const plan = this.getCodeModeBindingPlan(allowedNames);
    return Array.from(this.tools.values())
      .filter((tool) => {
        const exposure = getToolExposure(tool.name);
        if (exposure === 'exec') return true;
        return (
          exposure === 'direct-only' &&
          (!allowedNames || allowedNames.has(tool.name))
        );
      })
      .sort(ToolRegistry.compareCodeModeTools)
      .map((tool) =>
        tool.name === ToolNames.EXEC
          ? buildExecDeclaration(tool, plan)
          : tool.schema,
      );
  }

  getCodeModeBindingPlan(
    allowedNames?: ReadonlySet<string>,
  ): CodeModeBindingPlan {
    const plan = planCodeModeBindings(
      Array.from(this.tools.values()).filter(
        (tool) =>
          this.isToolAvailable(tool.name) && this.isToolDeclared(tool.name),
      ),
      (name) => this.isDeferredAndHidden(name),
      allowedNames,
    );
    this.warnCodeModeCollisions(plan);
    return plan;
  }

  private warnCodeModeCollisions(plan: CodeModeBindingPlan): void {
    for (const collision of plan.collisions) {
      const key = `${collision.jsName}:${collision.kept}:${collision.omitted}`;
      if (this.codeModeCollisionWarnings.has(key)) continue;
      this.codeModeCollisionWarnings.add(key);
      debugLogger.warn(
        `Code mode tool "${collision.omitted}" is unavailable because its JavaScript name ` +
          `tools.${collision.jsName} collides with "${collision.kept}".`,
      );
    }
  }

  /**
   * Marks a deferred tool as revealed. Revealed tools are included in
   * {@link getFunctionDeclarations} output for the rest of the session, even
   * though they are normally hidden. Used by startup preload, plan lifecycle
   * setup, and compatibility replay for histories with direct deferred calls.
   */
  revealDeferredTool(name: string): void {
    this.revealedDeferred.add(name);
  }

  /**
   * Marks a deferred tool's reveal as session-setup state that must survive
   * `/clear` resets: {@link clearRevealedDeferredTools} re-reveals pinned
   * tools (while still registered and deferred) so the fresh session's
   * `startChat` → `setTools()` re-declares them. Without a pin, a tool
   * revealed at session creation silently drops out of the declaration list
   * on the first `/clear` whenever the budget-based startup preload
   * withholds it — that preload is all-or-nothing on a schema-size budget
   * and returns early when preloading is disabled.
   */
  pinDeferredToolReveal(name: string): void {
    this.pinnedDeferredReveals.add(name);
  }

  /**
   * Removes a single tool from the revealed-deferred set. Used to roll back an
   * explicit reveal when the corresponding declaration refresh fails.
   */
  unrevealDeferredTool(name: string): void {
    this.revealedDeferred.delete(name);
  }

  /** Whether a given tool has been revealed via {@link revealDeferredTool}. */
  isDeferredToolRevealed(name: string): boolean {
    return this.revealedDeferred.has(name);
  }

  /**
   * Whether a deferred tool is currently hidden from the model's
   * function-declaration list. Returns `true` when the tool:
   * - is deferred (`shouldDefer=true`, or demoted by an active
   *   `settings.tools.eager` allowlist, #10075),
   * - is not always-loaded,
   * - has not been revealed this session, AND
   * - is not in the visibleTools config list.
   */
  isDeferredAndHidden(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    return (
      this.isEffectivelyDeferred(tool) &&
      !tool.alwaysLoad &&
      !this.revealedDeferred.has(name) &&
      !this.config.getVisibleTools().has(name)
    );
  }

  /**
   * Clears the set of revealed deferred tools. Called by {@link LlmClient}
   * when a chat session is reset (e.g. `/clear`) so the new session starts
   * with no transient deferred reveals — the same state as any fresh
   * session. Session-setup reveals pinned via {@link pinDeferredToolReveal}
   * survive the reset (while still registered and deferred): they are part
   * of that fresh session's setup, not of the dropped session's discovery.
   */
  clearRevealedDeferredTools(): void {
    this.revealedDeferred.clear();
    // A discovery pass pending across this reset must not replay its
    // pre-pass reveal snapshot over the fresh session (R5-48 round 6).
    this.revealResetEpoch += 1;
    for (const name of this.pinnedDeferredReveals) {
      const tool = this.tools.get(name);
      if (tool && this.isEffectivelyDeferred(tool) && !tool.alwaysLoad) {
        this.revealedDeferred.add(name);
      }
    }
  }

  /**
   * Returns a lightweight summary of tools that are
   * deferred from the initial function-declaration list. Used to describe the
   * set of on-demand tools in the startup reminder so the model knows what is
   * reachable via ToolSearch + ToolCall. `alwaysLoad` tools and tools listed in
   * {@link Config.getVisibleTools} are excluded.
   *
   * Always empty in CodeModeOnly: every schema is already bound into the `exec`
   * description and ToolSearch is hidden, so a reminder built from this summary
   * would offer a lookup step the model has no way to take.
   */
  getDeferredToolSummary(): DeferredToolSummary[] {
    if (this.config.getToolMode?.() === ToolMode.CodeModeOnly) {
      return [];
    }
    const summary: DeferredToolSummary[] = [];
    this.tools.forEach((tool) => {
      if (
        this.isToolAvailable(tool.name) &&
        this.isEffectivelyDeferred(tool) &&
        !tool.alwaysLoad &&
        this.isToolDeclared(tool.name) &&
        !this.config.getVisibleTools().has(tool.name)
      ) {
        summary.push({
          name: tool.name,
          description: tool.description,
          ...(tool instanceof DiscoveredMCPTool
            ? { serverName: tool.serverName }
            : {}),
        });
      }
    });
    // Stable order so the startup reminder text is deterministic across runs.
    summary.sort((a, b) => a.name.localeCompare(b.name));
    return summary;
  }

  /**
   * Reveals every deferred tool — bundled built-ins and MCP alike — when
   * the combined estimated token footprint of their schemas fits within
   * `budgetTokens`. A small deferred set can be cheaper to declare upfront
   * than to pay for bridge round trips. All-or-nothing on purpose — a partial
   * reveal would leave an arbitrary subset behind the bridge.
   *
   * Already-revealed tools count toward the total (reveal is
   * idempotent), so repeated calls cannot ratchet past the budget as MCP
   * servers come and go. Returns the number of newly revealed tools.
   */
  preloadDeferredToolsWithinBudget(budgetTokens: number): number {
    const candidates: string[] = [];
    let totalChars = 0;
    for (const tool of this.tools.values()) {
      if (!this.isToolAvailable(tool.name)) continue;
      if (!this.isEffectivelyDeferred(tool) || tool.alwaysLoad) continue;
      // Permission-deferred tools (#10075) are deliberately excluded: the
      // budget preload exists to stabilise the prompt cache for ordinary
      // deferred tools, but auto-revealing a demoted tool would re-add
      // exactly the schema the `settings.tools.eager` allowlist keeps out
      // of the eager request (#9827). Such tools stay reachable on demand
      // via ToolSearch + ToolCall.
      if (this.permissionDeferred.has(tool.name)) continue;
      if (this.config.getVisibleTools().has(tool.name)) continue;
      candidates.push(tool.name);
      totalChars += JSON.stringify(tool.schema).length;
    }
    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    if (candidates.length === 0) {
      debugLogger.debug(
        `preloadDeferredToolsWithinBudget: no deferrable tools to preload (budget=${budgetTokens} tokens).`,
      );
      return 0;
    }
    if (estimatedTokens > budgetTokens) {
      debugLogger.debug(
        `preloadDeferredToolsWithinBudget: keeping ${candidates.length} deferred tool(s) behind ToolSearch + ToolCall ` +
          `(estimated ${estimatedTokens} tokens > budget ${budgetTokens} tokens).`,
      );
      return 0;
    }
    let revealed = 0;
    for (const name of candidates) {
      if (!this.revealedDeferred.has(name)) {
        this.revealDeferredTool(name);
        revealed++;
      }
    }
    debugLogger.debug(
      `preloadDeferredToolsWithinBudget: preloading ${candidates.length} deferred tool(s) ` +
        `(estimated ${estimatedTokens} tokens <= budget ${budgetTokens} tokens); ${revealed} newly revealed.`,
    );
    return revealed;
  }

  getMcpServerInstructions(): Map<string, string> {
    return this.mcpClientManager.getServerInstructions();
  }

  /**
   * Retrieves a filtered list of tool schemas based on a list of tool names.
   * @param toolNames - An array of tool names to include.
   * @returns An array of FunctionDeclarations for the specified tools.
   * @remarks Requires all tool factories to be resolved first. Call
   * {@link warmAll} before invoking this method, otherwise factory-registered
   * tools that have not yet been loaded will be silently omitted.
   */
  getFunctionDeclarationsFiltered(toolNames: string[]): FunctionDeclaration[] {
    if (this.factories.size > 0) {
      debugLogger.warn(
        `getFunctionDeclarationsFiltered() called with ${this.factories.size} unloaded ` +
          `tool factories. Call warmAll() first to avoid incomplete results.`,
      );
    }
    if (this.config.getToolMode?.() === ToolMode.CodeModeOnly) {
      return this.getCodeModeFunctionDeclarations(new Set(toolNames));
    }
    const declarations: FunctionDeclaration[] = [];
    for (const name of toolNames) {
      const tool = this.getTool(name);
      if (tool && this.isToolDeclared(tool.name)) {
        declarations.push(tool.schema);
      }
    }
    return declarations;
  }

  isToolDeclared(name: string): boolean {
    const tool = this.tools.get(name);
    if (tool && isMediaPolicyToolHiddenFromModel(this.config, tool)) {
      return false;
    }
    return (
      name !== ToolNames.PROPOSE_GOAL || this.config.isGoalProposalAvailable()
    );
  }

  /**
   * Returns an array of all registered and discovered tool names,
   * including tools that are registered via factory but not yet loaded.
   */
  getAllToolNames(): string[] {
    const names = new Set([...this.tools.keys(), ...this.factories.keys()]);
    return Array.from(names).filter((name) => this.isToolAvailable(name));
  }

  /**
   * Returns an array of all registered and discovered tool instances.
   * @remarks Requires all tool factories to be resolved first. Call
   * {@link warmAll} before invoking this method, otherwise factory-registered
   * tools that have not yet been loaded will be absent from the result.
   */
  getAllTools(): AnyDeclarativeTool[] {
    if (this.factories.size > 0) {
      debugLogger.warn(
        `getAllTools() called with ${this.factories.size} unloaded tool factories. ` +
          `Call warmAll() first to avoid incomplete results.`,
      );
    }
    return Array.from(this.tools.values())
      .filter((tool) => this.isToolAvailable(tool.name))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * Returns an array of tools registered from a specific MCP server.
   */
  getToolsByServer(serverName: string): AnyDeclarativeTool[] {
    const serverTools: AnyDeclarativeTool[] = [];
    for (const tool of this.tools.values()) {
      if ((tool as DiscoveredMCPTool)?.serverName === serverName) {
        serverTools.push(tool);
      }
    }
    return serverTools.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get the definition of a specific tool.
   */
  getTool(name: string): AnyDeclarativeTool | undefined {
    return this.isToolAvailable(name) ? this.tools.get(name) : undefined;
  }

  async readMcpResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    if (!this.config.isTrustedFolder()) {
      throw new Error('MCP resources are unavailable in untrusted folders.');
    }

    return this.mcpClientManager.readResource(serverName, uri, options);
  }

  /**
   * Stops all MCP clients, disposes tools, and cleans up resources.
   * This method is idempotent and safe to call multiple times.
   */
  async stop(): Promise<void> {
    // Wait for any in-flight factory promises to settle before disposing, so
    // that tools which finish loading after stop() is called are still cleaned
    // up rather than leaking their listeners and resources.
    if (this.inflight.size > 0) {
      await Promise.allSettled(this.inflight.values());
    }

    for (const tool of this.tools.values()) {
      if ('dispose' in tool && typeof tool.dispose === 'function') {
        try {
          tool.dispose();
        } catch (error) {
          debugLogger.error(`Error disposing tool ${tool.name}:`, error);
        }
      }
    }

    try {
      await this.mcpClientManager.stop();
    } catch (error) {
      // Log but don't throw - cleanup should be best-effort
      debugLogger.error('Error stopping MCP clients:', error);
    }
  }
}
