/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger, type SDKMessage } from '@qwen-code/core';

interface ContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
}

interface ToolFailureScope {
  toolNames: Map<string, string>;
  settledToolIds: Set<string>;
}

/** Associates headless tool results with their names for the run log. */
export class ToolFailureLog {
  private readonly toolNames = new Map<string, string>();
  private readonly settledToolIds = new Set<string>();
  private readonly childScopes = new Map<string, ToolFailureScope>();
  private readonly taskScopes = new Map<string, string>();

  observe(message: SDKMessage): void {
    if (message.type === 'system') {
      if (
        message.subtype === 'task_started' ||
        message.subtype === 'task_progress'
      ) {
        if (message.tool_use_id)
          this.taskScopes.set(message.task_id, message.tool_use_id);
      } else if (
        message.subtype === 'task_notification' ||
        (message.subtype === 'task_updated' &&
          (message.patch.status === 'completed' ||
            message.patch.status === 'failed' ||
            message.patch.status === 'killed'))
      ) {
        const scopeId =
          message.subtype === 'task_notification'
            ? (message.tool_use_id ?? this.taskScopes.get(message.task_id))
            : this.taskScopes.get(message.task_id);
        if (scopeId) this.childScopes.delete(scopeId);
        this.taskScopes.delete(message.task_id);
      }
      return;
    }
    if (message.type !== 'assistant' && message.type !== 'user') return;
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    const parentId = message.parent_tool_use_id;
    let scope: ToolFailureScope = {
      toolNames: this.toolNames,
      settledToolIds: this.settledToolIds,
    };
    if (parentId) {
      const childScope = this.childScopes.get(parentId) ?? {
        toolNames: new Map<string, string>(),
        settledToolIds: new Set<string>(),
      };
      this.childScopes.set(parentId, childScope);
      scope = childScope;
    }

    for (const raw of content) {
      if (typeof raw !== 'object' || raw === null) continue;
      const block = raw as ContentBlock;
      if (
        message.type === 'assistant' &&
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        block.name.length > 0 &&
        !scope.settledToolIds.has(block.id)
      ) {
        scope.toolNames.set(block.id, block.name);
      } else if (
        message.type === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        const toolUseId = block.tool_use_id;
        if (scope.settledToolIds.has(toolUseId)) continue;
        const toolName = scope.toolNames.get(toolUseId);
        // Release names for successful results too; dedupe lasts until the owner ends.
        scope.toolNames.delete(toolUseId);
        scope.settledToolIds.add(toolUseId);
        if (block.is_error !== true) continue;
        const label =
          toolName ?? `(name unavailable; tool_use_id=${toolUseId})`;
        runLogger.warn(
          `Error executing tool ${label}: ${formatContent(block.content)}`,
        );
      }
    }
  }

  /** Background agents can continue after the main turn's terminal message. */
  clearTurn(): void {
    this.toolNames.clear();
    this.settledToolIds.clear();
  }

  clear(): void {
    this.clearTurn();
    this.childScopes.clear();
    this.taskScopes.clear();
  }
}

function formatContent(content: unknown): string {
  if (typeof content === 'string') return content || 'Tool execution failed';
  if (content === undefined || content === null) return 'Tool execution failed';
  try {
    return JSON.stringify(content) ?? 'Tool execution failed';
  } catch {
    return String(content);
  }
}
