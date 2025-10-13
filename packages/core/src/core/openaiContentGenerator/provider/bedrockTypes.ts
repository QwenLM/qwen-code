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
 * Model ID mapping for common Qwen model names to Bedrock model IDs
 */
export const BEDROCK_MODEL_MAP: Record<string, string> = {
  // Qwen3-Coder models (30B instruction-tuned model)
  'qwen-coder': 'qwen.qwen3-coder-30b-a3b-v1:0',
  'qwen3-coder': 'qwen.qwen3-coder-30b-a3b-v1:0',
  'qwen-3-coder': 'qwen.qwen3-coder-30b-a3b-v1:0',
  'qwen-coder-30b': 'qwen.qwen3-coder-30b-a3b-v1:0',
  'qwen3-coder-30b': 'qwen.qwen3-coder-30b-a3b-v1:0',
  // Qwen3 general purpose model (32B dense model)
  'qwen3': 'qwen.qwen3-32b-v1:0',
  'qwen-3': 'qwen.qwen3-32b-v1:0',
  'qwen3-32b': 'qwen.qwen3-32b-v1:0',
};

/**
 * Get Bedrock model ID from common model name
 */
export function getBedrockModelId(modelName: string): string {
  // If it already looks like a Bedrock model ID, return as-is
  if (modelName.includes('.') || modelName.startsWith('qwen.')) {
    return modelName;
  }

  // Check our mapping
  const normalized = modelName.toLowerCase();
  return BEDROCK_MODEL_MAP[normalized] || modelName;
}
