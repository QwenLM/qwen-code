/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Agent engine 的共享类型。
 *
 * 会话链的 slash command 契约与工具 schema registry 工厂。
 */

import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ProcessInputResult } from '../input/types.js';
import type { AttachmentMessage } from '../attachments/types.js';
import type { ModelInputContentBlock } from '../provider/modelStreamRequest.js';

export interface QueryEngineSlashCommandContext {
  promptId: string;
  signal: AbortSignal;
  userMessageUuid: string;
}

export type QueryEngineSlashCommandHandler = (
  input: string,
  precedingInputBlocks: readonly ModelInputContentBlock[],
  imageContentBlocks: readonly ModelInputContentBlock[],
  attachmentMessages: AttachmentMessage[],
  context: QueryEngineSlashCommandContext,
) => Promise<ProcessInputResult | false>;

/**
 * Factory that resolves the agent's tool bridge for a prompt.
 *
 * The bridge is per agent and owns execution state; prompt-scoped facts
 * travel through each ToolExecuteContext instead.
 */
export interface ToolRegistryFactory {
  create(promptId: string, messageId?: string): ToolRegistry;
}
