/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Export the original SubagentHooks as well for backward compatibility
export type { SubagentHooks } from '../subagents/subagent-hooks.js';
export {
  HookManager,
  HookType,
  type HookPayload,
  type HookContext,
  type HookFunction,
  type HookRegistration,
} from './HookManager.js';
