/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Candidate,
  CallableTool,
  Content,
  ContentListUnion,
  ContentUnion,
  FunctionCall,
  FunctionResponse,
  GenerateContentParameters,
  Part,
  PartUnion,
  Tool,
  ToolListUnion,
} from '@google/genai';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import type Anthropic from '@anthropic-ai/sdk';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import {
  convertSchema,
  type SchemaComplianceMode,
} from '../../utils/schemaConverter.js';

type AnthropicMessageParam = Anthropic.MessageParam;
type AnthropicToolParam = Anthropic.Tool;
type AnthropicContentBlockParam = Anthropic.ContentBlockParam;

type ThoughtPart = { text: string; signature?: string };

interface ParsedParts {
  thoughtParts: ThoughtPart[];
  contentParts: string[];
  functionCalls: FunctionCall[];
  functionResponses: FunctionResponse[];
}

export class AnthropicContentConverter {
  private model: string;
  private schemaCompliance: SchemaComplianceMode;

  constructor(model: string, schemaCompliance: SchemaComplianceMode = 'auto') {
    this.model = model;
    this.schemaCompliance = schemaCompliance;
  }

  convertGeminiRequestToAnthropic(request: GenerateContentParameters): {
    system?: string;
    messages: AnthropicMessageParam[];
  } {
    const messages: AnthropicMessageParam[] = [];

    const system = this.extractTextFromContentUnion(
      request.config?.systemInstruction,
    );

    this.processContents(request.contents, messages);

    return {
      system: system || undefined,
      messages,
    };
  }

  async convertGeminiToolsToAnthropic(
    geminiTools: ToolListUnion,
  ): Promise<AnthropicToolParam[]> {
    const tools: AnthropicToolParam[] = [];

    for (const tool of geminiTools) {
      let actualTool: Tool;

      if ('tool' in tool) {
        actualTool = await (tool as CallableTool).tool();
      } else {
        actualTool = tool as Tool;
      }

      if (!actualTool.functionDeclarations) {
        continue;
      }

      for (const func of actualTool.functionDeclarations) {
        if (!func.name) continue;

        let inputSchema: Record<string, unknown> | undefined;
        if (func.parametersJsonSchema) {
          inputSchema = {
            ...(func.parametersJsonSchema as Record<string, unknown>),
          };
        } else if (func.parameters) {
          inputSchema = func.parameters as Record<string, unknown>;
        }

        if (!inputSchema) {
          inputSchema = { type: 'object', properties: {} };
        }

        inputSchema = convertSchema(inputSchema, this.schemaCompliance);
        if (typeof inputSchema['type'] !== 'string') {
          inputSchema['type'] = 'object';
        }

        tools.push({
          name: func.name,
          description: func.description,
          input_schema: inputSchema as Anthropic.Tool.InputSchema,
        });
      }
    }

    return tools;
  }

  convertAnthropicResponseToGemini(
    response: Anthropic.Message,
  ): GenerateContentResponse {
    const geminiResponse = new GenerateContentResponse();
    const parts: Part[] = [];

    for (const block of response.content || []) {
      const blockType = String((block as { type?: string })['type'] || '');
      if (blockType === 'text') {
        const text =
          typeof (block as { text?: string }).text === 'string'
            ? (block as { text?: string }).text
            : '';
        if (text) {
          parts.push({ text });
        }
      } else if (blockType === 'tool_use') {
        const toolUse = block as {
          id?: string;
          name?: string;
          input?: unknown;
        };
        parts.push({
          functionCall: {
            id: typeof toolUse.id === 'string' ? toolUse.id : undefined,
            name: typeof toolUse.name === 'string' ? toolUse.name : undefined,
            args: this.safeInputToArgs(toolUse.input),
          },
        });
      } else if (blockType === 'thinking') {
        const thinking =
          typeof (block as { thinking?: string }).thinking === 'string'
            ? (block as { thinking?: string }).thinking
            : '';
        const signature =
          typeof (block as { signature?: string }).signature === 'string'
            ? (block as { signature?: string }).signature
            : '';
        if (thinking || signature) {
          const thoughtPart: Part = {
            text: thinking,
            thought: true,
            thoughtSignature: signature,
          };
          parts.push(thoughtPart);
        }
      } else if (blockType === 'redacted_thinking') {
        parts.push({ text: '', thought: true });
      }
    }

    const candidate: Candidate = {
      content: {
        parts,
        role: 'model' as const,
      },
      index: 0,
      safetyRatings: [],
    };

    const finishReason = this.mapAnthropicFinishReasonToGemini(
      response.stop_reason,
    );
    if (finishReason) {
      candidate.finishReason = finishReason;
    }

    geminiResponse.candidates = [candidate];
    geminiResponse.responseId = response.id;
    geminiResponse.createTime = Date.now().toString();
    geminiResponse.modelVersion = response.model || this.model;
    geminiResponse.promptFeedback = { safetyRatings: [] };

    if (response.usage) {
      const promptTokens = response.usage.input_tokens || 0;
      const completionTokens = response.usage.output_tokens || 0;
      geminiResponse.usageMetadata = {
        promptTokenCount: promptTokens,
        candidatesTokenCount: completionTokens,
        totalTokenCount: promptTokens + completionTokens,
      };
    }

    return geminiResponse;
  }

  private processContents(
    contents: ContentListUnion,
    messages: AnthropicMessageParam[],
  ): void {
    if (Array.isArray(contents)) {
      for (const content of contents) {
        this.processContent(content, messages);
      }
    } else if (contents) {
      this.processContent(contents, messages);
    }
  }

  private processContent(
    content: ContentUnion | PartUnion,
    messages: AnthropicMessageParam[],
  ): void {
    if (typeof content === 'string') {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: content }],
      });
      return;
    }

    if (!this.isContentObject(content)) return;

    const parsed = this.parseParts(content.parts || []);

    if (parsed.functionResponses.length > 0) {
      for (const response of parsed.functionResponses) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: response.id || '',
              content: this.extractFunctionResponseContent(response.response),
            },
          ],
        });
      }
      return;
    }

    if (content.role === 'model' && parsed.functionCalls.length > 0) {
      const thinkingBlocks: AnthropicContentBlockParam[] =
        parsed.thoughtParts.map((part) => {
          const thinkingBlock: unknown = {
            type: 'thinking',
            thinking: part.text,
          };
          if (part.signature) {
            (thinkingBlock as { signature?: string }).signature =
              part.signature;
          }
          return thinkingBlock as AnthropicContentBlockParam;
        });
      const toolUses: AnthropicContentBlockParam[] = parsed.functionCalls.map(
        (call, index) => ({
          type: 'tool_use',
          id: call.id || `tool_${index}`,
          name: call.name || '',
          input: (call.args as Record<string, unknown>) || {},
        }),
      );

      const textBlocks: AnthropicContentBlockParam[] = parsed.contentParts.map(
        (text) => ({
          type: 'text' as const,
          text,
        }),
      );

      messages.push({
        role: 'assistant',
        content: [...thinkingBlocks, ...textBlocks, ...toolUses],
      });
      return;
    }

    const role = content.role === 'model' ? 'assistant' : 'user';
    const thinkingBlocks: AnthropicContentBlockParam[] =
      role === 'assistant'
        ? parsed.thoughtParts.map((part) => {
            const thinkingBlock: unknown = {
              type: 'thinking',
              thinking: part.text,
            };
            if (part.signature) {
              (thinkingBlock as { signature?: string }).signature =
                part.signature;
            }
            return thinkingBlock as AnthropicContentBlockParam;
          })
        : [];
    const textBlocks: AnthropicContentBlockParam[] = [
      ...thinkingBlocks,
      ...parsed.contentParts.map((text) => ({
        type: 'text' as const,
        text,
      })),
    ];
    if (textBlocks.length > 0) {
      messages.push({ role, content: textBlocks });
    }
  }

  private parseParts(parts: Part[]): ParsedParts {
    const thoughtParts: ThoughtPart[] = [];
    const contentParts: string[] = [];
    const functionCalls: FunctionCall[] = [];
    const functionResponses: FunctionResponse[] = [];

    for (const part of parts) {
      if (typeof part === 'string') {
        contentParts.push(part);
      } else if (
        'text' in part &&
        part.text &&
        !('thought' in part && part.thought)
      ) {
        contentParts.push(part.text);
      } else if ('text' in part && 'thought' in part && part.thought) {
        thoughtParts.push({
          text: part.text || '',
          signature:
            'thoughtSignature' in part &&
            typeof part.thoughtSignature === 'string'
              ? part.thoughtSignature
              : undefined,
        });
      } else if ('functionCall' in part && part.functionCall) {
        functionCalls.push(part.functionCall);
      } else if ('functionResponse' in part && part.functionResponse) {
        functionResponses.push(part.functionResponse);
      }
    }

    return {
      thoughtParts,
      contentParts,
      functionCalls,
      functionResponses,
    };
  }

  private extractTextFromContentUnion(contentUnion: unknown): string {
    if (typeof contentUnion === 'string') {
      return contentUnion;
    }

    if (Array.isArray(contentUnion)) {
      return contentUnion
        .map((item) => this.extractTextFromContentUnion(item))
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

  private extractFunctionResponseContent(response: unknown): string {
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

  private safeInputToArgs(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object') {
      return input as Record<string, unknown>;
    }
    if (typeof input === 'string') {
      return safeJsonParse(input, {});
    }
    return {};
  }

  mapAnthropicFinishReasonToGemini(
    reason?: string | null,
  ): FinishReason | undefined {
    if (!reason) return undefined;
    const mapping: Record<string, FinishReason> = {
      end_turn: FinishReason.STOP,
      stop_sequence: FinishReason.STOP,
      tool_use: FinishReason.STOP,
      max_tokens: FinishReason.MAX_TOKENS,
      content_filter: FinishReason.SAFETY,
    };
    return mapping[reason] || FinishReason.FINISH_REASON_UNSPECIFIED;
  }

  private isContentObject(
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
}
