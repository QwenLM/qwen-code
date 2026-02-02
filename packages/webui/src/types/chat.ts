/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chat message role types
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Basic chat message structure
 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
  timestamp: number;
}

/**
 * Plan entry for task tracking
 */
export interface PlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}
