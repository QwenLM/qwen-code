/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  Content,
  ContentListUnion,
  FunctionCallingConfig,
  FunctionResponse,
  GenerateContentParameters,
  Part,
  PartUnion,
  ToolListUnion,
} from '@google/genai';
import { FunctionCallingConfigMode } from '@google/genai';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import { getSupportedReasoningEffortTiers } from '../reasoning-effort.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import { normalizeMcpToolName } from '../../utils/tool-name-utils.js';
import {
  convertSchema,
  relaxSchemaForFunctionCalling,
  type SchemaComplianceMode,
} from '../../utils/schemaConverter.js';
import { planCacheMarkers } from './cache.js';
import { resolveThinkingParameters } from './thinking.js';
import type {
  DashScopeContentBlock,
  DashScopeMessage,
  DashScopeRequest,
  DashScopeTool,
  DashScopeToolCall,
} from './types.js';

const debugLogger = createDebugLogger('DASHSCOPE');
let warnedDroppedForcedToolChoice = false;

/**
 * Per-call state threaded through {@link convertGeminiContentsToDashScopeMessages}
 * so a `functionResponse` with no explicit `id` resolves to the SAME
 * `tool_call_id` its matching `functionCall` was assigned, by function name
 * and call order.
 */
interface ConversionState {
  callIdsByName: Map<string, string[]>;
  responseMatchIndexByName: Map<string, number>;
  synthesizedOrdinal: number;
}

function createConversionState(): ConversionState {
  return {
    callIdsByName: new Map(),
    responseMatchIndexByName: new Map(),
    synthesizedOrdinal: 0,
  };
}

/**
 * Builds the native DashScope request body from a Gemini
 * `GenerateContentParameters`. Pure — performs no I/O.
 */
export function buildDashScopeRequest(
  request: GenerateContentParameters,
  args: {
    contentGeneratorConfig: ContentGeneratorConfig;
    streaming: boolean;
    thinkingMandatory?: boolean;
  },
): DashScopeRequest {
  const { contentGeneratorConfig: config, streaming } = args;
  const model = request.model || config.model;

  const systemText = extractTextFromContentUnion(
    request.config?.systemInstruction,
  );
  const splitToolMedia = config.splitToolMedia !== false;

  let messages = convertGeminiContentsToDashScopeMessages(request.contents, {
    splitToolMedia,
  });
  if (systemText) {
    messages = [
      { role: 'system', content: [{ text: systemText }] },
      ...messages,
    ];
  }
  messages = cleanOrphanedToolCalls(messages);

  const enableCacheControl = config.enableCacheControl !== false;

  const tools = convertGeminiToolsToDashScopeTools(
    request.config?.tools,
    config.schemaCompliance,
  );
  const finalTools = applyToolCacheControl(tools, enableCacheControl);

  const toolChoiceResolution = resolveToolChoiceRequest(
    request.config?.toolConfig?.functionCallingConfig,
  );

  const resolvedThinking = resolveThinkingParameters({
    reasoning: config.reasoning,
    thinkingConfig: request.config?.thinkingConfig
      ? {
          thinkingBudget: request.config.thinkingConfig.thinkingBudget,
          includeThoughts: request.config.thinkingConfig.includeThoughts,
        }
      : undefined,
    thinkingMandatory:
      args.thinkingMandatory ??
      (config.thinkingMandatory === true &&
        model.toLowerCase() === config.model.toLowerCase()),
    extraBody: config.extra_body,
    supportedEfforts: getSupportedReasoningEffortTiers(
      AuthType.USE_DASHSCOPE,
      model,
    ),
    forcedToolChoice: toolChoiceResolution?.forced ?? false,
  });

  let toolChoiceValue = toolChoiceResolution?.value;
  if (toolChoiceResolution?.forced && resolvedThinking.dropForcedToolChoice) {
    toolChoiceValue = 'auto';
    if (!warnedDroppedForcedToolChoice) {
      warnedDroppedForcedToolChoice = true;
      debugLogger.warn(
        'buildDashScopeRequest: downgrading a forced tool_choice to "auto" ' +
          'because thinking is mandatory for this model.',
      );
    }
  }

  const parameters = buildParameters({
    config,
    streaming,
    request,
    tools: finalTools,
    toolChoiceValue,
    resolvedThinking: resolvedThinking.params,
    hasAssistantMessage: messages.some(
      (message) => message.role === 'assistant',
    ),
  });

  const cachedMessages = planCacheMarkers(messages, {
    enabled: enableCacheControl,
    streaming,
  });

  return {
    model,
    input: { messages: cachedMessages },
    parameters,
  };
}

function buildParameters(args: {
  config: ContentGeneratorConfig;
  streaming: boolean;
  request: GenerateContentParameters;
  tools: DashScopeTool[] | undefined;
  toolChoiceValue: unknown;
  resolvedThinking: Record<string, unknown>;
  hasAssistantMessage: boolean;
}): Record<string, unknown> {
  const {
    config,
    streaming,
    request,
    tools,
    toolChoiceValue,
    resolvedThinking,
    hasAssistantMessage,
  } = args;
  const samplingParams = config.samplingParams ?? {};

  const parameters: Record<string, unknown> = { result_format: 'message' };
  if (streaming) {
    parameters['incremental_output'] = true;
  }

  const temperature = request.config?.temperature ?? samplingParams.temperature;
  if (temperature !== undefined) {
    parameters['temperature'] = temperature;
  }

  const topP = request.config?.topP ?? samplingParams.top_p;
  if (topP !== undefined) {
    parameters['top_p'] = topP;
  }

  const topK = request.config?.topK ?? samplingParams.top_k;
  if (topK !== undefined) {
    parameters['top_k'] = topK;
  }

  const seed = request.config?.seed;
  if (seed !== undefined) {
    parameters['seed'] = seed;
  }

  const presencePenalty =
    request.config?.presencePenalty ?? samplingParams.presence_penalty;
  if (presencePenalty !== undefined) {
    parameters['presence_penalty'] = presencePenalty;
  }

  const frequencyPenalty =
    request.config?.frequencyPenalty ?? samplingParams.frequency_penalty;
  if (frequencyPenalty !== undefined) {
    parameters['frequency_penalty'] = frequencyPenalty;
  }

  const repetitionPenalty = samplingParams.repetition_penalty;
  if (repetitionPenalty !== undefined) {
    parameters['repetition_penalty'] = repetitionPenalty;
  }

  const stop = request.config?.stopSequences;
  if (stop !== undefined) {
    parameters['stop'] = stop;
  }

  const maxTokens =
    request.config?.maxOutputTokens ?? samplingParams.max_tokens;
  if (maxTokens !== undefined) {
    parameters['max_tokens'] = maxTokens;
  }

  Object.assign(parameters, resolvedThinking);

  if (tools && tools.length > 0) {
    parameters['tools'] = tools;
    if (toolChoiceValue !== undefined) {
      parameters['tool_choice'] = toolChoiceValue;
    }
    parameters['parallel_tool_calls'] = true;
  }

  if (hasAssistantMessage) {
    parameters['preserve_thinking'] = true;
  }

  if (config.extra_body) {
    for (const [key, value] of Object.entries(config.extra_body)) {
      if (
        key === 'enable_thinking' ||
        key === 'reasoning_effort' ||
        key === 'thinking_budget'
      ) {
        continue;
      }
      parameters[key] = value;
    }
  }

  return parameters;
}

function applyToolCacheControl(
  tools: DashScopeTool[] | undefined,
  enabled: boolean,
): DashScopeTool[] | undefined {
  if (!tools || tools.length === 0 || !enabled) {
    return tools;
  }
  const lastIndex = tools.length - 1;
  return tools.map((tool, index) =>
    index === lastIndex
      ? { ...tool, cache_control: { type: 'ephemeral' as const } }
      : tool,
  );
}

function resolveToolChoiceRequest(
  functionCallingConfig: FunctionCallingConfig | undefined,
): { value: unknown; forced: boolean } | undefined {
  const mode = functionCallingConfig?.mode;

  if (mode === FunctionCallingConfigMode.NONE) {
    return { value: 'none', forced: false };
  }

  if (mode === FunctionCallingConfigMode.ANY) {
    const allowed = functionCallingConfig?.allowedFunctionNames;
    if (allowed && allowed.length === 1) {
      return {
        value: { type: 'function', function: { name: allowed[0] } },
        forced: true,
      };
    }
    return { value: 'required', forced: true };
  }

  return undefined;
}

/**
 * Converts normalized Gemini `Content`/`Part` history into native DashScope
 * messages. Never merges same-role messages; runs before
 * {@link cleanOrphanedToolCalls}.
 */
export function convertGeminiContentsToDashScopeMessages(
  contents: ContentListUnion,
  opts: { splitToolMedia: boolean },
): DashScopeMessage[] {
  const messages: DashScopeMessage[] = [];
  const state = createConversionState();

  for (const item of normalizeContents(contents)) {
    processContentItem(item, messages, state, opts);
  }

  return messages;
}

function normalizeContents(contents: ContentListUnion): Content[] {
  if (contents === undefined) {
    return [];
  }

  if (!Array.isArray(contents)) {
    if (isFunctionPart(contents)) {
      throw new Error(
        'To specify functionCall or functionResponse parts, please wrap them in a Content object, specifying the role for them',
      );
    }
    return isContentObject(contents)
      ? [contents]
      : [{ role: 'user', parts: [normalizePart(contents)] }];
  }

  const normalized: Content[] = [];
  const parts: Part[] = [];
  const isContentArray = isContentObject(contents[0]);

  for (const item of contents) {
    const isContent = isContentObject(item);
    if (isContent !== isContentArray) {
      throw new Error(
        'Mixing Content and Parts is not supported, please group the parts into a the appropriate Content objects and specify the roles for them',
      );
    }
    if (isContent) {
      normalized.push(item);
    } else if (isFunctionPart(item)) {
      throw new Error(
        'To specify functionCall or functionResponse parts, please wrap them, and any other parts, in Content objects as appropriate, specifying the role for them',
      );
    } else {
      parts.push(normalizePart(item));
    }
  }

  if (!isContentArray && parts.length > 0) {
    normalized.push({ role: 'user', parts });
  }
  return normalized;
}

function normalizePart(part: PartUnion): Part {
  return typeof part === 'string' ? { text: part } : part;
}

function isFunctionPart(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('functionCall' in value || 'functionResponse' in value)
  );
}

function processContentItem(
  item: unknown,
  messages: DashScopeMessage[],
  state: ConversionState,
  opts: { splitToolMedia: boolean },
): void {
  if (typeof item === 'string') {
    messages.push({ role: 'user', content: [{ text: item }] });
    return;
  }

  if (!isContentObject(item)) {
    return;
  }

  const role = item.role === 'model' ? 'assistant' : 'user';
  const parts = item.parts ?? [];

  if (role === 'assistant') {
    processAssistantContent(parts, messages, state);
  } else {
    processUserContent(parts, messages, state, opts);
  }
}

function isContentObject(value: unknown): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parts' in value &&
    Array.isArray((value as Record<string, unknown>)['parts'])
  );
}

function processAssistantContent(
  parts: Part[],
  messages: DashScopeMessage[],
  state: ConversionState,
): void {
  const contentBlocks: DashScopeContentBlock[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: DashScopeToolCall[] = [];

  for (const part of parts) {
    if (typeof part === 'string') {
      contentBlocks.push({ text: part });
      continue;
    }

    if (part.thought) {
      if (part.text) {
        reasoningParts.push(part.text);
      }
      continue;
    }

    if (part.text) {
      contentBlocks.push({ text: part.text });
      continue;
    }

    if (part.functionCall) {
      const rawName = part.functionCall.name ?? '';
      const id = resolveFunctionCallId(
        {
          id: part.functionCall.id,
          name: rawName,
          args: part.functionCall.args,
        },
        state,
      );
      recordFunctionCallId(rawName, id, state);
      toolCalls.push({
        id,
        index: toolCalls.length,
        type: 'function',
        function: {
          name: normalizeMcpToolName(rawName),
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  const reasoningContent = reasoningParts.join('');
  if (
    contentBlocks.length === 0 &&
    toolCalls.length === 0 &&
    reasoningContent.length === 0
  ) {
    return;
  }

  const message: DashScopeMessage = {
    role: 'assistant',
    content: contentBlocks,
  };
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  messages.push(message);
}

function processUserContent(
  parts: Part[],
  messages: DashScopeMessage[],
  state: ConversionState,
  opts: { splitToolMedia: boolean },
): void {
  const contentBlocks: DashScopeContentBlock[] = [];
  const splitMediaBlocks: DashScopeContentBlock[] = [];

  for (const part of parts) {
    if (typeof part === 'string') {
      contentBlocks.push({ text: part });
      continue;
    }

    if (part.functionResponse) {
      const toolCallId = resolveFunctionResponseToolCallId(
        part.functionResponse,
        state,
      );
      const { toolMessage, mediaBlocks } = buildToolMessage(
        part.functionResponse,
        toolCallId,
        opts.splitToolMedia,
      );
      messages.push(toolMessage);
      splitMediaBlocks.push(...mediaBlocks);
      continue;
    }

    if (part.text) {
      contentBlocks.push({ text: part.text });
      continue;
    }

    const mediaBlock = partToMediaBlock(part);
    if (mediaBlock) {
      contentBlocks.push(mediaBlock);
    }
  }

  if (contentBlocks.length > 0) {
    messages.push({ role: 'user', content: contentBlocks });
  }
  if (splitMediaBlocks.length > 0) {
    messages.push({ role: 'user', content: splitMediaBlocks });
  }
}

function buildToolMessage(
  functionResponse: FunctionResponse,
  toolCallId: string,
  splitToolMedia: boolean,
): { toolMessage: DashScopeMessage; mediaBlocks: DashScopeContentBlock[] } {
  const text = extractFunctionResponseContent(functionResponse.response);
  const mediaBlocks: DashScopeContentBlock[] = [];
  const inlineBlocks: DashScopeContentBlock[] = [];

  for (const responsePart of functionResponse.parts ?? []) {
    const part = responsePart as Part;
    if (part.text !== undefined) {
      inlineBlocks.push({ text: part.text });
      continue;
    }
    const block = partToMediaBlock(part);
    if (!block) continue;
    if (splitToolMedia) {
      mediaBlocks.push(block);
    } else {
      inlineBlocks.push(block);
    }
  }

  const content: DashScopeContentBlock[] = [{ text }, ...inlineBlocks];

  return {
    toolMessage: { role: 'tool', tool_call_id: toolCallId, content },
    mediaBlocks,
  };
}

function partToMediaBlock(part: Part): DashScopeContentBlock | undefined {
  if (part.inlineData?.mimeType && part.inlineData?.data) {
    return blockForMimeType(
      part.inlineData.mimeType,
      `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
    );
  }
  if (part.fileData?.mimeType && part.fileData?.fileUri) {
    return blockForMimeType(part.fileData.mimeType, part.fileData.fileUri);
  }
  return undefined;
}

function blockForMimeType(
  mimeType: string,
  value: string,
): DashScopeContentBlock {
  if (mimeType.startsWith('image/')) {
    return { image: value };
  }
  if (mimeType.startsWith('video/')) {
    return { video: value };
  }
  if (mimeType.startsWith('audio/')) {
    return { audio: value };
  }
  if (mimeType === 'application/pdf') {
    return { file: value };
  }
  return { text: `[Unsupported content type: ${mimeType}]` };
}

function resolveFunctionCallId(
  functionCall: { id?: string; name: string; args?: Record<string, unknown> },
  state: ConversionState,
): string {
  if (typeof functionCall.id === 'string' && functionCall.id.length > 0) {
    return functionCall.id;
  }

  const argsJson = JSON.stringify(functionCall.args ?? {});
  const ordinal = state.synthesizedOrdinal;
  state.synthesizedOrdinal += 1;
  const hash = createHash('sha256')
    .update(`${functionCall.name}:${argsJson}:${ordinal}`)
    .digest('hex')
    .slice(0, 24);
  return `call_${hash}`;
}

function recordFunctionCallId(
  name: string,
  id: string,
  state: ConversionState,
): void {
  const existing = state.callIdsByName.get(name);
  if (existing) {
    existing.push(id);
  } else {
    state.callIdsByName.set(name, [id]);
  }
}

function resolveFunctionResponseToolCallId(
  functionResponse: FunctionResponse,
  state: ConversionState,
): string {
  const name = functionResponse.name ?? '';
  const matchIndex = state.responseMatchIndexByName.get(name) ?? 0;
  state.responseMatchIndexByName.set(name, matchIndex + 1);

  if (
    typeof functionResponse.id === 'string' &&
    functionResponse.id.length > 0
  ) {
    return functionResponse.id;
  }

  const ids = state.callIdsByName.get(name);
  return ids?.[matchIndex] ?? '';
}

function extractFunctionResponseContent(response: unknown): string {
  if (response === null || response === undefined) {
    return '';
  }

  if (typeof response === 'string') {
    return response;
  }

  if (typeof response === 'object') {
    const responseObject = response as Record<string, unknown>;
    const output = responseObject['output'];
    if (typeof output === 'string') {
      return output;
    }

    const error = responseObject['error'];
    if (typeof error === 'string') {
      return error;
    }
  }

  try {
    return JSON.stringify(response) ?? String(response);
  } catch {
    return String(response);
  }
}

function extractTextFromContentUnion(contentUnion: unknown): string {
  if (typeof contentUnion === 'string') {
    return contentUnion;
  }

  if (Array.isArray(contentUnion)) {
    return contentUnion
      .map((item) => extractTextFromContentUnion(item))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof contentUnion === 'object' && contentUnion !== null) {
    if ('parts' in contentUnion) {
      const content = contentUnion as Content;
      return (
        content.parts
          ?.map((part: Part) => {
            if (typeof part === 'string') return part;
            if ('text' in part) return part.text || '';
            return '';
          })
          .filter(Boolean)
          .join('\n') || ''
      );
    }
    if ('text' in contentUnion) {
      return (contentUnion as Part).text || '';
    }
  }

  return '';
}

/**
 * Removes `tool_calls` entries with no matching later `role: 'tool'`
 * message, and `role: 'tool'` messages whose `tool_call_id` matches no
 * earlier `tool_calls[].id`. Drops assistant messages left with an empty
 * `content`, no `reasoning_content`, and no surviving `tool_calls`.
 */
export function cleanOrphanedToolCalls(
  messages: DashScopeMessage[],
): DashScopeMessage[] {
  const resultIds = new Set(
    messages
      .filter((message) => message.role === 'tool' && message.tool_call_id)
      .map((message) => message.tool_call_id as string),
  );
  const callIds = new Set(
    messages.flatMap((message) =>
      message.role === 'assistant' && message.tool_calls
        ? message.tool_calls.map((toolCall) => toolCall.id)
        : [],
    ),
  );

  const cleaned: DashScopeMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (message.tool_call_id && callIds.has(message.tool_call_id)) {
        cleaned.push(message);
      }
      continue;
    }

    if (message.role === 'assistant') {
      const survivingToolCalls = message.tool_calls?.filter((toolCall) =>
        resultIds.has(toolCall.id),
      );
      const hasContent =
        Array.isArray(message.content) && message.content.length > 0;
      const hasReasoning = Boolean(message.reasoning_content);
      const hasToolCalls = Boolean(survivingToolCalls?.length);

      if (!hasContent && !hasReasoning && !hasToolCalls) {
        continue;
      }

      cleaned.push({
        ...message,
        tool_calls: hasToolCalls ? survivingToolCalls : undefined,
      });
      continue;
    }

    cleaned.push(message);
  }

  return cleaned;
}

/**
 * Converts Gemini tool declarations (plain `Tool` entries with either
 * `parameters` or MCP-style `parametersJsonSchema`) into native DashScope
 * tools, then runs {@link canonicalizeToolJson} for byte-stable output.
 * `CallableTool` entries are skipped — resolving them requires an async
 * `tool()` call, and this converter (and `buildDashScopeRequest`) is
 * synchronous; callers must resolve `CallableTool`s to plain `Tool`s first.
 */
export function convertGeminiToolsToDashScopeTools(
  tools: ToolListUnion | undefined,
  schemaCompliance: SchemaComplianceMode = 'auto',
): DashScopeTool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const result: DashScopeTool[] = [];

  for (const tool of tools) {
    if ('tool' in tool) {
      continue;
    }

    const functionDeclarations = tool.functionDeclarations;
    if (!functionDeclarations) {
      continue;
    }

    for (const decl of functionDeclarations) {
      if (!decl.name) continue;

      let parameters: Record<string, unknown> | undefined;
      if (decl.parametersJsonSchema) {
        parameters = {
          ...(decl.parametersJsonSchema as Record<string, unknown>),
        };
      } else if (decl.parameters) {
        parameters = decl.parameters as Record<string, unknown>;
      }

      if (parameters) {
        parameters = convertSchema(parameters, schemaCompliance);
        parameters = relaxSchemaForFunctionCalling(parameters);
      }

      result.push(
        canonicalizeToolJson({
          type: 'function',
          function: {
            name: decl.name,
            description: decl.description,
            parameters,
          },
        }),
      );
    }
  }

  return result.length > 0 ? result : undefined;
}

const SCHEMA_KEY_ORDER = [
  'type',
  'description',
  'properties',
  'required',
  'enum',
  'items',
  'additionalProperties',
] as const;

/**
 * Rebuilds a tool with a fixed, deterministic key order — `type`, `function`
 * (`name`, `description`, `parameters`), `cache_control`; and inside every
 * schema object, `type`, `description`, `properties` (alphabetized),
 * `required`, `enum`, `items`, `additionalProperties`, then any remaining
 * keys sorted alphabetically. Drops `undefined` values. Makes
 * `JSON.stringify` byte-stable across independently-built requests, which
 * explicit prompt caching depends on for prefix hits.
 */
export function canonicalizeToolJson(tool: DashScopeTool): DashScopeTool {
  const canonical: DashScopeTool = {
    type: 'function',
    function: {
      name: tool.function.name,
      ...(tool.function.description !== undefined
        ? { description: tool.function.description }
        : {}),
      ...(tool.function.parameters !== undefined
        ? {
            parameters: canonicalizeSchemaValue(
              tool.function.parameters,
            ) as Record<string, unknown>,
          }
        : {}),
    },
  };

  if (tool.cache_control !== undefined) {
    canonical.cache_control = tool.cache_control;
  }

  return canonical;
}

function canonicalizeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeSchemaValue(item));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const remainingKeys = Object.keys(source)
    .filter((key) => !(SCHEMA_KEY_ORDER as readonly string[]).includes(key))
    .sort();
  const orderedKeys = [...SCHEMA_KEY_ORDER, ...remainingKeys];

  const result: Record<string, unknown> = {};
  for (const key of orderedKeys) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (raw === undefined) continue;

    if (
      key === 'properties' &&
      typeof raw === 'object' &&
      raw !== null &&
      !Array.isArray(raw)
    ) {
      const properties = raw as Record<string, unknown>;
      const sortedProperties: Record<string, unknown> = {};
      for (const propertyKey of Object.keys(properties).sort()) {
        sortedProperties[propertyKey] = canonicalizeSchemaValue(
          properties[propertyKey],
        );
      }
      result[key] = sortedProperties;
      continue;
    }

    result[key] = canonicalizeSchemaValue(raw);
  }

  return result;
}
