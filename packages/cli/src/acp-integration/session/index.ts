/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session module for ACP/Zed integration.
 *
 * This module provides a modular architecture for handling session events:
 * - **Emitters**: Unified event emission (MessageEmitter, ToolCallEmitter, PlanEmitter)
 * - **HistoryReplayer**: Replays session history using unified emitters
 * - **SubAgentTracker**: Tracks sub-agent tool events using unified emitters
 *
 * The key benefit is that all event emission goes through the same emitters,
 * ensuring consistency between normal flow, history replay, and sub-agent events.
 */

// Types
export type {
  SessionContext,
  SessionUpdateSender,
  ToolCallStartParams,
  ToolCallResultParams,
  TodoItem,
  ResolvedToolMetadata,
} from './types.js';

// Emitters
export { BaseEmitter } from './emitters/BaseEmitter.js';
export { MessageEmitter } from './emitters/MessageEmitter.js';
export { PlanEmitter } from './emitters/PlanEmitter.js';
export { ToolCallEmitter } from './emitters/ToolCallEmitter.js';

// Components
export { HistoryReplayer } from './HistoryReplayer.js';
export { SubAgentTracker } from './SubAgentTracker.js';

// Main Session class
export { Session } from './Session.js';
