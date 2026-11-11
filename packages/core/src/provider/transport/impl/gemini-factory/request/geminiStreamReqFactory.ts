/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionCallingConfigMode,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type Part,
} from '@google/genai';
import type {
  ModelInputContentBlock,
  ModelStreamMessage,
  ModelStreamRequest,
  ModelStreamTool,
  ModelToolChoice,
} from '../../../../modelStreamRequest.js';
import { ModelImageUtils } from '../../../../utils/modelImageUtils.js';
import { ModelThinkingUtils } from '../../../../utils/modelThinkingUtils.js';
import { ModelWireUtils } from '../../../../utils/modelWireUtils.js';

/**
 * 把协议无关推理入参映射为 Gemini `generateContent` 请求。
 *
 * - system 消息合并为 `systemInstruction`；user/assistant/tool 分别投影为
 *   `contents` 里的 user/model 角色，工具结果用 `functionResponse` 回填。
 * - assistant 历史里的 toolCalls 转 `functionCall`；Gemini 没有调用 id，回填
 *   `functionResponse.name` 时按同一份历史里的 id→name 表还原。
 * - tools 转 `functionDeclarations`；toolChoice 映射
 *   AUTO/ANY/NONE，具名策略追加 allowedFunctionNames。
 * - 生成参数落 `generationConfig`；思考只发支持思考的模型，关闭用
 *   thinkingBudget=0，档位/预算映射为对应 token budget。
 */
export function buildGeminiStreamReq(
  request: ModelStreamRequest,
): GenerateContentParameters {
  const { model, config } = request.resolution;
  const { prompt } = request;
  const contents: Content[] = [];
  const systemTexts: string[] = [];
  const toolNameById = new Map<string, string>();

  for (const message of prompt.messages) {
    switch (message.role) {
      case 'system':
        systemTexts.push(projectSystemText(message.content));
        break;
      case 'user':
        contents.push({
          role: 'user',
          parts: projectInputParts(message.content, model.capabilities.vision),
        });
        break;
      case 'assistant':
        contents.push(
          projectAssistantMessage(message, model.capabilities.vision, toolNameById),
        );
        break;
      case 'tool': {
        const name = toolNameById.get(message.toolCallId) ?? '';
        if (!name) break;
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name,
                response: projectToolResponse(message.content, message.isError),
              },
            },
          ],
        });
        break;
      }
      default:
        break;
    }
  }

  const tools = buildGeminiTools(prompt.tools);
  const generationConfig: GenerateContentConfig = {};
  if (config.sampling?.temperature !== undefined) {
    generationConfig.temperature = config.sampling.temperature;
  }
  if (config.sampling?.topP !== undefined) {
    generationConfig.topP = config.sampling.topP;
  }
  if (config.sampling?.topK !== undefined) {
    generationConfig.topK = config.sampling.topK;
  }
  if (config.sampling?.stop && config.sampling.stop.length > 0) {
    generationConfig.stopSequences = [...config.sampling.stop];
  }
  if (config.context?.maxOutputTokens !== undefined) {
    generationConfig.maxOutputTokens = config.context.maxOutputTokens;
  }
  if (tools.length > 0) {
    generationConfig.tools = [{ functionDeclarations: tools }];
    if (prompt.toolChoice !== undefined) {
      generationConfig.toolConfig = {
        functionCallingConfig: projectToolChoice(prompt.toolChoice),
      };
    }
  }
  const systemInstruction =
    systemTexts.length > 0
      ? { role: 'user', parts: [{ text: systemTexts.join('\n') }] }
      : undefined;
  if (systemInstruction) {
    generationConfig.systemInstruction = systemInstruction;
  }
  const thinkingConfig = buildThinkingConfig(request);
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  return {
    model: ModelWireUtils.modelId(model),
    contents,
    ...(Object.keys(generationConfig).length > 0
      ? { config: generationConfig }
      : {}),
  };
}

function projectSystemText(content: string | ReadonlyArray<{ text: string }>): string {
  return typeof content === 'string'
    ? content
    : content.map((block) => block.text).join('');
}

function projectInputParts(
  content: string | readonly ModelInputContentBlock[],
  supportsVision: boolean,
): Part[] {
  if (typeof content === 'string') return [{ text: content }];
  const parts: Part[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ text: block.text });
      continue;
    }
    const image = ModelImageUtils.resolve(block.source, supportsVision);
    if (!image) continue;
    if (image.type === 'text') {
      parts.push({ text: image.text });
    } else if (image.type === 'base64') {
      parts.push({
        inlineData: { mimeType: image.mediaType, data: image.data },
      });
    } else {
      parts.push({ fileData: { fileUri: image.url } });
    }
  }
  return parts;
}

function projectAssistantMessage(
  message: Extract<ModelStreamMessage, { role: 'assistant' }>,
  supportsVision: boolean,
  toolNameById: Map<string, string>,
): Content {
  const parts: Part[] = [];
  if (typeof message.content === 'string') {
    if (message.content) parts.push({ text: message.content });
  } else {
    for (const block of message.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'thinking') {
        parts.push({
          text: block.thinking,
          thought: true,
          ...(block.signature !== undefined
            ? { thoughtSignature: block.signature }
            : {}),
        });
      }
      // redacted_thinking 是其他协议的密文，Gemini 无回放位。
    }
  }
  for (const call of message.toolCalls ?? []) {
    toolNameById.set(call.id, call.name);
    parts.push({
      functionCall: { name: call.name, args: parseArguments(call.arguments) },
      ...(call.thoughtSignature !== undefined
        ? { thoughtSignature: call.thoughtSignature }
        : {}),
    });
  }
  // 视觉能力只影响新输入；历史里的图片按原样保留，因此这里传 true。
  void supportsVision;
  return { role: 'model', parts };
}

function parseArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsText || '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function projectToolResponse(
  content: string | readonly ModelInputContentBlock[],
  isError: boolean | undefined,
): Record<string, unknown> {
  const text =
    typeof content === 'string'
      ? content
      : content
          .map((block) =>
            block.type === 'text' ? block.text : '[image result omitted]',
          )
          .join('\n');
  return isError ? { error: text } : { result: text };
}

function buildGeminiTools(
  tools: readonly ModelStreamTool[] | undefined,
): FunctionDeclaration[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters
      ? {
          parameters: sanitizeGeminiSchema(
            tool.parameters,
          ) as FunctionDeclaration['parameters'],
        }
      : {}),
  }));
}

/**
 * Gemini's function-declaration schema is an OpenAPI subset: keywords such as
 * `additionalProperties` and `$schema` are rejected with HTTP 400. Strip the
 * unsupported keywords recursively; property names are preserved as-is.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'additionalProperties',
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'examples',
]);

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    // Property names are user data, not schema keywords: keep them even when
    // they collide with a keyword we strip elsewhere.
    if (key === 'properties' && typeof entry === 'object' && entry !== null) {
      result[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(
          ([name, schema]) => [name, sanitizeGeminiSchema(schema)],
        ),
      );
      continue;
    }
    result[key] = sanitizeGeminiSchema(entry);
  }
  return result;
}

function projectToolChoice(
  toolChoice: ModelToolChoice,
): NonNullable<
  NonNullable<GenerateContentConfig['toolConfig']>['functionCallingConfig']
> {
  if (toolChoice === 'none') {
    return { mode: FunctionCallingConfigMode.NONE };
  }
  if (toolChoice === 'required') {
    return { mode: FunctionCallingConfigMode.ANY };
  }
  if (typeof toolChoice === 'object') {
    return {
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: [toolChoice.name],
    };
  }
  return { mode: FunctionCallingConfigMode.AUTO };
}

/** 档位 → thinkingBudget；Gemini 只认预算，按与旧栈一致的分段反推。 */
const EFFORT_BUDGETS = {
  low: 1_024,
  medium: 8_192,
  high: 24_576,
  xhigh: 49_152,
  max: 65_536,
} as const;

function buildThinkingConfig(
  request: ModelStreamRequest,
): GenerateContentConfig['thinkingConfig'] | undefined {
  const { model, config } = request.resolution;
  if (!model.capabilities.reasoning.supported) return undefined;
  if (ModelThinkingUtils.isDisabled(config)) {
    return { thinkingBudget: 0, includeThoughts: false };
  }
  const thinking = config.reasoning?.thinking;
  const budget = thinking?.type === 'enabled' ? thinking.budgetTokens : undefined;
  if (budget !== undefined) {
    return { thinkingBudget: budget, includeThoughts: true };
  }
  const effort = config.reasoning?.effort;
  if (effort && effort !== 'none') {
    return { thinkingBudget: EFFORT_BUDGETS[effort], includeThoughts: true };
  }
  return { includeThoughts: true };
}
