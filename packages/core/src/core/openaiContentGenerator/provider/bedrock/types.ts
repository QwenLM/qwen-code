/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for AWS Bedrock Converse API
 * These types mirror the structures used by AWS SDK but with explicit definitions
 * for better type safety in our conversion logic.
 */

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
}

export type BedrockContentBlock =
  | BedrockTextBlock
  | BedrockImageBlock
  | BedrockToolUseBlock
  | BedrockToolResultBlock;

export interface BedrockTextBlock {
  text: string;
}

export interface BedrockImageBlock {
  image: {
    format: 'png' | 'jpeg' | 'gif' | 'webp';
    source: {
      bytes: Uint8Array;
    };
  };
}

export interface BedrockToolUseBlock {
  toolUse: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  };
}

export interface BedrockToolResultBlock {
  toolResult: {
    toolUseId: string;
    content: BedrockToolResultContent[];
    status?: 'success' | 'error';
  };
}

export type BedrockToolResultContent =
  | { text: string }
  | { json: Record<string, unknown> }
  | {
      image: {
        format: 'png' | 'jpeg' | 'gif' | 'webp';
        source: { bytes: Uint8Array };
      };
    };

export interface BedrockToolConfig {
  tools: BedrockTool[];
  toolChoice?: BedrockToolChoice;
}

export interface BedrockTool {
  toolSpec: {
    name: string;
    description?: string;
    inputSchema: {
      json: Record<string, unknown>;
    };
  };
}

export type BedrockToolChoice =
  | { auto: Record<string, never> }
  | { any: Record<string, never> }
  | { tool: { name: string } };

export interface BedrockInferenceConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface BedrockConverseRequest {
  modelId: string;
  messages: BedrockMessage[];
  system?: BedrockSystemContent[];
  inferenceConfig?: BedrockInferenceConfig;
  toolConfig?: BedrockToolConfig;
}

export type BedrockSystemContent = { text: string };

export interface BedrockConverseResponse {
  output: {
    message: BedrockMessage;
  };
  stopReason:
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'stop_sequence'
    | 'content_filtered';
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  metrics?: {
    latencyMs: number;
  };
}

export type BedrockStreamEvent =
  | BedrockMessageStartEvent
  | BedrockContentBlockStartEvent
  | BedrockContentBlockDeltaEvent
  | BedrockContentBlockStopEvent
  | BedrockMessageStopEvent
  | BedrockMetadataEvent;

export interface BedrockMessageStartEvent {
  messageStart: {
    role: 'assistant';
  };
}

export interface BedrockContentBlockStartEvent {
  contentBlockStart: {
    start:
      | { text: string }
      | {
          toolUse: {
            toolUseId: string;
            name: string;
          };
        };
    contentBlockIndex: number;
  };
}

export interface BedrockContentBlockDeltaEvent {
  contentBlockDelta: {
    delta:
      | { text: string }
      | {
          toolUse: {
            input: string; // JSON string that needs parsing
          };
        };
    contentBlockIndex: number;
  };
}

export interface BedrockContentBlockStopEvent {
  contentBlockStop: {
    contentBlockIndex: number;
  };
}

export interface BedrockMessageStopEvent {
  messageStop: {
    stopReason:
      | 'end_turn'
      | 'tool_use'
      | 'max_tokens'
      | 'stop_sequence'
      | 'content_filtered';
  };
}

export interface BedrockMetadataEvent {
  metadata: {
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    metrics?: {
      latencyMs: number;
    };
  };
}

/**
 * Get Bedrock model ID - returns the model name as-is since Bedrock requires exact model IDs
 * Users must specify the full Bedrock model ID (e.g., "qwen.qwen3-coder-30b-a3b-v1:0")
 */
export function getBedrockModelId(modelName: string): string {
  return modelName;
}
