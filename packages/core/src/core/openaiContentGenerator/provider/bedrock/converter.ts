/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type {
  BedrockMessage,
  BedrockContentBlock,
  BedrockTextBlock,
  BedrockImageBlock,
  BedrockToolUseBlock,
  BedrockToolResultBlock,
  BedrockConverseRequest,
  BedrockConverseResponse,
  BedrockStreamEvent,
  BedrockInferenceConfig,
  BedrockToolConfig,
  BedrockTool,
  BedrockSystemContent,
} from './types.js';

/**
 * Convert OpenAI chat completion request to Bedrock Converse format
 */
export function convertOpenAIToBedrock(
  request: OpenAI.Chat.ChatCompletionCreateParams,
  modelId: string,
): BedrockConverseRequest {
  const { messages, tools, tool_choice, temperature, max_tokens, top_p, stop } =
    request;

  // Separate system messages from conversation messages
  const systemMessages: BedrockSystemContent[] = [];
  const conversationMessages: BedrockMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      // Extract text from system message
      const text =
        typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((part) => part.type === 'text')
                .map((part) => (part as { text: string }).text)
                .join('\n')
            : '';
      if (text) {
        systemMessages.push({ text });
      }
    } else if (message.role === 'user' || message.role === 'assistant') {
      conversationMessages.push(convertMessage(message));
    } else if (message.role === 'tool') {
      // Tool messages need to be merged into the conversation
      // They're handled during message conversion
      conversationMessages.push(convertToolMessage(message));
    }
  }

  // Build inference config
  const inferenceConfig: BedrockInferenceConfig = {};
  if (max_tokens !== undefined && max_tokens !== null) {
    inferenceConfig.maxTokens = max_tokens;
  }
  if (temperature !== undefined && temperature !== null) {
    inferenceConfig.temperature = temperature;
  }
  if (top_p !== undefined && top_p !== null) {
    inferenceConfig.topP = top_p;
  }
  if (stop !== undefined && stop !== null) {
    inferenceConfig.stopSequences = Array.isArray(stop)
      ? stop.filter((s): s is string => s !== null)
      : [stop];
  }

  // Build tool config
  let toolConfig: BedrockToolConfig | undefined;
  if (tools && tools.length > 0) {
    const bedrockTools: BedrockTool[] = tools.map((tool) => ({
      toolSpec: {
        name: tool.function.name,
        description: tool.function.description,
        inputSchema: {
          json: tool.function.parameters as Record<string, unknown>,
        },
      },
    }));

    toolConfig = { tools: bedrockTools };

    if (tool_choice) {
      if (typeof tool_choice === 'string') {
        if (tool_choice === 'auto') {
          toolConfig.toolChoice = { auto: {} };
        } else if (tool_choice === 'required') {
          toolConfig.toolChoice = { any: {} };
        }
      } else if (typeof tool_choice === 'object' && 'function' in tool_choice) {
        toolConfig.toolChoice = { tool: { name: tool_choice.function.name } };
      }
    }
  }

  const bedrockRequest: BedrockConverseRequest = {
    modelId,
    messages: conversationMessages,
    inferenceConfig,
  };

  if (systemMessages.length > 0) {
    bedrockRequest.system = systemMessages;
  }

  if (toolConfig) {
    bedrockRequest.toolConfig = toolConfig;
  }

  return bedrockRequest;
}

/**
 * Convert a single OpenAI message to Bedrock format
 */
function convertMessage(
  message:
    | OpenAI.Chat.ChatCompletionUserMessageParam
    | OpenAI.Chat.ChatCompletionAssistantMessageParam,
): BedrockMessage {
  const role = message.role === 'user' ? 'user' : 'assistant';
  const contentBlocks: BedrockContentBlock[] = [];

  if (message.role === 'user') {
    // Handle user message content
    const content = message.content;
    if (typeof content === 'string') {
      contentBlocks.push({ text: content } as BedrockTextBlock);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text') {
          contentBlocks.push({ text: part.text } as BedrockTextBlock);
        } else if (part.type === 'image_url') {
          // Convert base64 image to bytes
          const imageBlock = convertImageUrl(part.image_url.url);
          if (imageBlock) {
            contentBlocks.push(imageBlock);
          }
        }
      }
    }
  } else if (message.role === 'assistant') {
    // Handle assistant message content
    const content = message.content;
    if (typeof content === 'string' && content) {
      contentBlocks.push({ text: content } as BedrockTextBlock);
    } else if (Array.isArray(content)) {
      // Handle array content (same as user messages)
      for (const part of content) {
        if (part.type === 'text' && part.text) {
          contentBlocks.push({ text: part.text } as BedrockTextBlock);
        }
      }
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === 'function') {
          const toolUseBlock: BedrockToolUseBlock = {
            toolUse: {
              toolUseId: toolCall.id,
              name: toolCall.function.name,
              input: JSON.parse(toolCall.function.arguments),
            },
          };
          contentBlocks.push(toolUseBlock);
        }
      }
    }
  }

  return {
    role,
    content: contentBlocks,
  };
}

/**
 * Convert OpenAI tool message to Bedrock format
 */
function convertToolMessage(
  message: OpenAI.Chat.ChatCompletionToolMessageParam,
): BedrockMessage {
  const toolResultBlock: BedrockToolResultBlock = {
    toolResult: {
      toolUseId: message.tool_call_id,
      content: [{ text: message.content as string }],
      status: 'success',
    },
  };

  return {
    role: 'user', // Tool results are represented as user messages in Bedrock
    content: [toolResultBlock],
  };
}

/**
 * Convert image URL (base64 or HTTP) to Bedrock image block
 */
function convertImageUrl(imageUrl: string): BedrockImageBlock | null {
  try {
    if (imageUrl.startsWith('data:image/')) {
      // Extract base64 data
      const match = imageUrl.match(
        /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/,
      );
      if (!match) return null;

      const format =
        match[1] === 'jpg'
          ? 'jpeg'
          : (match[1] as 'png' | 'jpeg' | 'gif' | 'webp');
      const base64Data = match[2];
      const bytes = Buffer.from(base64Data, 'base64');

      return {
        image: {
          format,
          source: { bytes: new Uint8Array(bytes) },
        },
      };
    }
    // For HTTP URLs, we would need to fetch and convert
    // This is not implemented yet
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert Bedrock response to OpenAI format
 */
export function convertBedrockToOpenAI(
  response: BedrockConverseResponse,
  modelId: string,
): OpenAI.Chat.ChatCompletion {
  const message = response.output.message;
  const finishReason = convertFinishReason(response.stopReason);

  const openaiMessage: OpenAI.Chat.ChatCompletion.Choice['message'] = {
    role: 'assistant',
    content: null,
    refusal: null,
  };

  const textParts: string[] = [];
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

  for (const block of message.content) {
    if ('text' in block) {
      textParts.push(block.text);
    } else if ('toolUse' in block) {
      toolCalls.push({
        id: block.toolUse.toolUseId,
        type: 'function',
        function: {
          name: block.toolUse.name,
          arguments: JSON.stringify(block.toolUse.input),
        },
      });
    }
  }

  if (textParts.length > 0) {
    openaiMessage.content = textParts.join('');
  }

  if (toolCalls.length > 0) {
    openaiMessage.tool_calls = toolCalls;
  }

  return {
    id: `bedrock-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: openaiMessage,
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.totalTokens,
    },
  };
}

/**
 * Convert Bedrock finish reason to OpenAI format
 */
function convertFinishReason(
  stopReason: BedrockConverseResponse['stopReason'],
): 'stop' | 'length' | 'tool_calls' | 'content_filter' {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    case 'content_filtered':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Convert Bedrock streaming events to OpenAI chat completion chunks
 */
export function* convertBedrockStreamToOpenAI(
  events: BedrockStreamEvent[],
  modelId: string,
): Generator<OpenAI.Chat.ChatCompletionChunk> {
  const streamId = `bedrock-stream-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  // Track state for accumulating tool call inputs
  const toolCallBuffer: Map<
    number,
    { id: string; name: string; arguments: string }
  > = new Map();

  for (const event of events) {
    if ('messageStart' in event) {
      // Stream start event
      yield {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ],
      };
    } else if ('contentBlockStart' in event) {
      const { start, contentBlockIndex } = event.contentBlockStart;
      if ('toolUse' in start) {
        // Initialize tool call buffer
        toolCallBuffer.set(contentBlockIndex, {
          id: start.toolUse.toolUseId,
          name: start.toolUse.name,
          arguments: '',
        });

        yield {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: contentBlockIndex,
                    id: start.toolUse.toolUseId,
                    type: 'function',
                    function: {
                      name: start.toolUse.name,
                      arguments: '',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        };
      }
    } else if ('contentBlockDelta' in event) {
      const { delta, contentBlockIndex } = event.contentBlockDelta;
      if ('text' in delta) {
        // Text delta
        yield {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: { content: delta.text },
              finish_reason: null,
            },
          ],
        };
      } else if ('toolUse' in delta) {
        // Tool call arguments delta
        const buffered = toolCallBuffer.get(contentBlockIndex);
        if (buffered) {
          buffered.arguments += delta.toolUse.input;

          yield {
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: contentBlockIndex,
                      function: {
                        arguments: delta.toolUse.input,
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        }
      }
    } else if ('messageStop' in event) {
      // Stream end event
      const finishReason = convertFinishReason(event.messageStop.stopReason);
      yield {
        id: streamId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      };
    }
    // 'metadata' events contain usage information but OpenAI chunks don't include this
  }
}
