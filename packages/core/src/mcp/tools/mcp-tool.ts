/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { safeJsonStringify } from '../../utils/safeJsonStringify.js';
import { coerceArgsToSchema } from '../../utils/coerceArgs.js';
import type { SchemaValidationMode } from '../../utils/schemaValidator.js';
import {
  getBase64DecodedSize,
  persistBinaryData,
  sanitizeUnicode,
} from '../mcpContentProcessing.js';
import {
  decodeBase64ImageData,
  processImageBufferWithTokenBudget,
} from '../../utils/imageReader.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from '../../tools/tools.js';
import type { ToolUseContext } from '../../tools/tool-types.js';
import { mcpModelContext, type McpModelInfo } from './mcp-model-context.js';
import type { CallableTool, FunctionCall, Part, Tool } from '@google/genai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpClientContext } from '../mcpClientContext.js';
import { validateAndTruncateMcpTextOutputWithResult } from '../mcpOutputValidation.js';
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../utils/fileUtils.js';
import { MAX_READ_TOKENS } from '../../utils/constants.js';


import { mcpContract } from '../../codemode/contracts.js';
import type {
  ProgrammaticContract,
  ToolExposureHints,
} from '../../codemode/types.js';
import type {
  McpResultMeta,
  McpSemanticContentBlock,
  McpSemanticToolResult,
} from './mcp-result.js';

// The qualified-name primitives live in a leaf module so that tool-name
// constants can classify a name without importing this file.
import {
  MCP_QUALIFIED_NAME_SEPARATOR,
  MCP_TOOL_PREFIX,
  isMcpToolName,
  normalizeMcpSegment,
  parseMcpToolName,
} from './mcp-names.js';

import { randomUUID } from 'node:crypto';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type {
  MCPServerConfig,
  McpToolRuntimeOverride,
} from '../mcpServerConfig.js';
import { runLogger } from '../../utils/runLogger.js';
import { McpAuthorizationRequiredError } from '../authorization.js';
import { createMcpToolErrorResult, getMcpErrorMessage } from '../errors.js';
import { isCancelledError } from '../../tools/abort-utils.js';
import {
  restoreOriginalArgKeys,
  sanitizeMcpInputSchema,
} from '../mcp-schema-sanitizer.js';
import { getToolCallContext } from '../../utils/toolCallContext.js';
import {
  McpToolIdleWatchdog,
  resolveMcpRequestTimeoutMs,
  resolveMcpToolHardTimeoutMs,
  resolveMcpToolIdleTimeoutMs,
} from './mcp-timeouts.js';
import type { McpProgressReporter } from '../client/progress.js';
import { inferMcpTransportTelemetryType } from '../client/mcpClient.js';

export {
  MCP_QUALIFIED_NAME_SEPARATOR,
  MCP_TOOL_PREFIX,
  isMcpToolName,
  normalizeMcpSegment,
  parseMcpToolName,
};

/**
 * Assembles a fully qualified MCP tool name (or wildcard pattern) from its server and tool components.
 *
 * @param serverName The backend MCP server name (can be '*' for global wildcards).
 * @param toolName The name of the tool (can be undefined or '*' for tool-level wildcards).
 * @returns The fully qualified name (e.g., `mcp__server__tool`, `mcp__*`, `mcp__server__*`).
 */
export function formatMcpToolName(
  serverName: string,
  toolName?: string,
): string {
  const SEP = MCP_QUALIFIED_NAME_SEPARATOR;
  if (serverName === '*' && (toolName === undefined || toolName === '*')) {
    return `${MCP_TOOL_PREFIX}*`;
  } else if (serverName === '*') {
    return `${MCP_TOOL_PREFIX}*${SEP}${toolName}`;
  } else if (toolName === undefined || toolName === '*') {
    return `${MCP_TOOL_PREFIX}${serverName}${SEP}*`;
  } else {
    return `${MCP_TOOL_PREFIX}${serverName}${SEP}${toolName}`;
  }
}

/**
 * Builds a fully qualified MCP tool name from unnormalized server and tool
 * names. Inverse of {@link parseMcpToolName}.
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${normalizeMcpSegment(serverName)}${MCP_QUALIFIED_NAME_SEPARATOR}${normalizeMcpSegment(toolName)}`;
}

/**
 * Interface representing metadata annotations specific to an MCP tool.
 * Ensures strongly-typed access to server-level properties.
 */
export interface McpToolAnnotation extends Record<string, unknown> {
  _serverName: string;
}

/**
 * Type guard to check if tool annotations implement McpToolAnnotation.
 */
export function isMcpToolAnnotation(
  annotation: unknown,
): annotation is McpToolAnnotation {
  if (typeof annotation !== 'object' || annotation === null) {
    return false;
  }

  const record = annotation as Record<string, unknown>;
  const serverName = record['_serverName'];
  return typeof serverName === 'string';
}

type ToolParams = Record<string, unknown>;

// Discriminated union for MCP Content Blocks to ensure type safety.
type McpTextBlock = {
  type: 'text';
  text: string;
  _meta?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

type McpImageBlock = {
  type: 'image';
  mimeType: string;
  data: string;
  _meta?: Record<string, unknown>;
};

type McpAudioBlock = {
  type: 'audio';
  mimeType: string;
  data: string;
  _meta?: Record<string, unknown>;
};

type McpMediaBlock = McpImageBlock | McpAudioBlock;

type McpResourceBlock = {
  type: 'resource';
  _meta?: Record<string, unknown>;
  resource: {
    uri?: string;
    name?: string;
    title?: string;
    text?: string;
    blob?: string;
    mimeType?: string;
    _meta?: Record<string, unknown>;
  };
};

type McpResourceLinkBlock = {
  type: 'resource_link';
  uri: string;
  title?: string;
  name?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
};

interface McpCallToolResult {
  content?: unknown;
  structuredContent?: unknown;
  _meta?: unknown;
  isError?: boolean | string;
  error?: unknown;
}

interface NormalizedMcpToolResult {
  toolUseResult: McpSemanticToolResult;
  mcpResult?: ToolResult['mcpResult'];
  mcpMeta?: McpResultMeta;
  modelParts: Part[];
  isError: boolean;
}

type McpContentBlock =
  | McpTextBlock
  | McpMediaBlock
  | McpResourceBlock
  | McpResourceLinkBlock;

/**
 * Metadata preserving the original (unnormalized) server and tool names for
 * an MCP tool. This lets callers reverse-map a normalized registry name
 * (which may have had invalid characters rewritten) back to the original
 * server/tool pair.
 */
export interface McpInfo {
  serverName: string;
  toolName: string;
}

export interface McpToolExtension {
  exposedName?: string;
  alwaysLoad?: boolean;
  /** Server-level opt-in: reached through CodeMode discovery or MCP meta tools, not declared. */
  deferred?: boolean;
}

export class DiscoveredMCPToolInvocation extends BaseToolInvocation<
  ToolParams,
  ToolResult
> {
  /** Original (unnormalized) server+tool names preserved for reverse lookup. */
  readonly mcpInfo: McpInfo;

  constructor(
    private readonly mcpTool: CallableTool,
    readonly serverName: string,
    readonly serverToolName: string,
    readonly displayName: string,
    readonly trust?: boolean,
    params: ToolParams = {},
    _cliConfig?: McpClientContext,
    _toolDescription?: string,
    private readonly toolParameterSchema?: unknown,
    toolAnnotationsData?: Record<string, unknown>,
    invocationToolName?: string,
  ) {
    super(
      params,
      invocationToolName ?? buildMcpToolName(serverName, serverToolName),
      displayName,
      normalizeMcpSegment(serverName),
      toolAnnotationsData,
    );
    this.mcpInfo = { serverName, toolName: serverToolName };
  }

  // Determine if the response contains tool errors
  // This is needed because CallToolResults should return errors inside the response.
  // ref: https://modelcontextprotocol.io/specification/2025-06-18/schema#calltoolresult
  isMCPToolError(rawResponseParts: Part[]): boolean {
    const response = rawResponseParts?.[0]?.functionResponse?.response;
    return isMcpErrorResponse(response as McpCallToolResult | undefined);
  }

  override executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    const workspaceContext = ctx.config?.getWorkspaceContext();
    const modelInfo: McpModelInfo = {
      displayName: ctx.modelDisplayName ?? '',
      key: ctx.modelKey ?? '',
      sessionId: ctx.sessionId,
      requestSetId: ctx.parentRequestSetId,
      modelEntry: ctx.modelEntry,
      cwd: ctx.config?.getWorkingDir() ?? ctx.config?.getTargetDir(),
      workspaceDirectories: workspaceContext?.getDirectories(),
    };
    return mcpModelContext.run(modelInfo, () => this.executeRaw(ctx.signal));
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    return this.executeRaw(signal);
  }

  private async executeRaw(signal: AbortSignal): Promise<ToolResult> {
    const startedAt = Date.now();
    runLogger.log(
      `[mcp-tool] call started server=${this.serverName} tool=${this.serverToolName}`,
    );

    // Coerce argument types based on MCP schema to handle models
    // that output all parameter values as strings.
    const schemaProps = (
      this.toolParameterSchema as Record<string, unknown> | undefined
    )?.['properties'] as Record<string, unknown> | undefined;
    const coercedParams =
      coerceArgsToSchema(this.params, schemaProps) ?? this.params;

    const functionCalls: FunctionCall[] = [
      {
        name: this.serverToolName,
        args: coercedParams,
      },
    ];

    let rawResponseParts: Part[];
    try {
      rawResponseParts = await (async () => {

          // Race MCP tool call with abort signal to respect cancellation.
          const parts = await new Promise<Part[]>((resolve, reject) => {
            if (signal.aborted) {
              const error = new Error('Tool call aborted');
              error.name = 'AbortError';
              reject(error);
              return;
            }
            const onAbort = () => {
              cleanup();
              const error = new Error('Tool call aborted');
              error.name = 'AbortError';
              reject(error);
            };
            const cleanup = () => {
              signal.removeEventListener('abort', onAbort);
            };
            signal.addEventListener('abort', onAbort, { once: true });

            (this.mcpTool as SignalAwareCallableTool)
              .callTool(functionCalls, signal)
              .then((res) => {
                cleanup();
                resolve(res);
              })
              .catch((err) => {
                cleanup();
                reject(err);
              });
          });

          return parts;
        })();
    } catch (error) {
      if (isCancelledError(error, signal)) throw error;
      const result = createMcpToolErrorResult(error);
      runLogger.warn(
        `[mcp-tool] call failed server=${this.serverName} tool=${this.serverToolName} durationMs=${Date.now() - startedAt} error=${result.error?.message}`,
      );
      return result;
    }

    const normalized = await normalizeMcpToolResult(
      rawResponseParts,
      this.serverName,
      this.serverToolName,
    );
    const validatedOutput = validateAndTruncateMcpTextOutputWithResult(
      normalized.modelParts,
      this.serverName,
      this.serverToolName,
    );
    const toolResultParts = validatedOutput.parts;
    const toolUseResult = validatedOutput.truncated
      ? modelPartsToMcpSemanticToolResult(toolResultParts, normalized.isError)
      : normalized.toolUseResult;
    const displayText = getStringifiedResultForDisplay(rawResponseParts);
    const result: ToolResult = {
      // Keep semantic persistence empty while allowing the scheduler's shared
      // no-output mapper to produce the provider-facing completion sentinel.
      llmContent: toolResultParts.length > 0 ? toolResultParts : '',
      returnDisplay: displayText,
      toolUseResult,
      mcpMeta: normalized.mcpMeta,
      mcpResult: normalized.mcpResult,
      ...(normalized.isError ? { isError: true } : {}),
    };
    runLogger.log(
      `[mcp-tool] call completed server=${this.serverName} tool=${this.serverToolName} isError=${normalized.isError} durationMs=${Date.now() - startedAt}`,
    );
    return result;
  }

  getDescription(): string {
    return safeJsonStringify(this.params);
  }

  override getDisplayTitle(): string {
    // If it's a known terminal execute tool provided by JetBrains or similar,
    // and a command argument is present, return just the command.
    const command = this.params['command'];
    if (typeof command === 'string') {
      return command;
    }

    // Otherwise fallback to the display name or server tool name
    return this.displayName || this.serverToolName;
  }

  override getExplanation(): string {
    const MAX_EXPLANATION_LENGTH = 500;
    const stringified = safeJsonStringify(this.params);
    if (stringified.length > MAX_EXPLANATION_LENGTH) {
      const keys = Object.keys(this.params);
      const displayedKeys = keys.slice(0, 5);
      const keysDesc =
        displayedKeys.length > 0
          ? ` with parameters: ${displayedKeys.join(', ')}${
              keys.length > 5 ? ', ...' : ''
            }`
          : '';
      return `[Payload omitted due to length${keysDesc}]`;
    }
    return stringified;
  }
}

export class DiscoveredMCPTool extends BaseDeclarativeTool<
  ToolParams,
  ToolResult
> {
  protected override get schemaValidationMode(): SchemaValidationMode {
    return 'coerce-on-failure';
  }

  override get maxResultSizeChars(): number {
    return DEFAULT_MAX_RESULT_SIZE_CHARS;
  }
  constructor(
    private readonly mcpTool: CallableTool,
    readonly serverName: string,
    readonly serverToolName: string,
    description: string,
    override readonly parameterSchema: unknown,
    readonly trust?: boolean,
    isReadOnly?: boolean,
    nameOverride?: string,
    private readonly cliConfig?: McpClientContext,
    override readonly pluginName?: string,
    override readonly pluginId?: string,
    private readonly _toolAnnotations?: Record<string, unknown>,
    readonly transportType?: string,
    private readonly extension?: McpToolExtension,
  ) {
    super(
      nameOverride ?? buildMcpToolName(serverName, serverToolName),
      `${serverToolName} (${serverName} MCP Server)`,
      /[^\p{ASCII}]/u.test(serverToolName)
        ? `Original tool name: ${serverToolName}\n${description}`
        : description,
      Kind.Other,
      parameterSchema,
      true, // isOutputMarkdown
      false, // canUpdateOutput,
      pluginName,
      pluginId,
    );
    this._isReadOnly = isReadOnly;
  }

  private readonly _isReadOnly?: boolean;

  override get programmatic(): ProgrammaticContract {
    return mcpContract;
  }

  private _exposureHints?: ToolExposureHints;

  /** alwaysLoad keeps a tool declared even when its server opts into deferral. */
  override get exposureHints(): ToolExposureHints {
    return (this._exposureHints ??= Object.freeze({
      namespace: { kind: 'mcp' as const, server: this.serverName },
      ...(this.alwaysLoad ? { pinned: true } : {}),
      ...(this.extension?.deferred ? { defaultDeferred: true } : {}),
    }));
  }

  get exposedName(): string | undefined {
    return this.extension?.exposedName;
  }

  get alwaysLoad(): boolean {
    return this.extension?.alwaysLoad === true;
  }

  getModelName(): string {
    return this.exposedName ?? this.getFullyQualifiedName();
  }

  override get isReadOnly(): boolean {
    if (this._isReadOnly !== undefined) {
      return this._isReadOnly;
    }
    return super.isReadOnly;
  }

  override isDestructive(input?: ToolParams): boolean {
    return (
      this._toolAnnotations?.['destructiveHint'] === true ||
      super.isDestructive(input)
    );
  }

  override isOpenWorld(input?: ToolParams): boolean {
    return (
      this._toolAnnotations?.['openWorldHint'] === true ||
      super.isOpenWorld(input)
    );
  }

  /**
   * Provide classifier-relevant input for auto mode evaluation.
   * MCP tools can access external services, so the classifier needs
   * to see the server, tool, and arguments to evaluate safety.
   *
   * Server-declared annotation hints (`destructiveHint` / `openWorldHint`)
   * are intentionally NOT surfaced here. They are unverifiable advisory
   * metadata: a malicious or careless server can under- or over-declare
   * with no enforcement, so admitting them into security decisions creates
   * authority-laundering (we'd be implicitly vouching for the server's
   * self-assessment) and consent-fatigue (servers can spam destructive=true
   * to train users to bypass warnings) risks. The classifier reasons from
   * the description text + arguments + transcript intent — those are also
   * server-supplied for description, but at least require the LLM to read
   * and reason rather than over-weight a structured boolean. The single
   * hint we do honor is `readOnlyHint`, but only for parallel batching
   * (via `isConcurrencySafe`) — that's a path where misdeclaration
   * self-punishes the server (their own backend hits races/corruption),
   * which is the rare case where the protocol's hint incentive aligns.
   */
  override toClassifierInput(input: ToolParams): unknown {
    let argsSummary: string;
    try {
      argsSummary = JSON.stringify(input);
    } catch {
      argsSummary = '[unserializable arguments]';
    }
    return {
      mcp_server: this.serverName,
      mcp_tool: this.serverToolName,
      description: this.description?.slice(0, 500),
      arguments: argsSummary,
    };
  }

  override get toolAnnotations(): Record<string, unknown> | undefined {
    return this._toolAnnotations;
  }

  /** Original (unnormalized) server+tool names preserved for reverse lookup. */
  get mcpInfo(): McpInfo {
    return { serverName: this.serverName, toolName: this.serverToolName };
  }

  getFullyQualifiedPrefix(): string {
    return `${MCP_TOOL_PREFIX}${normalizeMcpSegment(this.serverName)}${MCP_QUALIFIED_NAME_SEPARATOR}`;
  }

  getFullyQualifiedName(): string {
    return buildMcpToolName(this.serverName, this.serverToolName);
  }
  protected createInvocation(
    params: ToolParams,
    _toolName?: string,
    _displayName?: string,
  ): ToolInvocation<ToolParams, ToolResult> {
    return new DiscoveredMCPToolInvocation(
      this.mcpTool,
      this.serverName,
      this.serverToolName,
      _displayName ?? this.displayName,
      this.trust,
      params,
      this.cliConfig,
      this.description,
      this.parameterSchema,
      this._toolAnnotations,
      this.getModelName(),
    );
  }

  // === Permission Pipeline methods ===
}

const MCP_IMAGE_MAX_TOKENS = MAX_READ_TOKENS;

async function prepareMcpImageSemanticBlocks(
  data: string,
  mimeType: string,
  toolName: string,
  label: string,
): Promise<McpSemanticContentBlock[]> {
  try {
    const imageBuffer = decodeBase64ImageData(data);
    const image = await processImageBufferWithTokenBudget(imageBuffer, {
      maxTokens: MCP_IMAGE_MAX_TOKENS,
      originalMediaType: mimeType,
    });
    return [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.base64,
        },
      },
    ];
  } catch (error) {
    return [
      {
        type: 'text',
        text: `[${label} from tool '${toolName}' (mime-type: ${mimeType}) could not be processed: ${String(error)}]`,
      },
    ];
  }
}

async function transformImageBlock(
  block: McpImageBlock,
  toolName: string,
): Promise<McpSemanticContentBlock[]> {
  return prepareMcpImageSemanticBlocks(
    block.data,
    block.mimeType,
    toolName,
    block.type,
  );
}

function transformAudioBlock(
  block: McpAudioBlock,
  serverName: string,
  toolName: string,
  spillDir?: string,
): McpSemanticContentBlock[] {
  try {
    const filePath = persistBinaryData(
      block.data,
      block.mimeType,
      toolName,
      spillDir,
    );
    return [
      {
        type: 'text',
        text: `[Audio from ${serverName}] Binary content (${block.mimeType}, ${getBase64DecodedSize(block.data)} bytes) saved to ${filePath}`,
      },
    ];
  } catch (error) {
    return [
      {
        type: 'text',
        text: `[Audio from ${serverName}] Binary content (${block.mimeType}) could not be saved: ${String(error)}`,
      },
    ];
  }
}

async function transformResourceBlock(
  block: McpResourceBlock,
  serverName: string,
  toolName: string,
  spillDir?: string,
): Promise<McpSemanticContentBlock[]> {
  const resource = block.resource;
  const uri = resource?.uri ?? 'unknown URI';
  if (resource?.text) {
    return [
      {
        type: 'text',
        text: `[Resource from ${serverName} at ${uri}] ${sanitizeUnicode(resource.text)}`,
      },
    ];
  }
  if (resource?.blob) {
    const mimeType = resource.mimeType || 'application/octet-stream';

    if (mimeType.startsWith('image/')) {
      const imageBlocks = await prepareMcpImageSemanticBlocks(
        resource.blob,
        mimeType,
        toolName,
        'resource image',
      );
      return [
        {
          type: 'text',
          text: `[Resource from ${serverName} at ${uri}]`,
        },
        ...imageBlocks,
      ];
    }

    try {
      const filePath = persistBinaryData(
        resource.blob,
        mimeType,
        toolName,
        spillDir,
      );
      return [
        {
          type: 'text',
          text: `[Resource from ${serverName} at ${uri}] Binary content (${mimeType}, ${getBase64DecodedSize(resource.blob)} bytes) saved to ${filePath}`,
        },
      ];
    } catch (error) {
      return [
        {
          type: 'text',
          text: `[Resource from ${serverName} at ${uri}] Binary content (${mimeType}) could not be saved: ${String(error)}`,
        },
      ];
    }
  }
  return [];
}

function transformResourceLinkBlock(
  block: McpResourceLinkBlock,
): McpSemanticContentBlock[] {
  const name = block.title || block.name || 'resource';
  const description = block.description ? ` (${block.description})` : '';
  return [
    {
      type: 'text',
      text: `[Resource link: ${name}] ${block.uri}${description}`,
    },
  ];
}

function extractMcpErrorMessage(response: unknown): string | undefined {
  if (!response || typeof response !== 'object') {
    return undefined;
  }
  if (!('error' in response)) {
    return undefined;
  }
  const error = (response as { error: unknown }).error;
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const { message } = error as { message: unknown };
    if (typeof message === 'string') {
      return message;
    }
  }
  return undefined;
}

async function transformMcpContentToSemanticBlocks(
  mcpContent: McpContentBlock[],
  serverName: string,
  toolName: string,
  spillDir?: string,
): Promise<McpSemanticContentBlock[]> {
  // Process blocks with bounded concurrency for image-heavy responses.
  const IMAGE_CONCURRENCY = 3;
  const results: McpSemanticContentBlock[][] = new Array(mcpContent.length);
  const pendingImages: Array<{
    index: number;
    block: McpImageBlock | McpResourceBlock;
  }> = [];

  for (let i = 0; i < mcpContent.length; i++) {
    const block = mcpContent[i];
    switch (block.type) {
      case 'text':
        results[i] = [
          {
            type: 'text',
            text: sanitizeUnicode(block.text),
            ...(block._meta ? { _meta: block._meta } : {}),
          },
        ];
        break;
      case 'audio':
        results[i] = transformAudioBlock(block, serverName, toolName, spillDir);
        break;
      case 'resource_link':
        results[i] = transformResourceLinkBlock(block);
        break;
      case 'image':
      case 'resource':
        pendingImages.push({ index: i, block });
        break;
      default:
        results[i] = [];
    }
  }

  for (let i = 0; i < pendingImages.length; i += IMAGE_CONCURRENCY) {
    const batch = pendingImages.slice(i, i + IMAGE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(({ block }) =>
        block.type === 'image'
          ? transformImageBlock(block, toolName)
          : transformResourceBlock(block, serverName, toolName, spillDir),
      ),
    );
    for (let j = 0; j < batch.length; j++) {
      results[batch[j].index] = batchResults[j];
    }
  }

  return results.flat();
}

function semanticBlocksToParts(blocks: McpSemanticContentBlock[]): Part[] {
  return blocks.map((block): Part => {
    if (block.type === 'text') {
      return { text: block.text };
    }
    return {
      inlineData: {
        mimeType: block.source.media_type,
        data: block.source.data,
      },
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMcpErrorResponse(response: McpCallToolResult | undefined): boolean {
  if (!response) return false;
  if (response.isError === true || response.isError === 'true') return true;
  const error = response.error;
  return (
    isRecord(error) &&
    (error['isError'] === true || error['isError'] === 'true')
  );
}

function semanticBlocksToText(blocks: McpSemanticContentBlock[]): string {
  const text = blocks
    .map((block) =>
      block.type === 'text'
        ? block.text
        : `[Image: ${block.source.media_type}]`,
    )
    .join('\n');
  return text || '(no content)';
}

function modelPartsToMcpSemanticToolResult(
  parts: Part[],
  isError: boolean,
): McpSemanticToolResult {
  const blocks = parts.flatMap((part): McpSemanticContentBlock[] => {
    if (typeof part.text === 'string') {
      return [{ type: 'text', text: part.text }];
    }
    if (part.inlineData) {
      return [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.inlineData.mimeType ?? 'application/octet-stream',
            data: part.inlineData.data ?? '',
          },
        },
      ];
    }
    return [];
  });

  if (isError) {
    return `Error: ${semanticBlocksToText(blocks)}`;
  }
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return blocks[0].text;
  }
  return blocks;
}

async function normalizeMcpToolResult(
  sdkResponse: Part[],
  serverName: string,
  fallbackToolName: string,
  spillDir?: string,
): Promise<NormalizedMcpToolResult> {
  const functionResponse = sdkResponse?.[0]?.functionResponse;
  const response = functionResponse?.response as McpCallToolResult | undefined;
  const toolName = functionResponse?.name || fallbackToolName;
  const isError = isMcpErrorResponse(response);
  const rawContent = Array.isArray(response?.content)
    ? (response.content as McpContentBlock[])
    : response && response.content === undefined
      ? []
      : undefined;
  const topLevelMeta = isRecord(response?._meta) ? response._meta : undefined;
  const structuredContent = isRecord(response?.structuredContent)
    ? response.structuredContent
    : undefined;

  if (!rawContent) {
    const errorText = extractMcpErrorMessage(response);
    const fallbackText = errorText
      ? sanitizeUnicode(errorText)
      : '[Error: Could not parse tool response]';
    return {
      toolUseResult: isError ? `Error: ${fallbackText}` : fallbackText,
      modelParts: [{ text: fallbackText }],
      isError,
      ...(topLevelMeta ? { mcpMeta: { _meta: topLevelMeta } } : {}),
    };
  }

  let semanticBlocks: McpSemanticContentBlock[];
  let toolUseResult: McpSemanticToolResult;
  const legacyErrorText = isError
    ? extractMcpErrorMessage(response)
    : undefined;
  const legacyContent =
    rawContent.length === 0 && legacyErrorText
      ? [{ type: 'text' as const, text: sanitizeUnicode(legacyErrorText) }]
      : undefined;
  if (!isError && structuredContent) {
    const structuredJson = JSON.stringify(structuredContent);
    const nonTextContent = rawContent.filter((block) => block.type !== 'text');
    if (nonTextContent.length === 0) {
      semanticBlocks = [{ type: 'text', text: structuredJson }];
      toolUseResult = structuredJson;
    } else {
      semanticBlocks = await transformMcpContentToSemanticBlocks(
        nonTextContent,
        serverName,
        toolName,
        spillDir,
      );
      semanticBlocks.push({ type: 'text', text: structuredJson });
      toolUseResult = semanticBlocks;
    }
  } else {
    semanticBlocks =
      legacyContent ??
      (await transformMcpContentToSemanticBlocks(
        rawContent,
        serverName,
        toolName,
        spillDir,
      ));
    toolUseResult = isError
      ? `Error: ${semanticBlocksToText(semanticBlocks)}`
      : semanticBlocks;
  }

  const mcpMeta: McpResultMeta = {
    ...(topLevelMeta ? { _meta: topLevelMeta } : {}),
    ...(!isError && structuredContent ? { structuredContent } : {}),
  };

  return {
    toolUseResult,
    mcpResult: {
      content: legacyContent ?? rawContent,
      ...(structuredContent ? { structuredContent } : {}),
      isError,
    },
    modelParts: semanticBlocksToParts(semanticBlocks),
    isError,
    ...(Object.keys(mcpMeta).length > 0 ? { mcpMeta } : {}),
  };
}

function getStringifiedResultForDisplay(rawResponse: Part[]): string {
  const response = rawResponse?.[0]?.functionResponse?.response;
  const mcpContent = response?.['content'] as McpContentBlock[];

  if (!Array.isArray(mcpContent)) {
    const errorMsg = extractMcpErrorMessage(response);
    if (errorMsg) {
      return errorMsg;
    }
    return '```json\n' + JSON.stringify(rawResponse, null, 2) + '\n```';
  }

  const displayParts = mcpContent.map((block: McpContentBlock): string => {
    switch (block.type) {
      case 'text':
        return block.text;
      case 'image':
        return `[Image: ${block.mimeType}]`;
      case 'audio':
        return `[Audio: ${block.mimeType}]`;
      case 'resource_link':
        return `[Link to ${block.title || block.name}: ${block.uri}]`;
      case 'resource':
        if (block.resource?.text) {
          return block.resource.text;
        }
        return `[Embedded Resource: ${
          block.resource?.mimeType || 'unknown type'
        }]`;
      default:
        return `[Unknown content type: ${(block as { type: string }).type}]`;
    }
  });

  return displayParts.join('\n');
}

/**
 * Generate a valid MCP tool name from an unqualified input.
 *
 * Accepts either:
 *   - a raw single segment (e.g. `myTool`), which is normalized and prefixed
 *   - a pre-joined name using the MCP separator (e.g. `server__tool`), in
 *     which case each segment is normalized independently to avoid collapsing
 *     the delimiter
 *
 * The input may already start with `mcp__`; the prefix is stripped and
 * re-added after normalization.
 */
export function generateValidName(name: string) {
  const raw = name.startsWith(MCP_TOOL_PREFIX)
    ? name.slice(MCP_TOOL_PREFIX.length)
    : name;
  const parts = raw
    .split(MCP_QUALIFIED_NAME_SEPARATOR)
    .map(normalizeMcpSegment)
    .filter((part) => part.length > 0);
  return `${MCP_TOOL_PREFIX}${parts.join(MCP_QUALIFIED_NAME_SEPARATOR)}`;
}

const MCP_EXPOSED_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_MCP_TOOL_NAMES = new Set(['mcp_list', 'mcp_get', 'mcp_call']);

function validateMcpToolOverride(
  serverName: string,
  toolName: string,
  override: McpToolRuntimeOverride,
): void {
  if (override.exposedName === undefined) return;
  if (override.alwaysLoad !== true) {
    throw new Error(
      `MCP tool '${serverName}/${toolName}' sets exposedName without alwaysLoad: true`,
    );
  }
  if (!MCP_EXPOSED_TOOL_NAME_PATTERN.test(override.exposedName)) {
    throw new Error(
      `Invalid exposedName '${override.exposedName}' for MCP tool '${serverName}/${toolName}'`,
    );
  }
  if (RESERVED_MCP_TOOL_NAMES.has(override.exposedName)) {
    throw new Error(
      `MCP tool '${serverName}/${toolName}' cannot use reserved exposedName '${override.exposedName}'`,
    );
  }
}

interface NamedTool {
  name?: string;
}

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

export interface McpToolCaller {
  callMcpTool(
    params: {
      name: string;
      arguments?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<CallToolResult>;
}

type SignalAwareCallableTool = CallableTool & {
  callTool(
    functionCalls: FunctionCall[],
    signal?: AbortSignal,
  ): Promise<Part[]>;
};

export async function discoverTools(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  mcpClient: Client,
  toolCaller: McpToolCaller,
  cliConfig: McpClientContext,
  options?: {
    timeout?: number;
    signal?: AbortSignal;
    progressReporter?: McpProgressReporter;
    strict?: boolean;
  },
): Promise<DiscoveredMCPTool[]> {
  try {
    // Only request tools if the server supports them.
    if (mcpClient.getServerCapabilities()?.tools == null) return [];

    const {
      progressReporter,
      strict: _strict,
      ...requestOptions
    } = options ?? {};
    const discoveredTools: DiscoveredMCPTool[] = [];
    let cursor: string | undefined;
    do {
      const response = await mcpClient.listTools(cursor ? { cursor } : {}, {
        timeout: resolveMcpRequestTimeoutMs(),
        ...requestOptions,
      });
      cursor = response.nextCursor ?? undefined;
      for (const toolDef of response.tools) {
        try {
          if (!isEnabled(toolDef, mcpServerName, mcpServerConfig)) {
            continue;
          }

          const { schema: sanitizedInputSchema, keyMap: propertyKeyMap } =
            sanitizeMcpInputSchema(
              toolDef.inputSchema ?? { type: 'object', properties: {} },
              `${mcpServerName}/${toolDef.name}`,
            );

          const mcpCallableTool = new McpCallableTool(
            toolCaller,
            toolDef,
            mcpServerConfig,
            progressReporter,
            sanitizedInputSchema,
            propertyKeyMap,
          );

          // Extract annotations from the tool definition
          const annotations = toolDef.annotations;
          const isReadOnly = annotations?.readOnlyHint === true;
          const toolOverride = mcpServerConfig.toolOverrides?.[toolDef.name];
          if (toolOverride) {
            validateMcpToolOverride(mcpServerName, toolDef.name, toolOverride);
          }

          const tool = new DiscoveredMCPTool(
            mcpCallableTool,
            mcpServerName,
            toolDef.name,
            toolDef.description ?? '',
            sanitizedInputSchema,
            mcpServerConfig.trust,
            isReadOnly,
            undefined,
            cliConfig,
            mcpServerConfig.plugin?.name,
            mcpServerConfig.plugin?.id,
            annotations as Record<string, unknown> | undefined,
            inferMcpTransportTelemetryType(mcpServerConfig),
            mcpServerConfig.deferred === true
              ? { ...toolOverride, deferred: true }
              : toolOverride,
          );

          discoveredTools.push(tool);
        } catch (error) {
          cliConfig.emitMcpDiagnostic(
            'error',
            `Error discovering tool: '${
              toolDef.name
            }' from MCP server '${mcpServerName}': ${(error as Error).message}`,
            error,
            mcpServerName,
          );
        }
      }
    } while (cursor);
    return discoveredTools;
  } catch (error) {
    if (options?.strict || error instanceof McpAuthorizationRequiredError)
      throw error;
    if (
      error instanceof Error &&
      !error.message?.includes('Method not found')
    ) {
      cliConfig.emitMcpDiagnostic(
        'error',
        `Error discovering tools from ${mcpServerName}: ${getMcpErrorMessage(
          error,
        )}`,
        error,
        mcpServerName,
      );
    }
    return [];
  }
}

class McpCallableTool implements CallableTool {
  constructor(
    private readonly toolCaller: McpToolCaller,
    private readonly toolDef: McpTool,
    private readonly serverConfig: MCPServerConfig,
    private readonly progressReporter?: McpProgressReporter,
    /**
     * Sanitized variant of `toolDef.inputSchema` to expose over the wire.
     * Falls back to the raw schema when no sanitization was required.
     */
    private readonly sanitizedInputSchema: unknown = toolDef.inputSchema,
    /**
     * `sanitized → original` top-level property-name map. When present, the
     * model's args are reverse-mapped in {@link callTool} before dispatch
     * to the MCP server.
     */
    private readonly propertyKeyMap: Map<string, string> | null = null,
  ) {}

  /** Maximum characters for tool description sent to the model */
  private static readonly MAX_DESCRIPTION_LENGTH = 2048;

  async tool(): Promise<Tool> {
    let description = this.toolDef.description;
    if (
      description &&
      description.length > McpCallableTool.MAX_DESCRIPTION_LENGTH
    ) {
      description =
        description.slice(0, McpCallableTool.MAX_DESCRIPTION_LENGTH - 3) +
        '...';
    }
    return {
      functionDeclarations: [
        {
          name: this.toolDef.name,
          description,
          parametersJsonSchema: this.sanitizedInputSchema,
        },
      ],
    };
  }

  async callTool(
    functionCalls: FunctionCall[],
    outerSignal?: AbortSignal,
  ): Promise<Part[]> {
    // We only expect one function call at a time for MCP tools in this context
    if (functionCalls.length !== 1) {
      throw new Error('McpCallableTool only supports single function call');
    }
    const call = functionCalls[0];

    const progressToken = randomUUID();
    const context = getToolCallContext();
    const idleWatchdog = new McpToolIdleWatchdog(
      resolveMcpToolIdleTimeoutMs(this.serverConfig),
    );
    if (this.progressReporter) {
      this.progressReporter.registerIdleActivity?.(progressToken, idleWatchdog);
      const sessionId = mcpModelContext.getStore()?.sessionId;
      if (context && sessionId) {
        this.progressReporter.registerProgressToken(
          progressToken,
          context.callId,
          sessionId,
        );
      }
    }

    try {
      // Reverse-map sanitized property keys back to their original names so
      // the MCP server sees the parameter shape it declared.
      const restoredArgs = restoreOriginalArgKeys(
        call.args,
        this.propertyKeyMap,
      );
      const toolCallParams = {
        name: call.name!,
        arguments: restoredArgs as Record<string, unknown>,
        _meta: { progressToken },
      };
      const toolCallOptions = {
        timeout: resolveMcpToolHardTimeoutMs(this.serverConfig),
        signal: outerSignal
          ? AbortSignal.any([outerSignal, idleWatchdog.signal])
          : idleWatchdog.signal,
      };

      // Only a server-returned CallToolResult is a domain result. The tool
      // invocation maps thrown failures to ToolResult.error for all callers.
      const result = await this.toolCaller.callMcpTool(
        toolCallParams,
        toolCallOptions,
      );

      return [
        {
          functionResponse: {
            name: call.name,
            response: result,
          },
        },
      ];
    } finally {
      idleWatchdog.dispose();
      if (this.progressReporter) {
        this.progressReporter.unregisterProgressToken(progressToken);
      }
    }
  }
}

/** Visible for testing */
export function isEnabled(
  funcDecl: NamedTool,
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
): boolean {
  if (!funcDecl.name) {
    runLogger.warn(
      `Discovered a function declaration without a name from MCP server '${mcpServerName}'. Skipping.`,
    );
    return false;
  }
  const { includeTools, excludeTools } = mcpServerConfig;

  // excludeTools takes precedence over includeTools
  if (excludeTools && excludeTools.includes(funcDecl.name)) {
    return false;
  }

  return (
    !includeTools ||
    includeTools.some(
      (tool) => tool === funcDecl.name || tool.startsWith(`${funcDecl.name}(`),
    )
  );
}
