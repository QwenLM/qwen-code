/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentParameters,
  Part,
  Content,
  Tool,
  ToolListUnion,
  CallableTool,
  FunctionResponse,
  ContentListUnion,
  ContentUnion,
  PartUnion,
  Candidate,
} from '@google/genai';
import { GenerateContentResponse, FinishReason } from '@google/genai';
import type OpenAI from 'openai';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type { RequestContext } from './types.js';
import { parseTaggedThinkingText } from './taggedThinkingParser.js';
import {
  convertSchema,
  type SchemaComplianceMode,
} from '../../utils/schemaConverter.js';

const debugLogger = createDebugLogger('CONVERTER');

/**
 * Extended usage type that supports both OpenAI standard format and alternative formats
 * Some models return cached_tokens at the top level instead of in prompt_tokens_details
 */
interface ExtendedCompletionUsage extends OpenAI.CompletionUsage {
  cached_tokens?: number;
}

export interface ExtendedChatCompletionAssistantMessageParam
  extends OpenAI.Chat.ChatCompletionAssistantMessageParam {
  reasoning_content?: string | null;
}

type ExtendedChatCompletionMessageParam =
  | OpenAI.Chat.ChatCompletionMessageParam
  | ExtendedChatCompletionAssistantMessageParam;

export interface ExtendedCompletionMessage
  extends OpenAI.Chat.ChatCompletionMessage {
  reasoning_content?: string | null;
  reasoning?: string | null;
}

export interface ExtendedCompletionChunkDelta
  extends OpenAI.Chat.ChatCompletionChunk.Choice.Delta {
  reasoning_content?: string | null;
  reasoning?: string | null;
}

/**
 * Tool call accumulator for streaming responses
 */
export interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

type OpenAIContentPartVideoUrl = {
  type: 'video_url';
  video_url: {
    url: string;
  };
};

type OpenAIContentPartFile = {
  type: 'file';
  file: {
    filename: string;
    file_data: string;
  };
};

type OpenAIContentPart =
  | OpenAI.Chat.ChatCompletionContentPartText
  | OpenAI.Chat.ChatCompletionContentPartImage
  | OpenAI.Chat.ChatCompletionContentPartInputAudio
  | OpenAIContentPartVideoUrl
  | OpenAIContentPartFile;

/**
 * Convert Gemini tool parameters to OpenAI JSON Schema format.
 */
export function convertGeminiToolParametersToOpenAI(
  parameters: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!parameters || typeof parameters !== 'object') {
    return parameters;
  }

  const converted = JSON.parse(JSON.stringify(parameters));

  const convertTypes = (obj: unknown): unknown => {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(convertTypes);
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'type' && typeof value === 'string') {
        // Convert Gemini types to OpenAI JSON Schema types
        const lowerValue = value.toLowerCase();
        if (lowerValue === 'integer') {
          result[key] = 'integer';
        } else if (lowerValue === 'number') {
          result[key] = 'number';
        } else {
          result[key] = lowerValue;
        }
      } else if (
        key === 'minimum' ||
        key === 'maximum' ||
        key === 'multipleOf'
      ) {
        // Ensure numeric constraints are actual numbers, not strings
        if (typeof value === 'string' && !isNaN(Number(value))) {
          result[key] = Number(value);
        } else {
          result[key] = value;
        }
      } else if (
        key === 'minLength' ||
        key === 'maxLength' ||
        key === 'minItems' ||
        key === 'maxItems'
      ) {
        // Ensure length constraints are integers, not strings
        if (typeof value === 'string' && !isNaN(Number(value))) {
          result[key] = parseInt(value, 10);
        } else {
          result[key] = value;
        }
      } else if (typeof value === 'object') {
        result[key] = convertTypes(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  };

  return convertTypes(converted) as Record<string, unknown> | undefined;
}

/**
 * Convert Gemini tools to OpenAI format for API compatibility.
 * Handles both Gemini tools (using 'parameters' field) and MCP tools
 * (using 'parametersJsonSchema' field).
 */
export async function convertGeminiToolsToOpenAI(
  geminiTools: ToolListUnion,
  schemaCompliance: SchemaComplianceMode = 'auto',
): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  const openAITools: OpenAI.Chat.ChatCompletionTool[] = [];

  for (const tool of geminiTools) {
    let actualTool: Tool;

    // Handle CallableTool vs Tool
    if ('tool' in tool) {
      // This is a CallableTool
      actualTool = await (tool as CallableTool).tool();
    } else {
      // This is already a Tool
      actualTool = tool as Tool;
    }

    if (actualTool.functionDeclarations) {
      for (const func of actualTool.functionDeclarations) {
        if (func.name && func.description) {
          let parameters: Record<string, unknown> | undefined;

          // Handle both Gemini tools (parameters) and MCP tools (parametersJsonSchema)
          if (func.parametersJsonSchema) {
            // MCP tool format - use parametersJsonSchema directly
            // Create a shallow copy to avoid mutating the original object
            const paramsCopy = {
              ...(func.parametersJsonSchema as Record<string, unknown>),
            };
            parameters = paramsCopy;
          } else if (func.parameters) {
            // Gemini tool format - convert parameters to OpenAI format
            parameters = convertGeminiToolParametersToOpenAI(
              func.parameters as Record<string, unknown>,
            );
          }

          if (parameters) {
            parameters = convertSchema(parameters, schemaCompliance);
          }

          openAITools.push({
            type: 'function',
            function: {
              name: func.name,
              description: func.description,
              parameters,
            },
          });
        }
      }
    }
  }

  return openAITools;
}

/**
 * Convert Gemini request to OpenAI message format.
 */
export function convertGeminiRequestToOpenAI(
  request: GenerateContentParameters,
  requestContext: RequestContext,
  options: { cleanOrphanToolCalls: boolean } = { cleanOrphanToolCalls: true },
): OpenAI.Chat.ChatCompletionMessageParam[] {
  let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  // Handle system instruction from config
  addSystemInstructionMessage(request, messages);

  // Handle contents
  processContents(request.contents, messages, requestContext);

  // Clean up orphaned tool calls and merge consecutive assistant messages
  if (options.cleanOrphanToolCalls) {
    messages = cleanOrphanedToolCalls(messages);
  }
  messages = mergeConsecutiveAssistantMessages(messages);

  return messages;
}

/**
 * Convert Gemini response to OpenAI completion format (for logging).
 */
export function convertGeminiResponseToOpenAI(
  response: GenerateContentResponse,
  requestContext: RequestContext,
): OpenAI.Chat.ChatCompletion {
  const candidate = response.candidates?.[0];
  const parts = (candidate?.content?.parts || []) as Part[];

  // Parse parts inline
  const thoughtParts: string[] = [];
  const contentParts: string[] = [];
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  let toolCallIndex = 0;

  for (const part of parts) {
    if (typeof part === 'string') {
      contentParts.push(part);
    } else if ('text' in part && part.text) {
      if ('thought' in part && part.thought) {
        thoughtParts.push(part.text);
      } else {
        contentParts.push(part.text);
      }
    } else if ('functionCall' in part && part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id || `call_${toolCallIndex}`,
        type: 'function' as const,
        function: {
          name: part.functionCall.name || '',
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
      toolCallIndex += 1;
    }
  }

  const message: ExtendedCompletionMessage = {
    role: 'assistant',
    content: contentParts.join('') || null,
    refusal: null,
  };

  const reasoningContent = thoughtParts.join('');
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const finishReason = mapGeminiFinishReasonToOpenAI(candidate?.finishReason);

  const usageMetadata = response.usageMetadata;
  const usage: OpenAI.CompletionUsage = {
    prompt_tokens: usageMetadata?.promptTokenCount || 0,
    completion_tokens: usageMetadata?.candidatesTokenCount || 0,
    total_tokens: usageMetadata?.totalTokenCount || 0,
  };

  if (usageMetadata?.cachedContentTokenCount !== undefined) {
    (
      usage as OpenAI.CompletionUsage & {
        prompt_tokens_details?: { cached_tokens?: number };
      }
    ).prompt_tokens_details = {
      cached_tokens: usageMetadata.cachedContentTokenCount,
    };
  }

  const createdMs = response.createTime
    ? Number(response.createTime)
    : Date.now();
  const createdSeconds = Number.isFinite(createdMs)
    ? Math.floor(createdMs / 1000)
    : Math.floor(Date.now() / 1000);

  return {
    id: response.responseId || `gemini-${Date.now()}`,
    object: 'chat.completion',
    created: createdSeconds,
    model: response.modelVersion || requestContext.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage,
  };
}

/**
 * Extract and add system instruction message from request config.
 */
function addSystemInstructionMessage(
  request: GenerateContentParameters,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): void {
  if (!request.config?.systemInstruction) return;

  const systemText = extractTextFromContentUnion(
    request.config.systemInstruction,
  );

  if (systemText) {
    messages.push({
      role: 'system' as const,
      content: systemText,
    });
  }
}

/**
 * Process contents and convert to OpenAI messages.
 */
function processContents(
  contents: ContentListUnion,
  messages: ExtendedChatCompletionMessageParam[],
  requestContext: RequestContext,
): void {
  if (Array.isArray(contents)) {
    for (const content of contents) {
      processContent(content, messages, requestContext);
    }
  } else if (contents) {
    processContent(contents, messages, requestContext);
  }
}

/**
 * Process a single content item and convert to OpenAI message(s).
 */
function processContent(
  content: ContentUnion | PartUnion,
  messages: ExtendedChatCompletionMessageParam[],
  requestContext: RequestContext,
): void {
  if (typeof content === 'string') {
    messages.push({ role: 'user' as const, content });
    return;
  }

  if (!isContentObject(content)) return;
  const parts = content.parts || [];
  const role = content.role === 'model' ? 'assistant' : 'user';

  const contentParts: OpenAIContentPart[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  let toolCallIndex = 0;
  // When `splitToolMedia` is enabled, media stripped from tool messages is
  // accumulated here and emitted as a single follow-up user message after
  // ALL tool messages in this group have been pushed. OpenAI Chat
  // Completions requires every `role: "tool"` response for a given assistant
  // turn to appear contiguously before any non-tool message; emitting the
  // user message inline (after each tool message) would interleave and
  // break that contract when multiple parallel tool calls return media.
  const accumulatedSplitMedia: OpenAIContentPart[] = [];

  for (const part of parts) {
    if (typeof part === 'string') {
      contentParts.push({ type: 'text' as const, text: part });
      continue;
    }

    if ('text' in part && 'thought' in part && part.thought) {
      if (role === 'assistant' && part.text) {
        reasoningParts.push(part.text);
      }
    }

    if ('text' in part && part.text && !('thought' in part && part.thought)) {
      contentParts.push({ type: 'text' as const, text: part.text });
    }

    const mediaPart = createMediaContentPart(part, requestContext);
    if (mediaPart && role === 'user') {
      contentParts.push(mediaPart);
    }

    if ('functionCall' in part && part.functionCall && role === 'assistant') {
      toolCalls.push({
        id: part.functionCall.id || `call_${toolCallIndex}`,
        type: 'function' as const,
        function: {
          name: part.functionCall.name || '',
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
      toolCallIndex += 1;
    }

    if (part.functionResponse && role === 'user') {
      // Create tool message for the function response (with embedded media)
      const toolMessage = createToolMessage(
        part.functionResponse,
        requestContext,
      );
      if (toolMessage) {
        // Opt-in only (ContentGeneratorConfig.splitToolMedia). OpenAI spec
        // only permits string / text-part content on `role: "tool"` messages.
        // Strict OpenAI-compatible servers (e.g. LM Studio) reject tool
        // messages containing image_url / input_audio / video_url / file
        // parts with HTTP 400 "Invalid 'messages' in payload". When the flag
        // is set, strip non-text media from this tool message and accumulate
        // it; the combined media is emitted as a single follow-up user
        // message after the parts loop completes — preserving the
        // "all tool responses contiguous" requirement for parallel tool
        // calls. Default (flag false) preserves prior behavior: media is
        // embedded in the tool message and permissive providers continue
        // to receive it that way. See #3616.
        if (
          requestContext.splitToolMedia &&
          Array.isArray(toolMessage.content)
        ) {
          const mediaParts: OpenAIContentPart[] = [];
          const textParts: OpenAI.Chat.ChatCompletionContentPartText[] = [];
          for (const cp of toolMessage.content as OpenAIContentPart[]) {
            if (
              cp &&
              (cp.type === 'image_url' ||
                cp.type === 'input_audio' ||
                cp.type === 'video_url' ||
                cp.type === 'file')
            ) {
              mediaParts.push(cp);
            } else if (cp && cp.type === 'text') {
              textParts.push(cp);
            }
          }
          if (mediaParts.length > 0) {
            const textOnly = textParts.map((p) => p.text).join('\n');
            toolMessage.content =
              textOnly || '[media attached in following user message]';
            accumulatedSplitMedia.push(...mediaParts);
          }
        }
        messages.push(toolMessage);
      }
    }
  }

  // Emit one combined user message containing all media stripped from the
  // tool messages in this group. Runs after the parts loop so all tool
  // messages remain contiguous (OpenAI requirement for parallel tool calls).
  if (accumulatedSplitMedia.length > 0) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '(attached media from previous tool call)',
        },
        ...accumulatedSplitMedia,
      ] as unknown as OpenAI.Chat.ChatCompletionContentPartText[],
    });
  }

  if (role === 'assistant') {
    if (
      contentParts.length === 0 &&
      toolCalls.length === 0 &&
      reasoningParts.length === 0
    ) {
      return;
    }

    const assistantTextContent = contentParts
      .filter(
        (part): part is OpenAI.Chat.ChatCompletionContentPartText =>
          part.type === 'text',
      )
      .map((part) => part.text)
      .join('');
    const assistantMessage: ExtendedChatCompletionAssistantMessageParam = {
      role: 'assistant',
      // When there is reasoning content but no text, use "" instead of null.
      // Some OpenAI-compatible providers (e.g. Ollama) reject content: null
      // when reasoning_content is present, returning HTTP 400.
      // For tool-call-only messages we keep null to stay spec-compliant.
      content: assistantTextContent || (reasoningParts.length > 0 ? '' : null),
    };

    if (toolCalls.length > 0) {
      assistantMessage.tool_calls = toolCalls;
    }

    const reasoningContent = reasoningParts.join('');
    if (reasoningContent) {
      assistantMessage.reasoning_content = reasoningContent;
    }

    messages.push(assistantMessage);
    return;
  }

  if (contentParts.length > 0) {
    messages.push({
      role: 'user',
      content:
        contentParts as unknown as OpenAI.Chat.ChatCompletionContentPart[],
    });
  }
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
    const serialized = JSON.stringify(response);
    return serialized ?? String(response);
  } catch {
    return String(response);
  }
}

/**
 * Create a tool message from function response (with embedded media parts).
 */
function createToolMessage(
  response: FunctionResponse,
  requestContext: RequestContext,
): OpenAI.Chat.ChatCompletionToolMessageParam | null {
  const textContent = extractFunctionResponseContent(response.response);
  const contentParts: OpenAIContentPart[] = [];

  // Add text content first if present
  if (textContent) {
    contentParts.push({ type: 'text' as const, text: textContent });
  }

  // Add media parts from function response
  for (const part of response.parts || []) {
    const mediaPart = createMediaContentPart(part, requestContext);
    if (mediaPart) {
      contentParts.push(mediaPart);
    }
  }

  // IMPORTANT: Always return a tool message, even if content is empty
  // OpenAI API requires that every tool call has a corresponding tool response
  // Empty tool results are valid (e.g., reading an empty file, successful operations with no output)
  if (contentParts.length === 0) {
    // Return empty string for empty tool results
    return {
      role: 'tool' as const,
      tool_call_id: response.id || '',
      content: '',
    };
  }

  // Cast to OpenAI type - some OpenAI-compatible APIs support richer content in tool messages
  return {
    role: 'tool' as const,
    tool_call_id: response.id || '',
    content: contentParts as unknown as
      | string
      | OpenAI.Chat.ChatCompletionContentPartText[],
  };
}

/**
 * Create OpenAI media content part from Gemini part.
 * Checks modality support before building each media type.
 */
function createMediaContentPart(
  part: Part,
  requestContext: RequestContext,
): OpenAIContentPart | null {
  const { modalities } = requestContext;

  if (part.inlineData?.mimeType && part.inlineData?.data) {
    const mimeType = part.inlineData.mimeType;
    const mediaType = getMediaType(mimeType);
    const displayName = part.inlineData.displayName || mimeType;

    if (mediaType === 'image') {
      if (!modalities.image) {
        return unsupportedModalityPlaceholder(
          'image',
          displayName,
          requestContext,
        );
      }
      const dataUrl = `data:${mimeType};base64,${part.inlineData.data}`;
      return {
        type: 'image_url' as const,
        image_url: { url: dataUrl },
      };
    }

    if (mimeType === 'application/pdf') {
      if (!modalities.pdf) {
        return unsupportedModalityPlaceholder(
          'pdf',
          displayName,
          requestContext,
        );
      }
      const filename = part.inlineData.displayName || 'document.pdf';
      return {
        type: 'file' as const,
        file: {
          filename,
          file_data: `data:${mimeType};base64,${part.inlineData.data}`,
        },
      };
    }

    if (mediaType === 'audio') {
      if (!modalities.audio) {
        return unsupportedModalityPlaceholder(
          'audio',
          displayName,
          requestContext,
        );
      }
      const format = getAudioFormat(mimeType);
      if (format) {
        return {
          type: 'input_audio' as const,
          input_audio: {
            data: `data:${mimeType};base64,${part.inlineData.data}`,
            format,
          },
        };
      }
    }

    if (mediaType === 'video') {
      if (!modalities.video) {
        return unsupportedModalityPlaceholder(
          'video',
          displayName,
          requestContext,
        );
      }
      return {
        type: 'video_url' as const,
        video_url: {
          url: `data:${mimeType};base64,${part.inlineData.data}`,
        },
      };
    }

    return {
      type: 'text' as const,
      text: `Unsupported inline media type: ${mimeType} (${displayName}).`,
    };
  }

  if (part.fileData?.mimeType && part.fileData?.fileUri) {
    const filename = part.fileData.displayName || 'file';
    const fileUri = part.fileData.fileUri;
    const mimeType = part.fileData.mimeType;
    const mediaType = getMediaType(mimeType);

    if (mediaType === 'image') {
      if (!modalities.image) {
        return unsupportedModalityPlaceholder(
          'image',
          filename,
          requestContext,
        );
      }
      return {
        type: 'image_url' as const,
        image_url: { url: fileUri },
      };
    }

    if (mimeType === 'application/pdf') {
      if (!modalities.pdf) {
        return unsupportedModalityPlaceholder('pdf', filename, requestContext);
      }
      return {
        type: 'file' as const,
        file: {
          filename,
          file_data: fileUri,
        },
      };
    }

    if (mediaType === 'video') {
      if (!modalities.video) {
        return unsupportedModalityPlaceholder(
          'video',
          filename,
          requestContext,
        );
      }
      return {
        type: 'video_url' as const,
        video_url: {
          url: fileUri,
        },
      };
    }

    const displayNameStr = part.fileData.displayName
      ? ` (${part.fileData.displayName})`
      : '';
    return {
      type: 'text' as const,
      text: `Unsupported file media type: ${mimeType}${displayNameStr}.`,
    };
  }

  return null;
}

/**
 * Create a text placeholder for unsupported modalities.
 */
function unsupportedModalityPlaceholder(
  modality: string,
  displayName: string,
  requestContext: RequestContext,
): OpenAIContentPart {
  debugLogger.warn(
    `Model '${requestContext.model}' does not support ${modality} input. ` +
      `Replacing with text placeholder: ${displayName}`,
  );
  let hint: string;
  if (modality === 'pdf') {
    hint =
      'This model does not support PDF input directly. The read_file tool cannot extract PDF content either. To extract text from the PDF file, try using skills if applicable, or guide user to install pdf skill by running this slash command:\n/extensions install https://github.com/anthropics/skills:document-skills';
  } else {
    hint = `This model does not support ${modality} input. The read_file tool cannot process this type of file either. To handle this file, try using skills if applicable, or any tools installed at system wide, or let the user know you cannot process this type of file.`;
  }
  return {
    type: 'text' as const,
    text: `[Unsupported ${modality} file: "${displayName}". ${hint}]`,
  };
}

function getMediaType(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function getAudioFormat(mimeType: string): 'wav' | 'mp3' | null {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  return null;
}

function isContentObject(
  content: unknown,
): content is { role: string; parts: Part[] } {
  return (
    typeof content === 'object' &&
    content !== null &&
    'role' in content &&
    'parts' in content &&
    Array.isArray((content as Record<string, unknown>)['parts'])
  );
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
  }

  return '';
}

function convertOpenAITextToParts(
  text: string,
  requestContext: RequestContext,
  final = true,
): Part[] {
  if (!requestContext.responseParsingOptions?.taggedThinkingTags) {
    return text ? [{ text }] : [];
  }

  if (requestContext.taggedThinkingParser) {
    return requestContext.taggedThinkingParser.parse(text, final);
  }

  return parseTaggedThinkingText(text);
}

/**
 * Convert OpenAI response to Gemini format.
 */
export function convertOpenAIResponseToGemini(
  openaiResponse: OpenAI.Chat.ChatCompletion,
  requestContext: RequestContext,
): GenerateContentResponse {
  const choice = openaiResponse.choices?.[0];
  const response = new GenerateContentResponse();

  if (choice) {
    const parts: Part[] = [];

    // Handle reasoning content (thoughts).
    // When taggedThinkingTags is enabled, thought content is already
    // extracted from the text content via convertOpenAITextToParts.
    // Skip reasoning_content extraction to avoid duplicating thought parts.
    if (!requestContext.responseParsingOptions?.taggedThinkingTags) {
      const reasoningText =
        (choice.message as ExtendedCompletionMessage).reasoning_content ??
        (choice.message as ExtendedCompletionMessage).reasoning;
      if (reasoningText) {
        parts.push({ text: reasoningText, thought: true });
      }
    }

    // Handle text content
    if (choice.message.content) {
      parts.push(
        ...convertOpenAITextToParts(choice.message.content, requestContext),
      );
    }

    // Handle tool calls
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.function) {
          let args: Record<string, unknown> = {};
          if (toolCall.function.arguments) {
            args = safeJsonParse(toolCall.function.arguments, {});
          }

          parts.push({
            functionCall: {
              id: toolCall.id,
              name: toolCall.function.name,
              args,
            },
          });
        }
      }
    }

    response.candidates = [
      {
        content: {
          parts,
          role: 'model' as const,
        },
        finishReason: mapOpenAIFinishReasonToGemini(
          choice.finish_reason || 'stop',
        ),
        index: 0,
        safetyRatings: [],
      },
    ];
  } else {
    response.candidates = [];
  }

  response.responseId = openaiResponse.id;
  response.createTime = openaiResponse.created
    ? openaiResponse.created.toString()
    : new Date().getTime().toString();

  response.modelVersion = requestContext.model;
  response.promptFeedback = { safetyRatings: [] };

  // Add usage metadata if available
  if (openaiResponse.usage) {
    const usage = openaiResponse.usage;

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    // Support both formats: prompt_tokens_details.cached_tokens (OpenAI standard)
    // and cached_tokens (some models return it at top level)
    const extendedUsage = usage as ExtendedCompletionUsage;
    const cachedTokens =
      usage.prompt_tokens_details?.cached_tokens ??
      extendedUsage.cached_tokens ??
      0;
    const thinkingTokens =
      usage.completion_tokens_details?.reasoning_tokens || 0;

    // If we only have total tokens but no breakdown, estimate the split
    // Typically input is ~70% and output is ~30% for most conversations
    let finalPromptTokens = promptTokens;
    let finalCompletionTokens = completionTokens;

    if (totalTokens > 0 && promptTokens === 0 && completionTokens === 0) {
      // Estimate: assume 70% input, 30% output
      finalPromptTokens = Math.round(totalTokens * 0.7);
      finalCompletionTokens = Math.round(totalTokens * 0.3);
    }

    response.usageMetadata = {
      promptTokenCount: finalPromptTokens,
      candidatesTokenCount: finalCompletionTokens,
      totalTokenCount: totalTokens,
      cachedContentTokenCount: cachedTokens,
      thoughtsTokenCount: thinkingTokens,
    };
  }

  return response;
}

/**
 * Convert OpenAI stream chunk to Gemini format.
 *
 * `requestContext.toolCallParser` carries the tool-call parser for this
 * stream. Callers MUST attach a fresh parser at stream start and pass the
 * same instance for every chunk of that stream. Concurrent streams MUST use
 * distinct parsers or their tool-call buffers will interleave (issue #3516).
 */
export function convertOpenAIChunkToGemini(
  chunk: OpenAI.Chat.ChatCompletionChunk,
  requestContext: RequestContext,
): GenerateContentResponse {
  const choice = chunk.choices?.[0];
  const response = new GenerateContentResponse();
  const toolCallParser = requestContext.toolCallParser;
  if (!toolCallParser) {
    throw new Error(
      'convertOpenAIChunkToGemini requires requestContext.toolCallParser — attach a fresh StreamingToolCallParser at stream start.',
    );
  }

  if (choice) {
    const parts: Part[] = [];

    // Handle reasoning content (thoughts).
    // When taggedThinkingTags is enabled, thought content is already
    // extracted from the text content via convertOpenAITextToParts.
    // Skip reasoning_content extraction to avoid duplicating thought parts.
    if (!requestContext.responseParsingOptions?.taggedThinkingTags) {
      const reasoningText =
        (choice.delta as ExtendedCompletionChunkDelta)?.reasoning_content ??
        (choice.delta as ExtendedCompletionChunkDelta)?.reasoning;
      if (reasoningText) {
        parts.push({ text: reasoningText, thought: true });
      }
    }

    // Handle text content
    if (typeof choice.delta?.content === 'string') {
      parts.push(
        ...convertOpenAITextToParts(
          choice.delta.content,
          requestContext,
          Boolean(choice.finish_reason),
        ),
      );
    } else if (choice.finish_reason) {
      // Flush any buffered tagged-thinking content on stream end
      parts.push(...convertOpenAITextToParts('', requestContext, true));
    }

    // Handle tool calls using the stream-local parser
    if (choice.delta?.tool_calls) {
      for (const toolCall of choice.delta.tool_calls) {
        const index = toolCall.index ?? 0;

        // Process the tool call chunk through the streaming parser
        if (toolCall.function?.arguments) {
          toolCallParser.addChunk(
            index,
            toolCall.function.arguments,
            toolCall.id,
            toolCall.function.name,
          );
        } else {
          // Handle metadata-only chunks (id and/or name without arguments)
          toolCallParser.addChunk(
            index,
            '', // Empty chunk for metadata-only updates
            toolCall.id,
            toolCall.function?.name,
          );
        }
      }
    }

    // Only emit function calls when streaming is complete (finish_reason is present)
    let toolCallsTruncated = false;
    if (choice.finish_reason) {
      // Detect truncation the provider may not report correctly.
      // Some providers (e.g. DashScope/Qwen) send "stop" or "tool_calls"
      // even when output was cut off mid-JSON due to max_tokens.
      toolCallsTruncated = toolCallParser.hasIncompleteToolCalls();

      const completedToolCalls = toolCallParser.getCompletedToolCalls();

      for (const toolCall of completedToolCalls) {
        if (toolCall.name) {
          parts.push({
            functionCall: {
              id:
                toolCall.id ||
                `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              name: toolCall.name,
              args: toolCall.args,
            },
          });
        }
      }
    }

    // If tool call JSON was truncated, override to "length" so downstream
    // (turn.ts) correctly sets wasOutputTruncated=true.
    const effectiveFinishReason =
      toolCallsTruncated && choice.finish_reason !== 'length'
        ? 'length'
        : choice.finish_reason;

    // Only include finishReason key if finish_reason is present
    const candidate: Candidate = {
      content: {
        parts,
        role: 'model' as const,
      },
      index: 0,
      safetyRatings: [],
    };
    if (effectiveFinishReason) {
      candidate.finishReason = mapOpenAIFinishReasonToGemini(
        effectiveFinishReason,
      );
    }
    response.candidates = [candidate];
  } else {
    response.candidates = [];
  }

  response.responseId = chunk.id;
  response.createTime = chunk.created
    ? chunk.created.toString()
    : new Date().getTime().toString();

  response.modelVersion = requestContext.model;
  response.promptFeedback = { safetyRatings: [] };

  // Add usage metadata if available in the chunk
  if (chunk.usage) {
    const usage = chunk.usage;

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    const thinkingTokens =
      usage.completion_tokens_details?.reasoning_tokens || 0;
    // Support both formats: prompt_tokens_details.cached_tokens (OpenAI standard)
    // and cached_tokens (some models return it at top level)
    const extendedUsage = usage as ExtendedCompletionUsage;
    const cachedTokens =
      usage.prompt_tokens_details?.cached_tokens ??
      extendedUsage.cached_tokens ??
      0;

    // If we only have total tokens but no breakdown, estimate the split
    // Typically input is ~70% and output is ~30% for most conversations
    let finalPromptTokens = promptTokens;
    let finalCompletionTokens = completionTokens;

    if (totalTokens > 0 && promptTokens === 0 && completionTokens === 0) {
      // Estimate: assume 70% input, 30% output
      finalPromptTokens = Math.round(totalTokens * 0.7);
      finalCompletionTokens = Math.round(totalTokens * 0.3);
    }

    response.usageMetadata = {
      promptTokenCount: finalPromptTokens,
      candidatesTokenCount: finalCompletionTokens,
      thoughtsTokenCount: thinkingTokens,
      totalTokenCount: totalTokens,
      cachedContentTokenCount: cachedTokens,
    };
  }

  return response;
}

function mapOpenAIFinishReasonToGemini(
  openaiReason: string | null,
): FinishReason {
  if (!openaiReason) return FinishReason.FINISH_REASON_UNSPECIFIED;
  const mapping: Record<string, FinishReason> = {
    stop: FinishReason.STOP,
    length: FinishReason.MAX_TOKENS,
    content_filter: FinishReason.SAFETY,
    function_call: FinishReason.STOP,
    tool_calls: FinishReason.STOP,
  };
  return mapping[openaiReason] || FinishReason.FINISH_REASON_UNSPECIFIED;
}

function mapGeminiFinishReasonToOpenAI(
  geminiReason?: FinishReason,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' {
  if (!geminiReason) {
    return 'stop';
  }

  switch (geminiReason) {
    case FinishReason.STOP:
      return 'stop';
    case FinishReason.MAX_TOKENS:
      return 'length';
    case FinishReason.SAFETY:
      return 'content_filter';
    default:
      if (geminiReason === ('RECITATION' as FinishReason)) {
        return 'content_filter';
      }
      return 'stop';
  }
}

/**
 * Clean up orphaned tool calls from message history to prevent OpenAI API errors.
 */
function cleanOrphanedToolCalls(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const cleaned: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const toolCallIds = new Set<string>();
  const toolResponseIds = new Set<string>();

  // First pass: collect all tool call IDs and tool response IDs
  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      'tool_calls' in message &&
      message.tool_calls
    ) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.id) {
          toolCallIds.add(toolCall.id);
        }
      }
    } else if (
      message.role === 'tool' &&
      'tool_call_id' in message &&
      message.tool_call_id
    ) {
      toolResponseIds.add(message.tool_call_id);
    }
  }

  // Second pass: filter out orphaned messages
  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      'tool_calls' in message &&
      message.tool_calls
    ) {
      // Filter out tool calls that don't have corresponding responses
      const validToolCalls = message.tool_calls.filter(
        (toolCall) => toolCall.id && toolResponseIds.has(toolCall.id),
      );

      if (validToolCalls.length > 0) {
        // Keep the message but only with valid tool calls
        const cleanedMessage = { ...message };
        (
          cleanedMessage as OpenAI.Chat.ChatCompletionMessageParam & {
            tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
          }
        ).tool_calls = validToolCalls;
        cleaned.push(cleanedMessage);
      } else if (
        typeof message.content === 'string' &&
        message.content.trim()
      ) {
        // Keep the message if it has text content, but remove tool calls
        const cleanedMessage = { ...message };
        delete (
          cleanedMessage as OpenAI.Chat.ChatCompletionMessageParam & {
            tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
          }
        ).tool_calls;
        cleaned.push(cleanedMessage);
      }
      // If no valid tool calls and no content, skip the message entirely
    } else if (
      message.role === 'tool' &&
      'tool_call_id' in message &&
      message.tool_call_id
    ) {
      // Only keep tool responses that have corresponding tool calls
      if (toolCallIds.has(message.tool_call_id)) {
        cleaned.push(message);
      }
    } else {
      // Keep all other messages as-is
      cleaned.push(message);
    }
  }

  // Final validation: ensure every assistant message with tool_calls has corresponding tool responses
  const finalCleaned: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const finalToolCallIds = new Set<string>();

  // Collect all remaining tool call IDs
  for (const message of cleaned) {
    if (
      message.role === 'assistant' &&
      'tool_calls' in message &&
      message.tool_calls
    ) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.id) {
          finalToolCallIds.add(toolCall.id);
        }
      }
    }
  }

  // Verify all tool calls have responses
  const finalToolResponseIds = new Set<string>();
  for (const message of cleaned) {
    if (
      message.role === 'tool' &&
      'tool_call_id' in message &&
      message.tool_call_id
    ) {
      finalToolResponseIds.add(message.tool_call_id);
    }
  }

  // Remove any remaining orphaned tool calls
  for (const message of cleaned) {
    if (
      message.role === 'assistant' &&
      'tool_calls' in message &&
      message.tool_calls
    ) {
      const finalValidToolCalls = message.tool_calls.filter(
        (toolCall) => toolCall.id && finalToolResponseIds.has(toolCall.id),
      );

      if (finalValidToolCalls.length > 0) {
        const cleanedMessage = { ...message };
        (
          cleanedMessage as OpenAI.Chat.ChatCompletionMessageParam & {
            tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
          }
        ).tool_calls = finalValidToolCalls;
        finalCleaned.push(cleanedMessage);
      } else if (
        typeof message.content === 'string' &&
        message.content.trim()
      ) {
        const cleanedMessage = { ...message };
        delete (
          cleanedMessage as OpenAI.Chat.ChatCompletionMessageParam & {
            tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
          }
        ).tool_calls;
        finalCleaned.push(cleanedMessage);
      }
    } else {
      finalCleaned.push(message);
    }
  }

  return finalCleaned;
}

/**
 * Merge consecutive assistant messages to combine split text and tool calls.
 */
function mergeConsecutiveAssistantMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const merged: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'assistant' && merged.length > 0) {
      const lastMessage = merged[merged.length - 1];

      // If the last message is also an assistant message, merge them
      if (lastMessage.role === 'assistant') {
        const lastToolCalls =
          'tool_calls' in lastMessage ? lastMessage.tool_calls || [] : [];
        const currentToolCalls =
          'tool_calls' in message ? message.tool_calls || [] : [];
        // Combine content
        const lastContent = lastMessage.content;
        const currentContent = message.content;

        // Determine if we should use array format (if either content is an array)
        const useArrayFormat =
          Array.isArray(lastContent) || Array.isArray(currentContent);

        let combinedContent:
          | string
          | OpenAI.Chat.ChatCompletionContentPart[]
          | null;

        if (useArrayFormat) {
          // Convert both to array format and merge
          const lastParts = Array.isArray(lastContent)
            ? lastContent
            : typeof lastContent === 'string' && lastContent
              ? [{ type: 'text' as const, text: lastContent }]
              : [];

          const currentParts = Array.isArray(currentContent)
            ? currentContent
            : typeof currentContent === 'string' && currentContent
              ? [{ type: 'text' as const, text: currentContent }]
              : [];

          combinedContent = [
            ...lastParts,
            ...currentParts,
          ] as OpenAI.Chat.ChatCompletionContentPart[];
        } else {
          // Both are strings or null, merge as strings
          const lastText = typeof lastContent === 'string' ? lastContent : '';
          const currentText =
            typeof currentContent === 'string' ? currentContent : '';
          const mergedText = [lastText, currentText].filter(Boolean).join('');
          combinedContent = mergedText || null;
        }

        // Combine tool calls
        const combinedToolCalls = [...lastToolCalls, ...currentToolCalls];

        // Update the last message with combined data
        (
          lastMessage as OpenAI.Chat.ChatCompletionMessageParam & {
            content: string | OpenAI.Chat.ChatCompletionContentPart[] | null;
            tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
          }
        ).content = combinedContent || null;
        if (combinedToolCalls.length > 0) {
          (
            lastMessage as OpenAI.Chat.ChatCompletionMessageParam & {
              content: string | OpenAI.Chat.ChatCompletionContentPart[] | null;
              tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[];
            }
          ).tool_calls = combinedToolCalls;
        }

        continue; // Skip adding the current message since it's been merged
      }
    }

    // Add the message as-is if no merging is needed
    merged.push(message);
  }

  return merged;
}

export const OpenAIContentConverter = {
  convertGeminiToolParametersToOpenAI,
  convertGeminiToolsToOpenAI,
  convertGeminiRequestToOpenAI,
  convertGeminiResponseToOpenAI,
  convertOpenAIResponseToGemini,
  convertOpenAIChunkToGemini,
};
