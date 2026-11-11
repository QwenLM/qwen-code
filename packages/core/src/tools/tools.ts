/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration, PartListUnion } from '@google/genai';
import { ToolErrorType } from './tool-error.js';
import type { GrepMatch } from './grep-utils.js';
import type { ShellExecutionConfig } from '../services/shellExecutionService.js';
import {
  SchemaValidator,
  type SchemaValidationMode,
} from '../utils/schemaValidator.js';
import {
  ToolParameterValidationError,
  captureParameterShapes,
  createSchemaDiagnosticData,
  createToolParameterDiagnosticData,
  createUnknownBuildDiagnosticData,
  getToolParameterDiagnosticData,
} from './tool-parameter-diagnostics.js';
import { coerceContainerArgsToSchema } from '../utils/coerceArgs.js';
import type { SubagentProgress } from '../agents/types.js';
import type {
  AgentToolBackgroundLaunchResult,
  AgentToolTeammateSpawnedResult,
} from '../agents/agent-tool-result.js';
import type { QuestionAnnotation } from './ask-user-types.js';
import type {
  PermissionDecision,
  InterruptBehavior,
  ToolInvocationOrigin,
  ToolUseContext,
} from './tool-types.js';
import type { McpCallResult, McpResultMeta } from '../mcp/tools/mcp-result.js';
import { CoreToolCallStatus } from '../tool-executor/types.js';
import {
  SCRIPT_STATUSES,
  type ProgrammaticContract,
  type ScriptStatus,
  type ToolExposureHints,
} from '../codemode/types.js';
import { textContract } from '../codemode/contracts.js';

const NO_EXPOSURE_HINTS: ToolExposureHints = Object.freeze({});

// Re-export enhanced types for convenient access
export type {
  PermissionDecision,
  InterruptBehavior,
  ToolInvocationOrigin,
  ToolUseContext,
};

/**
/**
 * Supported decisions for forcing tool execution behavior.
 */
export type ForcedToolDecision = 'allow' | 'deny' | 'ask_user';

/**
 * Options bag for tool execution, replacing positional parameters that are
 * only relevant to specific tool types.
 */
export interface ExecuteOptions {
  shellExecutionConfig?: ShellExecutionConfig;
  setExecutionIdCallback?: (executionId: number) => void;
}

/**
 * Represents a validated and ready-to-execute tool call.
 * An instance of this is created by a `ToolBuilder`.
 */
export interface ToolInvocation<
  TParams extends object,
  TResult extends ToolResult,
> {
  /**
   * The validated parameters for this specific invocation.
   */
  params: TParams;

  /**
   * Gets a pre-execution description of the tool operation.
   *
   * @returns A markdown string describing what the tool will do.
   */
  getDescription(): string;

  /**
   * Gets a clean title for display in the UI (e.g. the raw command without metadata).
   * If not implemented, the UI may fall back to getDescription().
   * @returns A string representing the tool call title.
   */
  getDisplayTitle?(): string;

  /**
   * Gets conversational explanation or secondary metadata.
   * @returns A string representing the explanation, or undefined.
   */
  getExplanation?(): string;

  /**
   * Determines what file system paths the tool will affect.
   * @returns A list of such paths.
   */
  toolLocations(): ToolLocation[];

  /**
   * Executes the tool with the validated parameters.
   * @param signal AbortSignal for tool cancellation.
   * @param updateOutput Optional callback to stream output.
   * @param setExecutionIdCallback Optional callback for tools that expose a background execution handle.
   * @returns Result of the tool execution.
   */
  execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
  ): Promise<TResult>;

  /**
   * Executes the tool using a unified ToolUseContext.
   *
   * This is the preferred entry point called by executeToolWithHooks.
   * The default implementation in BaseToolInvocation delegates to
   * execute(signal, updateOutput, options) for backward compatibility.
   *
   * @param ctx Unified execution context.
   * @returns Result of the tool execution.
   */
  executeWithContext?(ctx: ToolUseContext): Promise<TResult>;

  /**
   * Optionally validates runtime preconditions before hooks, policy checks,
   * and user confirmation run.
   *
   * Return an error ToolResult to stop the invocation, or undefined to
   * continue. Execution must still re-check mutable preconditions after
   * permission is granted.
   */
  validateBeforePermission?(ctx: ToolUseContext): Promise<TResult | undefined>;
}

/**
 * Structured payload used by tools to surface background execution metadata to
 * the CLI UI.
 *
 * NOTE: `pid` is used as the canonical identifier for now to stay consistent
 * with existing types (ExecutingToolCall.pid, ExecutionHandle.pid, etc.).
 * A future rename to `executionId` is planned once the codebase is fully
 * migrated — not done in this PR to keep the diff focused on the abstraction.
 */
export interface BackgroundExecutionData extends Record<string, unknown> {
  pid?: number;
  command?: string;
  initialOutput?: string;
  totalLines?: number;
  totalBytes?: number;
}

export function isBackgroundExecutionData(
  data: unknown,
): data is BackgroundExecutionData {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const pid = 'pid' in data ? data.pid : undefined;
  const command = 'command' in data ? data.command : undefined;
  const initialOutput =
    'initialOutput' in data ? data.initialOutput : undefined;
  const totalLines = 'totalLines' in data ? data.totalLines : undefined;
  const totalBytes = 'totalBytes' in data ? data.totalBytes : undefined;

  return (
    (pid === undefined || typeof pid === 'number') &&
    (command === undefined || typeof command === 'string') &&
    (initialOutput === undefined || typeof initialOutput === 'string') &&
    (totalLines === undefined || typeof totalLines === 'number') &&
    (totalBytes === undefined || typeof totalBytes === 'number')
  );
}

/**
 * A convenience base class for ToolInvocation.
 */
export abstract class BaseToolInvocation<
  TParams extends object,
  TResult extends ToolResult,
> implements ToolInvocation<TParams, TResult>
{
  constructor(
    readonly params: TParams,
    readonly _toolName?: string,
    readonly _toolDisplayName?: string,
    readonly _serverName?: string,
    readonly _toolAnnotations?: Record<string, unknown>,
  ) {}

  abstract getDescription(): string;

  getDisplayTitle(): string {
    return this.getDescription();
  }

  getExplanation(): string {
    return '';
  }

  toolLocations(): ToolLocation[] {
    return [];
  }

  abstract execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
  ): Promise<TResult>;

  /** Execute with unified context; delegates to execute() by default. */
  executeWithContext(ctx: ToolUseContext): Promise<TResult> {
    return this.execute(ctx.signal, ctx.updateOutput, ctx.options);
  }

  toJSON() {
    return {
      params: this.params,
    };
  }
}

/**
 * A type alias for a tool invocation where the specific parameter and result types are not known.
 */
export type AnyToolInvocation = ToolInvocation<object, ToolResult>;

/**
 * Interface for a tool builder that validates parameters and creates invocations.
 */
export interface ToolBuilder<
  TParams extends object,
  TResult extends ToolResult,
> {
  /**
   * The internal name of the tool (used for API calls).
   */
  name: string;

  /**
   * The user-friendly display name of the tool.
   */
  displayName: string;

  /**
   * Description of what the tool does.
   */
  description: string;

  /**
   * The kind of tool for categorization and permissions
   */
  kind: Kind;

  /**
   * Function declaration schema from @google/genai.
   * @param modelId Optional model identifier to get a model-specific schema.
   */
  getSchema(modelId?: string): FunctionDeclaration;

  /**
   * Function declaration schema for the default model.
   * @deprecated Use getSchema(modelId) for model-specific schemas.
   */
  readonly schema: FunctionDeclaration;

  /**
   * Whether the tool's output should be rendered as markdown.
   */
  isOutputMarkdown: boolean;

  /**
   * Whether the tool supports live (streaming) output.
   */
  canUpdateOutput: boolean;

  /**
   * Whether the tool is read-only (has no side effects).
   */
  isReadOnly: boolean;

  /**
   * Validates raw parameters and builds a ready-to-execute invocation.
   * @param params The raw, untrusted parameters from the model.
   * @returns A valid `ToolInvocation` if successful. Throws an error if validation fails.
   */
  build(params: TParams): ToolInvocation<TParams, TResult>;
}

/**
 * New base class for tools that separates validation from execution.
 * New tools should extend this class.
 */
export abstract class DeclarativeTool<
  TParams extends object,
  TResult extends ToolResult,
> implements ToolBuilder<TParams, TResult>
{
  /** How a script receives this tool's result; scripts get the model's text unless a tool projects structure. */
  get programmatic(): ProgrammaticContract {
    return textContract;
  }
  get exposureHints(): ToolExposureHints {
    return NO_EXPOSURE_HINTS;
  }
  constructor(
    readonly name: string, // 模型可见，调用时使用的 Tool 名称
    readonly displayName: string, // UI 展示名称、参数校验报错名称
    readonly description: string, // 模型可见，主 Agent 可以看到的工具描述
    readonly kind: Kind, // Tool 分类
    readonly parameterSchema: unknown, // 模型可见，工具入参 JSON Schema，模型调用 Tool 后会基于 Schema 进行本地参数校验
    readonly isOutputMarkdown: boolean = true, // Tool 结果是否作为 markdown 渲染
    readonly canUpdateOutput: boolean = false, // Tool 是否支持执行期间持续更新输出。
    readonly pluginName?: string, // Tool 来源 Plugin 的可读名称。
    readonly pluginId?: string, // Tool 来源 Plugin 的稳定唯一标识。
  ) {}

  /** Stable legacy class name for configuration matching across product subclasses. */
  readonly configurationName?: string;

  clone(): this {
    return Object.assign(
      // eslint-disable-next-line eslint-js/no-restricted-syntax
      Object.create(Object.getPrototypeOf(this)),
      this,
    ) as this;
  }

  toJSON() {
    return {
      name: this.name,
      displayName: this.displayName,
      description: this.description,
      kind: this.kind,
      parameterSchema: this.parameterSchema,
    };
  }

  get isReadOnly(): boolean {
    return READ_ONLY_KINDS.includes(this.kind);
  }

  /** Override for input-dependent concurrency decisions. */
  isConcurrencySafe(_input?: TParams): boolean {
    return this.isReadOnly;
  }

  isDestructive(_input?: TParams): boolean {
    return false;
  }

  isOpenWorld(_input?: TParams): boolean {
    return false;
  }

  interruptBehavior(): InterruptBehavior {
    return 'block';
  }

  /**
   * Whether this tool requires user interaction to function at all
   * (bypass-immune): its ask decision survives every permission mode,
   * including bypassPermissions, because what the dialog collects cannot be
   * supplied by anything other than the user.
   *
   * AskUserQuestion qualifies because it exists to collect an answer; the plan
   * lifecycle tools qualify because entering and leaving plan mode is a
   * workflow decision no mode can make on the user's behalf.
   */
  requiresUserInteraction(): boolean {
    return false;
  }

  /**
   * Produces a simplified input representation for the AI classifier.
   * Used by the auto-mode classifier to evaluate whether a tool action
   * should be allowed in auto permission mode.
   *
   * Override in subclasses to provide a focused representation.
   * Default: returns the raw input whole, so the reviewed action is the one
   * that runs; unserializable input becomes a placeholder.
   * Returning '' means the tool has no classifier-relevant input — but for
   * non-allowlisted tools this will cause the classifier to DENY (fail-closed).
   */
  toClassifierInput(input: TParams): unknown {
    try {
      JSON.stringify(input);
    } catch {
      return { _error: 'input not serializable' };
    }
    return input;
  }

  /**
   * Maximum result size in characters for per-tool truncation.
   * Override in subclasses to set tool-specific limits.
   * - Infinity = exempt from truncation (e.g., Read)
   * - 0 = use DEFAULT_MAX_RESULT_SIZE_CHARS (50,000)
   */
  get maxResultSizeChars(): number {
    return 0;
  }

  get toolAnnotations(): Record<string, unknown> | undefined {
    return undefined;
  }

  getSchema(_modelId?: string): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parametersJsonSchema: this.parameterSchema,
    };
  }

  get schema(): FunctionDeclaration {
    return this.getSchema();
  }

  /**
   * Validates the raw tool parameters.
   * Subclasses should override this to add custom validation logic
   * beyond the JSON schema check.
   * @param params The raw parameters from the model.
   * @returns An error message string if invalid, null otherwise.
   */
  validateToolParams(
    _params: TParams,
    _context?: ToolUseContext,
  ): string | null {
    // Base implementation can be extended by subclasses.
    return null;
  }

  /**
   * The core of the new pattern. It validates parameters and, if successful,
   * returns a `ToolInvocation` object that encapsulates the logic for the
   * specific, validated call.
   * @param params The raw, untrusted parameters from the model.
   * @returns A `ToolInvocation` instance.
   */
  abstract build(
    params: TParams,
    context?: ToolUseContext,
  ): ToolInvocation<TParams, TResult>;

  /**
   * A convenience method that builds and executes the tool in one step.
   * Throws an error if validation fails.
   * @param params The raw, untrusted parameters from the model.
   * @param signal AbortSignal for tool cancellation.
   * @param updateOutput Optional callback to stream output.
   * @returns The result of the tool execution.
   */
  async buildAndExecute(
    params: TParams,
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
    options?: ExecuteOptions,
  ): Promise<TResult> {
    const invocation = this.build(params);
    return invocation.execute(signal, updateOutput, options);
  }

  /**
   * Similar to `build` but never throws.
   * @param params The raw, untrusted parameters from the model.
   * @returns A `ToolInvocation` instance.
   */
  private silentBuild(
    params: TParams,
  ): ToolInvocation<TParams, TResult> | Error {
    try {
      return this.build(params);
    } catch (e) {
      if (e instanceof Error) {
        return e;
      }
      return new Error(String(e));
    }
  }

  /**
   * A convenience method that builds and executes the tool in one step.
   * Never throws.
   * @param params The raw, untrusted parameters from the model.
   * @param abortSignal a signal to abort.
   * @returns The result of the tool execution.
   */
  async validateBuildAndExecute(
    params: TParams,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    const invocationOrError = this.silentBuild(params);
    if (invocationOrError instanceof Error) {
      const errorMessage = invocationOrError.message;
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${errorMessage}`,
        returnDisplay: errorMessage,
        error: {
          message: errorMessage,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
        data:
          getToolParameterDiagnosticData(invocationOrError) ??
          createUnknownBuildDiagnosticData(),
      };
    }

    try {
      return await invocationOrError.execute(abortSignal);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error: Tool call execution failed. Reason: ${errorMessage}`,
        returnDisplay: errorMessage,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

/**
 * New base class for declarative tools that separates validation from execution.
 * New tools should extend this class, which provides a `build` method that
 * validates parameters before deferring to a `createInvocation` method for
 * the final `ToolInvocation` object instantiation.
 */
export abstract class BaseDeclarativeTool<
  TParams extends object,
  TResult extends ToolResult,
> extends DeclarativeTool<TParams, TResult> {
  protected get schemaValidationMode(): SchemaValidationMode {
    return 'coerce';
  }

  build(params: TParams, context?: ToolUseContext): ToolInvocation<TParams, TResult> {
    const originalShapes = captureParameterShapes(params);
    const validationError = this.validateToolParams(params, context);
    if (validationError) {
      const schemaFailure = SchemaValidator.validateWithDetails(
        this.schema.parametersJsonSchema,
        params,
        this.schemaValidationMode,
      );
      const data = schemaFailure?.errors[0]
        ? createSchemaDiagnosticData(
            schemaFailure.errors[0],
            this.schema.parametersJsonSchema,
            originalShapes,
          )
        : this.createCustomParameterValidationDiagnostic(
            params,
            validationError,
          );
      throw new ToolParameterValidationError(
        `${this.displayName} tool parameter validation failed: ${validationError}`,
        data,
      );
    }
    return this.createInvocation(params, this.name, this.displayName);
  }

  protected createCustomParameterValidationDiagnostic(
    _params: TParams,
    _validationError: string,
  ) {
    return createToolParameterDiagnosticData('custom_semantic', {
      validation_source: 'custom',
      constraint_category: 'unknown_custom_validation',
      quality: 'fallback',
      validation_phase: 'build',
    });
  }

  override validateToolParams(params: TParams, context?: ToolUseContext): string | null {
    const schema = this.schema.parametersJsonSchema;
    const schemaProps = getSchemaProperties(schema);
    const coercedParams = coerceContainerArgsToSchema(
      params as Record<string, unknown>,
      schemaProps,
    );
    if (coercedParams && coercedParams !== params) {
      Object.assign(params, coercedParams);
    }

    const errors = SchemaValidator.validate(
      schema,
      params,
      this.schemaValidationMode,
    );

    if (errors) {
      return errors;
    }
    return this.validateToolParamValues(params, context);
  }

  protected validateToolParamValues(_params: TParams, _context?: ToolUseContext): string | null {
    // Base implementation can be extended by subclasses.
    return null;
  }

  protected abstract createInvocation(
    params: TParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<TParams, TResult>;
}

export function getSchemaProperties(
  schema: unknown,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }
  const properties = (schema as Record<string, unknown>)['properties'];
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return undefined;
  }
  return properties as Record<string, unknown>;
}

/**
 * A type alias for a declarative tool where the specific parameter and result types are not known.
 */
export type AnyDeclarativeTool = DeclarativeTool<object, ToolResult>;

/**
 * Type guard to check if an object is a Tool.
 * @param obj The object to check.
 * @returns True if the object is a Tool, false otherwise.
 */
export function isTool(obj: unknown): obj is AnyDeclarativeTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    'build' in obj &&
    typeof (obj as AnyDeclarativeTool).build === 'function'
  );
}

/**
 * Supplementary message produced by a tool, appended to conversation
 * history independently of the tool_result.
 *
 * - Always user role (tool results live in the user turn).
 * - Content can be text or media that is intentionally outside tool_result.
 *
 * Tool-produced images belong in `llmContent` so they remain attached to the
 * matching tool_result. Use this field only for genuinely separate context.
 */
export interface NewToolMessage {
  /** Must be 'user' — tool supplementary messages are part of the user turn. */
  readonly role: 'user';
  /** Content for this message. String is shorthand for a single text part. */
  readonly content: PartListUnion;
  /** When true, the message is visible to the model but hidden in the UI. */
  readonly isMeta?: boolean;
}

export interface FileWriteFacts {
  filePath: string;
  workspacePath: string;
  originalContent: string;
  proposedContent: string;
  writtenContent: string;
}

export interface ToolResult {
  /**
   * Content meant to be included in LLM history.
   * This should represent the factual outcome of the tool execution.
   */
  llmContent: PartListUnion;

  /**
   * Markdown string for user display.
   * This provides a user-friendly summary or visualization of the result.
   * NOTE: This might also be considered UI-specific and could potentially be
   * removed or modified in a further refactor if the server becomes purely API-driven.
   * For now, we keep it as the core logic in ReadFileTool currently produces it.
   */
  returnDisplay: ToolResultDisplay;

  /**
   * If this property is present, the tool call is considered a failure.
   */
  error?: {
    message: string; // raw error message
    type?: ToolErrorType; // An optional machine-readable error type (e.g., 'FILE_NOT_FOUND').
  };

  /**
   * Semantic-error flag: tool executed cleanly but the handler signaled
   * a failure outcome (e.g., MCP CallToolResult.isError = true, or a shell
   * command exiting non-zero). Unlike `error`, this does NOT discard the
   * result — the handler-provided `llmContent` is preserved verbatim and
   * reaches the model, only with `is_error: true` set on the resulting
   * tool_result block so the model can see the failure semantics. It does
   * however participate in the failure lifecycle: `PostToolUseFailure` fires
   * and execution records `failed` (see `coreToolHookTriggers.ts`).
   */
  isError?: boolean;

  /**
   * When true, the agent loop records this tool result and then ends the
   * current turn without requesting another model response.
   */
  endsTurn?: boolean;

  /**
   * Optional data payload for passing structured information back to the caller.
   */
  data?: Record<string, unknown>;

  /**
   * Structured tool output used to render the user-visible result.
   *
   * This is persisted in transcripts and rendered again on resume. It must be
   * semantic tool output, not a pre-rendered display string.
   */
  toolUseResult?: unknown;

  /** Host-only MCP result metadata persisted separately from semantic output. */
  mcpMeta?: McpResultMeta;
  /** Complete MCP result for CodeMode; never persisted and invalidated by output hooks. */
  mcpResult?: McpCallResult;
  /** Host-only complete facts for a successful file write. */
  fileWrite?: FileWriteFacts;
  /** Host-only actual Read path when a hook replaced its output. */
  readOutputReplacement?: string;
  /** Host-only: this successful poll should not count toward repeated-call detection. */
  repeatNeutral?: boolean;
  /** Host-only hook effects already appended to llmContent, kept for programmatic consumers. */
  hookNotices?: string[];

  /**
   * Optional modifier applied to the ToolUseContext after this tool completes.
   *
   * The streaming executor applies it immediately only for a
   * concurrency-unsafe tool, behind that tool's exclusive barrier. It is also
   * carried by the result message for loop-level propagation after the batch.
   *
   * Use this for tools that need to influence subsequent executions
   * (e.g., caching file state, recording permission decisions).
   */
  contextModifier?: (ctx: ToolUseContext) => ToolUseContext;

  /**
   * Additional messages to append to conversation history AFTER the
   * main tool_result message.
   *
   * Unlike llmContent (which becomes the tool_result), these produce
   * independent messages. Tool-produced images must be returned through
   * llmContent rather than this field.
   *
   */
  newMessages?: NewToolMessage[];
}

/**
 * Detects cycles in a JSON schemas due to `$ref`s.
 * @param schema The root of the JSON schema.
 * @returns `true` if a cycle is detected, `false` otherwise.
 */
export function hasCycleInSchema(schema: object): boolean {
  function resolveRef(ref: string): object | null {
    if (!ref.startsWith('#/')) {
      return null;
    }
    const path = ref.substring(2).split('/');
    let current: unknown = schema;
    for (const segment of path) {
      if (
        typeof current !== 'object' ||
        current === null ||
        !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return null;
      }

      current = (current as Record<string, unknown>)[segment];
    }

    return current as object;
  }

  function traverse(
    node: unknown,
    visitedRefs: Set<string>,
    pathRefs: Set<string>,
  ): boolean {
    if (typeof node !== 'object' || node === null) {
      return false;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        if (traverse(item, visitedRefs, pathRefs)) {
          return true;
        }
      }
      return false;
    }

    if ('$ref' in node && typeof node.$ref === 'string') {
      const ref = node.$ref;
      if (ref === '#' || ref === '#/' || pathRefs.has(ref)) {
        // A ref to just '#/' is always a cycle.
        return true; // Cycle detected!
      }
      if (visitedRefs.has(ref)) {
        return false; // Bail early, we have checked this ref before.
      }

      const resolvedNode = resolveRef(ref);
      if (resolvedNode) {
        // Add it to both visited and the current path
        visitedRefs.add(ref);
        pathRefs.add(ref);
        const hasCycle = traverse(resolvedNode, visitedRefs, pathRefs);
        pathRefs.delete(ref); // Backtrack, leaving it in visited
        return hasCycle;
      }
    }

    // Crawl all the properties of node
    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        if (
          traverse(
            (node as Record<string, unknown>)[key],
            visitedRefs,
            pathRefs,
          )
        ) {
          return true;
        }
      }
    }

    return false;
  }

  return traverse(schema, new Set<string>(), new Set<string>());
}

export interface TodoList {
  todos: Todo[];
}

export interface ShellLiveOutput {
  isShellLiveOutput: true;
  output: string;
  totalLines?: number;
  totalBytes: number;
}

export function isShellLiveOutput(obj: unknown): obj is ShellLiveOutput {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'isShellLiveOutput' in obj &&
    obj.isShellLiveOutput === true
  );
}

/** One tool call a CodeMode script made, for in-session display only. */
export interface CodeModeChildDisplay {
  /** Native host result shared by live notifications and incremental call records. */
  hostResult?: import('../protocol/schemas/sdk-message.js').SDKCodeModeHostResult;
  callId: string;
  /** Registered tool name, e.g. `Read`. */
  name: string;
  args: Record<string, unknown>;
  /** True when transcript arguments are only a bounded preview. */
  argsTruncated?: boolean;
  status: CoreToolCallStatus;
  /** The child's own `returnDisplay` once it settles. */
  resultDisplay?: ToolResultDisplay;
  error?: string;
  notice?: string;
}

/**
 * CodeMode progress and result as the TUI renders it. Never persisted: a
 * resumed session falls back to the summaries in `toolUseResult.calls`.
 */
export interface CodeModeDisplay {
  isCodeModeDisplay: true;
  /** Script state, independent of whether the exec/wait tool response has returned. */
  status?: ScriptStatus | 'running';
  /** Calls not already shown in their current state by an earlier poll of the same cell. */
  children: CodeModeChildDisplay[];
  /** Every call the script has made, when `children` omits some. */
  totalCalls?: number;
  /** Script error and printed output, separate from the header's status and count. */
  summary?: string;
}

export function isCodeModeDisplay(obj: unknown): obj is CodeModeDisplay {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'isCodeModeDisplay' in obj &&
    obj.isCodeModeDisplay === true
  );
}

/** Pending summaries occur in running cells; stopped, unsettled calls are cancelled. */
export function codeModeChildStatus(
  status: string | undefined,
): CoreToolCallStatus {
  return (
    (status && CODE_MODE_CHILD_STATUSES[status]) || CoreToolCallStatus.Cancelled
  );
}

const CODE_MODE_CHILD_STATUSES: Record<string, CoreToolCallStatus> = {
  pending: CoreToolCallStatus.Executing,
  completed: CoreToolCallStatus.Success,
  error: CoreToolCallStatus.Error,
};

export function isCodeModeDisplayStatus(
  status: string | undefined,
): status is NonNullable<CodeModeDisplay['status']> {
  return status === 'running' || SCRIPT_STATUSES.includes(status as ScriptStatus);
}

export type ToolLiveOutput =
  | string
  | SubagentProgress
  | ShellLiveOutput
  | CodeModeDisplay;

export interface StructuredToolResult {
  summary: string;
}

export function isStructuredToolResult(
  obj: unknown,
): obj is StructuredToolResult {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'summary' in obj &&
    typeof obj.summary === 'string'
  );
}

export const hasSummary = (res: unknown): res is { summary: string } =>
  isStructuredToolResult(res);

export type ToolStatusResultStatus = 'cancelled' | 'denied';

export interface ToolStatusResult extends StructuredToolResult {
  kind: 'tool-status';
  status: ToolStatusResultStatus;
}

export function buildToolStatusResult(
  status: ToolStatusResultStatus,
  summary: string,
): ToolStatusResult {
  return {
    kind: 'tool-status',
    status,
    summary,
  };
}

export const isToolStatusResult = (res: unknown): res is ToolStatusResult => {
  if (!isStructuredToolResult(res) || !('kind' in res) || !('status' in res)) {
    return false;
  }
  const { kind, status } = res as { kind: unknown; status: unknown };
  return (
    kind === 'tool-status' && (status === 'cancelled' || status === 'denied')
  );
};

export interface GrepResult {
  /** True when pagination or persisted-result bounding omitted data. */
  truncated?: boolean;
  mode?: 'content' | 'files_with_matches' | 'count';
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
  totalFiles?: number;
  totalLines?: number;
  appliedLimit?: number;
  appliedOffset?: number;
  /** @deprecated Present only in transcripts written before Grep matched the cc output protocol. */
  matches?: GrepMatch[];
  /** @deprecated Present only in transcripts written before Grep matched the cc output protocol. */
  summary?: string;
}

function isGrepMode(value: unknown): value is NonNullable<GrepResult['mode']> {
  return (
    value === 'content' || value === 'files_with_matches' || value === 'count'
  );
}

interface CurrentGrepResultShape {
  mode?: unknown;
  filenames?: unknown;
  numFiles?: unknown;
}

function hasCurrentGrepResultShape(res: unknown): boolean {
  if (typeof res !== 'object' || res === null) {
    return false;
  }

  const { mode, filenames, numFiles } = res as CurrentGrepResultShape;
  return (
    isGrepMode(mode) && Array.isArray(filenames) && typeof numFiles === 'number'
  );
}

export const isGrepResult = (res: unknown): res is GrepResult => {
  if (typeof res !== 'object' || res === null) {
    return false;
  }

  const record = res as Record<string, unknown>;
  const isLegacyShape =
    isStructuredToolResult(res) && Array.isArray(record['matches']);

  return hasCurrentGrepResultShape(res) || isLegacyShape;
};

export interface GlobResult {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
  /** Total matching files before truncation. Absent on results persisted by older CLI versions. */
  totalMatches?: number;
  /** False when the search returned only a partial result set. */
  countIsComplete?: boolean;
}

export const isGlobResult = (res: unknown): res is GlobResult =>
  typeof res === 'object' &&
  res !== null &&
  'durationMs' in res &&
  typeof res.durationMs === 'number' &&
  'numFiles' in res &&
  typeof res.numFiles === 'number' &&
  'filenames' in res &&
  Array.isArray(res.filenames) &&
  'truncated' in res &&
  typeof res.truncated === 'boolean';

// ---------------------------------------------------------------------------
// Cron tool result types
// ---------------------------------------------------------------------------

export interface CronCreateResultDisplay {
  cronResultType: 'create';
  id: string;
  cron: string;
  humanSchedule: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
}

export interface CronDeleteResultDisplay {
  cronResultType: 'delete';
  id: string;
}

export interface CronListResultDisplay {
  cronResultType: 'list';
  jobs: Array<{
    id: string;
    cron: string;
    humanSchedule: string;
    prompt: string;
    recurring: boolean;
    durable: boolean;
  }>;
}

export type CronResult =
  | CronCreateResultDisplay
  | CronDeleteResultDisplay
  | CronListResultDisplay;

export const isCronResult = (res: unknown): res is CronResult =>
  typeof res === 'object' &&
  res !== null &&
  'cronResultType' in res &&
  ((res as Record<string, unknown>)['cronResultType'] === 'create' ||
    (res as Record<string, unknown>)['cronResultType'] === 'delete' ||
    (res as Record<string, unknown>)['cronResultType'] === 'list');

export interface TodoWriteResult {
  oldTodos: Todo[];
  newTodos: Todo[];
  verificationNudgeNeeded?: boolean;
}

export const isTodoWriteResult = (res: unknown): res is TodoWriteResult =>
  typeof res === 'object' &&
  res !== null &&
  'oldTodos' in res &&
  Array.isArray(res.oldTodos) &&
  'newTodos' in res &&
  Array.isArray(res.newTodos);

export type FileReadResult =
  | {
      type: 'text';
      file: {
        filePath: string;
        content: string;
        numLines: number;
        startLine: number;
        totalLines: number;
      };
    }
  | {
      type: 'image';
      file: {
        base64?: string;
        url?: string;
        type: string;
        originalSize: number;
        dimensions?: {
          originalWidth?: number;
          originalHeight?: number;
          displayWidth?: number;
          displayHeight?: number;
        };
      };
    }
  | {
      type: 'notebook';
      file: {
        filePath: string;
        cells: unknown[];
      };
    }
  | {
      type: 'pdf';
      file: {
        filePath: string;
        base64: string;
        originalSize: number;
      };
    }
  | {
      type: 'parts';
      file: {
        filePath: string;
        originalSize: number;
        count: number;
        outputDir: string;
      };
    }
  | {
      type: 'file_unchanged';
      file: {
        filePath: string;
      };
    };

export const isFileReadResult = (res: unknown): res is FileReadResult =>
  typeof res === 'object' &&
  res !== null &&
  'type' in res &&
  typeof res.type === 'string' &&
  'file' in res &&
  typeof res.file === 'object' &&
  res.file !== null;

export interface ImageGenResult {
  filePath: string;
  requestId: string;
}

export const isImageGenResult = (res: unknown): res is ImageGenResult =>
  typeof res === 'object' &&
  res !== null &&
  'filePath' in res &&
  typeof res.filePath === 'string' &&
  'requestId' in res &&
  typeof res.requestId === 'string';

export type VideoGenTaskStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed';

export interface VideoGenError {
  code: string;
  message: string;
}

export interface VideoGenResult {
  taskId: string;
  status: VideoGenTaskStatus;
  requestId: string;
  model?: string;
  prompt?: string;
  filePath?: string;
  videoUrl?: string;
  seconds?: number;
  /** Wire size value, when set on submit. */
  size?: string;
  error?: VideoGenError;
}

export const isVideoGenResult = (res: unknown): res is VideoGenResult =>
  typeof res === 'object' &&
  res !== null &&
  'taskId' in res &&
  typeof (res as VideoGenResult).taskId === 'string' &&
  'status' in res &&
  typeof (res as VideoGenResult).status === 'string' &&
  'requestId' in res &&
  typeof (res as VideoGenResult).requestId === 'string';

export interface WebFetchResult {
  bytes: number;
  code: number;
  codeText: string;
  result: string;
  durationMs: number;
  url: string;
}

export const isWebFetchResult = (res: unknown): res is WebFetchResult =>
  typeof res === 'object' &&
  res !== null &&
  'bytes' in res &&
  typeof res.bytes === 'number' &&
  'code' in res &&
  typeof res.code === 'number' &&
  'codeText' in res &&
  typeof res.codeText === 'string' &&
  'result' in res &&
  typeof res.result === 'string' &&
  'durationMs' in res &&
  typeof res.durationMs === 'number' &&
  'url' in res &&
  typeof res.url === 'string';

export interface WebSearchResult {
  query: string;
  results: unknown[];
  durationSeconds: number;
}

export const isWebSearchResult = (res: unknown): res is WebSearchResult =>
  typeof res === 'object' &&
  res !== null &&
  'query' in res &&
  typeof res.query === 'string' &&
  'results' in res &&
  Array.isArray(res.results) &&
  'durationSeconds' in res &&
  typeof res.durationSeconds === 'number';

export interface ImageSearchResult {
  query: string;
  results: unknown[];
  durationSeconds: number;
  requestId: string;
}

export const isImageSearchResult = (
  res: unknown,
): res is ImageSearchResult =>
  typeof res === 'object' &&
  res !== null &&
  'query' in res &&
  typeof res.query === 'string' &&
  'results' in res &&
  Array.isArray(res.results) &&
  'durationSeconds' in res &&
  typeof res.durationSeconds === 'number' &&
  'requestId' in res &&
  typeof res.requestId === 'string';

export type SkillResult =
  | {
      success: boolean;
      commandName: string;
      allowedTools?: string[];
      model?: string;
      status?: 'inline';
    }
  | {
      success: boolean;
      commandName: string;
      status: 'forked';
      agentId?: string;
      result: string;
    };

export const isSkillResult = (res: unknown): res is SkillResult =>
  typeof res === 'object' &&
  res !== null &&
  'success' in res &&
  typeof res.success === 'boolean' &&
  'commandName' in res &&
  typeof res.commandName === 'string';

export interface EnterPlanModeResult {
  message: string;
}

export const isEnterPlanModeResult = (
  res: unknown,
): res is EnterPlanModeResult =>
  typeof res === 'object' &&
  res !== null &&
  'message' in res &&
  typeof res.message === 'string';

export interface ExitPlanModeResult {
  plan: string | null;
  isAgent: boolean;
  status?: 'approved' | 'rejected';
  filePath?: string;
  feedback?: string;
  hasTaskTool?: boolean;
  planWasEdited?: boolean;
  awaitingLeaderApproval?: boolean;
  requestId?: string;
}

export const isExitPlanModeResult = (res: unknown): res is ExitPlanModeResult =>
  typeof res === 'object' &&
  res !== null &&
  'plan' in res &&
  (typeof res.plan === 'string' || res.plan === null) &&
  'isAgent' in res &&
  typeof res.isAgent === 'boolean' &&
  (!('status' in res) ||
    res.status === 'approved' ||
    res.status === 'rejected') &&
  (!('feedback' in res) || typeof res.feedback === 'string');

/** Generic structured result with an expandable payload section. */
export interface PayloadResult extends StructuredToolResult {
  payload: string;
}

export const isPayloadResult = (res: unknown): res is PayloadResult => {
  if (!isStructuredToolResult(res) || !('payload' in res)) return false;
  const { payload } = res as { payload: unknown };
  return typeof payload === 'string';
};

export type ToolResultDisplay =
  | string
  | CodeModeDisplay
  | AgentToolBackgroundLaunchResult
  | AgentToolTeammateSpawnedResult
  | FileDiff
  | TodoList
  | SubagentProgress
  | GrepResult
  | GlobResult
  | CronResult
  | TodoWriteResult
  | FileReadResult
  | FileWriteResult
  | FileEditResult
  | ImageGenResult
  | VideoGenResult
  | WebFetchResult
  | WebSearchResult
  | ImageSearchResult
  | SkillResult
  | EnterPlanModeResult
  | ExitPlanModeResult
  | PayloadResult;

export type TodoStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'blocked';

export interface Todo {
  description: string;
  status: TodoStatus;
}

export interface FileDiff {
  fileDiff: string;
  fileName: string;
  filePath: string;
  /**
   * True when the display was reconstructed from a compact persisted result.
   * In that form `fileDiff` is authoritative and the complete before/after
   * file bodies are intentionally unavailable.
   */
  contentOmitted?: true;
  originalContent: string | null;
  newContent: string;
  diffStat?: DiffStat;
  isNewFile?: boolean;
}

export const isFileDiff = (res: unknown): res is FileDiff =>
  typeof res === 'object' &&
  res !== null &&
  'fileDiff' in res &&
  'fileName' in res &&
  'filePath' in res;

export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileWriteResult {
  type: 'create' | 'update';
  filePath: string;
  content: string;
  structuredPatch: StructuredPatchHunk[];
  originalFile: string | null;
}

export interface FileEditResult {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch: StructuredPatchHunk[];
  userModified: boolean;
  replaceAll: boolean;
}

export const isFileWriteResult = (res: unknown): res is FileWriteResult =>
  typeof res === 'object' &&
  res !== null &&
  'type' in res &&
  (res.type === 'create' || res.type === 'update') &&
  'filePath' in res &&
  typeof res.filePath === 'string' &&
  'content' in res &&
  typeof res.content === 'string' &&
  'structuredPatch' in res &&
  Array.isArray(res.structuredPatch) &&
  'originalFile' in res &&
  (typeof res.originalFile === 'string' || res.originalFile === null);

export const isFileEditResult = (res: unknown): res is FileEditResult =>
  typeof res === 'object' &&
  res !== null &&
  'filePath' in res &&
  typeof res.filePath === 'string' &&
  'oldString' in res &&
  typeof res.oldString === 'string' &&
  'newString' in res &&
  typeof res.newString === 'string' &&
  'originalFile' in res &&
  typeof res.originalFile === 'string' &&
  'structuredPatch' in res &&
  Array.isArray(res.structuredPatch);

export interface DiffStat {
  model_added_lines: number;
  model_removed_lines: number;
  model_added_chars: number;
  model_removed_chars: number;
  user_added_lines: number;
  user_removed_lines: number;
  user_added_chars: number;
  user_removed_chars: number;
}

export interface ToolEditConfirmationPayload {
  newContent: string;
}

export interface ToolAskUserConfirmationPayload {
  answers: { [questionText: string]: string };
  annotations?: { [questionText: string]: QuestionAnnotation };
}

export interface ToolExitPlanModeConfirmationPayload {
  /** Whether the user approved the plan */
  approved: boolean;
  /** If rejected, the user's feedback */
  feedback?: string;
  /** True when the user edited the plan file in an external editor before approving */
  planWasEdited?: boolean;
  /**
   * When true, immediately activate the goal loop after exiting plan mode
   * (ExitPlanModeDialog "Yes, start goal execution" option).
   */
  startGoal?: boolean;
}

export interface ToolCancelFeedbackPayload {
  /** User's feedback/suggestions for why the tool execution was rejected */
  cancelFeedback: string;
}

export interface ToolWorkflowConfirmationPayload {
  /** Edited workflow script content to run instead of the original source. */
  script: string;
  /** Clear source selectors when an edited script should run inline. */
  scriptPath?: undefined;
  name?: undefined;
}

export type ToolConfirmationPayload =
  | ToolEditConfirmationPayload
  | ToolAskUserConfirmationPayload
  | ToolExitPlanModeConfirmationPayload
  | ToolCancelFeedbackPayload
  | ToolWorkflowConfirmationPayload;

/**
 * Extract the user's cancel feedback from a confirmation payload, if present.
 * Returns the feedback string or a default message.
 */
export function extractCancelFeedback(
  payload: ToolConfirmationPayload | undefined,
): string {
  if (payload && 'cancelFeedback' in payload) {
    return payload.cancelFeedback;
  }
  return 'User cancelled.';
}

export enum ToolConfirmationOutcome {
  ProceedOnce = 'proceed_once',
  ProceedSession = 'proceed_always',
  ProceedPersist = 'proceed_always_and_save',
  ModifyWithEditor = 'modify_with_editor',
  Cancel = 'cancel',
}

export enum Kind {
  Read = 'read',
  Edit = 'edit',
  Delete = 'delete',
  Move = 'move',
  Search = 'search',
  Execute = 'execute',
  Think = 'think',
  Agent = 'agent',
  Fetch = 'fetch',
  Communicate = 'communicate',
  Plan = 'plan',
  SwitchMode = 'switch_mode',
  Workflow = 'workflow',
  Other = 'other',
}

// Function kinds that have side effects
export const MUTATOR_KINDS: Kind[] = [
  Kind.Edit,
  Kind.Delete,
  Kind.Move,
  Kind.Execute,
] as const;

// Function kinds that are safe to run in parallel
export const READ_ONLY_KINDS: Kind[] = [
  Kind.Read,
  Kind.Search,
  Kind.Fetch,
] as const;

export interface ToolLocation {
  // Absolute path to the file
  path: string;
  // Which line (if known)
  line?: number;
}
