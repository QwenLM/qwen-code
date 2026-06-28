/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sub-agent tool classification now lives in `@qwen-code/chat-panel`; re-exported
 * so existing web-shell imports keep resolving.
 */
export {
  isTaskExecutionRaw,
  isSubAgentToolCall,
  isBackgroundSubAgentToolCall,
} from '@qwen-code/chat-panel';
