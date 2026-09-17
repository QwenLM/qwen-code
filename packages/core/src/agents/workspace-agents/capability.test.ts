/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '../../tools/tool-names.js';
import {
  buildAgentToolConfig,
  classifyAgentTool,
  createAgentToolInvocationGuard,
  THREAD_TOOL_NAMES,
  AGENT_TOOL_CLASSIFICATION,
} from './capability.js';

describe('agent capability boundary', () => {
  it('classifies every core and thread tools exactly once', () => {
    expect(new Set(Object.keys(AGENT_TOOL_CLASSIFICATION))).toEqual(
      new Set([...Object.values(ToolNames), ...THREAD_TOOL_NAMES]),
    );
    // `THREAD_TOOL_NAMES` is built from `ToolNames`, so the six are core wire
    // names too. What must hold is that nothing else joins their class: an
    // ordinary tool classified `thread` would be handed to every agent as part
    // of the collaboration surface.
    const threadNames = new Set<string>(THREAD_TOOL_NAMES);
    expect(
      Object.values(ToolNames)
        .filter((name) => !threadNames.has(name))
        .map(classifyAgentTool),
    ).not.toContain('thread');
    expect(THREAD_TOOL_NAMES.map(classifyAgentTool)).toEqual(
      THREAD_TOOL_NAMES.map(() => 'thread'),
    );
  });

  it('fails closed for tools outside the classification table', () => {
    expect(classifyAgentTool('mcp__server__read')).toBe('deny');
    expect(classifyAgentTool('__proto__')).toBe('deny');
  });

  it('applies the built-in ceiling and always adds thread tools', () => {
    const full = buildAgentToolConfig();
    const wildcard = buildAgentToolConfig({ tools: ['*'] });
    const narrowed = buildAgentToolConfig({
      tools: [ToolNames.READ_FILE, ToolNames.EDIT, 'mcp__server__read'],
    });

    expect(wildcard).toEqual(full);
    expect(full.tools).not.toContain(ToolNames.SHELL);
    expect(full.tools).not.toContain(ToolNames.MEMORY);
    expect(full.disallowedTools).toEqual(
      expect.arrayContaining([
        ToolNames.EDIT,
        ToolNames.WRITE_FILE,
        ToolNames.MEMORY,
      ]),
    );
    expect(narrowed.tools).toEqual([ToolNames.READ_FILE, ...THREAD_TOOL_NAMES]);
    expect(narrowed.executionAllowedTools).toEqual(narrowed.tools);
    expect(narrowed.disallowedTools).toEqual(full.disallowedTools);
  });

  it('preserves definition execution and disallow restrictions', () => {
    const narrowed = buildAgentToolConfig({
      tools: ['*'],
      executionAllowedTools: [ToolNames.READ_FILE, ToolNames.SHELL],
      disallowedTools: [ToolNames.READ_FILE, 'thread_post'],
    });

    expect(narrowed.tools).toEqual([...THREAD_TOOL_NAMES]);
    expect(narrowed.executionAllowedTools).toEqual(narrowed.tools);
    expect(narrowed.disallowedTools).not.toContain('thread_post');
    expect(narrowed.disallowedTools).toContain(ToolNames.READ_FILE);
  });

  it('enforces the boundary at invocation time', async () => {
    const guard = createAgentToolInvocationGuard();
    const base = { callId: 'call-1', signal: new AbortController().signal };
    await expect(
      guard({
        ...base,
        toolName: ToolNames.EDIT,
        args: {},
        cwd: process.cwd(),
      }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    await expect(
      guard({
        ...base,
        toolName: ToolNames.SHELL,
        args: { command: 'git push' },
        cwd: process.cwd(),
      }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
    await expect(
      guard({
        ...base,
        toolName: ToolNames.SHELL,
        args: { command: 'git status' },
        cwd: process.cwd(),
      }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
  });
});
