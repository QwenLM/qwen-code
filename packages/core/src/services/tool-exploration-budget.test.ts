/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Kind } from '../tools/tools.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import {
  getToolExplorationKind,
  TOOL_EXPLORATION_REMINDER,
  ToolExplorationBudget,
} from './tool-exploration-budget.js';

describe('ToolExplorationBudget', () => {
  it('reminds once at the allowance and allows a legitimate investigation to continue', () => {
    const budget = new ToolExplorationBudget();
    for (let i = 0; i < 99; i++) budget.record(Kind.Read);
    expect(budget.takeReminder(100)).toBeUndefined();
    budget.record(Kind.Search);
    expect(budget.takeReminder(100)).toBe(TOOL_EXPLORATION_REMINDER);
    for (let i = 0; i < 50; i++) budget.record(Kind.Fetch);
    expect(budget.takeReminder(100)).toBeUndefined();
  });

  it('resets a phase on implementation, planning or unknown tools and new user turns', () => {
    const budget = new ToolExplorationBudget();
    for (const kind of [Kind.Edit, Kind.Think, undefined]) {
      budget.record(Kind.Read);
      budget.record(kind);
      budget.record(Kind.Read);
      expect(budget.takeReminder(2)).toBeUndefined();
      budget.record(Kind.Read);
      expect(budget.takeReminder(2)).toBe(TOOL_EXPLORATION_REMINDER);
      budget.reset();
    }
  });

  it('rolls back a replayed attempt without repeating an already sent reminder', () => {
    const budget = new ToolExplorationBudget();
    budget.record(Kind.Read);
    budget.commit();
    budget.record(Kind.Read);
    budget.rollback();
    expect(budget.takeReminder(2)).toBeUndefined();
    budget.record(Kind.Read);
    budget.commit();
    expect(budget.takeReminder(2)).toBe(TOOL_EXPLORATION_REMINDER);
    budget.record(Kind.Edit);
    budget.rollback();
    expect(budget.takeReminder(2)).toBeUndefined();
  });

  it('honors a disabled allowance', () => {
    const budget = new ToolExplorationBudget();
    budget.record(Kind.Read);
    expect(budget.takeReminder(Infinity)).toBeUndefined();
    expect(budget.takeReminder(0)).toBeUndefined();
  });

  it('leaves ambiguous case-insensitive registrations unclassified', () => {
    const registry = {
      getAllToolNames: () => ['READ_FILE', 'Read_File'],
      getTool: () => ({ kind: Kind.Read }),
    } as unknown as ToolRegistry;
    expect(getToolExplorationKind(registry, 'read_file', {})).toBeUndefined();
  });

  it('uses the registered kind for arbitrary and bridged MCP tool names', () => {
    const registry = {
      getAllToolNames: () => ['mcp__anonymous__describe_dataset'],
      getTool: (name: string) =>
        name === 'mcp__anonymous__describe_dataset'
          ? { kind: Kind.Read }
          : undefined,
    } as unknown as ToolRegistry;
    expect(
      getToolExplorationKind(registry, 'tool_call', {
        name: 'mcp__anonymous__describe_dataset',
        arguments: {},
      }),
    ).toBe(Kind.Read);
    expect(
      getToolExplorationKind(registry, 'unregistered', {}),
    ).toBeUndefined();
  });
});
