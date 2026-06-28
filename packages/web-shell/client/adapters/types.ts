/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The shared chat-panel contract (message union, tool calls, permission requests,
 * turn collapse) now lives in `@qwen-code/chat-panel`; re-exported here so the
 * many `../adapters/types` imports across web-shell keep resolving. Composer /
 * model-picker types stay local — they are web-shell concerns, not panel ones.
 */
export type {
  Message,
  ACPToolCall,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
  ToolCallLocation,
  TodoItem,
  StreamingState,
  TurnCollapseHead,
  ContentBlock,
  PermissionOptionKind,
  PermissionOption,
  PermissionRequest,
} from '@qwen-code/chat-panel';

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  subcommands?: string[];
  source?: string;
  displayCategory?: 'custom' | 'skill' | 'system';
}

export interface ModelInfo {
  id: string;
  baseModelId?: string;
  label?: string;
  authType?: string;
  contextWindow?: number;
  modalities?: {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
  };
  isRuntime?: boolean;
}
