/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getToolCallComponent } from './routing.js';
import { AgentToolCall } from './AgentToolCall.js';
import { GenericToolCall } from './GenericToolCall.js';
import { ReadToolCall } from './ReadToolCall.js';
import { WriteToolCall } from './WriteToolCall.js';
import { EditToolCall } from './EditToolCall.js';
import { ShellToolCall } from './ShellToolCall.js';
import { UpdatedPlanToolCall } from './UpdatedPlanToolCall.js';
import { SearchToolCall } from './SearchToolCall.js';
import { ThinkToolCall } from './ThinkToolCall.js';
import { WebFetchToolCall } from './WebFetchToolCall.js';
import type { ToolCallData } from './shared/index.js';

function tc(kind: string, extra?: Partial<ToolCallData>): ToolCallData {
  return { kind, ...extra } as ToolCallData;
}

function agentTc(): ToolCallData {
  return {
    kind: 'other',
    rawOutput: {
      type: 'task_execution',
      taskDescription: 'test task',
      status: 'completed',
    },
  } as ToolCallData;
}

describe('getToolCallComponent', () => {
  it('routes agent execution to AgentToolCall', () => {
    expect(getToolCallComponent(agentTc())).toBe(AgentToolCall);
  });

  it('routes read-family kinds to ReadToolCall', () => {
    expect(getToolCallComponent(tc('read'))).toBe(ReadToolCall);
    expect(getToolCallComponent(tc('read_file'))).toBe(ReadToolCall);
    expect(getToolCallComponent(tc('read_many_files'))).toBe(ReadToolCall);
    expect(getToolCallComponent(tc('readmanyfiles'))).toBe(ReadToolCall);
    expect(getToolCallComponent(tc('list_directory'))).toBe(ReadToolCall);
    expect(getToolCallComponent(tc('listfiles'))).toBe(ReadToolCall);
  });

  it('routes write to WriteToolCall', () => {
    expect(getToolCallComponent(tc('write'))).toBe(WriteToolCall);
  });

  it('routes edit to EditToolCall', () => {
    expect(getToolCallComponent(tc('edit'))).toBe(EditToolCall);
  });

  it('routes shell-family kinds to ShellToolCall', () => {
    expect(getToolCallComponent(tc('execute'))).toBe(ShellToolCall);
    expect(getToolCallComponent(tc('bash'))).toBe(ShellToolCall);
    expect(getToolCallComponent(tc('command'))).toBe(ShellToolCall);
  });

  it('routes plan/todo kinds to UpdatedPlanToolCall', () => {
    expect(getToolCallComponent(tc('updated_plan'))).toBe(UpdatedPlanToolCall);
    expect(getToolCallComponent(tc('updatedplan'))).toBe(UpdatedPlanToolCall);
    expect(getToolCallComponent(tc('todo_write'))).toBe(UpdatedPlanToolCall);
    expect(getToolCallComponent(tc('update_todos'))).toBe(UpdatedPlanToolCall);
    expect(getToolCallComponent(tc('todowrite'))).toBe(UpdatedPlanToolCall);
  });

  it('routes search-family kinds to SearchToolCall', () => {
    expect(getToolCallComponent(tc('search'))).toBe(SearchToolCall);
    expect(getToolCallComponent(tc('grep'))).toBe(SearchToolCall);
    expect(getToolCallComponent(tc('glob'))).toBe(SearchToolCall);
    expect(getToolCallComponent(tc('find'))).toBe(SearchToolCall);
  });

  it('routes think-family kinds to ThinkToolCall', () => {
    expect(getToolCallComponent(tc('think'))).toBe(ThinkToolCall);
    expect(getToolCallComponent(tc('thinking'))).toBe(ThinkToolCall);
  });

  it('routes fetch/web-fetch/web-search kinds to WebFetchToolCall', () => {
    expect(getToolCallComponent(tc('fetch'))).toBe(WebFetchToolCall);
    expect(getToolCallComponent(tc('web_fetch'))).toBe(WebFetchToolCall);
    expect(getToolCallComponent(tc('webfetch'))).toBe(WebFetchToolCall);
    expect(getToolCallComponent(tc('web_search'))).toBe(WebFetchToolCall);
  });

  it('falls back to GenericToolCall for unknown kinds', () => {
    expect(getToolCallComponent(tc('unknown_tool'))).toBe(GenericToolCall);
    expect(getToolCallComponent(tc('mcp_tool'))).toBe(GenericToolCall);
  });

  it('performs case-insensitive kind matching', () => {
    expect(getToolCallComponent(tc('Read'))).toBe(ReadToolCall);
    expect(getToolCallComponent(tc('BASH'))).toBe(ShellToolCall);
    expect(getToolCallComponent(tc('Web_Search'))).toBe(WebFetchToolCall);
  });
});
