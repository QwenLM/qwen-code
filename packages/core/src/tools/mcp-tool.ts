/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import type {
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolMcpConfirmationDetails,
  ToolResult,
  ToolResultDisplay,
  ToolConfirmationPayload,
  McpToolProgressData,
  ToolConfirmationOutcome,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type {
  CallableTool,
  FunctionCall,
  Part,
  PartListUnion,
} from '@google/genai';
import { StructuredToolError, ToolErrorType } from './tool-error.js';
import type { Config } from '../config/config.js';
import { truncateToolOutput } from '../utils/truncation.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';
import {
  getAllMCPServerStatuses,
  getMCPServerStatus,
  MCPServerStatus,
} from './mcp-status.js';
import {
  getInvocationContext,
  INVOCATION_CONTEXT_META_KEY,
} from '../utils/invocation-context.js';
import {
  generateLegacyMcpToolName,
  normalizeToolNameForProvider,
} from '../utils/tool-name-utils.js';
import { isImagePart } from '../services/visionBridge/image-part-utils.js';

const debugLogger = createDebugLogger('MCP_TOOL');

const MCP_CONNECTION_ERROR_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /connection (closed|lost)/i,
  /not connected/i,
  /disconnected/i,
  /transport closed/i,
];
// The MCP SDK's generic `RequestTimeout` code. It is emitted for both
// client-configured timeouts (`timeout` / `resetTimeoutOnProgress`) and
// server-side timeouts, so both collapse into a single EXECUTION_TIMEOUT
// classification here.
const MCP_REQUEST_TIMEOUT_CODE = -32001;

function isMcpRequestTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === MCP_REQUEST_TIMEOUT_CODE
  );
}

/**
 * A `-32001` rejection only tells us the request never got a response. That is
 * a genuine execution timeout while the transport is believed healthy, but
 * when the server is known to be DISCONNECTED the same code just means the
 * connection died mid-request — which `handleReconnectOnError` can still
 * recover from by reconnecting and retrying. Classifying that as
 * EXECUTION_TIMEOUT would turn a recoverable transport failure into a hard
 * error the user has to retry by hand.
 *
 * Deliberately checks for a *recorded* DISCONNECTED rather than
 * `getMCPServerStatus(...) !== CONNECTED`: that getter reports DISCONNECTED
 * for servers it has never seen, so the simpler comparison would misroute
 * every timeout from a server whose status was never registered. Default to
 * "timeout" and only divert on positive evidence the transport is dead.
 */
function isExecutionTimeoutFailure(
  error: unknown,
  serverName: string,
  signal: AbortSignal,
): boolean {
  // A `-32001` that lands while the parent signal is aborted is the SDK's
  // abort rejection (forwarded by createParentAbortRace) or a timeout that
  // raced with a cancel. Classifying it as EXECUTION_TIMEOUT would count a
  // user cancellation against the timeout SLI, so the abort side wins.
  if (signal.aborted) return false;
  if (!isMcpRequestTimeout(error)) return false;
  const statuses = getAllMCPServerStatuses();
  return !(
    statuses.has(serverName) &&
    statuses.get(serverName) === MCPServerStatus.DISCONNECTED
  );
}

const PARENT_ABORT_OUTCOME = Symbol('parent_abort_outcome');

type ParentAbortOutcome = {
  [PARENT_ABORT_OUTCOME]: true;
  reason: unknown;
};

function createToolCallAbortError(): Error {
  return Object.assign(new Error('Tool call aborted'), { name: 'AbortError' });
}

function isParentAbortOutcome(value: unknown): value is ParentAbortOutcome {
  return (
    typeof value === 'object' && value !== null && PARENT_ABORT_OUTCOME in value
  );
}

function createParentAbortRace(
  signal: AbortSignal,
  forwardAbort?: (reason: unknown) => void,
): {
  promise: Promise<ParentAbortOutcome>;
  dispose: () => void;
} {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<ParentAbortOutcome>((resolve) => {
    onAbort = () => {
      const reason = createToolCallAbortError();
      // Freeze the parent outcome before forwarding to the SDK, whose abort
      // rejection uses the same -32001 code as a genuine request timeout.
      // Ordering-safe: resolve() queues its Promise.race reaction as a
      // microtask before forwardAbort triggers the SDK rejection, so the
      // parent outcome always wins the race.
      resolve({ [PARENT_ABORT_OUTCOME]: true, reason });
      forwardAbort?.(reason);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  return {
    promise,
    dispose: () => {
      if (onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

type ToolParams = Record<string, unknown>;

/**
 * Minimal interface for the raw MCP Client's callTool method.
 * This avoids a direct import of @modelcontextprotocol/sdk in this file,
 * keeping the dependency contained in mcp-client.ts.
 */
export interface McpDirectClient {
  callTool(
    params: {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    },
    resultSchema?: unknown,
    options?: {
      onprogress?: (progress: {
        progress: number;
        total?: number;
        message?: string;
      }) => void;
      timeout?: number;
      signal?: AbortSignal;
    },
  ): Promise<McpCallToolResult>;
}

/** The result shape returned by MCP SDK Client.callTool(). */
interface McpCallToolResult {
  content?: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
  [key: string]: unknown;
}

// Discriminated union for MCP Content Blocks to ensure type safety.
type McpTextBlock = {
  type: 'text';
  text: string;
};

type McpMediaBlock = {
  type: 'image' | 'audio';
  mimeType: string;
  data: string;
};

type McpResourceBlock = {
  type: 'resource';
  resource: {
    text?: string;
    blob?: string;
    mimeType?: string;
  };
};

type McpResourceLinkBlock = {
  type: 'resource_link';
  uri: string;
  title?: string;
  name?: string;
};

type McpContentBlock =
  | McpTextBlock
  | McpMediaBlock
  | McpResourceBlock
  | McpResourceLinkBlock;

/**
 * MCP Tool Annotations as defined in the MCP specification.
 * These provide hints about a tool's behavior to help clients make decisions
 * about tool approval and safety.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

class DiscoveredMCPToolInvocation extends BaseToolInvocation<
  ToolParams,
  ToolResult
> {
  private static readonly MAX_RECONNECT_RETRIES = 3;
  private static readonly UNSAFE_REPLAY_ERROR_MESSAGE =
    'MCP tool execution may have completed before the connection failed. Automatic replay was skipped because the call could not be verified as safe to replay. Do not retry automatically; verify the outcome before trying again.';

  constructor(
    private readonly mcpTool: CallableTool,
    readonly serverName: string,
    readonly serverToolName: string,
    readonly displayName: string,
    readonly registeredToolName: string,
    readonly permissionAliases: readonly string[],
    readonly trust?: boolean,
    params: ToolParams = {},
    private readonly cliConfig?: Config,
    private readonly mcpClient?: McpDirectClient,
    private readonly mcpTimeout?: number,
    private readonly mcpToolIdleTimeoutMs?: number,
    private readonly annotations?: McpToolAnnotations,
    private readonly allowInvocationContext: boolean = false,
    private readonly retryCount: number = 0,
  ) {
    super(params);
  }

  /**
   * MCP tool default permission based on trust:
   * - trust: true in a trusted folder → 'allow' (server explicitly trusted by user config)
   * - All other MCP tools → 'ask'
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    // MCP servers explicitly marked as trusted bypass confirmation,
    // but only when the workspace folder is also trusted (security gate).
    if (this.trust === true && this.cliConfig?.isTrustedFolder()) {
      return 'allow';
    }
    return 'ask';
  }

  /**
   * Constructs confirmation dialog details for an MCP tool call.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const permissionRule = this.registeredToolName;

    const confirmationDetails: ToolMcpConfirmationDetails = {
      type: 'mcp',
      title: 'Confirm MCP Tool Execution',
      serverName: this.serverName,
      toolName: this.serverToolName,
      toolDisplayName: this.displayName,
      permissionRules: [permissionRule],
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence is handled by coreToolScheduler via PM rules
      },
    };
    return confirmationDetails;
  }

  // MCP spec: errors are returned inside the CallToolResult, not as exceptions.
  // ref: https://modelcontextprotocol.io/specification/2025-06-18/schema#calltoolresult
  isMCPToolError(rawResponseParts: Part[]): boolean {
    const functionResponse = rawResponseParts?.[0]?.functionResponse;
    const response = functionResponse?.response;

    interface McpError {
      isError?: boolean | string;
    }

    if (response) {
      const error = (response as { error?: McpError })?.error;
      const isError = error?.isError;

      if (error && (isError === true || isError === 'true')) {
        return true;
      }
    }
    return false;
  }

  private async attemptReconnect(): Promise<DiscoveredMCPTool | null> {
    if (!this.cliConfig) {
      return null;
    }

    try {
      debugLogger.info(
        `Attempting to reconnect MCP server '${this.serverName}'...`,
      );
      const toolRegistry = this.cliConfig.getToolRegistry();
      await toolRegistry.discoverToolsForServer(this.serverName);

      const newTool = await toolRegistry.ensureTool(this.registeredToolName);
      if (newTool instanceof DiscoveredMCPTool) {
        debugLogger.info(
          `Successfully reconnected to MCP server '${this.serverName}'`,
        );
        return newTool;
      }
      return null;
    } catch (error) {
      debugLogger.error(
        `Failed to reconnect MCP server '${this.serverName}': ${error}`,
      );
      return null;
    }
  }

  private async handleReconnectOnError(
    error: unknown,
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    debugLogger.error(`MCP server error '${this.serverName}': ${error}`);

    if (signal.aborted) {
      throw error;
    }

    if (!this.shouldAttemptReconnect(error)) {
      throw error;
    }

    if (!this.cliConfig) {
      throw error;
    }

    if (!this.canSafelyReplay()) {
      throw new Error(DiscoveredMCPToolInvocation.UNSAFE_REPLAY_ERROR_MESSAGE);
    }

    if (this.retryCount < DiscoveredMCPToolInvocation.MAX_RECONNECT_RETRIES) {
      debugLogger.info(
        `Reconnection attempt ${this.retryCount + 1}/${DiscoveredMCPToolInvocation.MAX_RECONNECT_RETRIES} for MCP server '${this.serverName}'`,
      );
      const newTool = await this.attemptReconnect();
      if (newTool) {
        const newInvocation = new DiscoveredMCPToolInvocation(
          newTool['mcpTool'],
          this.serverName,
          this.serverToolName,
          this.displayName,
          newTool.name,
          newTool.permissionAliases,
          newTool.trust,
          this.params,
          this.cliConfig,
          newTool['mcpClient'],
          this.mcpTimeout,
          this.mcpToolIdleTimeoutMs,
          newTool.annotations,
          newTool['allowInvocationContext'] === true,
          this.retryCount + 1,
        );
        if (!newInvocation.canSafelyReplay()) {
          throw new Error(
            DiscoveredMCPToolInvocation.UNSAFE_REPLAY_ERROR_MESSAGE,
          );
        }
        return newInvocation.execute(signal, updateOutput);
      }
    } else if (
      this.retryCount >= DiscoveredMCPToolInvocation.MAX_RECONNECT_RETRIES
    ) {
      debugLogger.error(
        `Max reconnection attempts (${DiscoveredMCPToolInvocation.MAX_RECONNECT_RETRIES}) reached for MCP server '${this.serverName}'`,
      );
    }

    throw error;
  }

  private canSafelyReplay(): boolean {
    if (
      this.trust !== true ||
      this.cliConfig?.isTrustedFolder() !== true ||
      !this.annotations
    ) {
      return false;
    }

    if (
      this.annotations.readOnlyHint === true &&
      (this.annotations.destructiveHint === true ||
        this.annotations.idempotentHint === false)
    ) {
      return false;
    }

    return (
      this.annotations.idempotentHint === true ||
      this.annotations.readOnlyHint === true
    );
  }

  private shouldAttemptReconnect(error: unknown): boolean {
    if (isAbortError(error)) {
      return false;
    }

    // An executor-boundary guard authorizes one concrete invocation attempt.
    // A transport error is ambiguous: the MCP server may have applied the
    // side effect before its response was lost. Reusing the original allow
    // decision for an internal reconnect would turn one authorization into
    // multiple execution attempts, so guarded invocations fail closed.
    if (this.cliConfig?.getToolInvocationGuard?.()) {
      return false;
    }

    if (getMCPServerStatus(this.serverName) === MCPServerStatus.DISCONNECTED) {
      return true;
    }

    const message = getErrorMessage(error);
    return MCP_CONNECTION_ERROR_PATTERNS.some((pattern) =>
      pattern.test(message),
    );
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    // Use direct MCP client if available (supports progress notifications),
    // otherwise fall back to the @google/genai mcpToTool wrapper.
    if (this.mcpClient) {
      return this.executeWithDirectClient(signal, updateOutput);
    }
    return this.executeWithCallableTool(signal);
  }

  /**
   * Execute using the raw MCP SDK Client, which supports progress
   * notifications via the onprogress callback. This enables real-time
   * streaming of progress updates to the user during long-running
   * MCP tool calls (e.g., browser automation).
   */
  private async executeWithDirectClient(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      throw createToolCallAbortError();
    }

    // Create an AbortController for idle timeout
    const idleTimeoutController = new AbortController();
    const parentAbortController = new AbortController();
    const parentAbortRace = createParentAbortRace(signal, (reason) => {
      parentAbortController.abort(reason);
    });
    let idleTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let idleTimeoutWon = false;

    // Combine the external signal with our idle timeout controller
    const combinedSignal = AbortSignal.any([
      parentAbortController.signal,
      idleTimeoutController.signal,
    ]);

    const resetIdleTimeout = () => {
      if (idleTimeoutId) {
        clearTimeout(idleTimeoutId);
      }
      if (this.mcpToolIdleTimeoutMs && this.mcpToolIdleTimeoutMs > 0) {
        const timer = setTimeout(() => {
          if (signal.aborted) {
            return;
          }
          idleTimeoutWon = true;
          const error = new Error(
            `MCP tool '${this.serverToolName}' on server '${this.serverName}' ` +
              `did not respond within ${this.mcpToolIdleTimeoutMs}ms idle timeout`,
          );
          error.name = 'AbortError';
          idleTimeoutController.abort(error);
        }, this.mcpToolIdleTimeoutMs);
        timer.unref();
        idleTimeoutId = timer;
      }
    };

    try {
      // Start the idle timeout
      resetIdleTimeout();

      const invocationContext = this.allowInvocationContext
        ? getInvocationContext()
        : undefined;
      const callPromise = this.mcpClient!.callTool(
        {
          name: this.serverToolName,
          arguments: this.params as Record<string, unknown>,
          ...(invocationContext
            ? {
                _meta: {
                  [INVOCATION_CONTEXT_META_KEY]: invocationContext,
                },
              }
            : {}),
        },
        undefined,
        {
          onprogress: (progress) => {
            // Reset idle timeout on progress
            resetIdleTimeout();

            if (updateOutput) {
              const progressData: McpToolProgressData = {
                type: 'mcp_tool_progress',
                progress: progress.progress,
                ...(progress.total != null && { total: progress.total }),
                ...(progress.message != null && { message: progress.message }),
              };
              updateOutput(progressData);
            }
          },
          timeout: this.mcpTimeout,
          signal: combinedSignal,
        },
      );
      const outcome = await Promise.race([
        callPromise,
        parentAbortRace.promise,
      ]);
      if (isParentAbortOutcome(outcome)) {
        throw outcome.reason;
      }
      const callToolResult = outcome;

      // Wrap the raw CallToolResult into the Part[] format that the
      // existing transform/display functions expect.
      const rawResponseParts = wrapMcpCallToolResultAsParts(
        this.serverToolName,
        callToolResult,
      );

      if (this.isMCPToolError(rawResponseParts)) {
        return await this.buildMcpToolError(rawResponseParts, {
          name: this.serverToolName,
          args: this.params,
        });
      }

      const transformedParts = transformMcpContentToParts(rawResponseParts);
      const truncated = await this.truncateTextParts(transformedParts);

      return {
        llmContent: truncated.parts,
        returnDisplay: getDisplayFromPartsWithPersistedOutput(
          transformedParts,
          truncated.persistedOutputFiles,
        ),
        persistedOutputFiles: truncated.persistedOutputFiles,
      };
    } catch (error) {
      // `idleTimeoutWon` is our own client-side timer firing, so it is an
      // execution timeout regardless of what the transport thinks.
      if (
        idleTimeoutWon ||
        isExecutionTimeoutFailure(error, this.serverName, signal)
      ) {
        throw new StructuredToolError(
          getErrorMessage(error),
          ToolErrorType.EXECUTION_TIMEOUT,
        );
      }
      return this.handleReconnectOnError(error, signal, updateOutput);
    } finally {
      // Clear the idle timeout in all cases
      if (idleTimeoutId) {
        clearTimeout(idleTimeoutId);
      }
      parentAbortRace.dispose();
    }
  }

  /**
   * Fallback: execute using the @google/genai CallableTool wrapper.
   * This path does NOT support progress notifications.
   */
  private async executeWithCallableTool(
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      throw createToolCallAbortError();
    }

    const functionCalls: FunctionCall[] = [
      {
        name: this.serverToolName,
        args: this.params,
      },
    ];
    const parentAbortRace = createParentAbortRace(signal);

    // Race MCP tool call with abort signal to respect cancellation
    try {
      const callPromise = this.mcpTool.callTool(functionCalls);
      const outcome = await Promise.race([
        callPromise,
        parentAbortRace.promise,
      ]);
      if (isParentAbortOutcome(outcome)) {
        throw outcome.reason;
      }
      const rawResponseParts = outcome;

      if (this.isMCPToolError(rawResponseParts)) {
        return await this.buildMcpToolError(rawResponseParts, functionCalls[0]);
      }

      const transformedParts = transformMcpContentToParts(rawResponseParts);
      const truncated = await this.truncateTextParts(transformedParts);

      return {
        llmContent: truncated.parts,
        returnDisplay: getDisplayFromPartsWithPersistedOutput(
          transformedParts,
          truncated.persistedOutputFiles,
        ),
        persistedOutputFiles: truncated.persistedOutputFiles,
      };
    } catch (error) {
      if (isExecutionTimeoutFailure(error, this.serverName, signal)) {
        throw new StructuredToolError(
          getErrorMessage(error),
          ToolErrorType.EXECUTION_TIMEOUT,
        );
      }
      return this.handleReconnectOnError(error, signal);
    } finally {
      parentAbortRace.dispose();
    }
  }

  private async buildMcpToolError(
    rawResponseParts: Part[],
    functionCall: FunctionCall,
  ): Promise<ToolResult> {
    const imageContent = getMcpErrorImageContent(rawResponseParts);
    let llmContent: PartListUnion;
    let errorMessage: string;
    let persistedOutputFiles: string[] | undefined;
    if (imageContent) {
      const truncatedContent = await this.truncateTextParts(imageContent);
      llmContent = truncatedContent.parts;
      persistedOutputFiles = truncatedContent.persistedOutputFiles;
      errorMessage = `MCP tool '${
        this.serverToolName
      }' reported tool error for function call: ${safeJsonStringify(
        functionCall,
      )} with response: ${getDisplayFromParts(truncatedContent.parts)}`;
    } else {
      errorMessage = `MCP tool '${
        this.serverToolName
      }' reported tool error for function call: ${safeJsonStringify(
        functionCall,
      )} with response: ${safeJsonStringify(rawResponseParts)}`;
      llmContent = errorMessage;
    }

    return {
      llmContent,
      returnDisplay: `Error: MCP tool '${this.serverToolName}' reported an error.`,
      error: {
        message: errorMessage,
        type: ToolErrorType.MCP_TOOL_ERROR,
      },
      ...(persistedOutputFiles !== undefined ? { persistedOutputFiles } : {}),
    };
  }

  /**
   * Truncates text parts in the transformed result if they exceed the
   * configured threshold. Non-text parts (images, audio, etc.) are preserved.
   */
  private async truncateTextParts(parts: Part[]): Promise<{
    parts: Part[];
    persistedOutputFiles?: string[];
  }> {
    if (!this.cliConfig) {
      return { parts };
    }

    const result: Part[] = [];
    const persistedOutputFiles: string[] = [];
    let persistenceAttempted = false;
    for (const part of parts) {
      if (part.text && !part.inlineData) {
        const truncated = await truncateToolOutput(
          this.cliConfig,
          this.registeredToolName,
          part.text,
          // Per-tool char budget; mirrors DiscoveredMCPTool.maxOutputChars
          // (10x the global default, since MCP servers return large structured
          // output). char-only (lines: Infinity) so the global line cap can't
          // undercut the 500k char budget — many short lines (structured JSON,
          // tables) would otherwise truncate while chars remain. Consistent
          // with the shell tool's in-tool truncation.
          {
            threshold: 500_000,
            previewChars: 2000,
            lines: Number.POSITIVE_INFINITY,
          },
        );
        result.push({ text: truncated.content });
        persistenceAttempted ||= truncated.content !== part.text;
        if (truncated.outputFile) {
          persistedOutputFiles.push(truncated.outputFile);
        }
      } else {
        result.push(part);
      }
    }
    return {
      parts: result,
      ...(persistenceAttempted ? { persistedOutputFiles } : {}),
    };
  }

  getDescription(): string {
    return safeJsonStringify(this.params);
  }
}

export class DiscoveredMCPTool extends BaseDeclarativeTool<
  ToolParams,
  ToolResult
> {
  // MCP servers often return large structured payloads; allow 10x the global
  // budget (mirrors Claude Code's MCP `maxResultSizeChars`) before the
  // scheduler offloads. truncateTextParts uses the same ceiling per text part.
  override get maxOutputChars(): number {
    return 500_000;
  }

  /** Keeps pre-normalization permission and disabled-tool entries effective. */
  get permissionAliases(): readonly string[] {
    const legacyName = generateLegacyMcpToolName(
      `mcp__${this.serverName}__${this.serverToolName}`,
    );
    return legacyName === this.name ? [] : [legacyName];
  }

  constructor(
    private readonly mcpTool: CallableTool,
    readonly serverName: string,
    readonly serverToolName: string,
    description: string,
    override readonly parameterSchema: unknown,
    readonly trust?: boolean,
    nameOverride?: string,
    private readonly cliConfig?: Config,
    private readonly mcpClient?: McpDirectClient,
    private readonly mcpTimeout?: number,
    private readonly mcpToolIdleTimeoutMs?: number,
    readonly annotations?: McpToolAnnotations,
    alwaysLoad = false,
    private readonly allowInvocationContext: boolean = false,
  ) {
    super(
      nameOverride ??
        generateValidName(`mcp__${serverName}__${serverToolName}`),
      `${serverToolName} (${serverName} MCP Server)`,
      description,
      annotations?.readOnlyHint === true ? Kind.Read : Kind.Other,
      parameterSchema,
      true, // isOutputMarkdown
      true, // canUpdateOutput — enables streaming progress for MCP tools
      true, // shouldDefer — MCP tools are discovered via ToolSearch to keep the
      //   initial tool-declaration list small when many MCP servers are attached.
      alwaysLoad,
      // searchHint: server name boosts fuzzy matching when the user references
      // the server in their query ("send a slack message").
      `mcp ${serverName}`,
    );
  }

  asFullyQualifiedTool(): DiscoveredMCPTool {
    return new DiscoveredMCPTool(
      this.mcpTool,
      this.serverName,
      this.serverToolName,
      this.description,
      this.parameterSchema,
      this.trust,
      generateValidName(`mcp__${this.serverName}__${this.serverToolName}`),
      this.cliConfig,
      this.mcpClient,
      this.mcpTimeout,
      this.mcpToolIdleTimeoutMs,
      this.annotations,
      this.alwaysLoad,
      this.allowInvocationContext,
    );
  }

  /**
   * Return a clone of this tool with a different `trust` value while
   * keeping every other field (including the shared underlying
   * `CallableTool` / MCP transport) identical.
   *
   * Kept as the trust-only convenience used by non-pool callers. Pooled
   * session views use `withSessionConfig` because eager loading can differ
   * between sessions too.
   */
  withTrust(trust: boolean | undefined): DiscoveredMCPTool {
    return this.withSessionConfig(trust, this.alwaysLoad);
  }

  /**
   * Return a per-session projection of metadata that does not belong to the
   * shared MCP transport snapshot. Pool entries can be shared by sessions
   * whose trust and eager-loading settings differ, so neither field may be
   * mutated on the canonical tool instance.
   */
  withSessionConfig(
    trust: boolean | undefined,
    alwaysLoad: boolean,
  ): DiscoveredMCPTool {
    if (trust === this.trust && alwaysLoad === this.alwaysLoad) return this;
    return new DiscoveredMCPTool(
      this.mcpTool,
      this.serverName,
      this.serverToolName,
      this.description,
      this.parameterSchema,
      trust,
      // Preserve the original name (do NOT re-call generateValidName)
      // — equal-by-name is the registry's deduplication key, and a
      // different name would race-register two tools in the same
      // session.
      this.name,
      this.cliConfig,
      this.mcpClient,
      this.mcpTimeout,
      this.mcpToolIdleTimeoutMs,
      this.annotations,
      alwaysLoad,
      this.allowInvocationContext,
    );
  }

  protected createInvocation(
    params: ToolParams,
  ): ToolInvocation<ToolParams, ToolResult> {
    return new DiscoveredMCPToolInvocation(
      this.mcpTool,
      this.serverName,
      this.serverToolName,
      this.displayName,
      this.name,
      this.permissionAliases,
      this.trust,
      params,
      this.cliConfig,
      this.mcpClient,
      this.mcpTimeout,
      this.mcpToolIdleTimeoutMs,
      this.annotations,
      this.allowInvocationContext,
    );
  }
}

/**
 * Wraps a raw MCP CallToolResult into the Part[] format that the
 * existing transform/display functions expect. This bridges the gap
 * between the raw MCP SDK response and the @google/genai Part format.
 */
function wrapMcpCallToolResultAsParts(
  toolName: string,
  result: {
    content?: Array<{ [key: string]: unknown }>;
    isError?: boolean;
  },
): Part[] {
  const response = result.isError
    ? { error: result, content: result.content }
    : result;
  return [
    {
      functionResponse: {
        name: toolName,
        response,
      },
    },
  ];
}

function transformTextBlock(block: McpTextBlock): Part {
  return { text: block.text };
}

function transformImageAudioBlock(
  block: McpMediaBlock,
  toolName: string,
): Part[] {
  return [
    {
      text: `[Tool '${toolName}' provided the following ${
        block.type
      } data with mime-type: ${block.mimeType}]`,
    },
    {
      inlineData: {
        mimeType: block.mimeType,
        data: block.data,
      },
    },
  ];
}

function transformResourceBlock(
  block: McpResourceBlock,
  toolName: string,
): Part | Part[] | null {
  const resource = block.resource;
  if (resource?.text) {
    return { text: resource.text };
  }
  if (resource?.blob) {
    const mimeType = resource.mimeType || 'application/octet-stream';
    return [
      {
        text: `[Tool '${toolName}' provided the following embedded resource with mime-type: ${mimeType}]`,
      },
      {
        inlineData: {
          mimeType,
          data: resource.blob,
        },
      },
    ];
  }
  return null;
}

function transformResourceLinkBlock(block: McpResourceLinkBlock): Part {
  return {
    text: `Resource Link: ${block.title || block.name} at ${block.uri}`,
  };
}

/**
 * Transforms the raw MCP content blocks from the SDK response into a
 * standard GenAI Part array.
 * @param sdkResponse The raw Part[] array from `mcpTool.callTool()`.
 * @returns A clean Part[] array ready for the scheduler.
 */
function transformMcpContentToParts(sdkResponse: Part[]): Part[] {
  const funcResponse = sdkResponse?.[0]?.functionResponse;
  const mcpContent = funcResponse?.response?.['content'] as McpContentBlock[];
  const toolName = funcResponse?.name || 'unknown tool';

  if (!Array.isArray(mcpContent)) {
    return [{ text: '[Error: Could not parse tool response]' }];
  }

  const transformed = mcpContent.flatMap(
    (block: McpContentBlock): Part | Part[] | null => {
      switch (block.type) {
        case 'text':
          return transformTextBlock(block);
        case 'image':
        case 'audio':
          return transformImageAudioBlock(block, toolName);
        case 'resource':
          return transformResourceBlock(block, toolName);
        case 'resource_link':
          return transformResourceLinkBlock(block);
        default:
          return null;
      }
    },
  );

  return transformed.filter((part): part is Part => part !== null);
}

function getMcpErrorImageContent(rawResponseParts: Part[]): Part[] | undefined {
  const transformedParts = transformMcpContentToParts(rawResponseParts);
  return transformedParts.some(isImagePart) ? transformedParts : undefined;
}

/**
 * Builds a human-readable display string from transformed Part[].
 * Text parts are shown directly; inline data is summarized by mime type.
 */
function getDisplayFromParts(parts: Part[]): string {
  if (parts.length === 0) {
    return '';
  }

  const displayParts: string[] = [];
  for (const part of parts) {
    if (part.text !== undefined) {
      displayParts.push(part.text);
    } else if (part.inlineData) {
      displayParts.push(`[${part.inlineData.mimeType}]`);
    }
  }

  return displayParts.join('\n');
}

function getDisplayFromPartsWithPersistedOutput(
  parts: Part[],
  persistedOutputFiles: string[] | undefined,
): string {
  const display = getDisplayFromParts(parts);
  if (!persistedOutputFiles?.length) return display;

  const paths = persistedOutputFiles.map((file) => `- ${file}`).join('\n');
  return `${display}\nOutput too long and was saved to:\n${paths}`;
}

/** Visible for testing */
export function generateValidName(name: string) {
  return normalizeToolNameForProvider(name);
}
