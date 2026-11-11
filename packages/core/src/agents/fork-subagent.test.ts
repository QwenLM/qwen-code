/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildForkDirectivePrompt,
  deriveForkName,
  truncateDirectiveLabel,
} from './fork-subagent.js';
import { StreamingToolExecutor } from '../tool-executor/index.js';
import { ToolRegistry } from '../tools/tool-registry.js';

import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';
import type { ToolUseContext } from '../tools/tool-types.js';

describe('buildForkDirectivePrompt', () => {
  it('wraps the directive with the fork worker contract', () => {
    expect(buildForkDirectivePrompt('inspect the failing tests')).toBe(
      `<fork-boilerplate>
You are a worker fork. The transcript above is the parent's history — inherited reference, not your situation. You are NOT a continuation of that agent. Execute ONE directive, then stop.

Hard rules:
- Do NOT spawn subagents with the Agent tool. The "default to forking" guidance is for the parent; you ARE the fork, execute directly.
- One shot: report once and stop. No follow-up questions, no proposed next steps, no waiting for the user.

Guidelines (your directive may override any of these):
- Stay in scope. Other forks may be handling adjacent work; if you spot something outside your directive, note it in a sentence and move on.
- Open with one line restating your task, so the parent can spot scope drift at a glance.
- Be concise — as short as the answer allows, no shorter. Plain text, no preamble, no meta-commentary.
- If you committed changes, list the paths and commit hashes in your report.
</fork-boilerplate>

Your directive: inspect the failing tests`,
    );
  });
});

describe('agent tool schema registry', () => {
  it('advertises overridden parent schemas and rejects schema-only execution', async () => {
    const signal = new AbortController().signal;
    const toolUseContext: ToolUseContext = {
      signal,
      mcpToolIdentities: new Map(),
    };
    const block: ModelToolUseBlock = {
      type: 'tool_use',
      id: 'call-1',
      name: 'Read',
      input: { file_path: '/x' },
    };
    const ctx = {
      agentContext: {
        toolRegistry: { getModelFunctionDeclarations: () => [] },
      } as never,
      toolUseContext,
      signal,
      responseId: 'response-1',
      promptId: 'prompt-1',
    };
    const parentSchemas = [{ name: 'Read', description: '', parameters: {} }];
    const config = { getToolRegistry: () => undefined } as never;
    const registry = new ToolRegistry(config, false, {
      schemaOverride: parentSchemas,
    });

    expect(registry.getSchema()).toEqual(parentSchemas);
    expect(
      new ToolRegistry(config, false, { schemaOverride: [] }).getSchema(),
    ).toEqual([]);
    const executor = new StreamingToolExecutor();
    await expect(
      executor.execute(block, { ...ctx, executionDisabled: true }),
    ).rejects.toThrow('Tool execution disabled');
  });
});

describe('deriveForkName', () => {
  it('slugifies the first three words', () => {
    expect(deriveForkName('Fix the flaky login test')).toBe('fix-the-flaky');
  });

  it('truncates to 24 chars without a trailing hyphen', () => {
    const name = deriveForkName(
      'refactor authentication middleware thoroughly',
    );
    expect(name.length).toBeLessThanOrEqual(24);
    expect(name.endsWith('-')).toBe(false);
  });

  it('strips punctuation from the slug', () => {
    expect(deriveForkName('Add: caching!!! layer')).toBe('add-caching-layer');
  });

  it('preserves non-Latin (CJK) characters instead of collapsing', () => {
    const name = deriveForkName('修复 登录 测试');
    expect(name).toBe('修复-登录-测试');
    expect(name).not.toBe('subtask');
  });

  it('falls back to "subtask" when nothing slug-able remains', () => {
    expect(deriveForkName('!!! ??? ...')).toBe('subtask');
    expect(deriveForkName('   ')).toBe('subtask');
  });
});

describe('truncateDirectiveLabel', () => {
  it('collapses whitespace and returns short directives unchanged', () => {
    expect(truncateDirectiveLabel('  fix   the   test  ')).toBe('fix the test');
  });

  it('truncates long directives with an ellipsis to the bound', () => {
    const label = truncateDirectiveLabel('a'.repeat(200));
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.endsWith('…')).toBe(true);
  });

  it('honors a custom max length', () => {
    expect(truncateDirectiveLabel('abcdefghij', 5)).toBe('abcd…');
  });
});
