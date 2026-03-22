/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponse,
  FinishReason,
} from '@google/genai';
import type {
  GenerateContentParameters,
  Part,
  Content,
  Candidate,
} from '@google/genai';
import type {
  ResponsesSSEEvent,
  ResponsesApiOutputItem,
  ResponsesApiOutputFunctionCall,
  ResponsesApiOutputReasoningSummary,
  ResponsesApiUsage,
  ResponsesApiInputItem,
  ResponsesApiMessageItem,
  ResponsesApiFunctionCallItem,
  ResponsesApiFunctionCallOutputItem,
  ResponsesApiTool,
  ResponsesApiContentPart,
} from './types.js';

/**
 * Tracks accumulated state for a single streaming response from the
 * Responses API. A new instance should be created per response stream.
 */
export class ResponsesStreamState {
  responseId: string | null = null;
  encryptedContentItems: Array<{ type: string; id?: string; encrypted_content: string }> = [];
  private funcCallArgs: Map<number, { id: string; name: string; args: string }> =
    new Map();

  getFunctionCallBuffer(
    outputIndex: number,
  ): { id: string; name: string; args: string } | undefined {
    return this.funcCallArgs.get(outputIndex);
  }

  initFunctionCall(
    outputIndex: number,
    id: string,
    callId: string,
    name: string,
  ): void {
    this.funcCallArgs.set(outputIndex, { id: callId, name, args: '' });
  }

  appendFunctionCallArgs(outputIndex: number, delta: string): void {
    const buf = this.funcCallArgs.get(outputIndex);
    if (buf) buf.args += delta;
  }

  reset(): void {
    this.responseId = null;
    this.encryptedContentItems = [];
    this.funcCallArgs.clear();
  }
}

/**
 * Converts Responses API SSE events into GenerateContentResponse objects
 * matching the shape produced by the Chat Completions converter, so the
 * downstream Turn / GeminiClient pipeline works unchanged.
 */
export function convertResponsesEventToGemini(
  event: ResponsesSSEEvent,
  model: string,
  state: ResponsesStreamState,
): GenerateContentResponse | null {
  switch (event.event) {
    case 'response.created': {
      const data = event.data as { id?: string };
      if (data.id) {
        state.responseId = data.id;
      }
      return null;
    }

    case 'response.in_progress':
      return null;

    case 'response.output_item.added': {
      const data = event.data as {
        output_index: number;
        item: ResponsesApiOutputItem;
      };
      if (data.item.type === 'function_call') {
        const fc = data.item as ResponsesApiOutputFunctionCall;
        state.initFunctionCall(data.output_index, fc.id, fc.call_id, fc.name);
      }
      return null;
    }

    case 'response.output_text.delta': {
      const data = event.data as { delta: string };
      return makeChunkResponse(model, state, [{ text: data.delta }]);
    }

    case 'response.reasoning_summary_text.delta': {
      const data = event.data as { delta: string };
      return makeChunkResponse(model, state, [
        { text: data.delta, thought: true },
      ]);
    }

    case 'response.function_call_arguments.delta': {
      const data = event.data as { output_index: number; delta: string };
      state.appendFunctionCallArgs(data.output_index, data.delta);
      return null;
    }

    case 'response.output_item.done': {
      const data = event.data as {
        output_index: number;
        item: ResponsesApiOutputItem;
      };
      if (data.item.type === 'function_call') {
        const buf = state.getFunctionCallBuffer(data.output_index);
        if (buf) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(buf.args) as Record<string, unknown>;
          } catch {
            args = {};
          }
          return makeChunkResponse(model, state, [
            {
              functionCall: {
                id: buf.id,
                name: buf.name,
                args,
              },
            },
          ]);
        }
      }
      if (
        data.item.type === 'reasoning' &&
        (data.item as ResponsesApiOutputReasoningSummary).encrypted_content
      ) {
        state.encryptedContentItems.push({
          type: 'reasoning',
          id: data.item.id,
          encrypted_content: (data.item as ResponsesApiOutputReasoningSummary)
            .encrypted_content!,
        });
      }
      return null;
    }

    case 'response.completed': {
      const data = event.data as {
        id?: string;
        usage?: ResponsesApiUsage;
        status?: string;
      };
      if (data.id) state.responseId = data.id;
      return makeFinalResponse(model, state, data.usage, data.status);
    }

    case 'response.failed': {
      const data = event.data as {
        error?: { code: string; message: string };
      };
      const errMsg = data.error
        ? `${data.error.code}: ${data.error.message}`
        : 'Response failed';
      throw new Error(`Responses API failed: ${errMsg}`);
    }

    case 'response.incomplete':
      return makeFinalResponse(model, state, undefined, 'incomplete');

    case 'error': {
      const data = event.data as { message?: string };
      throw new Error(
        `Responses API error: ${data.message ?? 'Unknown error'}`,
      );
    }

    default:
      return null;
  }
}

function makeChunkResponse(
  model: string,
  state: ResponsesStreamState,
  parts: Part[],
  finishReason?: string,
): GenerateContentResponse {
  const candidate: Candidate = {
    content: { parts, role: 'model' as const },
    index: 0,
    safetyRatings: [],
  };
  if (finishReason) {
    candidate.finishReason = mapFinishReason(finishReason);
  }

  const resp = new GenerateContentResponse();
  resp.candidates = [candidate];
  resp.responseId = state.responseId ?? undefined;
  resp.modelVersion = model;
  resp.createTime = Date.now().toString();
  resp.promptFeedback = { safetyRatings: [] };
  return resp;
}

function makeFinalResponse(
  model: string,
  state: ResponsesStreamState,
  usage: ResponsesApiUsage | undefined,
  status: string | undefined,
): GenerateContentResponse {
  const finishReason =
    status === 'incomplete' ? 'length' : status === 'failed' ? 'stop' : 'stop';

  const resp = makeChunkResponse(model, state, [], finishReason);

  if (usage) {
    resp.usageMetadata = {
      promptTokenCount: usage.input_tokens,
      candidatesTokenCount: usage.output_tokens,
      totalTokenCount: usage.total_tokens,
      thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens ?? 0,
      cachedContentTokenCount:
        usage.input_tokens_details?.cached_tokens ?? 0,
    };
  }

  return resp;
}

function mapFinishReason(reason: string): FinishReason {
  const mapping: Record<string, FinishReason> = {
    stop: FinishReason.STOP,
    length: FinishReason.MAX_TOKENS,
    content_filter: FinishReason.SAFETY,
    max_output_tokens: FinishReason.MAX_TOKENS,
  };
  return mapping[reason] ?? FinishReason.STOP;
}

// ── Input conversion: Gemini Content[] → Responses API input items ─────

export function convertGeminiContentsToResponsesInput(
  request: GenerateContentParameters,
): { instructions: string | undefined; input: ResponsesApiInputItem[] } {
  let instructions: string | undefined;
  const items: ResponsesApiInputItem[] = [];

  if (request.config?.systemInstruction) {
    const si = request.config.systemInstruction;
    if (typeof si === 'string') {
      instructions = si;
    } else if (
      typeof si === 'object' &&
      'parts' in si &&
      Array.isArray(si.parts)
    ) {
      instructions = si.parts
        .map((p: Part) => (typeof p === 'string' ? p : p.text ?? ''))
        .join('\n');
    }
  }

  const contents = request.contents;
  if (!contents) return { instructions, input: items };

  const contentArray: Content[] = Array.isArray(contents)
    ? (contents as Content[])
    : typeof contents === 'string'
      ? [{ role: 'user', parts: [{ text: contents }] }]
      : [contents as Content];

  for (const content of contentArray) {
    if (typeof content === 'string') {
      items.push({
        type: 'message',
        role: 'user',
        content: content,
      } as ResponsesApiMessageItem);
      continue;
    }

    const role = content.role === 'model' ? 'assistant' : 'user';
    const parts = content.parts ?? [];

    for (const part of parts) {
      if (typeof part === 'string') {
        items.push({
          type: 'message',
          role,
          content: part,
        } as ResponsesApiMessageItem);
        continue;
      }

      if ('thought' in part && part.thought) {
        continue;
      }

      if ('text' in part && part.text) {
        items.push({
          type: 'message',
          role,
          content: part.text,
        } as ResponsesApiMessageItem);
      }

      if ('functionCall' in part && part.functionCall) {
        const callId = part.functionCall.id ?? `call_${Date.now()}`;
        items.push({
          type: 'function_call',
          id: callId,
          call_id: callId,
          name: part.functionCall.name ?? '',
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        } as ResponsesApiFunctionCallItem);
      }

      if ('functionResponse' in part && part.functionResponse) {
        const fr = part.functionResponse;
        let output: string;
        if (typeof fr.response === 'string') {
          output = fr.response;
        } else {
          output = JSON.stringify(fr.response ?? {});
        }
        items.push({
          type: 'function_call_output',
          call_id: fr.id ?? '',
          output,
        } as ResponsesApiFunctionCallOutputItem);
      }

      if ('inlineData' in part && part.inlineData && role === 'user') {
        const mimeType = part.inlineData.mimeType ?? 'image/png';
        if (mimeType.startsWith('image/')) {
          const contentParts: ResponsesApiContentPart[] = [
            {
              type: 'input_image',
              image_url: `data:${mimeType};base64,${part.inlineData.data}`,
            },
          ];
          items.push({
            type: 'message',
            role: 'user',
            content: contentParts,
          } as ResponsesApiMessageItem);
        }
      }
    }
  }

  return { instructions, input: items };
}

export function convertGeminiToolsToResponsesTools(
  request: GenerateContentParameters,
): ResponsesApiTool[] | undefined {
  const tools = request.config?.tools;
  if (!tools || !Array.isArray(tools)) return undefined;

  const result: ResponsesApiTool[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue;
    const funcDecls =
      'functionDeclarations' in tool ? tool.functionDeclarations : undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const func of funcDecls) {
      if (!func.name) continue;
      result.push({
        type: 'function',
        name: func.name,
        description: func.description,
        parameters: (func.parameters ?? func.parametersJsonSchema) as
          | Record<string, unknown>
          | undefined,
      });
    }
  }

  return result.length > 0 ? result : undefined;
}
