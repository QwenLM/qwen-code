/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolNames } from '../../tools/tool-names.js';
import {
  buildSessionAgentToolConfig,
  classifyAgentTool,
  createAgentToolInvocationGuard,
  createSessionAgentToolInvocationGuard,
  AGENT_TOOL_CLASSIFICATION,
} from './capability.js';

describe('agent capability boundary', () => {
  it('classifies every core tool exactly once', () => {
    expect(new Set(Object.keys(AGENT_TOOL_CLASSIFICATION))).toEqual(
      new Set(Object.values(ToolNames)),
    );
  });

  it('fails closed for tools outside the classification table', () => {
    expect(classifyAgentTool('mcp__server__read')).toBe('deny');
    expect(classifyAgentTool('__proto__')).toBe('deny');
  });

  it('gives a session agent every tool unless a definition narrows it', () => {
    expect(buildSessionAgentToolConfig()).toEqual({ tools: ['*'] });
    expect(
      buildSessionAgentToolConfig({
        tools: [ToolNames.READ_FILE, ToolNames.EDIT],
        executionAllowedTools: [ToolNames.READ_FILE, ToolNames.SHELL],
        disallowedTools: [ToolNames.SHELL, ToolNames.SHELL],
      }),
    ).toEqual({
      tools: [ToolNames.READ_FILE, ToolNames.EDIT],
      executionAllowedTools: [ToolNames.READ_FILE],
      disallowedTools: [ToolNames.SHELL],
    });
  });

  it('lets a session agent call writes unless its allowlist excludes them', async () => {
    const base = {
      callId: 'call-1',
      signal: new AbortController().signal,
      args: {},
      cwd: process.cwd(),
    };
    await expect(
      createSessionAgentToolInvocationGuard()({
        ...base,
        toolName: ToolNames.EDIT,
      }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      createSessionAgentToolInvocationGuard(
        undefined,
        new Set([ToolNames.READ_FILE]),
      )({ ...base, toolName: ToolNames.EDIT }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
  });

  it("denies a session agent its definition's disallowedTools", async () => {
    const base = {
      callId: 'call-1',
      signal: new AbortController().signal,
      args: {},
      cwd: process.cwd(),
    };
    // A deny-only definition: every tool but write_file and one MCP server.
    const config = buildSessionAgentToolConfig({
      tools: ['*'],
      disallowedTools: [ToolNames.WRITE_FILE, 'mcp__secrets'],
    });
    expect(config.executionAllowedTools).toBeUndefined();
    const guard = createSessionAgentToolInvocationGuard(
      undefined,
      undefined,
      config.disallowedTools,
    );
    for (const [toolName, allowed] of [
      [ToolNames.WRITE_FILE, false],
      ['mcp__secrets__read', false],
      [ToolNames.READ_FILE, true],
      [ToolNames.EDIT, true],
      ['mcp__other__read', true],
    ] as const) {
      await expect(guard({ ...base, toolName })).resolves.toEqual(
        expect.objectContaining({ allowed }),
      );
    }
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
    await expect(
      guard({
        ...base,
        toolName: ToolNames.SKILL,
        args: { skill: 'project-hook' },
        cwd: process.cwd(),
      }),
    ).resolves.toEqual(expect.objectContaining({ allowed: false }));
  });
});
