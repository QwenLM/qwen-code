/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Re-export the main provider class
export { BedrockOpenAICompatibleProvider } from './provider.js';

// Re-export types for external use
export type {
  BedrockConverseRequest,
  BedrockConverseResponse,
  BedrockMessage,
  BedrockContentBlock,
  BedrockStreamEvent,
} from './types.js';

// Re-export converter functions for testing/advanced use
export {
  convertOpenAIToBedrock,
  convertBedrockToOpenAI,
  convertBedrockStreamToOpenAI,
} from './converter.js';
