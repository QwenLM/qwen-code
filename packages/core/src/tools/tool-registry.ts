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
import type { Config } from '../config/config.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { SendSdkMcpMessage } from './mcp-client.js';
import { removeMCPServerStatus } from './mcp-client.js';
import { McpClientManager } from './mcp-client-manager.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import { parse } from 'shell-quote';
import { ToolErrorType } from './tool-error.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import type { EventEmitter } from 'node:events';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

type ToolParams = Record<string, unknown>;

/** Factory function for lazy tool instantiation via dynamic import. */
export type ToolFactory = () => Promise<AnyDeclarativeTool>;

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
    const child = spawn(callCommand, [this.toolName]);
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
  private inflight: Map<string, Promise<AnyDeclarativeTool>> = new Map();
  // Deferred tools that ToolSearch has loaded this session. Once revealed, a
  // tool's schema is included in subsequent function-declaration lists even
  // though it would normally be hidden.
  private revealedDeferred: Set<string> = new Set();
  private config: Config;
  private mcpClientManager: McpClientManager;

  constructor(
    config: Config,
    eventEmitter?: EventEmitter,
    sendSdkMcpMessage?: SendSdkMcpMessage,
  ) {
    this.config = config;
    this.mcpClientManager = new McpClientManager(
      this.config,
      this,
      eventEmitter,
      sendSdkMcpMessage,
    );
  }

  /**
   * Registers a tool definition.
   * @param tool - The tool object containing schema and execution logic.
   */
  registerTool(tool: AnyDeclarativeTool): void {
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
    this.tools.set(tool.name, tool);
  }

  /**
   * Registers a lazy tool factory. The tool module is not imported and the tool
   * is not instantiated until {@link ensureTool} or {@link warmAll} is called.
   */
  registerFactory(name: string, factory: ToolFactory): void {
    this.factories.set(name, factory);
  }

  /**
   * Ensures a specific tool is loaded. Returns the cached instance if already
   * loaded, otherwise invokes the factory, caches the result, and returns it.
   * Concurrent calls for the same name share a single in-flight promise so the
   * factory is never executed more than once.
   */
  async ensureTool(name: string): Promise<AnyDeclarativeTool | undefined> {
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
        return tool;
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
    for (const tool of source.tools.values()) {
      if (
        (tool instanceof DiscoveredTool || tool instanceof DiscoveredMCPTool) &&
        !this.tools.has(tool.name)
      ) {
        this.tools.set(tool.name, tool);
      }
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
   * Removes all tools from a specific MCP server.
   * @param serverName The name of the server to remove tools from.
   */
  removeMcpToolsByServer(serverName: string): void {
    for (const [name, tool] of this.tools.entries()) {
      if (tool instanceof DiscoveredMCPTool && tool.serverName === serverName) {
        this.tools.delete(name);
        // Drop reveal state for the removed tool. Otherwise a server
        // disconnect → reconnect cycle that re-registers a tool of
        // the same name would inherit `revealed: true` from the prior
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

    // Remove prompts
    this.config.getPromptRegistry().removePromptsByServer(serverName);

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

    // Remove prompts
    this.config.getPromptRegistry().removePromptsByServer(serverName);

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
        if (!currentExcluded.includes(serverName)) {
          this.config.setExcludedMcpServers([...currentExcluded, serverName]);
        }
      } finally {
        // Always drop the server from the global status registry — even
        // if disconnect or the exclusion-list update throws — so the
        // Footer's MCP health pill stops counting it as "offline". A
        // leftover entry would resurrect the bug from #3895.
        removeMCPServerStatus(serverName);
      }
    }
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
    // Remove any previously discovered tools from this server
    for (const [name, tool] of this.tools.entries()) {
      if (tool instanceof DiscoveredMCPTool && tool.serverName === serverName) {
        this.tools.delete(name);
        // Drop reveal state too so a re-discovered tool of the same
        // name doesn't inherit a `revealed: true` from before the
        // disconnect (would surface in declarations before any
        // ToolSearch call this session).
        this.revealedDeferred.delete(name);
      }
    }

    this.config.getPromptRegistry().removePromptsByServer(serverName);

    await this.mcpClientManager.discoverMcpToolsForServer(
      serverName,
      this.config,
    );
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
      const proc = spawn(cmdParts[0] as string, cmdParts.slice(1) as string[]);
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
      for (const func of functions) {
        if (!func.name) {
          debugLogger.warn('Discovered a tool with no name. Skipping.');
          continue;
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
   * discovered by the model on demand via the ToolSearch tool). Pass
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
    const includeDeferred = options?.includeDeferred === true;
    const declarations: FunctionDeclaration[] = [];
    this.tools.forEach((tool) => {
      if (
        !includeDeferred &&
        tool.shouldDefer &&
        !tool.alwaysLoad &&
        !this.revealedDeferred.has(tool.name)
      ) {
        return;
      }
      declarations.push(tool.schema);
    });
    return declarations;
  }

  /**
   * Marks a deferred tool as revealed. Revealed tools are included in
   * {@link getFunctionDeclarations} output for the rest of the session, even
   * though they are normally hidden. Called by the ToolSearch tool after it
   * successfully loads a tool so the model can invoke it on subsequent turns.
   */
  revealDeferredTool(name: string): void {
    this.revealedDeferred.add(name);
  }

  /**
   * Removes a single tool from the revealed-deferred set. Used for rollback
   * when a `setTools()` re-sync fails after revealing — leaving the tool
   * "revealed" in the registry while the chat's declaration list never
   * received the schema would mean future ToolSearch keyword queries
   * exclude the tool (per `collectCandidates`'s isDeferredToolRevealed
   * filter), making it unreachable until `/clear`.
   */
  unrevealDeferredTool(name: string): void {
    this.revealedDeferred.delete(name);
  }

  /** Whether a given tool has been revealed via {@link revealDeferredTool}. */
  isDeferredToolRevealed(name: string): boolean {
    return this.revealedDeferred.has(name);
  }

  /**
   * Clears the set of revealed deferred tools. Called by {@link GeminiClient}
   * when a chat session is reset (e.g. `/clear`) so the new session starts
   * with no revealed tools — the same state as any fresh session.
   */
  clearRevealedDeferredTools(): void {
    this.revealedDeferred.clear();
  }

  /**
   * Returns a lightweight summary ({name, description}) of tools that are
   * deferred from the initial function-declaration list. Used to describe the
   * set of on-demand tools in the system prompt so the model knows what is
   * reachable via ToolSearch. `alwaysLoad` tools are excluded.
   */
  getDeferredToolSummary(): Array<{ name: string; description: string }> {
    const summary: Array<{ name: string; description: string }> = [];
    this.tools.forEach((tool) => {
      if (tool.shouldDefer && !tool.alwaysLoad) {
        summary.push({ name: tool.name, description: tool.description });
      }
    });
    // Stable order so the system prompt text is deterministic across runs.
    summary.sort((a, b) => a.name.localeCompare(b.name));
    return summary;
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
    const declarations: FunctionDeclaration[] = [];
    for (const name of toolNames) {
      const tool = this.tools.get(name);
      if (tool) {
        declarations.push(tool.schema);
      }
    }
    return declarations;
  }

  /**
   * Returns an array of all registered and discovered tool names,
   * including tools that are registered via factory but not yet loaded.
   */
  getAllToolNames(): string[] {
    const names = new Set([...this.tools.keys(), ...this.factories.keys()]);
    return Array.from(names);
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
    return Array.from(this.tools.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
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
    return this.tools.get(name);
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
