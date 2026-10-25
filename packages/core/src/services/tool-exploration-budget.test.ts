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

  it('resets a phase on implementation, planning or unknown tools', () => {
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

  it('commits the zeroed floor on reset so a later rollback cannot resurrect a prior turn', () => {
    const budget = new ToolExplorationBudget();
    // Turn 1 reads past the allowance and commits its count.
    budget.record(Kind.Read);
    budget.record(Kind.Read);
    budget.commit();
    // Turn 2 resets (zeroing state AND committing the zero floor), streams
    // one read, then the attempt fails with a retry: the rollback must land
    // on turn 2's own floor of 0, not turn 1's committed count of 2.
    budget.reset();
    budget.record(Kind.Read);
    budget.rollback();
    expect(budget.takeReminder(2)).toBeUndefined();
    // A fresh phase accumulates normally after the reset.
    budget.record(Kind.Read);
    budget.record(Kind.Read);
    expect(budget.takeReminder(2)).toBe(TOOL_EXPLORATION_REMINDER);
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
    // The phase reset above must commit its own zero floor, so the rollback
    // cannot carry the delivered reminder's latch into the phase that
    // follows it: a fresh phase earns its own reminder.
    budget.record(Kind.Read);
    budget.record(Kind.Read);
    expect(budget.takeReminder(2)).toBe(TOOL_EXPLORATION_REMINDER);
  });

  it('honors a disabled allowance', () => {
    const budget = new ToolExplorationBudget();
    budget.record(Kind.Read);
    expect(budget.takeReminder(Infinity)).toBeUndefined();
    expect(budget.takeReminder(0)).toBeUndefined();
  });

  it('counts read-only discovery tools registered outside the read kinds', () => {
    // `lsp` and `tool_search` are registered Kind.Other, but interleaving
    // them into a read-only investigation must not wipe the phase: LSP's
    // own description steers the model into exactly that alternation.
    const registry = {
      getAllToolNames: () => ['read_file', 'lsp', 'tool_search', 'tool_call'],
      getTool: (name: string) =>
        name === 'read_file'
          ? { kind: Kind.Read }
          : name === 'tool_call'
            ? { kind: Kind.Other }
            : undefined,
    } as unknown as ToolRegistry;
    expect(getToolExplorationKind(registry, 'lsp', {})).toBe(Kind.Read);
    expect(getToolExplorationKind(registry, 'tool_search', {})).toBe(Kind.Read);
    // A bridged read-only MCP target still classifies as read (covered for
    // the registry path below); the bridge tool itself still ends a phase.
    expect(
      getToolExplorationKind(registry, 'tool_call', {
        name: 'lsp',
        arguments: {},
      }),
    ).toBe(Kind.Read);
    // The phase survives the interleaving.
    const budget = new ToolExplorationBudget();
    budget.record(getToolExplorationKind(registry, 'read_file', {}));
    budget.record(getToolExplorationKind(registry, 'lsp', {}));
    budget.record(getToolExplorationKind(registry, 'read_file', {}));
    expect(budget.takeReminder(2)).toBe(TOOL_EXPLORATION_REMINDER);
  });

  it('leaves an unregistered read-only discovery name unclassified', () => {
    // `lsp` is registered only when LSP is enabled and `tool_search` can be
    // removed with `--exclude-tools`; a refused call still reaches record(),
    // so a name the session never registered must not be credited as a read.
    const registry = {
      getAllToolNames: () => ['read_file'],
      getTool: (name: string) =>
        name === 'read_file' ? { kind: Kind.Read } : undefined,
    } as unknown as ToolRegistry;
    expect(getToolExplorationKind(registry, 'tool_search', {})).toBeUndefined();
    expect(getToolExplorationKind(registry, 'lsp', {})).toBeUndefined();
    expect(
      getToolExplorationKind(registry, 'tool_call', {
        name: 'tool_search',
        arguments: {},
      }),
    ).toBeUndefined();
  });

  it('leaves a bridge-refused discovery target unclassified', () => {
    // `tool_call` unconditionally refuses `tool_search` and itself
    // (tools/tool-call.ts), so a bridged call to either performs no read
    // even though the registry knows the name.
    const registry = {
      getAllToolNames: () => ['read_file', 'lsp', 'tool_search', 'tool_call'],
      getTool: (name: string) =>
        name === 'tool_call' ? { kind: Kind.Other } : undefined,
    } as unknown as ToolRegistry;
    expect(
      getToolExplorationKind(registry, 'tool_call', {
        name: 'tool_search',
        arguments: {},
      }),
    ).toBeUndefined();
    // A bridged target the bridge does accept keeps its classification.
    expect(
      getToolExplorationKind(registry, 'tool_call', {
        name: 'lsp',
        arguments: {},
      }),
    ).toBe(Kind.Read);
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
